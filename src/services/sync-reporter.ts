import { Effect } from "effect";
import type { SyncProgress } from "../domain/sync.js";

export class SyncReporter extends Effect.Service<SyncReporter>()("@skygent/SyncReporter", {
  succeed: {
    report: (_progress: SyncProgress) => Effect.void,
    warn: (_message: string, _data?: Record<string, unknown>) => Effect.void
  }
}) {
  static readonly layer = SyncReporter.Default;
}
