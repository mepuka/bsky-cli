import { Effect, Schema } from "effect";
import { Timestamp } from "../domain/primitives.js";
import { CliInputError } from "./errors.js";

const rangeExample = "2026-01-01T00:00:00Z..2026-01-31T23:59:59Z";

const parseTimestamp = (value: string) =>
  Schema.decodeUnknown(Timestamp)(value).pipe(
    Effect.mapError((cause) =>
      CliInputError.make({
        message:
          `Invalid timestamp "${value}". Expected ISO 8601 with timezone ` +
          `(e.g. 2026-01-01T00:00:00Z).`,
        cause
      })
    )
  );

export const parseRange = (raw: string) =>
  Effect.gen(function* () {
    const [startRaw = "", endRaw = ""] = raw.split("..");
    if (startRaw.length === 0 || endRaw.length === 0) {
      return yield* CliInputError.make({
        message:
          "Invalid date range format.\n" +
          "Expected: <start>..<end> in ISO 8601 format.\n" +
          `Example: ${rangeExample}\n` +
          `Received: "${raw}"`,
        cause: raw
      });
    }

    const start = yield* parseTimestamp(startRaw.trim());
    const end = yield* parseTimestamp(endRaw.trim());

    if (start.getTime() > end.getTime()) {
      return yield* CliInputError.make({
        message: `Range start must be before end. start=${start.toISOString()} end=${end.toISOString()}`,
        cause: raw
      });
    }

    return { start, end };
  });
