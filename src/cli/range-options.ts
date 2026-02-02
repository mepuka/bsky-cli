import { Clock, Effect, Option, Schema } from "effect";
import { Timestamp } from "../domain/primitives.js";
import { CliInputError } from "./errors.js";
import { parseRange } from "./range.js";
import { parseTimeInput } from "./time.js";

type RangeDefaults = {
  readonly since?: string;
  readonly until?: string;
};

export const parseRangeOptions = (
  range: Option.Option<string>,
  since: Option.Option<string>,
  until: Option.Option<string>,
  defaults?: RangeDefaults
) =>
  Effect.gen(function* () {
    const toTimestamp = (date: Date, label: string) =>
      Schema.decodeUnknown(Timestamp)(date).pipe(
        Effect.mapError((cause) =>
          CliInputError.make({
            message: `Computed ${label} timestamp is invalid.`,
            cause
          })
        )
      );
    const hasRange = Option.isSome(range);
    const hasSince = Option.isSome(since);
    const hasUntil = Option.isSome(until);

    if (hasRange && (hasSince || hasUntil)) {
      return yield* CliInputError.make({
        message: "Use either --range or --since/--until, not both.",
        cause: { range: range.value, since: Option.getOrUndefined(since), until: Option.getOrUndefined(until) }
      });
    }

    if (hasRange) {
      const parsed = yield* parseRange(range.value);
      return Option.some(parsed);
    }

    const defaultSince = defaults?.since;
    const defaultUntil = defaults?.until;
    const resolvedSince =
      hasSince ? Option.some(since.value) : defaultSince ? Option.some(defaultSince) : Option.none();
    const resolvedUntil =
      hasUntil ? Option.some(until.value) : defaultUntil ? Option.some(defaultUntil) : Option.none();

    if (Option.isNone(resolvedSince) && Option.isNone(resolvedUntil)) {
      return Option.none();
    }

    const nowMillis = yield* Clock.currentTimeMillis;
    const now = new Date(nowMillis);

    const start = Option.isSome(resolvedSince)
      ? yield* parseTimeInput(resolvedSince.value, now, { label: "--since" })
      : new Date(0);
    const end = Option.isSome(resolvedUntil)
      ? yield* parseTimeInput(resolvedUntil.value, now, { label: "--until" })
      : now;

    if (start.getTime() > end.getTime()) {
      return yield* CliInputError.make({
        message: `Invalid time range: start ${start.toISOString()} must be before end ${end.toISOString()}.`,
        cause: { start, end }
      });
    }

    const startTimestamp = yield* toTimestamp(start, "start");
    const endTimestamp = yield* toTimestamp(end, "end");
    return Option.some({ start: startTimestamp, end: endTimestamp });
  });
