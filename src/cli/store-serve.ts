import { Command, Options } from "@effect/cli";
import { HttpRouter, HttpServer, HttpServerResponse, HttpMiddleware } from "@effect/platform";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import { BunHttpServer } from "@effect/platform-bun";
import * as Reactivity from "@effect/experimental/Reactivity";
import { Chunk, Duration, Effect, Layer, Option, Ref, Schedule, Schema, Stream } from "effect";
import { StoreManager } from "../services/store-manager.js";
import { StoreEventLog } from "../services/store-event-log.js";
import { StoreIndex } from "../services/store-index.js";
import { StoreRef } from "../domain/store.js";
import { StoreQuery } from "../domain/events.js";
import { FilterExprSchema } from "../domain/filter.js";
import { StoreName, type EventSeq } from "../domain/primitives.js";
import { StoreNotFound, type StoreIoError } from "../domain/errors.js";
import { withExamples } from "./help.js";

const StoreParams = Schema.Struct({ name: Schema.String });

const resolveStore = (
  manager: StoreManager,
  name: string
): Effect.Effect<StoreRef, StoreNotFound | StoreIoError> =>
  Schema.decodeUnknown(StoreName)(name).pipe(
    Effect.orDie,
    Effect.flatMap((storeName) => manager.getStore(storeName)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Schema.decodeUnknown(StoreName)(name).pipe(
            Effect.orDie,
            Effect.flatMap((sn) => Effect.fail(StoreNotFound.make({ name: sn })))
          ),
        onSome: Effect.succeed
      })
    )
  );

const SearchParams = Schema.Struct({
  filter: Schema.optional(Schema.String)
});

const makeRouter = Effect.gen(function* () {
  const reactivity = yield* Reactivity.Reactivity;
  const manager = yield* StoreManager;
  const eventLog = yield* StoreEventLog;
  const index = yield* StoreIndex;

  return HttpRouter.empty.pipe(
    HttpRouter.get(
      "/health",
      HttpServerResponse.json({ status: "ok" })
    ),

    HttpRouter.get(
      "/stores",
      Effect.gen(function* () {
        const stores = yield* manager.listStores();
        const items = Chunk.toReadonlyArray(stores).map((s) => ({
          name: s.name,
          root: s.root,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          ...(s.description ? { description: s.description } : {})
        }));
        return HttpServerResponse.unsafeJson({ stores: items });
      })
    ),

    HttpRouter.get(
      "/stores/:name/posts",
      Effect.gen(function* () {
        const { name } = yield* HttpRouter.schemaPathParams(StoreParams);
        const storeRef = yield* resolveStore(manager, name);
        const searchParams = yield* HttpServerRequest.schemaSearchParams(SearchParams);
        const filter = searchParams.filter
          ? yield* Schema.decodeUnknown(Schema.parseJson(FilterExprSchema))(searchParams.filter).pipe(Effect.orDie)
          : undefined;
        const storeQuery = StoreQuery.make({
          ...(filter ? { filter } : {})
        });
        const posts = yield* index
          .query(storeRef, storeQuery)
          .pipe(Stream.runCollect);
        return HttpServerResponse.unsafeJson({
          store: storeRef.name,
          count: Chunk.size(posts),
          posts: Chunk.toReadonlyArray(posts)
        });
      })
    ),

    HttpRouter.get(
      "/stores/:name/events",
      Effect.gen(function* () {
        const { name } = yield* HttpRouter.schemaPathParams(StoreParams);
        const storeRef = yield* resolveStore(manager, name);

        // Seed cursor to current tail so we only stream new events
        const currentSeq = yield* eventLog.getLastEventSeq(storeRef);
        const lastSeq = yield* Ref.make(currentSeq);

        const sseStream = reactivity
          .stream(
            { "store:events": [name] },
            Effect.gen(function* () {
              const cursor = yield* Ref.get(lastSeq);
              const entries = yield* eventLog.getEventsAfter(storeRef, cursor);
              if (entries.length > 0) {
                yield* Ref.set(
                  lastSeq,
                  Option.some(entries[entries.length - 1]!.seq)
                );
              }
              return entries;
            })
          )
          .pipe(
            Stream.filter((entries) => entries.length > 0),
            Stream.map(
              (entries) =>
                `event: posts\ndata: ${JSON.stringify(entries.map((e) => ({ seq: e.seq, event: e.record.event })))}\n\n`
            ),
            Stream.encodeText
          );

        return HttpServerResponse.stream(sseStream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive"
          }
        });
      })
    )
  );
});

const pollExternalChanges = (pollInterval: Duration.Duration) =>
  Effect.gen(function* () {
    const reactivity = yield* Reactivity.Reactivity;
    const manager = yield* StoreManager;
    const eventLog = yield* StoreEventLog;
    const lastSeqs = yield* Ref.make(new Map<string, EventSeq>());

    return yield* Effect.repeat(
      Effect.gen(function* () {
        const stores = yield* manager.listStores();
        yield* Effect.forEach(
          Chunk.toReadonlyArray(stores),
          (store) =>
            Effect.gen(function* () {
              const storeRef = StoreRef.make({ name: store.name, root: store.root });
              const currentSeq = yield* eventLog.getLastEventSeq(storeRef);
              if (Option.isNone(currentSeq)) return;
              const seqs = yield* Ref.get(lastSeqs);
              const prev = seqs.get(store.name);
              if (prev !== undefined && prev === currentSeq.value) return;
              yield* Ref.update(lastSeqs, (m) => {
                const next = new Map(m);
                next.set(store.name, currentSeq.value);
                return next;
              });
              if (prev !== undefined) {
                reactivity.unsafeInvalidate({ "store:events": [store.name] });
              }
            }),
          { discard: true }
        );
      }),
      Schedule.spaced(pollInterval)
    );
  });

export const storeServe = Command.make(
  "serve",
  {
    port: Options.integer("port").pipe(
      Options.withDefault(3000),
      Options.withDescription("HTTP server port")
    ),
    pollInterval: Options.integer("poll-interval").pipe(
      Options.withDefault(2),
      Options.withDescription("Poll interval in seconds for detecting external changes")
    )
  },
  ({ port, pollInterval }) =>
    Effect.gen(function* () {
      const router = yield* makeRouter;

      yield* pollExternalChanges(Duration.seconds(pollInterval)).pipe(
        Effect.fork
      );

      return yield* router.pipe(
        HttpServer.serve(HttpMiddleware.logger),
        HttpServer.withLogAddress,
        Layer.provide(BunHttpServer.layer({ port })),
        Layer.launch
      );
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Start HTTP server with SSE streaming for store events",
      [
        "skygent store serve",
        "skygent store serve --port 8080",
        "skygent store serve --poll-interval 5"
      ]
    )
  )
);
