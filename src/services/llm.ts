import { IdGenerator, LanguageModel, Prompt, Response } from "@effect/ai";
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient";
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel";
import * as GoogleClient from "@effect/ai-google/GoogleClient";
import * as GoogleLanguageModel from "@effect/ai-google/GoogleLanguageModel";
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient";
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import {
  Clock,
  Config,
  Context,
  Duration,
  Effect,
  ExecutionPlan,
  Layer,
  Option,
  ParseResult,
  Request,
  RequestResolver,
  Schedule,
  Schema
} from "effect";
import type { NonEmptyArray } from "effect/Array";
import { ConfigError, FilterEvalError } from "../domain/errors.js";
import { LlmDecisionMeta, LlmUsage } from "../domain/llm.js";

const SINGLE_SYSTEM_PROMPT =
  "You are a precise classifier. Return a JSON object with a numeric score between 0 and 1.";
const BATCH_SYSTEM_PROMPT =
  "You are a precise classifier. Return a JSON object with a list of {id, score} results.";

const SingleDecisionSchema = Schema.Struct({
  score: Schema.Number
});

const BatchDecisionSchema = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      score: Schema.Number
    })
  )
});

const LlmProviderSchema = Schema.Literal("openai", "anthropic", "google");
type LlmProvider = typeof LlmProviderSchema.Type;
const LlmProviderListSchema = Schema.Array(LlmProviderSchema);

const formatSchemaError = (error: unknown) =>
  ParseResult.isParseError(error)
    ? ParseResult.TreeFormatter.formatErrorSync(error)
    : String(error);

const requireOption = <A>(option: Option.Option<A>, message: string) =>
  Effect.gen(function* () {
    if (Option.isNone(option)) {
      return yield* ConfigError.make({ message });
    }
    return option.value;
  });

const parseProviderList = (raw: string) => {
  const value = raw.trim();
  if (value.length === 0) {
    return Effect.succeed([] as ReadonlyArray<LlmProvider>);
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (entries.length === 1 && entries[0] === "none") {
    return Effect.succeed([] as ReadonlyArray<LlmProvider>);
  }
  return Schema.decodeUnknown(LlmProviderListSchema)(entries).pipe(
    Effect.mapError((error) =>
      ConfigError.make({
        message: `Invalid SKYGENT_LLM_PROVIDER(S): ${formatSchemaError(error)}`
      })
    )
  );
};

const providerModelKey = (provider: LlmProvider) => {
  switch (provider) {
    case "openai":
      return "SKYGENT_OPENAI_MODEL";
    case "anthropic":
      return "SKYGENT_ANTHROPIC_MODEL";
    case "google":
      return "SKYGENT_GOOGLE_MODEL";
  }
};

const resolveModel = (provider: LlmProvider) =>
  Effect.gen(function* () {
    const generic = yield* Config.string("SKYGENT_LLM_MODEL").pipe(Config.option);
    const specific = yield* Config.string(providerModelKey(provider)).pipe(Config.option);
    const model = Option.getOrElse(specific, () => Option.getOrUndefined(generic));
    if (!model) {
      return yield* ConfigError.make({
        message: `Missing model for ${provider}. Set ${providerModelKey(provider)} or SKYGENT_LLM_MODEL.`
      });
    }
    return model;
  });

const openAiLayer = (model: string) =>
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("SKYGENT_OPENAI_API_KEY").pipe(
      Config.option
    );
    const apiUrl = yield* Config.string("SKYGENT_OPENAI_API_URL").pipe(Config.option);
    const organizationId = yield* Config.redacted("SKYGENT_OPENAI_ORG_ID").pipe(
      Config.option
    );
    const projectId = yield* Config.redacted("SKYGENT_OPENAI_PROJECT_ID").pipe(
      Config.option
    );
    const resolvedKey = yield* requireOption(
      apiKey,
      "Missing SKYGENT_OPENAI_API_KEY for OpenAI provider."
    );

    const clientLayer = OpenAiClient.layer({
      apiKey: resolvedKey,
      apiUrl: Option.getOrUndefined(apiUrl),
      organizationId: Option.getOrUndefined(organizationId),
      projectId: Option.getOrUndefined(projectId)
    });

    return OpenAiLanguageModel.model(model).pipe(Layer.provide(clientLayer));
  });

