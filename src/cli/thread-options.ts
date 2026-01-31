import { Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { parseBoundedIntOption } from "./shared-options.js";

export const depthOption = (description: string) =>
  Options.integer("depth").pipe(
    Options.withDescription(description),
    Options.optional
  );

export const parentHeightOption = (description: string) =>
  Options.integer("parent-height").pipe(
    Options.withDescription(description),
    Options.optional
  );

export const parseThreadDepth = (
  depth: Option.Option<number>,
  parentHeight: Option.Option<number>
) =>
  Effect.gen(function* () {
    const parsedDepth = yield* parseBoundedIntOption(depth, "depth", 0, 1000);
    const parsedParentHeight = yield* parseBoundedIntOption(
      parentHeight,
      "parent-height",
      0,
      1000
    );
    return {
      depth: Option.getOrUndefined(parsedDepth),
      parentHeight: Option.getOrUndefined(parsedParentHeight)
    };
  });
