import { Options } from "@effect/cli";
import { Option } from "effect";
import { PositiveInt } from "./option-schemas.js";

export const limitOption = Options.integer("limit").pipe(
  Options.withSchema(PositiveInt),
  Options.optional
);
export const cursorOption = Options.text("cursor").pipe(Options.optional);

export const parsePagination = (
  limit: Option.Option<number>,
  cursor: Option.Option<string>
) => ({
  limit: Option.getOrUndefined(limit),
  cursor: Option.getOrUndefined(cursor)
});
