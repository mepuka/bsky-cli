import { Option } from "effect";
import type { OutputFormat } from "../domain/config.js";

export const jsonNdjsonTableFormats = ["json", "ndjson", "table"] as const;
export type JsonNdjsonTableFormat = typeof jsonNdjsonTableFormats[number];

export const jsonTableFormats = ["json", "table"] as const;
export type JsonTableFormat = typeof jsonTableFormats[number];

export const textJsonFormats = ["text", "json"] as const;
export type TextJsonFormat = typeof textJsonFormats[number];

export const treeTableJsonFormats = ["tree", "table", "json"] as const;
export type TreeTableJsonFormat = typeof treeTableJsonFormats[number];

export const queryOutputFormats = [
  "json",
  "ndjson",
  "markdown",
  "table",
  "compact",
  "card",
  "thread"
] as const;
export type QueryOutputFormat = typeof queryOutputFormats[number];

const normalizeEnvFormat = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed.toLowerCase() : undefined;
};

export const resolveOutputFormat = <T extends string>(
  format: Option.Option<T>,
  configFormat: OutputFormat,
  supported: readonly T[],
  fallback: T
) => {
  if (Option.isSome(format)) {
    return format.value;
  }
  const envFormat = normalizeEnvFormat(process.env.SKYGENT_OUTPUT_FORMAT);
  if (envFormat && supported.includes(envFormat as T)) {
    return envFormat as T;
  }
  return supported.includes(configFormat as T) ? (configFormat as T) : fallback;
};
