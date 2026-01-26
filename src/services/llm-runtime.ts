import {
  Config,
  Duration,
  Effect,
  ExecutionPlan,
  Layer,
  Option,
  Schedule
} from "effect";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { GoogleClient, GoogleLanguageModel } from "@effect/ai-google";
import { IdGenerator } from "@effect/ai";
import { LlmDecision, LlmPlan, LlmSettings } from "./llm.js";

type ProviderName = "openai" | "anthropic" | "google";

type PlanStep = {
  readonly provide: Layer.Layer<any>;
  readonly attempts: number;
  readonly delay: Option.Option<Duration.Duration>;
};

const providerConfig = (name: string) =>
  Config.string(name).pipe(Config.option);

const attemptsConfig = (name: string) =>
  Config.integer(name).pipe(Config.withDefault(1));

const delayConfig = (name: string) =>
  Config.duration(name).pipe(Config.option);

const apiKeyConfig = (name: string) =>
  Config.redacted(name).pipe(Config.option);

const stepToPlan = (step: PlanStep) => ({
  provide: step.provide,
  attempts: step.attempts,
  schedule: Option.match(step.delay, {
    onNone: () => undefined,
    onSome: (delay) => Schedule.spaced(delay)
  })
});

export const LlmPlanLive = Layer.effect(
  LlmPlan,
  Effect.gen(function* () {
    const primaryProvider = yield* providerConfig("SKYGENT_LLM_PRIMARY_PROVIDER");
    const primaryModel = yield* providerConfig("SKYGENT_LLM_PRIMARY_MODEL");

    if (Option.isNone(primaryProvider) || Option.isNone(primaryModel)) {
      return Option.none();
    }

    const primaryAttempts = yield* attemptsConfig("SKYGENT_LLM_PRIMARY_ATTEMPTS");
    const primaryDelay = yield* delayConfig("SKYGENT_LLM_PRIMARY_RETRY_DELAY");

    const openAiKey = yield* apiKeyConfig("OPENAI_API_KEY");
    const anthropicKey = yield* apiKeyConfig("ANTHROPIC_API_KEY");
    const googleKey = yield* apiKeyConfig("GOOGLE_API_KEY");

    const providerLayer = (provider: ProviderName, model: string) => {
      switch (provider) {
        case "openai":
          return Option.map(openAiKey, (apiKey) => {
            const client = OpenAiClient.layer({ apiKey }).pipe(
              Layer.provide(FetchHttpClient.layer)
            );
            return OpenAiLanguageModel.model(model).pipe(Layer.provide(client));
          });
        case "anthropic":
          return Option.map(anthropicKey, (apiKey) => {
            const client = AnthropicClient.layer({ apiKey }).pipe(
              Layer.provide(FetchHttpClient.layer)
            );
            return AnthropicLanguageModel.model(model).pipe(Layer.provide(client));
          });
        case "google":
          return Option.map(googleKey, (apiKey) => {
            const client = GoogleClient.layer({ apiKey }).pipe(
              Layer.provide(FetchHttpClient.layer)
            );
            return GoogleLanguageModel.model(model).pipe(Layer.provide(client));
          });
      }
    };

    const primaryLayer = providerLayer(
      primaryProvider.value as ProviderName,
      primaryModel.value
    );

    if (Option.isNone(primaryLayer)) {
      return Option.none();
    }

    const steps: Array<PlanStep> = [
      {
        provide: primaryLayer.value,
        attempts: Math.max(1, primaryAttempts),
        delay: primaryDelay
      }
    ];
    const providers: Array<{ provider: ProviderName; model: string }> = [
      { provider: primaryProvider.value as ProviderName, model: primaryModel.value }
    ];

    const fallbackProvider = yield* providerConfig("SKYGENT_LLM_FALLBACK_PROVIDER");
    const fallbackModel = yield* providerConfig("SKYGENT_LLM_FALLBACK_MODEL");

    if (Option.isSome(fallbackProvider) && Option.isSome(fallbackModel)) {
      const fallbackAttempts = yield* attemptsConfig("SKYGENT_LLM_FALLBACK_ATTEMPTS");
      const fallbackDelay = yield* delayConfig("SKYGENT_LLM_FALLBACK_RETRY_DELAY");
      const fallbackLayer = providerLayer(
        fallbackProvider.value as ProviderName,
        fallbackModel.value
      );
      if (Option.isSome(fallbackLayer)) {
        steps.push({
          provide: fallbackLayer.value,
          attempts: Math.max(1, fallbackAttempts),
          delay: fallbackDelay
        });
        providers.push({
          provider: fallbackProvider.value as ProviderName,
          model: fallbackModel.value
        });
      }
    }

    if (steps.length === 0) {
      return Option.none();
    }

    const [first, ...rest] = steps as [PlanStep, ...PlanStep[]];
    const plan = ExecutionPlan.make(
      stepToPlan(first),
      ...rest.map(stepToPlan)
    );
    const signature = providers
      .map((entry) => `${entry.provider}:${entry.model}`)
      .join("|");

    return Option.some({ plan, providers, signature });
  })
);

export const LlmProviderClients = Layer.mergeAll(
  OpenAiClient.layerConfig({
    apiKey: Config.redacted("OPENAI_API_KEY").pipe(
      Config.option,
      Config.map(Option.getOrElse(() => undefined))
    )
  }).pipe(Layer.provide(FetchHttpClient.layer)),
  AnthropicClient.layerConfig({
    apiKey: Config.redacted("ANTHROPIC_API_KEY").pipe(
      Config.option,
      Config.map(Option.getOrElse(() => undefined))
    )
  }).pipe(Layer.provide(FetchHttpClient.layer)),
  GoogleClient.layerConfig({
    apiKey: Config.redacted("GOOGLE_API_KEY").pipe(
      Config.option,
      Config.map(Option.getOrElse(() => undefined))
    )
  }).pipe(Layer.provide(FetchHttpClient.layer))
);

export const LlmLive = LlmDecision.layer.pipe(
  Layer.provideMerge(LlmSettings.layer),
  Layer.provideMerge(LlmPlanLive),
  Layer.provideMerge(
    Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)
  )
);