const anthropicLayer = (model: string) =>
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("SKYGENT_ANTHROPIC_API_KEY").pipe(
      Config.option
    );
    const apiUrl = yield* Config.string("SKYGENT_ANTHROPIC_API_URL").pipe(
      Config.option
    );
    const anthropicVersion = yield* Config.string(
      "SKYGENT_ANTHROPIC_API_VERSION"
    ).pipe(Config.option);
    const resolvedKey = yield* requireOption(
      apiKey,
      "Missing SKYGENT_ANTHROPIC_API_KEY for Anthropic provider."
    );

    const clientLayer = AnthropicClient.layer({
      apiKey: resolvedKey,
      apiUrl: Option.getOrUndefined(apiUrl),
      anthropicVersion: Option.getOrUndefined(anthropicVersion)
    });

    return AnthropicLanguageModel.model(model).pipe(Layer.provide(clientLayer));
  });

const googleLayer = (model: string) =>
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("SKYGENT_GOOGLE_API_KEY").pipe(
      Config.option
    );
    const apiUrl = yield* Config.string("SKYGENT_GOOGLE_API_URL").pipe(
      Config.option
    );
    const resolvedKey = yield* requireOption(
      apiKey,
      "Missing SKYGENT_GOOGLE_API_KEY for Google provider."
    );

    const clientLayer = GoogleClient.layer({
      apiKey: resolvedKey,
      apiUrl: Option.getOrUndefined(apiUrl)
    });

    return GoogleLanguageModel.model(model).pipe(Layer.provide(clientLayer));
  });

const providerLayer = (provider: LlmProvider, model: string) =>
  Effect.gen(function* () {
    switch (provider) {
      case "openai":
        return yield* openAiLayer(model);
      case "anthropic":
        return yield* anthropicLayer(model);
      case "google":
        return yield* googleLayer(model);
    }
  });

type PromptStrategy = "auto" | "single" | "batch";
type PromptKind = "single" | "batch";

type CacheConfig = {
  readonly capacity: number;
  readonly timeToLive: Duration.Duration;
};

type PersistentCacheConfig = {
  readonly timeToLive: Duration.Duration;
};

export interface LlmSettingsService {
  readonly strategy: PromptStrategy;
  readonly maxBatchSize: number;
  readonly cache: Option.Option<CacheConfig>;
  readonly persistentCache: Option.Option<PersistentCacheConfig>;
  readonly systemPrompt: string;
  readonly batchSystemPrompt: string;
}

export class LlmSettings extends Context.Tag("@skygent/LlmSettings")<
  LlmSettings,
  LlmSettingsService
>() {
  static readonly layer = Layer.effect(
    LlmSettings,
    Effect.gen(function* () {
      const strategy = yield* Config.literal("auto", "single", "batch")(
        "SKYGENT_LLM_STRATEGY"
      ).pipe(Config.withDefault("auto"));

      const maxBatchSize = yield* Config.integer("SKYGENT_LLM_BATCH_SIZE").pipe(
        Config.withDefault(16)
      );

      const cacheCapacity = yield* Config.integer("SKYGENT_LLM_CACHE_CAPACITY").pipe(
        Config.option
      );

      const cacheTtl = yield* Config.duration("SKYGENT_LLM_CACHE_TTL").pipe(
        Config.withDefault(Duration.minutes(10))
      );

      const cache = Option.match(cacheCapacity, {
        onNone: () => Option.none<CacheConfig>(),
        onSome: (capacity) => Option.some({ capacity, timeToLive: cacheTtl })
      });

      const persistentCacheTtl = yield* Config.duration(
        "SKYGENT_LLM_PERSIST_CACHE_TTL"
      ).pipe(Config.withDefault(Duration.hours(24)));

      const persistentCache =
        Duration.toMillis(persistentCacheTtl) <= 0
          ? Option.none<PersistentCacheConfig>()
          : Option.some({ timeToLive: persistentCacheTtl });

      const systemPrompt = yield* Config.string("SKYGENT_LLM_SYSTEM_PROMPT").pipe(
        Config.withDefault(SINGLE_SYSTEM_PROMPT)
      );

      const batchSystemPrompt = yield* Config.string(
        "SKYGENT_LLM_BATCH_SYSTEM_PROMPT"
      ).pipe(Config.withDefault(BATCH_SYSTEM_PROMPT));

      return {
        strategy,
        maxBatchSize,
        cache,
        persistentCache,
        systemPrompt,
        batchSystemPrompt
      };
    })
  );
}

