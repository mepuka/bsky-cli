import { Terminal } from "@effect/platform";
import { Effect, Match, Option } from "effect";
import { SyncProgress } from "../domain/sync.js";
import { SyncReporter } from "../services/sync-reporter.js";
import type { ResourceMonitorService, ResourceWarning } from "../services/resource-monitor.js";
import type { CliOutputService } from "./output.js";
import { CliOutput } from "./output.js";
import { CliPreferences } from "./preferences.js";

type LogLevel = "INFO" | "WARN" | "ERROR" | "PROGRESS";
export type LogFormat = "json" | "human";

const nowIso = () => new Date().toISOString();

const encodeLog = (level: LogLevel, payload: Record<string, unknown>) =>
  JSON.stringify({
    timestamp: nowIso(),
    level,
    ...payload
  });

const formatHuman = (level: LogLevel, payload: Record<string, unknown>) => {
  if (level === "PROGRESS" && "progress" in payload) {
    const progress = payload.progress as SyncProgress;
    const rate = Number.isFinite(progress.rate)
      ? progress.rate.toFixed(2)
      : String(progress.rate);
    return `[PROGRESS] processed=${progress.processed} stored=${progress.stored} skipped=${progress.skipped} errors=${progress.errors} rate=${rate}/s elapsedMs=${progress.elapsedMs}`;
  }

  const message =
    typeof payload.message === "string" && payload.message.length > 0
      ? payload.message
      : "";
  const rest = { ...payload };
  delete rest.message;
  const suffix = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
  const base = `[${level}]${message ? ` ${message}` : ""}`;
  return `${base}${suffix}`.trim();
};

const encodeLogFormat = (
  format: LogFormat,
  level: LogLevel,
  payload: Record<string, unknown>
) => (format === "human" ? formatHuman(level, payload) : encodeLog(level, payload));

const resolveLogFormat = Effect.gen(function* () {
  const preferences = yield* Effect.serviceOption(CliPreferences);
  const override = Option.flatMap(preferences, (value) =>
    Option.fromNullable(value.logFormat)
  );
  if (Option.isSome(override)) {
    return override.value;
  }
  const terminal = yield* Effect.serviceOption(Terminal.Terminal);
  if (Option.isSome(terminal)) {
    const isTTY = yield* terminal.value.isTTY.pipe(Effect.orElseSucceed(() => false));
    return isTTY ? "human" : "json";
  }
  return "json" as const;
});

const logEventWith = (
  output: CliOutputService,
  format: LogFormat,
  level: LogLevel,
  payload: Record<string, unknown>
) => output.writeStderr(encodeLogFormat(format, level, payload));

const logEvent = (level: LogLevel, payload: Record<string, unknown>) =>
  Effect.gen(function* () {
    const output = yield* CliOutput;
    const format = yield* resolveLogFormat;
    yield* logEventWith(output, format, level, payload);
  });

export const logInfo = (message: string, data?: Record<string, unknown>) =>
  logEvent("INFO", { message, ...data });

export const logErrorEvent = (message: string, data?: Record<string, unknown>) =>
  logEvent("ERROR", { message, ...data });

export const logWarn = (message: string, data?: Record<string, unknown>) =>
  logEvent("WARN", { message, ...data });

export const logProgress = (progress: SyncProgress) =>
  logEvent("PROGRESS", { operation: "sync", progress });

const warningDetails = (warning: ResourceWarning): Record<string, unknown> => {
  return Match.type<ResourceWarning>().pipe(
    Match.tagsExhaustive({
      StoreSize: (store) => ({
        kind: "StoreSize",
        bytes: store.bytes,
        threshold: store.threshold,
        root: store.root
      }),
      MemoryRss: (memory) => ({
        kind: "MemoryRss",
        bytes: memory.bytes,
        threshold: memory.threshold
      })
    })
  )(warning);
};

export const makeSyncReporter = (
  quiet: boolean,
  monitor: ResourceMonitorService,
  output: CliOutputService
) =>
  SyncReporter.of({
    report: (progress) =>
      Effect.gen(function* () {
        const format = yield* resolveLogFormat;
        if (!quiet) {
          yield* logEventWith(output, format, "PROGRESS", {
            operation: "sync",
            progress
          });
        }
        const warnings = yield* monitor.check();
        if (warnings.length > 0) {
          yield* Effect.forEach(
            warnings,
            (warning) =>
              logEventWith(output, format, "WARN", {
                message: "Resource warning",
                ...warningDetails(warning)
              }),
            { discard: true }
          );
        }
      }).pipe(Effect.orElseSucceed(() => undefined)),
    warn: (message, data) =>
      Effect.gen(function* () {
        const format = yield* resolveLogFormat;
        yield* logEventWith(output, format, "WARN", {
          message,
          ...data
        });
      }).pipe(Effect.orElseSucceed(() => undefined))
  });
