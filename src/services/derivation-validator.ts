import { Context, Effect, Layer, Option } from "effect";
import { ViewCheckpointStore } from "./view-checkpoint-store.js";
import { StoreEventLog } from "./store-event-log.js";
import { StoreManager } from "./store-manager.js";
import { StoreName } from "../domain/primitives.js";
import { StoreIoError } from "../domain/errors.js";

export class DerivationValidator extends Context.Tag(
  "@skygent/DerivationValidator"
)<
  DerivationValidator,
  {
    readonly isStale: (
      viewName: StoreName,
      sourceName: StoreName
    ) => Effect.Effect<boolean, StoreIoError>;
  }
>() {
  static readonly layer = Layer.effect(
    DerivationValidator,
    Effect.gen(function* () {
      const checkpoints = yield* ViewCheckpointStore;
      const eventLog = yield* StoreEventLog;
      const storeManager = yield* StoreManager;

      const isStale = Effect.fn("DerivationValidator.isStale")(
        (viewName: StoreName, sourceName: StoreName) =>
          Effect.gen(function* () {
            const checkpointOption = yield* checkpoints.load(viewName, sourceName);

            if (Option.isNone(checkpointOption)) {
              return true; // Never materialized
            }

            const checkpoint = checkpointOption.value;

            // O(1) optimization: use getLastEventId instead of streaming
            const sourceRefOption = yield* storeManager.getStore(sourceName);
            if (Option.isNone(sourceRefOption)) {
              return false; // Source store deleted
            }

            const sourceRef = sourceRefOption.value;
            const lastSourceIdOption = yield* eventLog.getLastEventId(sourceRef);

            if (Option.isNone(lastSourceIdOption)) {
              return false; // Source has no events
            }

            const lastSourceId = lastSourceIdOption.value;

            // Convert checkpoint.lastSourceEventId from EventId | undefined to Option<EventId>
            const checkpointLastIdOption = Option.fromNullable(
              checkpoint.lastSourceEventId
            );

            if (Option.isNone(checkpointLastIdOption)) {
              return true; // Checkpoint never recorded a last event
            }

            // CRITICAL: use localeCompare for ULID EventId strings
            return lastSourceId.localeCompare(checkpointLastIdOption.value) > 0;
          })
      );

      return DerivationValidator.of({ isStale });
    })
  );
}