export type LlmExecutionPlan = ExecutionPlan.ExecutionPlan<any>;

export type LlmPlanConfig = {
  readonly plan: LlmExecutionPlan;
  readonly providers: ReadonlyArray<{ provider: LlmProvider; model: string }>;
  readonly signature: string;
};

export class LlmPlan extends Context.Tag("@skygent/LlmPlan")<
  LlmPlan,
  Option.Option<LlmPlanConfig>
>() {
  static readonly none = Layer.succeed(LlmPlan, Option.none());
  static readonly layer = Layer.effect(
    LlmPlan,
    Effect.gen(function* () {
      const providersRaw = yield* Config.string("SKYGENT_LLM_PROVIDERS").pipe(
        Config.option
      );
      const providerRaw = yield* Config.string("SKYGENT_LLM_PROVIDER").pipe(
        Config.option
      );
      const providers = yield* Option.match(providersRaw, {
        onSome: parseProviderList,
        onNone: () =>
          Option.match(providerRaw, {
            onSome: parseProviderList,
            onNone: () => Effect.succeed([] as ReadonlyArray<LlmProvider>)
          })
      });

      if (providers.length === 0) {
        return Option.none();
      }

      const attempts = yield* Config.integer("SKYGENT_LLM_ATTEMPTS").pipe(
        Config.withDefault(1)
      );
      if (attempts < 1) {
        return yield* ConfigError.make({
          message: "SKYGENT_LLM_ATTEMPTS must be >= 1."
        });
      }
      const retryDelay = yield* Config.duration("SKYGENT_LLM_RETRY_DELAY").pipe(
        Config.option
      );
      const schedule = Option.map(retryDelay, Schedule.spaced);

      const uniqueProviders = Array.from(new Set(providers));
      const providerConfigs = yield* Effect.forEach(
        uniqueProviders,
        (provider) =>
          Effect.gen(function* () {
            const model = yield* resolveModel(provider);
            const layer = yield* providerLayer(provider, model);
            return { provider, model, layer };
          })
      );

      const steps: Array<ExecutionPlan.make.Step> = providerConfigs.map(
        (config) => ({
          provide: config.layer,
          attempts: attempts > 1 ? attempts : undefined,
          schedule: Option.getOrUndefined(schedule)
        })
      );

      const [first, ...rest] = steps;
      if (!first) {
        return Option.none();
      }
      const plan = ExecutionPlan.make(first, ...rest);
      const providersConfig = providerConfigs.map(({ provider, model }) => ({
        provider,
        model
      }));
      const signature = providersConfig
        .map((entry) => `${entry.provider}:${entry.model}`)
        .join("|");
      return Option.some({ plan, providers: providersConfig, signature });
    })
  );
}

export class LlmDecisionRequest extends Request.TaggedClass("LlmDecision")<
  LlmDecisionMeta,
  FilterEvalError,
  {
    readonly prompt: string;
    readonly text: string;
    readonly minConfidence: number;
  }
> {}

export interface LlmDecisionService {
  readonly decide: (request: LlmDecisionRequest) => Effect.Effect<boolean, FilterEvalError>;
  readonly decideBatch: (
    requests: ReadonlyArray<LlmDecisionRequest>
  ) => Effect.Effect<ReadonlyArray<boolean>, FilterEvalError>;
  readonly decideDetailed: (
    request: LlmDecisionRequest
  ) => Effect.Effect<LlmDecisionMeta, FilterEvalError>;
  readonly decideDetailedBatch: (
    requests: ReadonlyArray<LlmDecisionRequest>
  ) => Effect.Effect<ReadonlyArray<LlmDecisionMeta>, FilterEvalError>;
}

const cachePrefix = "cache/llm/";

class LlmCacheEntry extends Schema.Class<LlmCacheEntry>("LlmCacheEntry")({
  promptHash: Schema.String,
  textHash: Schema.String,
  score: Schema.Number,
  modelId: Schema.optional(Schema.String),
  responseId: Schema.optional(Schema.String),
  usage: Schema.optional(LlmUsage),
  cachedAt: Schema.DateFromString,
  expiresAt: Schema.optional(Schema.DateFromString)
}) {}

