import { Schema } from "effect";
import { FilterExprSchema } from "./filter.js";
import { StoreName, StorePath, Timestamp } from "./primitives.js";

/**
 * A reference to a Skygent store, uniquely identified by its name and root directory.
 *
 * Stores are the primary data containers in Skygent, holding filtered Bluesky posts.
 * Each store maintains its own SQLite database and event log.
 *
 * @example
 * ```ts
 * const storeRef = new StoreRef({
 *   name: "tech-posts",
 *   root: "/path/to/.skygent"
 * });
 * ```
 */
export class StoreRef extends Schema.Class<StoreRef>("StoreRef")({
  /** The unique name of the store (2-64 characters, lowercase alphanumeric with hyphens and underscores) */
  name: StoreName,
  /** The absolute path to the store's root directory where database and files are stored */
  root: StorePath
}) {}

/**
 * Metadata about a store, tracking its creation and last update times.
 *
 * This is stored in the store's metadata file and used for tracking store state.
 */
export class StoreMetadata extends Schema.Class<StoreMetadata>("StoreMetadata")({
  /** The unique name of the store */
  name: StoreName,
  /** The absolute path to the store's root directory */
  root: StorePath,
  /** ISO timestamp when the store was first created */
  createdAt: Timestamp,
  /** ISO timestamp when the store was last modified */
  updatedAt: Timestamp
}) {}

/**
 * Configuration for filter output format and destination.
 *
 * Defines how filtered posts should be exported from a store, including
 * the output path and which formats (JSON, Markdown) to generate.
 */
export class FilterOutput extends Schema.Class<FilterOutput>("FilterOutput")({
  /** The file system path where filtered output should be written */
  path: Schema.String,
  /** Whether to output posts as JSON */
  json: Schema.Boolean,
  /** Whether to output posts as Markdown */
  markdown: Schema.Boolean
}) {}

/**
 * A filter specification that defines which posts to include in a store.
 *
 * Each filter has a unique name within the store and an expression that
 * determines which posts match. Filtered output can be exported to files.
 */
export class FilterSpec extends Schema.Class<FilterSpec>("FilterSpec")({
  /** The unique name for this filter within the store */
  name: Schema.String,
  /** The filter expression that determines which posts to include */
  expr: FilterExprSchema,
  /** Configuration for how to output filtered posts */
  output: FilterOutput
}) {}

/**
 * Policy for handling duplicate posts during sync operations.
 *
 * - `dedupe`: Skip posts that already exist in the store (default)
 * - `refresh`: Overwrite existing posts with fresh data from the API
 */
export const SyncUpsertPolicy = Schema.Literal("dedupe", "refresh");
export type SyncUpsertPolicy = typeof SyncUpsertPolicy.Type;

/**
 * Complete configuration for a store.
 *
 * Defines the store's behavior including default output formats, automatic
 * sync settings, and the set of filters that populate the store.
 */
export class StoreConfig extends Schema.Class<StoreConfig>("StoreConfig")({
  /** Default output format settings for the store */
  format: Schema.Struct({
    /** Whether to enable JSON output by default */
    json: Schema.Boolean,
    /** Whether to enable Markdown output by default */
    markdown: Schema.Boolean
  }),
  /** Whether to automatically sync when running watch mode */
  autoSync: Schema.Boolean,
  /** Optional ISO 8601 duration string for automatic sync intervals (e.g., "PT5M") */
  syncInterval: Schema.optional(Schema.String),
  /** Policy for handling duplicate posts during sync (defaults to "dedupe") */
  syncPolicy: Schema.optional(SyncUpsertPolicy),
  /** Array of filter specifications that determine which posts to store */
  filters: Schema.Array(FilterSpec)
}) {}
