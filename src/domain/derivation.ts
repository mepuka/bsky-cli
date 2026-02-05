import { Schema } from "effect";
import { StoreName, Timestamp, EventSeq } from "./primitives.js";
import { FilterExprSchema } from "./filter.js";

export const FilterEvaluationMode = Schema.Literal("EventTime", "DeriveTime");
export type FilterEvaluationMode = typeof FilterEvaluationMode.Type;

export class StoreSource extends Schema.Class<StoreSource>("StoreSource")({
  storeName: StoreName,
  filter: FilterExprSchema,
  filterHash: Schema.String,
  evaluationMode: FilterEvaluationMode,
  derivedAt: Timestamp
}) {}

export class DerivationResult extends Schema.Class<DerivationResult>(
  "DerivationResult"
)({
  eventsProcessed: Schema.NonNegativeInt,
  eventsMatched: Schema.NonNegativeInt,
  eventsSkipped: Schema.NonNegativeInt,
  deletesPropagated: Schema.NonNegativeInt,
  durationMs: Schema.Number
}) {}

export class DerivationCheckpoint extends Schema.Class<DerivationCheckpoint>(
  "DerivationCheckpoint"
)({
  viewName: StoreName,
  sourceStore: StoreName,
  targetStore: StoreName,
  filterHash: Schema.String,
  evaluationMode: FilterEvaluationMode,
  lastSourceEventSeq: Schema.optional(EventSeq),
  eventsProcessed: Schema.NonNegativeInt,
  eventsMatched: Schema.NonNegativeInt,
  deletesPropagated: Schema.NonNegativeInt,
  updatedAt: Timestamp
}) {}

export class StoreLineage extends Schema.Class<StoreLineage>("StoreLineage")({
  storeName: StoreName,
  isDerived: Schema.Boolean,
  sources: Schema.Array(StoreSource),
  updatedAt: Timestamp
}) {}

export class DerivationError extends Schema.TaggedError<DerivationError>()(
  "DerivationError",
  {
    message: Schema.String,
    sourceStore: Schema.optional(StoreName),
    targetStore: Schema.optional(StoreName)
  }
) {}
