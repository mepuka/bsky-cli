import { Schema } from "effect";
import { FilterExprSchema } from "./filter.js";
import { StoreName, StorePath, Timestamp } from "./primitives.js";

export class StoreRef extends Schema.Class<StoreRef>("StoreRef")({
  name: StoreName,
  root: StorePath
}) {}

export class StoreMetadata extends Schema.Class<StoreMetadata>("StoreMetadata")({
  name: StoreName,
  root: StorePath,
  createdAt: Timestamp,
  updatedAt: Timestamp
}) {}

export class FilterOutput extends Schema.Class<FilterOutput>("FilterOutput")({
  path: Schema.String,
  json: Schema.Boolean,
  markdown: Schema.Boolean
}) {}

export class FilterSpec extends Schema.Class<FilterSpec>("FilterSpec")({
  name: Schema.String,
  expr: FilterExprSchema,
  output: FilterOutput
}) {}

export class StoreConfig extends Schema.Class<StoreConfig>("StoreConfig")({
  format: Schema.Struct({
    json: Schema.Boolean,
    markdown: Schema.Boolean
  }),
  autoSync: Schema.Boolean,
  syncInterval: Schema.optional(Schema.String),
  filters: Schema.Array(FilterSpec)
}) {}
