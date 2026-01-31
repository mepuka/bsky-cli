import { Effect, Option } from "effect";
import type { OutputFormat } from "../domain/config.js";
import { resolveOutputFormat } from "./output-format.js";

export const emitWithFormat = <T extends string, E, R>(
  format: Option.Option<T>,
  configFormat: OutputFormat,
  supported: readonly T[],
  fallback: T,
  handlers: { readonly [K in T]: Effect.Effect<unknown, E, R> }
): Effect.Effect<unknown, E, R> => {
  const resolved = resolveOutputFormat(format, configFormat, supported, fallback);
  return handlers[resolved];
};
