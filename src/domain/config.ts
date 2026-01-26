import { Schema } from "effect";

export const OutputFormat = Schema.Literal("json", "ndjson", "markdown", "table");
export type OutputFormat = typeof OutputFormat.Type;

export class AppConfig extends Schema.Class<AppConfig>("AppConfig")({
  service: Schema.String,
  storeRoot: Schema.String,
  outputFormat: OutputFormat,
  identifier: Schema.optional(Schema.String)
}) {}
