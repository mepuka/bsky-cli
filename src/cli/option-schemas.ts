import { Duration, Effect, ParseResult, Schema } from "effect";
import { parseDurationInput } from "./time.js";

export const PositiveInt = Schema.Int.pipe(Schema.greaterThan(0));

export const NonNegativeInt = Schema.NonNegativeInt;

export const boundedInt = (min: number, max: number) =>
  Schema.Int.pipe(
    Schema.greaterThanOrEqualTo(min),
    Schema.lessThanOrEqualTo(max)
  );

export const DurationInput = Schema.transformOrFail(Schema.String, Schema.DurationFromSelf, {
  strict: true,
  decode: (raw, _options, ast) =>
    parseDurationInput(raw).pipe(
      Effect.mapError((error) => new ParseResult.Type(ast, raw, error.message))
    ),
  encode: (duration) =>
    Effect.succeed(`${Duration.toMillis(duration)} millis`)
}).pipe(Schema.greaterThanOrEqualToDuration(0));
