import { Effect } from "effect";
import { SyncProgress } from "../domain/sync.js";
import { SyncReporter } from "../services/sync-reporter.js";
import type { ResourceMonitorService, ResourceWarning } from "../services/resource-monitor.js";
import type { CliOutputService } from "./output.js";
import { CliOutput } from "./output.js";

type LogLevel = "INFO" | "WARN" | "ERROR" | "PROGRESS";

const nowIso = () => new Date().toISOString();

const encodeLog = (level: LogLevel, payload: Record<string, unknown>) =>
  JSON.stringify({
    timestamp: nowIso(),
    level,
    ...payload
  });

const logEventWith = (
  output: CliOutputService,
  level: LogLevel,
  payload: Record<string, unknown>
) => output.writeStderr(encodeLog(level, payload));

const logEvent = (level: LogLevel, payload: Record<string, unknown>) =>
  Effect.flatMap(CliOutput, (output) => logEventWith(output, level, payload));

export const logInfo = (message: string, data?: Record<string, unknown>) =>
  logEvent("INFO", { message, ...data });

export const logErrorEvent = (message: string, data?: Record<string, unknown>) =>
  logEvent("ERROR", { message, ...data });

export const logWarn = (message: string, data?: Record<string, unknown>) =>
  logEvent("WARN", { message, ...data });

export const logProgress = (progress: SyncProgress) =>
  logEvent("PROGRESS", { operation: "sync", progress });

const warningDetails = (warning: ResourceWarning): Record<string, unknown> => {
  switch (warning._tag) {
    case "StoreSize":
      return {
        kind: warning._tag,
        bytes: warning.bytes,
        threshold: warning.threshold,
        root: warning.root
      };
    case "MemoryRss":
      return {
        kind: warning._tag,
        bytes: warning.bytes,
        threshold: warning.threshold
      };
  }
};

export const makeSyncReporter = (
  quiet: boolean,
  monitor: ResourceMonitorService,
  output: CliOutputService
) =>
  SyncReporter.of({
    report: (progress) =>
      Effect.gen(function* () {
        if (!quiet) {
          yield* logEventWith(output, "PROGRESS", {
            operation: "sync",
            progress
          });
        }
        const warnings = yield* monitor.check();
        if (warnings.length > 0) {
          yield* Effect.forEach(
            warnings,
            (warning) =>
              logEventWith(output, "WARN", {
                message: "Resource warning",
                ...warningDetails(warning)
              }),
            { discard: true }
          );
        }
      }).pipe(Effect.orElseSucceed(() => undefined))
  });
