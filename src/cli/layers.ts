import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { Path } from "@effect/platform";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { Effect, Layer } from "effect";
import { BskyClient } from "../services/bsky-client.js";
import { FilterRuntime } from "../services/filter-runtime.js";
import { LlmDecision, LlmPlan, LlmSettings } from "../services/llm.js";
import { LlmTelemetry } from "../services/llm-telemetry.js";
import { PostParser } from "../services/post-parser.js";
import { AppConfigService } from "../services/app-config.js";
import { CredentialStore } from "../services/credential-store.js";
import { StoreEventLog } from "../services/store-event-log.js";
import { StoreIndex } from "../services/store-index.js";
import { StoreManager } from "../services/store-manager.js";
import { StoreWriter } from "../services/store-writer.js";
import { SyncEngine } from "../services/sync-engine.js";
import { SyncCheckpointStore } from "../services/sync-checkpoint-store.js";
import { SyncReporter } from "../services/sync-reporter.js";
import { StoreCleaner } from "../services/store-cleaner.js";
import { IdGenerator } from "@effect/ai";
import { LinkValidator } from "../services/link-validator.js";
import { TrendingTopics } from "../services/trending-topics.js";
import { ResourceMonitor } from "../services/resource-monitor.js";
import { CliOutput } from "./output.js";
import { DerivationEngine } from "../services/derivation-engine.js";
import { DerivationValidator } from "../services/derivation-validator.js";
import { ViewCheckpointStore } from "../services/view-checkpoint-store.js";
import { LineageStore } from "../services/lineage-store.js";
import { FilterCompiler } from "../services/filter-compiler.js";
import { OutputManager } from "../services/output-manager.js";
import { FilterLibrary } from "../services/filter-library.js";

const appConfigLayer = AppConfigService.layer;
const credentialLayer = CredentialStore.layer.pipe(Layer.provideMerge(appConfigLayer));
const bskyLayer = BskyClient.layer.pipe(
  Layer.provideMerge(appConfigLayer),
  Layer.provideMerge(credentialLayer)
);

const storageLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* AppConfigService;
    const path = yield* Path.Path;
    const kvRoot = path.join(config.storeRoot, "kv");
    return KeyValueStore.layerFileSystem(kvRoot);
  })
).pipe(Layer.provide(appConfigLayer));
const writerLayer = StoreWriter.layer.pipe(Layer.provideMerge(storageLayer));
const eventLogLayer = StoreEventLog.layer.pipe(Layer.provideMerge(storageLayer));
const indexLayer = StoreIndex.layer.pipe(
  Layer.provideMerge(storageLayer),
  Layer.provideMerge(eventLogLayer)
);
const managerLayer = StoreManager.layer.pipe(Layer.provideMerge(storageLayer));
const cleanerLayer = StoreCleaner.layer.pipe(
  Layer.provideMerge(managerLayer),
  Layer.provideMerge(indexLayer),
  Layer.provideMerge(eventLogLayer)
);
const checkpointLayer = SyncCheckpointStore.layer.pipe(
  Layer.provideMerge(storageLayer)
);
const idGeneratorLayer = Layer.succeed(
  IdGenerator.IdGenerator,
  IdGenerator.defaultIdGenerator
);
const llmDecisionLayer = LlmDecision.layer.pipe(
  Layer.provideMerge(
    LlmPlan.layer.pipe(Layer.provide(LlmSettings.layer))
  ),
  Layer.provideMerge(LlmSettings.layer),
  Layer.provideMerge(idGeneratorLayer),
  Layer.provideMerge(storageLayer),
  Layer.provideMerge(LlmTelemetry.layer)
);
const linkValidatorLayer = LinkValidator.layer.pipe(
  Layer.provideMerge(storageLayer),
  Layer.provideMerge(FetchHttpClient.layer)
);
const trendingTopicsLayer = TrendingTopics.layer.pipe(
  Layer.provideMerge(storageLayer),
  Layer.provideMerge(appConfigLayer),
  Layer.provideMerge(credentialLayer)
);
const resourceMonitorLayer = ResourceMonitor.layer.pipe(
  Layer.provideMerge(appConfigLayer)
);
const runtimeLayer = FilterRuntime.layer.pipe(
  Layer.provideMerge(llmDecisionLayer),
  Layer.provideMerge(linkValidatorLayer),
  Layer.provideMerge(trendingTopicsLayer)
);
const syncLayer = SyncEngine.layer.pipe(
  Layer.provideMerge(writerLayer),
  Layer.provideMerge(indexLayer),
  Layer.provideMerge(checkpointLayer),
  Layer.provideMerge(runtimeLayer),
  Layer.provideMerge(PostParser.layer),
  Layer.provideMerge(bskyLayer),
  Layer.provideMerge(SyncReporter.layer)
);
const viewCheckpointLayer = ViewCheckpointStore.layer.pipe(
  Layer.provideMerge(storageLayer)
);
const lineageLayer = LineageStore.layer.pipe(
  Layer.provideMerge(storageLayer)
);
const compilerLayer = FilterCompiler.layer;
const postParserLayer = PostParser.layer;
const derivationEngineLayer = DerivationEngine.layer.pipe(
  Layer.provideMerge(eventLogLayer),
  Layer.provideMerge(writerLayer),
  Layer.provideMerge(indexLayer),
  Layer.provideMerge(compilerLayer),
  Layer.provideMerge(runtimeLayer),
  Layer.provideMerge(viewCheckpointLayer),
  Layer.provideMerge(lineageLayer)
);
const derivationValidatorLayer = DerivationValidator.layer.pipe(
  Layer.provideMerge(viewCheckpointLayer),
  Layer.provideMerge(eventLogLayer),
  Layer.provideMerge(managerLayer)
);
const outputManagerLayer = OutputManager.layer.pipe(
  Layer.provideMerge(appConfigLayer),
  Layer.provideMerge(managerLayer),
  Layer.provideMerge(indexLayer),
  Layer.provideMerge(runtimeLayer),
  Layer.provideMerge(compilerLayer)
);
const filterLibraryLayer = FilterLibrary.layer.pipe(
  Layer.provideMerge(appConfigLayer)
);

export const CliLive = Layer.mergeAll(
  appConfigLayer,
  credentialLayer,
  CliOutput.layer,
  resourceMonitorLayer,
  managerLayer,
  indexLayer,
  cleanerLayer,
  syncLayer,
  viewCheckpointLayer,
  derivationEngineLayer,
  derivationValidatorLayer,
  lineageLayer,
  outputManagerLayer,
  compilerLayer,
  postParserLayer,
  filterLibraryLayer
);
