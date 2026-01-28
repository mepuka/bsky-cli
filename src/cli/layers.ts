import * as KeyValueStore from "@effect/platform/KeyValueStore";
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
import { StoreWriter } from "../services/store-writer.js";
import { StoreCommitter } from "../services/store-commit.js";
import { SyncEngine } from "../services/sync-engine.js";
import { SyncCheckpointStore } from "../services/sync-checkpoint-store.js";
import { SyncReporter } from "../services/sync-reporter.js";
import { SyncSettings } from "../services/sync-settings.js";
import { StoreCleaner } from "../services/store-cleaner.js";
import { LinkValidator } from "../services/link-validator.js";
import { TrendingTopics } from "../services/trending-topics.js";
import { ResourceMonitor } from "../services/resource-monitor.js";
import { CliOutput } from "./output.js";
import { DerivationEngine } from "../services/derivation-engine.js";
import { DerivationValidator } from "../services/derivation-validator.js";
import { DerivationSettings } from "../services/derivation-settings.js";
import { ViewCheckpointStore } from "../services/view-checkpoint-store.js";
import { LineageStore } from "../services/lineage-store.js";
import { FilterCompiler } from "../services/filter-compiler.js";
import { OutputManager } from "../services/output-manager.js";
import { FilterLibrary } from "../services/filter-library.js";
import { StoreStats } from "../services/store-stats.js";
import { ProfileResolver } from "../services/profile-resolver.js";
import { StoreLock } from "../services/store-lock.js";

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
  Layer.provideMerge(storageLayer)
);
const linkValidatorLayer = LinkValidator.layer.pipe(
  Layer.provideMerge(storageLayer),
  Layer.provideMerge(FetchHttpClient.layer)
);
const trendingTopicsLayer = TrendingTopics.layer.pipe(
  Layer.provideMerge(storageLayer),
  Layer.provideMerge(bskyLayer)
);
const resourceMonitorLayer = ResourceMonitor.layer.pipe(
  Layer.provideMerge(appConfigLayer)
);
const runtimeLayer = FilterRuntime.layer.pipe(
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
const profileResolverLayer = ProfileResolver.layer.pipe(
  Layer.provideMerge(bskyLayer)
);
const storeLockLayer = StoreLock.layer.pipe(
  Layer.provideMerge(appConfigLayer)
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

export const CliLive = Layer.mergeAll(
  appConfigLayer,
  credentialLayer,
  CliOutput.layer,
  resourceMonitorLayer,
  managerLayer,
  committerLayer,
  indexLayer,
  eventLogLayer,
  cleanerLayer,
  syncLayer,
  checkpointLayer,
  viewCheckpointLayer,
  derivationEngineLayer,
  derivationValidatorLayer,
  lineageLayer,
  outputManagerLayer,
  storeStatsLayer,
  compilerLayer,
  postParserLayer,
  filterLibraryLayer,
  profileResolverLayer,
  storeLockLayer
);
