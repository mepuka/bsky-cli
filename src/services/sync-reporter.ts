import { Context, Effect, Layer } from "effect";
import type { SyncProgress } from "../domain/sync.js";

export class SyncReporter extends Context.Tag("@skygent/SyncReporter")<
  SyncReporter,
  {
    readonly report: (progress: SyncProgress) => Effect.Effect<void>;
  }
>() {
  static readonly layer = Layer.succeed(
    SyncReporter,
    SyncReporter.of({
      report: () => Effect.void
    })
  );
}
