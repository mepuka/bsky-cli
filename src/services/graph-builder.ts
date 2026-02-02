import { Chunk, Clock, Context, Effect, Layer, Schema, Stream } from "effect";
import { FilterCompileError, FilterEvalError, StoreIndexError } from "../domain/errors.js";
import { GraphEdge, GraphNode, GraphSnapshot } from "../domain/graph.js";
import { filterExprSignature } from "../domain/filter.js";
import type { StoreQuery } from "../domain/events.js";
import type { StoreRef } from "../domain/store.js";
import { Timestamp, type Did } from "../domain/primitives.js";
import {
  isEmbedRecord,
  isEmbedRecordWithMedia,
  isFeedReasonRepost,
  type EmbedRecordTarget,
  type FeedReasonRepost,
  type PostEmbed
} from "../domain/bsky.js";
import { StoreIndex } from "./store-index.js";
import { FilterRuntime } from "./filter-runtime.js";
import { filterByFlags } from "../typeclass/chunk.js";

export type InteractionNetworkInput = {
  readonly query: StoreQuery;
  readonly limit?: number;
};

type GraphBuilderError = StoreIndexError | FilterCompileError | FilterEvalError;

const getRecordAuthor = (
  record: EmbedRecordTarget
): { readonly did: Did; readonly handle?: string } | undefined =>
  "author" in record && record.author && "did" in record.author
    ? (() => {
        const did = record.author.did;
        const handle = "handle" in record.author ? record.author.handle : undefined;
        return handle ? { did, handle } : { did };
      })()
    : undefined;

const getEmbedRecordAuthor = (embed?: PostEmbed) => {
  if (!embed) return undefined;
  if (isEmbedRecord(embed)) {
    return getRecordAuthor(embed.record);
  }
  if (isEmbedRecordWithMedia(embed)) {
    return getRecordAuthor(embed.record);
  }
  return undefined;
};

const recordRepostActor = (reason: FeedReasonRepost) => ({
  did: reason.by.did,
  handle: reason.by.handle
});

export class GraphBuilder extends Context.Tag("@skygent/GraphBuilder")<
  GraphBuilder,
  {
    readonly buildInteractionNetwork: (
      store: StoreRef,
      input: InteractionNetworkInput
    ) => Effect.Effect<GraphSnapshot, GraphBuilderError>;
  }
>() {
  static readonly layer = Layer.effect(
    GraphBuilder,
    Effect.gen(function* () {
      const index = yield* StoreIndex;
      const runtime = yield* FilterRuntime;

      const buildInteractionNetwork = Effect.fn("GraphBuilder.buildInteractionNetwork")(
        (store: StoreRef, input: InteractionNetworkInput) =>
          Effect.gen(function* () {
            const query = input.query;
            const expr = query.filter;
            const evaluateBatch = expr ? yield* runtime.evaluateBatch(expr) : undefined;

            const baseStream = index.query(store, query);
            const filteredStream = expr && evaluateBatch
              ? baseStream.pipe(
                  Stream.grouped(50),
                  Stream.mapEffect((batch) =>
                    evaluateBatch(batch).pipe(
                      Effect.map((flags) => filterByFlags(batch, flags))
                    )
                  ),
                  Stream.mapConcat((chunk) => Chunk.toReadonlyArray(chunk))
                )
              : baseStream;
            const limitedStream = input.limit
              ? filteredStream.pipe(Stream.take(input.limit))
              : filteredStream;
            const collected = yield* Stream.runCollect(limitedStream);
            const posts = Chunk.toReadonlyArray(collected);

            const byUri = new Map<string, Did>();
            for (const post of posts) {
              if (post.authorDid) {
                byUri.set(String(post.uri), post.authorDid);
              }
            }

            const nodes = new Map<Did, GraphNode>();
            const edges = new Map<string, GraphEdge>();

            const ensureNode = (did: Did, label?: string) => {
              const existing = nodes.get(did);
              if (!existing) {
                nodes.set(did, GraphNode.make({ id: did, label }));
                return;
              }
              if (!existing.label && label) {
                nodes.set(did, GraphNode.make({ id: did, label, meta: existing.meta }));
              }
            };

            const addEdge = (from: Did, to: Did, type: GraphEdge["type"]) => {
              if (from === to) return;
              const key = `${from}|${to}|${type}`;
              const existing = edges.get(key);
              if (!existing) {
                edges.set(key, GraphEdge.make({ from, to, type, weight: 1 }));
                return;
              }
              const weight = (existing.weight ?? 0) + 1;
              edges.set(key, GraphEdge.make({ from, to, type, weight }));
            };

            for (const post of posts) {
              const authorDid = post.authorDid;
              if (!authorDid) {
                continue;
              }
              ensureNode(authorDid, post.author);

              for (const mentionDid of post.mentionDids ?? []) {
                ensureNode(mentionDid);
                addEdge(authorDid, mentionDid, "mention");
              }

              const replyParentUri = post.reply?.parent.uri
                ? String(post.reply.parent.uri)
                : undefined;
              if (replyParentUri) {
                const parentDid = byUri.get(replyParentUri);
                if (parentDid) {
                  ensureNode(parentDid);
                  addEdge(authorDid, parentDid, "reply");
                }
              }

              const quotedAuthor = getEmbedRecordAuthor(post.embed);
              if (quotedAuthor) {
                ensureNode(quotedAuthor.did, quotedAuthor.handle);
                addEdge(authorDid, quotedAuthor.did, "quote");
              }

              const reason = post.feed?.reason;
              if (reason && isFeedReasonRepost(reason)) {
                const repostActor = recordRepostActor(reason);
                ensureNode(repostActor.did, repostActor.handle);
                ensureNode(authorDid, post.author);
                addEdge(repostActor.did, authorDid, "repost");
              }
            }

            const now = yield* Clock.currentTimeMillis;
            const builtAt = yield* Schema.decodeUnknown(
              Timestamp
            )(new Date(now).toISOString()).pipe(
              Effect.mapError((cause) =>
                StoreIndexError.make({
                  message: "GraphBuilder.buildInteractionNetwork invalid timestamp",
                  cause
                })
              )
            );

            const filterHash = expr ? filterExprSignature(expr) : undefined;

            return GraphSnapshot.make({
              nodes: Array.from(nodes.values()),
              edges: Array.from(edges.values()),
              directed: true,
              builtAt,
              sources: [`store:${store.name}`],
              window: query.range ? { start: query.range.start, end: query.range.end } : undefined,
              filters: filterHash ? { filterHash } : undefined
            });
          })
      );

      return GraphBuilder.of({ buildInteractionNetwork });
    })
  );
}
