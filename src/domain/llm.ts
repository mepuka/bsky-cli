import { Schema } from "effect";

export class LlmUsage extends Schema.Class<LlmUsage>("LlmUsage")({
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
  reasoningTokens: Schema.optional(Schema.Number),
  cachedInputTokens: Schema.optional(Schema.Number)
}) {}

export class LlmDecisionMeta extends Schema.Class<LlmDecisionMeta>("LlmDecisionMeta")({
  promptHash: Schema.String,
  textHash: Schema.String,
  score: Schema.Number,
  minConfidence: Schema.Number,
  keep: Schema.Boolean,
  cached: Schema.Boolean,
  planHash: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
  responseId: Schema.optional(Schema.String),
  usage: Schema.optional(LlmUsage)
}) {}
