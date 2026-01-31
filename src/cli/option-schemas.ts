import { Schema } from "effect";

export const PositiveInt = Schema.Int.pipe(Schema.greaterThan(0));

export const NonNegativeInt = Schema.NonNegativeInt;

export const boundedInt = (min: number, max: number) =>
  Schema.Int.pipe(
    Schema.greaterThanOrEqualTo(min),
    Schema.lessThanOrEqualTo(max)
  );
