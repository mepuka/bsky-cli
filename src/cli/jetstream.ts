import { Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { JetstreamConfig } from "effect-jetstream";
import { DataSource } from "../domain/sync.js";
import type { StoreRef } from "../domain/store.js";
import { SyncCheckpointStore } from "../services/sync-checkpoint-store.js";
import { CliInputError } from "./errors.js";

const DEFAULT_COLLECTIONS = ["app.bsky.feed.post"];

export const jetstreamOptions = {
  endpoint: Options.text("endpoint").pipe(
    Options.withDescription("Jetstream WebSocket endpoint"),
    Options.optional
  ),
  collections: Options.text("collections").pipe(
    Options.withDescription(
      "Comma-separated collections to subscribe (only app.bsky.feed.post supported)"
    ),
    Options.optional
  ),
  dids: Options.text("dids").pipe(
    Options.withDescription("Comma-separated DIDs to subscribe"),
    Options.optional
  ),
  cursor: Options.text("cursor").pipe(
    Options.withDescription("Jetstream cursor (microseconds)"),
    Options.optional
  ),
  compress: Options.boolean("compress").pipe(
    Options.withDescription("Enable compression if supported by runtime")
  ),
  maxMessageSize: Options.integer("max-message-size").pipe(
    Options.withDescription("Max message size in bytes"),
    Options.optional
  )
};

export type JetstreamCliOptions = {
  readonly endpoint: Option.Option<string>;
  readonly collections: Option.Option<string>;
  readonly dids: Option.Option<string>;
  readonly cursor: Option.Option<string>;
  readonly compress: boolean;
  readonly maxMessageSize: Option.Option<number>;
};

export type JetstreamSelection = {
  readonly source: Extract<DataSource, { _tag: "Jetstream" }>;
  readonly config: JetstreamConfig.JetstreamConfig;
  readonly cursor: string | undefined;
};

const parseCsv = (value: string) =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const parseCursorValue = (value: string, message: string) =>
  Effect.try({
    try: () => {
      const trimmed = value.trim();
      const parsed = Number(trimmed);
      if (
        trimmed.length === 0 ||
        !Number.isFinite(parsed) ||
        !Number.isSafeInteger(parsed) ||
        parsed < 0
      ) {
        throw new Error("Invalid cursor");
      }
      return { raw: trimmed, value: parsed };
    },
    catch: (cause) => CliInputError.make({ message, cause })
  });

export const buildJetstreamSelection = (
  options: JetstreamCliOptions,
  store: StoreRef,
  filterHash: string
) =>
  Effect.gen(function* () {
    const endpoint = Option.getOrUndefined(options.endpoint);
    const collections = Option.match(options.collections, {
      onNone: () => DEFAULT_COLLECTIONS,
      onSome: parseCsv
    });
    const dids = Option.match(options.dids, {
      onNone: () => [],
      onSome: parseCsv
    });
    const maxMessageSize = Option.getOrUndefined(options.maxMessageSize);

    const unsupportedCollections = collections.filter(
      (collection) => collection !== DEFAULT_COLLECTIONS[0]
    );
    if (unsupportedCollections.length > 0) {
      return yield* CliInputError.make({
        message:
          "Only app.bsky.feed.post is supported for Jetstream collections.",
        cause: unsupportedCollections
      });
    }

    if (typeof maxMessageSize === "number" && maxMessageSize <= 0) {
      return yield* CliInputError.make({
        message: "max-message-size must be a positive integer.",
        cause: maxMessageSize
      });
    }

    const source = DataSource.jetstream({
      ...(endpoint !== undefined ? { endpoint } : {}),
      collections,
      dids,
      compress: options.compress,
      ...(maxMessageSize !== undefined
        ? { maxMessageSizeBytes: maxMessageSize }
        : {})
    }) as Extract<DataSource, { _tag: "Jetstream" }>;

    const explicitCursor = yield* Option.match(options.cursor, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (value) =>
        parseCursorValue(
          value,
          `Invalid cursor: ${value}. Use a non-negative integer in microseconds.`
        ).pipe(Effect.map(Option.some))
    });

    const checkpoints = yield* SyncCheckpointStore;
    const checkpoint = yield* checkpoints.load(store, source);
    const activeCheckpoint = Option.filter(checkpoint, (value) =>
      value.filterHash ? value.filterHash === filterHash : true
    );
    const checkpointCursor = Option.flatMap(activeCheckpoint, (value) =>
      Option.fromNullable(value.cursor)
    );

    const resolvedCursor = yield* Option.match(explicitCursor, {
      onSome: (cursor) => Effect.succeed(Option.some(cursor)),
      onNone: () =>
        Option.match(checkpointCursor, {
          onSome: (value) =>
            parseCursorValue(
              value,
              `Invalid checkpoint cursor: ${value}. Delete the checkpoint or provide --cursor.`
            ).pipe(Effect.map(Option.some)),
          onNone: () => Effect.succeed(Option.none())
        })
    });

    const cursorValue = Option.getOrUndefined(
      Option.map(resolvedCursor, (cursor) => cursor.value)
    );
    const cursorRaw = Option.getOrUndefined(
      Option.map(resolvedCursor, (cursor) => cursor.raw)
    );

    const config = JetstreamConfig.JetstreamConfig.make({
      ...(endpoint !== undefined ? { endpoint } : {}),
      wantedCollections: collections,
      wantedDids: dids,
      ...(cursorValue !== undefined ? { cursor: cursorValue } : {}),
      compress: options.compress,
      ...(maxMessageSize !== undefined
        ? { maxMessageSizeBytes: maxMessageSize }
        : {})
    });

    return { source, config, cursor: cursorRaw };
  });
