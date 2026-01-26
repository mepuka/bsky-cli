import { Effect, Schema } from "effect";
import { Timestamp } from "../domain/primitives.js";
import { CliInputError } from "./errors.js";

const parseTimestamp = (value: string) =>
  Schema.decodeUnknown(Timestamp)(value).pipe(
    Effect.mapError((cause) =>
      CliInputError.make({
        message: `Invalid timestamp: ${value}`,
        cause
      })
    )
  );

export const parseRange = (raw: string) =>
  Effect.gen(function* () {
    const [startRaw = "", endRaw = ""] = raw.split("..");
    if (startRaw.length === 0 || endRaw.length === 0) {
      return yield* CliInputError.make({
        message: "Range must be in the form <start>..<end>",
        cause: raw
      });
    }

    const start = yield* parseTimestamp(startRaw.trim());
    const end = yield* parseTimestamp(endRaw.trim());

    if (start.getTime() > end.getTime()) {
      return yield* CliInputError.make({
        message: "Range start must be before end",
        cause: raw
      });
    }

    return { start, end };
  });
