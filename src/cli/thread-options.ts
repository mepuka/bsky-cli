import { Options } from "@effect/cli";
import { Option } from "effect";
import { boundedInt } from "./option-schemas.js";

export const depthOption = (description: string) =>
  Options.integer("depth").pipe(
    Options.withSchema(boundedInt(0, 1000)),
    Options.withDescription(description),
    Options.optional
  );

export const parentHeightOption = (description: string) =>
  Options.integer("parent-height").pipe(
    Options.withSchema(boundedInt(0, 1000)),
    Options.withDescription(description),
    Options.optional
  );

export const parseThreadDepth = (
  depth: Option.Option<number>,
  parentHeight: Option.Option<number>
) => ({
  depth: Option.getOrUndefined(depth),
  parentHeight: Option.getOrUndefined(parentHeight)
});
