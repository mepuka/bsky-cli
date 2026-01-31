import { Duration, Effect, Option, ParseResult, Schema } from "effect";

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
    Option.match(Duration.decodeUnknown(raw), {
      onNone: () =>
        Effect.fail(new ParseResult.Type(ast, raw, "Invalid duration")),
      onSome: (duration) => Effect.succeed(duration)
    }),
  encode: (duration) =>
    Effect.succeed(`${Duration.toMillis(duration)} millis`)
}).pipe(Schema.greaterThanOrEqualToDuration(0));
