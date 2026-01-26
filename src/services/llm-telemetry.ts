import { Context, Duration, Effect, Layer, Metric, MetricBoundaries, MetricLabel } from "effect";
import type { LlmUsage } from "../domain/llm.js";

type PromptKind = "single" | "batch";
type CacheLevel = "persistent" | "memory";
type RequestStage = "single" | "batch";

export interface LlmTelemetryService {
  readonly recordCacheHit: (params: {
    readonly level: CacheLevel;
    readonly kind: PromptKind;
    readonly count?: number;
  }) => Effect.Effect<void>;
  readonly recordCacheMiss: (params: {
    readonly level: CacheLevel;
    readonly kind: PromptKind;
    readonly count?: number;
  }) => Effect.Effect<void>;
  readonly recordDecision: (params: {
    readonly kind: PromptKind;
    readonly cached: boolean;
    readonly count?: number;
    readonly modelId?: string;
  }) => Effect.Effect<void>;
  readonly recordRequest: (params: {
    readonly kind: PromptKind;
    readonly duration: Duration.Duration;
    readonly usage?: LlmUsage;
    readonly modelId?: string;
    readonly batchSize?: number;
  }) => Effect.Effect<void>;
  readonly recordFailure: (params: {
    readonly kind: PromptKind;
    readonly stage: RequestStage;
    readonly modelId?: string;
  }) => Effect.Effect<void>;
}

const labels = (pairs: ReadonlyArray<readonly [string, string | undefined]>) =>
  pairs.flatMap(([key, value]) =>
    value ? [MetricLabel.make(key, value)] : []
  );

const updateMetric = <Type, In, Out>(
  metric: Metric.Metric<Type, In, Out>,
  value: In,
  pairs: ReadonlyArray<readonly [string, string | undefined]>
) => Metric.update(Metric.taggedWithLabels(metric, labels(pairs)), value);

const requestCounter = Metric.counter("skygent_llm_requests_total", {
  description: "Total LLM request count"
});
const decisionCounter = Metric.counter("skygent_llm_decisions_total", {
  description: "Total LLM decisions produced"
});
const cacheHitCounter = Metric.counter("skygent_llm_cache_hits_total", {
  description: "LLM cache hits"
});
const cacheMissCounter = Metric.counter("skygent_llm_cache_misses_total", {
  description: "LLM cache misses"
});
const failureCounter = Metric.counter("skygent_llm_failures_total", {
  description: "LLM request failures"
});
const batchSizeHistogram = Metric.histogram(
  "skygent_llm_batch_size",
  MetricBoundaries.linear({ start: 1, width: 1, count: 32 }),
  "Batch size distribution"
);
const latencyHistogram = Metric.histogram(
  "skygent_llm_latency_ms",
  MetricBoundaries.exponential({ start: 5, factor: 2, count: 12 }),
  "LLM request latency (ms)"
);
const tokenCounter = Metric.counter("skygent_llm_tokens_total", {
  description: "LLM token usage"
});

export class LlmTelemetry extends Context.Tag("@skygent/LlmTelemetry")<
  LlmTelemetry,
  LlmTelemetryService
>() {
  static readonly layer = Layer.succeed(
    LlmTelemetry,
    LlmTelemetry.of({
      recordCacheHit: ({ level, kind, count = 1 }) =>
        updateMetric(cacheHitCounter, count, [
          ["level", level],
          ["kind", kind]
        ]),
      recordCacheMiss: ({ level, kind, count = 1 }) =>
        updateMetric(cacheMissCounter, count, [
          ["level", level],
          ["kind", kind]
        ]),
      recordDecision: ({ kind, cached, count = 1, modelId }) =>
        updateMetric(decisionCounter, count, [
          ["kind", kind],
          ["cached", cached ? "true" : "false"],
          ["model", modelId]
        ]),
      recordRequest: ({ kind, duration, usage, modelId, batchSize }) =>
        Effect.gen(function* () {
          const latencyMs = Duration.toMillis(duration);
          yield* updateMetric(requestCounter, 1, [
            ["kind", kind],
            ["model", modelId]
          ]);
          yield* updateMetric(latencyHistogram, latencyMs, [
            ["kind", kind],
            ["model", modelId]
          ]);
          if (batchSize && batchSize > 0) {
            yield* updateMetric(batchSizeHistogram, batchSize, [
              ["kind", kind],
              ["model", modelId]
            ]);
          }
          if (usage) {
            const tokens: ReadonlyArray<readonly [string, number | undefined]> = [
              ["input", usage.inputTokens],
              ["output", usage.outputTokens],
              ["total", usage.totalTokens],
              ["reasoning", usage.reasoningTokens],
              ["cachedInput", usage.cachedInputTokens]
            ];
            for (const [kindLabel, value] of tokens) {
              if (typeof value === "number" && value > 0) {
                yield* updateMetric(tokenCounter, value, [
                  ["kind", kindLabel],
                  ["model", modelId]
                ]);
              }
            }
          }
        }),
      recordFailure: ({ kind, stage, modelId }) =>
        updateMetric(failureCounter, 1, [
          ["kind", kind],
          ["stage", stage],
          ["model", modelId]
        ])
    })
  );

  static readonly testLayer = Layer.succeed(
    LlmTelemetry,
    LlmTelemetry.of({
      recordCacheHit: () => Effect.void,
      recordCacheMiss: () => Effect.void,
      recordDecision: () => Effect.void,
      recordRequest: () => Effect.void,
      recordFailure: () => Effect.void
    })
  );
}
