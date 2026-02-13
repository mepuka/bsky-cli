import * as KeyValueStore from "@effect/platform/KeyValueStore";
import * as Persistence from "@effect/experimental/Persistence";
import * as Reactivity from "@effect/experimental/Reactivity";
import { Path } from "@effect/platform";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { Effect, Layer } from "effect";
import { BskyClient } from "../services/bsky-client.js";
import { FilterRuntime } from "../services/filter-runtime.js";
import { PostParser } from "../services/post-parser.js";
import { AppConfigService } from "../services/app-config.js";
import { CredentialStore } from "../services/credential-store.js";
import { StoreEventLog } from "../services/store-event-log.js";
import { StoreIndex } from "../services/store-index.js";
import { StoreDb } from "../services/store-db.js";
import { StoreManager } from "../services/store-manager.js";
import { StoreSources } from "../services/store-sources.js";
import { StoreWriter } from "../services/store-writer.js";
import { StoreCommitter } from "../services/store-commit.js";
import { SyncEngine } from "../services/sync-engine.js";
import { SyncCheckpointStore } from "../services/sync-checkpoint-store.js";
import { SyncReporter } from "../services/sync-reporter.js";
import { SyncSettings } from "../services/sync-settings.js";
import { StoreCleaner } from "../services/store-cleaner.js";
import { StoreRenamer } from "../services/store-renamer.js";
import { LinkValidator } from "../services/link-validator.js";
import { TrendingTopics } from "../services/trending-topics.js";
import { ResourceMonitor } from "../services/resource-monitor.js";
import { ImageFetcher } from "../services/images/image-fetcher.js";
import { ImageConfig } from "../services/images/image-config.js";
import { ImageArchive } from "../services/images/image-archive.js";
import { ImageCache } from "../services/images/image-cache.js";
import { ImageRefIndex } from "../services/images/image-ref-index.js";
import { ImagePipeline } from "../services/images/image-pipeline.js";
import { CliOutput } from "./output.js";
import { CliInput } from "./input.js";
import { DerivationEngine } from "../services/derivation-engine.js";
import { DerivationValidator } from "../services/derivation-validator.js";
import { DerivationSettings } from "../services/derivation-settings.js";
import { ViewCheckpointStore } from "../services/view-checkpoint-store.js";
import { LineageStore } from "../services/lineage-store.js";
import { FilterCompiler } from "../services/filter-compiler.js";
import { FilterSettings } from "../services/filter-settings.js";
import { OutputManager } from "../services/output-manager.js";
import { FilterLibrary } from "../services/filter-library.js";
import { StoreStats } from "../services/store-stats.js";
import { StoreAnalytics } from "../services/store-analytics.js";
import { ProfileResolver } from "../services/profile-resolver.js";
import { IdentityResolver } from "../services/identity-resolver.js";
import { GraphBuilder } from "../services/graph-builder.js";
import { StoreTopology } from "../services/store-topology.js";

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
const storeDbLayer = StoreDb.layer.pipe(Layer.provideMerge(appConfigLayer));
const storeSourcesLayer = StoreSources.layer.pipe(Layer.provideMerge(storeDbLayer));
const writerLayer = StoreWriter.layer.pipe(Layer.provideMerge(storeDbLayer));
const committerLayer = StoreCommitter.layer.pipe(
  Layer.provideMerge(storeDbLayer),
  Layer.provideMerge(writerLayer)
);
const eventLogLayer = StoreEventLog.layer.pipe(Layer.provideMerge(storeDbLayer));
const indexLayer = StoreIndex.layer.pipe(
  Layer.provideMerge(storeDbLayer),
  Layer.provideMerge(eventLogLayer)
);
const managerLayer = StoreManager.layer.pipe(Layer.provideMerge(appConfigLayer));
const cleanerLayer = StoreCleaner.layer.pipe(
  Layer.provideMerge(managerLayer),
  Layer.provideMerge(indexLayer),
  Layer.provideMerge(eventLogLayer),
  Layer.provideMerge(storeDbLayer)
);
const checkpointLayer = SyncCheckpointStore.layer.pipe(
  Layer.provideMerge(storeDbLayer)
);
const linkValidatorLayer = LinkValidator.layer.pipe(
  Layer.provideMerge(storageLayer),
  Layer.provideMerge(FetchHttpClient.layer)
);
const imageConfigLayer = ImageConfig.layer.pipe(
  Layer.provideMerge(appConfigLayer)
);
const imageFetcherLayer = ImageFetcher.layer.pipe(
  Layer.provideMerge(FetchHttpClient.layer)
);
const imageCacheStoreLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* ImageConfig;
    return config.enabled
      ? KeyValueStore.layerFileSystem(config.metaRoot)
      : KeyValueStore.layerMemory;
  })
).pipe(Layer.provide(imageConfigLayer));
const imagePersistenceLayer = Persistence.layerResultKeyValueStore.pipe(
  Layer.provide(imageCacheStoreLayer)
);
const imageRefIndexLayer = ImageRefIndex.layer.pipe(
  Layer.provideMerge(imagePersistenceLayer)
);
const imageArchiveLayer = ImageArchive.layer.pipe(
  Layer.provideMerge(imageConfigLayer)
);
const imageCacheLayer = ImageCache.layer.pipe(
  Layer.provideMerge(imageConfigLayer),
  Layer.provideMerge(imageArchiveLayer),
  Layer.provideMerge(imageFetcherLayer),
  Layer.provideMerge(imagePersistenceLayer),
  Layer.provideMerge(imageRefIndexLayer)
);
const imagePipelineLayer = ImagePipeline.layer.pipe(
  Layer.provideMerge(imageConfigLayer),
  Layer.provideMerge(imageCacheLayer)
);
const trendingTopicsLayer = TrendingTopics.layer.pipe(
  Layer.provideMerge(storageLayer),
  Layer.provideMerge(bskyLayer)
);
const resourceMonitorLayer = ResourceMonitor.layer.pipe(
  Layer.provideMerge(appConfigLayer)
);
const filterSettingsLayer = FilterSettings.layer;
const runtimeLayer = FilterRuntime.layer.pipe(
  Layer.provideMerge(filterSettingsLayer),
  Layer.provideMerge(linkValidatorLayer),
  Layer.provideMerge(trendingTopicsLayer)
);
const syncSettingsLayer = SyncSettings.layer;
const syncLayer = SyncEngine.layer.pipe(
  Layer.provideMerge(committerLayer),
  Layer.provideMerge(indexLayer),
  Layer.provideMerge(checkpointLayer),
  Layer.provideMerge(runtimeLayer),
  Layer.provideMerge(PostParser.layer),
  Layer.provideMerge(bskyLayer),
  Layer.provideMerge(SyncReporter.layer),
  Layer.provideMerge(syncSettingsLayer)
);
const identityResolverLayer = IdentityResolver.layer.pipe(
  Layer.provideMerge(storageLayer),
  Layer.provideMerge(bskyLayer)
);
const profileResolverLayer = ProfileResolver.layer.pipe(
  Layer.provideMerge(bskyLayer),
  Layer.provideMerge(identityResolverLayer)
);
const viewCheckpointLayer = ViewCheckpointStore.layer.pipe(
  Layer.provideMerge(storeDbLayer),
  Layer.provideMerge(managerLayer)
);
const lineageLayer = LineageStore.layer.pipe(
  Layer.provideMerge(storageLayer)
);
const storeRenamerLayer = StoreRenamer.layer.pipe(
  Layer.provideMerge(appConfigLayer),
  Layer.provideMerge(managerLayer),
  Layer.provideMerge(storeDbLayer),
  Layer.provideMerge(lineageLayer)
);
const compilerLayer = FilterCompiler.layer;
const postParserLayer = PostParser.layer;
const derivationEngineLayer = DerivationEngine.layer.pipe(
  Layer.provideMerge(eventLogLayer),
  Layer.provideMerge(committerLayer),
  Layer.provideMerge(indexLayer),
  Layer.provideMerge(compilerLayer),
  Layer.provideMerge(runtimeLayer),
  Layer.provideMerge(viewCheckpointLayer),
  Layer.provideMerge(lineageLayer),
  Layer.provideMerge(DerivationSettings.layer)
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
  Layer.provideMerge(filterSettingsLayer),
  Layer.provideMerge(compilerLayer)
);
const filterLibraryLayer = FilterLibrary.layer.pipe(
  Layer.provideMerge(appConfigLayer)
);
const storeStatsLayer = StoreStats.layer.pipe(
  Layer.provideMerge(appConfigLayer),
  Layer.provideMerge(managerLayer),
  Layer.provideMerge(indexLayer),
  Layer.provideMerge(storeDbLayer),
  Layer.provideMerge(lineageLayer),
  Layer.provideMerge(derivationValidatorLayer),
  Layer.provideMerge(eventLogLayer),
  Layer.provideMerge(checkpointLayer)
);
const storeAnalyticsLayer = StoreAnalytics.layer.pipe(
  Layer.provideMerge(storeDbLayer)
);
const graphBuilderLayer = GraphBuilder.layer.pipe(
  Layer.provideMerge(indexLayer),
  Layer.provideMerge(runtimeLayer)
);
const storeTopologyLayer = StoreTopology.layer.pipe(
  Layer.provideMerge(managerLayer),
  Layer.provideMerge(indexLayer),
  Layer.provideMerge(lineageLayer),
  Layer.provideMerge(storeSourcesLayer)
);

const reactivityLayer = Reactivity.layer;

export const CliLive = Layer.mergeAll(
  appConfigLayer,
  filterSettingsLayer,
  credentialLayer,
  CliInput.layer,
  CliOutput.layer,
  resourceMonitorLayer,
  reactivityLayer,
  managerLayer,
  committerLayer,
  indexLayer,
  eventLogLayer,
  cleanerLayer,
  storeRenamerLayer,
  storeSourcesLayer,
  syncLayer,
  checkpointLayer,
  viewCheckpointLayer,
  derivationEngineLayer,
  derivationValidatorLayer,
  lineageLayer,
  outputManagerLayer,
  storeStatsLayer,
  storeAnalyticsLayer,
  graphBuilderLayer,
  storeTopologyLayer,
  compilerLayer,
  postParserLayer,
  filterLibraryLayer,
  imageConfigLayer,
  imageArchiveLayer,
  imageCacheLayer,
  imagePipelineLayer,
  imageFetcherLayer,
  profileResolverLayer,
  identityResolverLayer
);
