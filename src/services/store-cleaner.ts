import { Effect, Option } from "effect";
import { StoreName } from "../domain/primitives.js";
import { StoreDb } from "./store-db.js";
import { StoreEventLog } from "./store-event-log.js";
import { StoreIndex } from "./store-index.js";
import { StoreManager } from "./store-manager.js";

export class StoreCleaner extends Effect.Service<StoreCleaner>()("@skygent/StoreCleaner", {
  effect: Effect.gen(function* () {
      const manager = yield* StoreManager;
      const index = yield* StoreIndex;
      const eventLog = yield* StoreEventLog;
      const storeDb = yield* StoreDb;

      const deleteStore = Effect.fn("StoreCleaner.deleteStore")((name: StoreName) =>
        Effect.gen(function* () {
          const storeOption = yield* manager.getStore(name);
          if (Option.isNone(storeOption)) {
            return { deleted: false, reason: "missing" } as const;
          }
          const store = storeOption.value;
          yield* eventLog.clear(store);
          yield* index.clear(store);
          yield* manager.deleteStore(name);
          yield* storeDb.removeClient(name);
          return { deleted: true } as const;
        })
      );

      return { deleteStore };
    })
}) {
  static readonly layer = StoreCleaner.Default;
}
