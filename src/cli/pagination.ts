import { Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { parseLimit } from "./shared-options.js";

export const limitOption = Options.integer("limit").pipe(Options.optional);
export const cursorOption = Options.text("cursor").pipe(Options.optional);

export const parsePagination = (
  limit: Option.Option<number>,
  cursor: Option.Option<string>
) =>
  Effect.gen(function* () {
    const parsedLimit = yield* parseLimit(limit);
    return {
      limit: Option.getOrUndefined(parsedLimit),
      cursor: Option.getOrUndefined(cursor)
    };
  });
