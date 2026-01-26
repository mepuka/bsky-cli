import { Schema } from "effect";

const ConfidenceScore = Schema.Number.pipe(Schema.finite(), Schema.between(0, 1));
const NonNegativeNumber = Schema.Number.pipe(
  Schema.finite(),
  Schema.nonNegative()
);

export class LlmUsage extends Schema.Class<LlmUsage>("LlmUsage")({
  inputTokens: Schema.optional(NonNegativeNumber),
  outputTokens: Schema.optional(NonNegativeNumber),
  totalTokens: Schema.optional(NonNegativeNumber),
  reasoningTokens: Schema.optional(NonNegativeNumber),
  cachedInputTokens: Schema.optional(NonNegativeNumber)
}) {}

export class LlmDecisionMeta extends Schema.Class<LlmDecisionMeta>("LlmDecisionMeta")({
  promptHash: Schema.String,
  textHash: Schema.String,
  score: ConfidenceScore,
  minConfidence: ConfidenceScore,
  keep: Schema.Boolean,
  cached: Schema.Boolean,
  planHash: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
  responseId: Schema.optional(Schema.String),
  usage: Schema.optional(LlmUsage)
}) {}
