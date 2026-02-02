import { Duration, Effect, Schema } from "effect";
import { Timestamp } from "../domain/primitives.js";
import { CliInputError } from "./errors.js";

export type TimeParseError = (message: string, cause?: unknown) => CliInputError;

type TimeParseOptions = {
  readonly label?: string;
  readonly onError?: TimeParseError;
};

const defaultError: TimeParseError = (message, cause) =>
  CliInputError.make({ message, cause });

const compactDurationPattern = /^(-?\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/i;
const compactDurationUnits: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000
};

const parseCompactDurationMillis = (raw: string): number | undefined => {
  const match = raw.match(compactDurationPattern);
  if (!match) {
    return undefined;
  }
  const value = Number.parseFloat(match[1] ?? "");
  const unit = (match[2] ?? "").toLowerCase();
  const multiplier = compactDurationUnits[unit];
  if (!Number.isFinite(value) || multiplier === undefined) {
    return Number.NaN;
  }
  return value * multiplier;
};

const toUtcStartOfDay = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const parseDateOnly = (raw: string): Date | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) {
    return undefined;
  }
  const year = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const day = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return undefined;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date;
};

const looksLikeDate = (raw: string) => /^\d{4}-\d{2}-\d{2}/.test(raw);

const hasExplicitTimezone = (raw: string) => /([zZ]|[+-]\d{2}:\d{2})$/.test(raw);

const makeErrorFactory = (options?: TimeParseOptions): TimeParseError => {
  const base = options?.onError ?? defaultError;
  const label = options?.label;
  if (!label) {
    return base;
  }
  return (message, cause) => base(`${label}: ${message}`, cause);
};

export const parseDurationInput = (
  raw: string,
  options?: TimeParseOptions
): Effect.Effect<Duration.Duration, CliInputError> =>
  Effect.suspend(() => {
    const onError = makeErrorFactory(options);
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return Effect.fail(onError("Duration cannot be empty."));
    }

    const compactMillis = parseCompactDurationMillis(trimmed);
    if (compactMillis !== undefined) {
      if (!Number.isFinite(compactMillis)) {
        return Effect.fail(onError("Duration must be a finite number."));
      }
      if (compactMillis < 0) {
        return Effect.fail(onError("Duration must be non-negative."));
      }
      return Effect.succeed(Duration.millis(compactMillis));
    }

    return Effect.try({
      try: () => Duration.decode(trimmed as Duration.DurationInput),
      catch: (cause) =>
        onError(
          `Invalid duration "${raw}". Use formats like "30 seconds", "500 millis", or "1.5h".`,
          cause
        )
    }).pipe(
      Effect.flatMap((duration) => {
        if (!Duration.isFinite(duration)) {
          return Effect.fail(onError("Duration must be finite."));
        }
        if (Duration.toMillis(duration) < 0) {
          return Effect.fail(onError("Duration must be non-negative."));
        }
        return Effect.succeed(duration);
      })
    );
  });

export const parseTimeInput = (
  raw: string,
  now: Date,
  options?: TimeParseOptions
): Effect.Effect<Date, CliInputError> =>
  Effect.suspend(() => {
    const onError = makeErrorFactory(options);
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return Effect.fail(onError("Time value cannot be empty."));
    }

    const lower = trimmed.toLowerCase();
    if (lower === "now") {
      return Effect.succeed(new Date(now.getTime()));
    }
    if (lower === "today") {
      return Effect.succeed(toUtcStartOfDay(now));
    }
    if (lower === "yesterday") {
      return Effect.succeed(new Date(toUtcStartOfDay(now).getTime() - 86_400_000));
    }

    const dateOnly = parseDateOnly(trimmed);
    if (dateOnly) {
      return Effect.succeed(dateOnly);
    }

    if (looksLikeDate(trimmed)) {
      if (/[Tt]/.test(trimmed) && !hasExplicitTimezone(trimmed)) {
        return Effect.fail(
          onError(
            "Timestamp must include a timezone (e.g. 2026-01-01T00:00:00Z)."
          )
        );
      }
      return Schema.decodeUnknown(Timestamp)(trimmed).pipe(
        Effect.mapError((cause) =>
          onError(
            `Invalid timestamp "${raw}". Expected ISO 8601 with timezone (e.g. 2026-01-01T00:00:00Z).`,
            cause
          )
        )
      );
    }

    return parseDurationInput(trimmed, options).pipe(
      Effect.map((duration) => {
        const millis = Duration.toMillis(duration);
        return new Date(now.getTime() - millis);
      })
    );
  });

export const normalizeDateOnlyInput = (raw: string): string => {
  const trimmed = raw.trim();
  const dateOnly = parseDateOnly(trimmed);
  return dateOnly ? dateOnly.toISOString() : trimmed;
};
