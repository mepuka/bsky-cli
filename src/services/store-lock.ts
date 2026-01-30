import { FileSystem, Path } from "@effect/platform";
import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect";
import { StoreLockError } from "../domain/errors.js";
import type { StoreRef } from "../domain/store.js";
import { StorePath } from "../domain/primitives.js";
import { AppConfigService } from "./app-config.js";

const activeLockPaths = new Set<string>();

const cleanupActiveLocks = (fs: FileSystem.FileSystem) =>
  Effect.forEach(
    Array.from(activeLockPaths),
    (lockPath) =>
      fs.remove(lockPath, { recursive: true }).pipe(
        Effect.catchTag("SystemError", (error) =>
          error.reason === "NotFound" ? Effect.void : Effect.fail(error)
        ),
        Effect.catchAll(() => Effect.void)
      ),
    { discard: true }
  );

type StoreLockService = {
  readonly withStoreLock: <A, E, R>(
    store: StoreRef,
    effect: Effect.Effect<A, E, R>,
    options?: { readonly waitFor?: Duration.DurationInput }
  ) => Effect.Effect<A, E | StoreLockError, R>;
};

const isSystemError = (cause: unknown): cause is { _tag: "SystemError"; reason: string } =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  (cause as { _tag?: unknown })._tag === "SystemError" &&
  "reason" in cause;

export class StoreLock extends Context.Tag("@skygent/StoreLock")<
  StoreLock,
  StoreLockService
>() {
  static readonly layer = Layer.scoped(
    StoreLock,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* AppConfigService;

      yield* Effect.addFinalizer(() => cleanupActiveLocks(fs));

      const lockRoot = path.join(config.storeRoot, "locks");

      const lockPathFor = (store: StoreRef) =>
        path.join(lockRoot, `store-${store.name}`);

      const toStoreLockError = (store: StoreRef, lockPath: string) => (cause: unknown) => {
        const message = isSystemError(cause) && cause.reason === "AlreadyExists"
          ? `Store \"${store.name}\" is busy.`
          : `Failed to acquire store lock for \"${store.name}\".`;
        return StoreLockError.make({
          store: store.name,
          path: Schema.decodeUnknownSync(StorePath)(lockPath),
          message,
          cause
        });
      };

      const releaseLock = (store: StoreRef, lockPath: string) =>
        fs.remove(lockPath, { recursive: true }).pipe(
          Effect.catchTag("SystemError", (error) =>
            error.reason === "NotFound" ? Effect.void : Effect.fail(error)
          ),
          Effect.catchAll((cause) =>
            Effect.logWarning("Failed to release store lock", {
              store: store.name,
              lockPath,
              cause
            }).pipe(Effect.asVoid)
          )
        );

      const acquireLock = (store: StoreRef) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const lockPath = lockPathFor(store);
            yield* fs.makeDirectory(lockRoot, { recursive: true }).pipe(
              Effect.mapError(toStoreLockError(store, lockPath))
            );
            yield* fs.makeDirectory(lockPath, { recursive: false }).pipe(
              Effect.mapError(toStoreLockError(store, lockPath))
            );
            activeLockPaths.add(lockPath);
            return lockPath;
          }),
          (lockPath) =>
            releaseLock(store, lockPath).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  activeLockPaths.delete(lockPath);
                })
              )
            )
        );

      const isStoreLockError = (error: unknown): error is StoreLockError =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        (error as { _tag?: unknown })._tag === "StoreLockError";

      const isBusyLockError = (error: unknown) =>
        isStoreLockError(error) &&
        typeof (error as { message?: unknown }).message === "string" &&
        (error as { message: string }).message.includes("busy");

      const withStoreLock = Effect.fn("StoreLock.withStoreLock")(
        <A, E, R>(
          store: StoreRef,
          effect: Effect.Effect<A, E, R>,
          options?: { readonly waitFor?: Duration.DurationInput }
        ) => {
          const attempt = Effect.scoped(acquireLock(store).pipe(Effect.zipRight(effect)));
          const waitFor = options?.waitFor;
          if (!waitFor) {
            return attempt;
          }
          const schedule = Schedule.spaced("250 millis").pipe(
            Schedule.intersect(Schedule.recurUpTo(waitFor))
          );
          return attempt.pipe(
            Effect.retry({
              while: (error: StoreLockError | E) => isBusyLockError(error),
              schedule
            })
          );
        }
      );

      return StoreLock.of({ withStoreLock });
    })
  );
}
