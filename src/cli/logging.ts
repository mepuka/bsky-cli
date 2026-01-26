import { Console, Effect } from "effect";
import { SyncProgress } from "../domain/sync.js";
import { SyncReporter } from "../services/sync-reporter.js";

type LogLevel = "INFO" | "ERROR" | "PROGRESS";

const nowIso = () => new Date().toISOString();

const logEvent = (level: LogLevel, payload: Record<string, unknown>) =>
  Console.error(
    JSON.stringify({
      timestamp: nowIso(),
      level,
      ...payload
    })
  );

export const logInfo = (message: string, data?: Record<string, unknown>) =>
  logEvent("INFO", { message, ...data });

export const logErrorEvent = (message: string, data?: Record<string, unknown>) =>
  logEvent("ERROR", { message, ...data });

export const logProgress = (progress: SyncProgress) =>
  logEvent("PROGRESS", { operation: "sync", progress });

export const makeSyncReporter = (quiet: boolean) =>
  SyncReporter.of({
    report: quiet ? () => Effect.void : logProgress
  });
