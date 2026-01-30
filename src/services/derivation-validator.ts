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

            // O(1) optimization: use getLastEventSeq instead of streaming
            const sourceRefOption = yield* storeManager.getStore(sourceName);
            if (Option.isNone(sourceRefOption)) {
              return false; // Source store deleted
            }

            const sourceRef = sourceRefOption.value;
            const lastSourceSeqOption = yield* eventLog.getLastEventSeq(sourceRef);

            if (Option.isNone(lastSourceSeqOption)) {
              return false; // Source has no events
            }

            const lastSourceSeq = lastSourceSeqOption.value;

            // Convert checkpoint.lastSourceEventSeq from EventSeq | undefined to Option<EventSeq>
            const checkpointLastSeqOption = Option.fromNullable(
              checkpoint.lastSourceEventSeq
            );

            if (Option.isNone(checkpointLastSeqOption)) {
              return true; // Checkpoint never recorded a last event
            }

            return lastSourceSeq > checkpointLastSeqOption.value;
          })
      );

      return DerivationValidator.of({ isStale });
    })
  );
}