const cacheKey = (model: string, promptHash: string, textHash: string) =>
  `${encodeURIComponent(model)}:${promptHash}:${textHash}`;

const promptFingerprint = (
  kind: PromptKind,
  settings: LlmSettingsService,
  request: LlmDecisionRequest,
  minConfidence: number
) =>
  JSON.stringify({
    kind,
    systemPrompt:
      kind === "batch" ? settings.batchSystemPrompt : settings.systemPrompt,
    prompt: request.prompt,
    minConfidence
  });

const hexFromBytes = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const hashString = (value: string) =>
  Effect.tryPromise({
    try: async () => {
      const data = new TextEncoder().encode(value);
      const digest = await crypto.subtle.digest("SHA-256", data);
      return hexFromBytes(new Uint8Array(digest));
    },
    catch: (cause) =>
      FilterEvalError.make({ message: "Failed to hash LLM input", cause })
  });

const usageFromResponse = (usage: Response.Usage) =>
  LlmUsage.make({
    inputTokens: usage.inputTokens ?? undefined,
    outputTokens: usage.outputTokens ?? undefined,
    totalTokens: usage.totalTokens ?? undefined,
    reasoningTokens: usage.reasoningTokens ?? undefined,
    cachedInputTokens: usage.cachedInputTokens ?? undefined
  });

const responseMetadata = (content: ReadonlyArray<Response.Part<any>>) => {
  const metadata = content.find(
    (part): part is Response.ResponseMetadataPart =>
      part.type === "response-metadata"
  );
  return {
    modelId: metadata ? Option.getOrUndefined(metadata.modelId) : undefined,
    responseId: metadata ? Option.getOrUndefined(metadata.id) : undefined
  };
};

const buildSinglePrompt = (settings: LlmSettingsService, request: LlmDecisionRequest) =>
  Prompt.fromMessages([
    Prompt.makeMessage("system", { content: settings.systemPrompt }),
    Prompt.makeMessage("user", {
      content: [
        Prompt.makePart("text", {
          text:
            `Task: ${request.prompt}\n` +
            `Minimum confidence: ${request.minConfidence}\n` +
            `Text: ${request.text}\n` +
            "Return JSON: {\"score\": number}"
        })
      ]
    })
  ]);

const buildBatchPrompt = (
  settings: LlmSettingsService,
  prompt: string,
  minConfidence: number,
  items: ReadonlyArray<{ id: string; text: string }>
) => {
  const lines = items
    .map((item) => `- id: ${item.id}\n  text: ${item.text}`)
    .join("\n");

  const text =
    `Task: ${prompt}\n` +
    `Minimum confidence: ${minConfidence}\n\n` +
    `Items:\n${lines}\n\n` +
    "Return JSON: {\"results\":[{\"id\": string, \"score\": number}]}";

  return Prompt.fromMessages([
    Prompt.makeMessage("system", { content: settings.batchSystemPrompt }),
    Prompt.makeMessage("user", {
      content: [Prompt.makePart("text", { text })]
    })
  ]);
};

const applyPlan = <A, E>(
  effect: Effect.Effect<A, E, LanguageModel.LanguageModel>,
  plan: Option.Option<LlmPlanConfig>
): Effect.Effect<A, E | FilterEvalError, never> =>
  Option.isSome(plan)
    ? Effect.withExecutionPlan(effect, plan.value.plan)
    : FilterEvalError.make({ message: "LLM execution plan not configured" });

const scoreToDecision = (score: number, minConfidence: number) =>
  Number.isFinite(score) && score >= minConfidence;

export class LlmDecision extends Context.Tag("@skygent/LlmDecision")<
  LlmDecision,
  LlmDecisionService
