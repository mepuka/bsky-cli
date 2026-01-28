import { Context, Effect, Layer, Option } from "effect";
import { StoreIoError } from "../domain/errors.js";
import type { StorePath } from "../domain/primitives.js";
import type { StoreRef } from "../domain/store.js";
import { PostDelete, PostEventRecord, PostUpsert } from "../domain/events.js";
import { StoreDb } from "./store-db.js";
import { StoreWriter } from "./store-writer.js";
import { deletePost, insertPostIfMissing, upsertPost } from "./store-index-sql.js";

const toStoreIoError = (path: StorePath) => (cause: unknown) =>
  StoreIoError.make({ path, cause });

export class StoreCommitter extends Context.Tag("@skygent/StoreCommitter")<
  StoreCommitter,
  {
    readonly appendUpsert: (
      store: StoreRef,
      event: PostUpsert
    ) => Effect.Effect<PostEventRecord, StoreIoError>;
    readonly appendUpsertIfMissing: (
      store: StoreRef,
      event: PostUpsert
    ) => Effect.Effect<Option.Option<PostEventRecord>, StoreIoError>;
    readonly appendDelete: (
      store: StoreRef,
      event: PostDelete
    ) => Effect.Effect<PostEventRecord, StoreIoError>;
  }
>() {
  static readonly layer = Layer.effect(
    StoreCommitter,
    Effect.gen(function* () {
      const storeDb = yield* StoreDb;
      const writer = yield* StoreWriter;

      const appendUpsert = Effect.fn("StoreCommitter.appendUpsert")(
        (store: StoreRef, event: PostUpsert) =>
          storeDb
            .withClient(store, (client) =>
              client.withTransaction(
                Effect.gen(function* () {
                  yield* upsertPost(client, event.post);
                  return yield* writer.appendWithClient(client, event);
                })
              )
            )
            .pipe(Effect.mapError(toStoreIoError(store.root)))
      );

      const appendUpsertIfMissing = Effect.fn(
        "StoreCommitter.appendUpsertIfMissing"
      )((store: StoreRef, event: PostUpsert) =>
        storeDb
          .withClient(store, (client) =>
            client.withTransaction(
              Effect.gen(function* () {
                const inserted = yield* insertPostIfMissing(client, event.post);
                if (!inserted) {
                  return Option.none<PostEventRecord>();
                }
                const record = yield* writer.appendWithClient(client, event);
                return Option.some(record);
              })
            )
          )
          .pipe(Effect.mapError(toStoreIoError(store.root)))
      );

      const appendDelete = Effect.fn("StoreCommitter.appendDelete")(
        (store: StoreRef, event: PostDelete) =>
          storeDb
            .withClient(store, (client) =>
              client.withTransaction(
                Effect.gen(function* () {
                  yield* deletePost(client, event.uri);
                  return yield* writer.appendWithClient(client, event);
                })
              )
            )
            .pipe(Effect.mapError(toStoreIoError(store.root)))
      );

      return StoreCommitter.of({
        appendUpsert,
        appendUpsertIfMissing,
        appendDelete
      });
    })
  );
}
