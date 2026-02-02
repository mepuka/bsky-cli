import * as Persistence from "@effect/experimental/Persistence";
import { Clock, Context, Effect, Exit, Layer, Option, PrimaryKey, Schema } from "effect";
import { createHash } from "node:crypto";
import { ImageCacheError, isImageCacheError } from "../../domain/errors.js";
import { Timestamp } from "../../domain/primitives.js";
import { messageFromCause } from "../shared.js";

const keyHash = (path: string) =>
  createHash("sha256").update(path).digest("hex");

const ImageRefEntry = Schema.Struct({
  path: Schema.String,
  count: Schema.Int.pipe(Schema.nonNegative()),
  lastAccessed: Timestamp
});
type ImageRefEntry = typeof ImageRefEntry.Type;

class ImageRefIndexKey extends Schema.TaggedRequest<ImageRefIndexKey>()(
  "ImageRefIndexKey",
  {
    success: ImageRefEntry,
    failure: ImageCacheError,
    payload: { path: Schema.String }
  }
) implements Persistence.Persistable<typeof ImageRefEntry, typeof ImageCacheError> {
  [PrimaryKey.symbol]() {
    return `image-ref:${keyHash(this.path)}`;
  }
}

const toIndexError = (path: string, operation: string) => (cause: unknown) => {
  if (isImageCacheError(cause)) {
    return cause;
  }
  return ImageCacheError.make({
    message: messageFromCause("Image ref index failed", cause),
    key: path,
    operation
  });
};

export class ImageRefIndex extends Context.Tag("@skygent/ImageRefIndex")<
  ImageRefIndex,
  {
    readonly get: (path: string) => Effect.Effect<Option.Option<ImageRefEntry>, ImageCacheError>;
    readonly ensure: (path: string) => Effect.Effect<ImageRefEntry, ImageCacheError>;
    readonly increment: (path: string) => Effect.Effect<ImageRefEntry, ImageCacheError>;
    readonly decrement: (path: string) => Effect.Effect<number, ImageCacheError>;
    readonly remove: (path: string) => Effect.Effect<void, ImageCacheError>;
  }
>() {
  static readonly layer = Layer.scoped(
    ImageRefIndex,
    Effect.gen(function* () {
      const persistence = yield* Persistence.ResultPersistence;
      const store = yield* persistence.make({ storeId: "image-ref-index" });

      const toTimestamp = (value: Date) =>
        Schema.decodeUnknownSync(Timestamp)(value);

      const getEntry = (path: string) =>
        store
          .get(new ImageRefIndexKey({ path }))
          .pipe(
            Effect.mapError(toIndexError(path, "imageRefIndexGet")),
            Effect.map((cached) =>
              Option.match(cached, {
                onNone: () => Option.none<ImageRefEntry>(),
                onSome: (exit) =>
                  Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none()
              })
            )
          );

      const setEntry = (entry: ImageRefEntry) =>
        store
          .set(new ImageRefIndexKey({ path: entry.path }), Exit.succeed(entry))
          .pipe(Effect.mapError(toIndexError(entry.path, "imageRefIndexSet")));

      const remove = Effect.fn("ImageRefIndex.remove")((path: string) =>
        store
          .remove(new ImageRefIndexKey({ path }))
          .pipe(Effect.mapError(toIndexError(path, "imageRefIndexRemove")))
      );

      const increment = Effect.fn("ImageRefIndex.increment")((path: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const current = yield* getEntry(path);
          const nextCount = Option.match(current, {
            onNone: () => 1,
            onSome: (entry) => entry.count + 1
          });
          const next = {
            path,
            count: nextCount,
            lastAccessed: toTimestamp(new Date(now))
          } satisfies ImageRefEntry;
          yield* setEntry(next);
          return next;
        })
      );

      const ensure = Effect.fn("ImageRefIndex.ensure")((path: string) =>
        Effect.gen(function* () {
          const current = yield* getEntry(path);
          if (Option.isSome(current)) {
            return current.value;
          }
          return yield* increment(path);
        })
      );

      const decrement = Effect.fn("ImageRefIndex.decrement")((path: string) =>
        Effect.gen(function* () {
          const current = yield* getEntry(path);
          if (Option.isNone(current)) {
            return 0;
          }
          const nextCount = current.value.count - 1;
          if (nextCount <= 0) {
            yield* remove(path);
            return 0;
          }
          const now = yield* Clock.currentTimeMillis;
          const next = {
            path,
            count: nextCount,
            lastAccessed: toTimestamp(new Date(now))
          } satisfies ImageRefEntry;
          yield* setEntry(next);
          return nextCount;
        })
      );

      return ImageRefIndex.of({ get: getEntry, ensure, increment, decrement, remove });
    })
  );
}