>() {
  static readonly layer = Layer.effect(
    LlmDecision,
    Effect.gen(function* () {
      const settings = yield* LlmSettings;
      const idGenerator = yield* IdGenerator.IdGenerator;
      const plan = yield* LlmPlan;
      const persistentStore = yield* Option.match(settings.persistentCache, {
        onNone: () => Effect.succeed(Option.none()),
        onSome: (config) =>
          Effect.serviceOption(KeyValueStore.KeyValueStore).pipe(
            Effect.map(
              Option.map((kv) => ({
                store: KeyValueStore.prefix(kv.forSchema(LlmCacheEntry), cachePrefix),
                ttl: config.timeToLive
              }))
            )
          )
      });
      const planSignature = Option.map(plan, (value) => value.signature);

      const makeMeta = (params: {
        promptHash: string;
        textHash: string;
        score: number;
        minConfidence: number;
        cached: boolean;
        modelId?: string | undefined;
        responseId?: string | undefined;
        usage?: LlmUsage | undefined;
      }) =>
        LlmDecisionMeta.make({
          promptHash: params.promptHash,
          textHash: params.textHash,
          score: params.score,
          minConfidence: params.minConfidence,
          keep: scoreToDecision(params.score, params.minConfidence),
          cached: params.cached,
          planHash: Option.getOrUndefined(planSignature),
          modelId: params.modelId,
          responseId: params.responseId,
          usage: params.usage
        });

      const computeHashes = (
        kind: PromptKind,
        request: LlmDecisionRequest,
        promptMinConfidence: number = request.minConfidence
      ) =>
        Effect.all({
          promptHash: hashString(
            promptFingerprint(kind, settings, request, promptMinConfidence)
          ),
          textHash: hashString(request.text)
        });

      const readCache = (
        store: KeyValueStore.SchemaStore<LlmCacheEntry, never>,
        model: string,
        promptHash: string,
        textHash: string
      ) =>
        Effect.gen(function* () {
          const key = cacheKey(model, promptHash, textHash);
          const entry = yield* store
            .get(key)
            .pipe(Effect.catchAll(() => Effect.succeed(Option.none())));
          if (Option.isNone(entry)) {
            return Option.none();
          }
          const now = yield* Clock.currentTimeMillis;
          const expiresAt = entry.value.expiresAt;
          if (!expiresAt || expiresAt.getTime() > now) {
            return Option.some({ entry: entry.value, model });
          }
          yield* Effect.ignore(store.remove(key));
          return Option.none();
        });

      const findCache = (
        store: KeyValueStore.SchemaStore<LlmCacheEntry, never>,
        models: ReadonlyArray<string>,
        promptHash: string,
        textHash: string
      ) =>
        Effect.gen(function* () {
          for (const model of models) {
            const cached = yield* readCache(store, model, promptHash, textHash);
            if (Option.isSome(cached)) {
              return cached;
            }
          }
          return Option.none();
        });

      const writeCache = (
        store: KeyValueStore.SchemaStore<LlmCacheEntry, never>,
        ttl: Duration.Duration,
        model: string,
        promptHash: string,
        textHash: string,
        payload: {
          score: number;
          modelId?: string | undefined;
          responseId?: string | undefined;
          usage?: LlmUsage | undefined;
        }
      ) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const expiresAt = Duration.isFinite(ttl)
            ? new Date(now + Duration.toMillis(ttl))
            : undefined;
          const entry = LlmCacheEntry.make({
            promptHash,
            textHash,
            score: payload.score,
            modelId: payload.modelId,
            responseId: payload.responseId,
            usage: payload.usage,
            cachedAt: new Date(now),
            expiresAt
          });
          const key = cacheKey(model, promptHash, textHash);
          yield* store.set(key, entry).pipe(Effect.catchAll(() => Effect.void));
        });

      const decideOne = (request: LlmDecisionRequest) =>
        applyPlan(
          LanguageModel.generateObject({
            prompt: buildSinglePrompt(settings, request),
            schema: SingleDecisionSchema,
            objectName: "LlmDecision"
          }),
          plan
        ).pipe(
          Effect.map((response) => {
            const meta = responseMetadata(response.content);
            return {
              score: response.value.score,
              usage: usageFromResponse(response.usage),
              modelId: meta.modelId,
              responseId: meta.responseId
            };
          }),
          Effect.mapError((cause) =>
            cause._tag === "FilterEvalError"
              ? cause
              : FilterEvalError.make({ message: "LLM decision failed", cause })
          )
        );

      const decideGroupBatch = (
        prompt: string,
        minConfidence: number,
        items: ReadonlyArray<{ id: string; request: LlmDecisionRequest }>
      ) =>
        applyPlan(
          LanguageModel.generateObject({
            prompt: buildBatchPrompt(
              settings,
              prompt,
              minConfidence,
              items.map((item) => ({ id: item.id, text: item.request.text }))
            ),
            schema: BatchDecisionSchema,
            objectName: "LlmDecisionBatch"
          }),
          plan
        ).pipe(
          Effect.map((response) => {
            const meta = responseMetadata(response.content);
            return {
              results: response.value.results,
              usage: usageFromResponse(response.usage),
              modelId: meta.modelId,
              responseId: meta.responseId
            };
          }),
          Effect.mapError((cause) =>
            cause._tag === "FilterEvalError"
              ? cause
              : FilterEvalError.make({ message: "LLM batch decision failed", cause })
          )
        );

      const decideBatchImpl = (requests: ReadonlyArray<LlmDecisionRequest>) =>
        Effect.gen(function* () {
          if (requests.length === 0) {
            return [] as ReadonlyArray<LlmDecisionMeta>;
          }

          if (Option.isNone(plan)) {
            return yield* FilterEvalError.make({
              message: "LLM execution plan not configured"
            });
          }

          const planInfo = plan.value;
          const models = planInfo.providers.map((entry) => entry.model);

          const ids = yield* Effect.forEach(requests, () => idGenerator.generateId());
          const items = requests.map((request, index) => ({
            request,
            id: ids[index] ?? `${index}`,
            index
          }));

          const grouped = new Map<string, Array<typeof items[number]>>();
          for (const item of items) {
            const key = item.request.prompt;
            const existing = grouped.get(key) ?? [];
            existing.push(item);
            grouped.set(key, existing);
          }

          const results: Array<LlmDecisionMeta | undefined> = Array(requests.length);

          for (const [prompt, group] of grouped.entries()) {
            const kind: PromptKind =
              settings.strategy === "auto"
                ? group.length > 1
                  ? "batch"
                  : "single"
                : settings.strategy === "batch"
                  ? "batch"
                  : "single";

            const batchMinConfidence =
              kind === "batch"
                ? Math.max(...group.map((item) => item.request.minConfidence))
                : undefined;

            const hashed = yield* Effect.forEach(
              group,
              (item) =>
                computeHashes(
                  kind,
                  item.request,
                  batchMinConfidence ?? item.request.minConfidence
                ).pipe(
                  Effect.map(({ promptHash, textHash }) => ({
                    ...item,
                    promptHash,
                    textHash
                  }))
                ),
              { concurrency: "unbounded" }
            );

            const missing: Array<(typeof hashed)[number]> = [];

            if (Option.isSome(persistentStore) && models.length > 0) {
              for (const item of hashed) {
                const cached = yield* findCache(
                  persistentStore.value.store,
                  models,
                  item.promptHash,
                  item.textHash
                );
                if (Option.isSome(cached)) {
                  const entry = cached.value.entry;
                  results[item.index] = makeMeta({
                    promptHash: item.promptHash,
                    textHash: item.textHash,
                    score: entry.score,
                    minConfidence: item.request.minConfidence,
                    cached: true,
                    modelId: entry.modelId,
                    responseId: entry.responseId,
                    usage: entry.usage
                  });
                } else {
                  missing.push(item);
                }
              }
            } else {
              missing.push(...hashed);
            }

            if (missing.length === 0) {
              continue;
            }

            if (kind === "batch") {
              const minConfidence =
                batchMinConfidence ??
                Math.max(...missing.map((item) => item.request.minConfidence));
              const batch = yield* decideGroupBatch(prompt, minConfidence, missing);
              const scores = new Map(
                batch.results.map((result) => [result.id, result.score])
              );

              for (const item of missing) {
                const score = scores.get(item.id);
                if (score === undefined) {
                  return yield* FilterEvalError.make({
                    message: `Missing LLM decision for request ${item.id}`
                  });
                }
                results[item.index] = makeMeta({
                  promptHash: item.promptHash,
                  textHash: item.textHash,
                  score,
                  minConfidence: item.request.minConfidence,
                  cached: false,
                  modelId: batch.modelId,
                  responseId: batch.responseId,
                  usage: batch.usage
                });
              }

              if (Option.isSome(persistentStore)) {
                const model = batch.modelId ?? models[0];
                if (model) {
                  yield* Effect.forEach(
                    missing,
                    (item) => {
                      const score = scores.get(item.id);
                      if (score === undefined) return Effect.void;
                      return writeCache(
                        persistentStore.value.store,
                        persistentStore.value.ttl,
                        model,
                        item.promptHash,
                        item.textHash,
                        {
                          score,
                          modelId: batch.modelId,
                          responseId: batch.responseId,
                          usage: batch.usage
                        }
                      );
                    },
                    { concurrency: "unbounded", discard: true }
                  );
                }
              }
            } else {
              const decided = yield* Effect.forEach(
                missing,
                (item) =>
                  decideOne(item.request).pipe(
                    Effect.map((decision) => ({ item, decision }))
                  ),
                { concurrency: "unbounded" }
              );

              for (const { item, decision } of decided) {
                results[item.index] = makeMeta({
                  promptHash: item.promptHash,
                  textHash: item.textHash,
                  score: decision.score,
                  minConfidence: item.request.minConfidence,
                  cached: false,
                  modelId: decision.modelId,
                  responseId: decision.responseId,
                  usage: decision.usage
                });
              }

              if (Option.isSome(persistentStore)) {
                yield* Effect.forEach(
                  decided,
                  ({ item, decision }) => {
                    const model = decision.modelId ?? models[0];
                    if (!model) return Effect.void;
                    return writeCache(
                      persistentStore.value.store,
                      persistentStore.value.ttl,
                      model,
                      item.promptHash,
                      item.textHash,
                      {
                        score: decision.score,
                        modelId: decision.modelId,
                        responseId: decision.responseId,
                        usage: decision.usage
                      }
                    );
                  },
                  { concurrency: "unbounded", discard: true }
                );
              }
            }
          }

          const finalized: Array<LlmDecisionMeta> = [];
          for (const [index, meta] of results.entries()) {
            if (!meta) {
              return yield* FilterEvalError.make({
                message: `Missing LLM decision for request index ${index}`
              });
            }
            finalized.push(meta);
          }
          return finalized;
        });

      const resolver = RequestResolver.makeBatched<LlmDecisionRequest, never>(
        (requests: NonEmptyArray<LlmDecisionRequest>) =>
          decideBatchImpl(requests).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.forEach(requests, (request) => Request.fail(request, error), {
                  discard: true
                }),
              onSuccess: (results) =>
                Effect.forEach(
                  requests,
                  (request, index) =>
                    Request.succeed(request, results[index] as LlmDecisionMeta),
                  { discard: true }
                )
            })
          )
      ).pipe(
        settings.maxBatchSize > 0
          ? RequestResolver.batchN(settings.maxBatchSize)
          : (self) => self
      );
      const cache = yield* Option.match(settings.cache, {
        onNone: () => Effect.succeed(Option.none()),
        onSome: (config) => Request.makeCache(config).pipe(Effect.map(Option.some))
      });

      const decideDetailed = (request: LlmDecisionRequest) => {
        const effect = Effect.request(request, resolver);
        return Option.match(cache, {
          onNone: () => effect,
          onSome: (cache) =>
            effect.pipe(Effect.withRequestCaching(true), Effect.withRequestCache(cache))
        });
      };

      const decideDetailedBatch = (requests: ReadonlyArray<LlmDecisionRequest>) =>
        Effect.forEach(requests, decideDetailed, {
          batching: true,
          concurrency: "unbounded"
        });

      const decide = (request: LlmDecisionRequest) =>
        decideDetailed(request).pipe(Effect.map((meta) => meta.keep));

      const decideBatch = (requests: ReadonlyArray<LlmDecisionRequest>) =>
        Effect.forEach(requests, decide, { batching: true, concurrency: "unbounded" });

      return LlmDecision.of({
        decide,
        decideBatch,
        decideDetailed,
        decideDetailedBatch
      });
    })
  );

  static readonly testLayer = Layer.succeed(
    LlmDecision,
    LlmDecision.of({
      decide: () =>
        Effect.fail(
          FilterEvalError.make({ message: "LlmDecision not configured" })
        ),
      decideBatch: () =>
        Effect.fail(
          FilterEvalError.make({ message: "LlmDecision not configured" })
        ),
      decideDetailed: () =>
        Effect.fail(
          FilterEvalError.make({ message: "LlmDecision not configured" })
        ),
      decideDetailedBatch: () =>
        Effect.fail(
          FilterEvalError.make({ message: "LlmDecision not configured" })
        )
    })
  );
}
