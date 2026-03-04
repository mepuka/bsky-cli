import { Command } from "@effect/cli";
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import { deriveCommand } from "../../src/cli/derive.js";
import { DerivationResult } from "../../src/domain/derivation.js";
import { defaultStoreConfig } from "../../src/domain/defaults.js";
import { Did, Handle, StoreName } from "../../src/domain/primitives.js";
import { OutputManager } from "../../src/services/output-manager.js";
import { DerivationEngine } from "../../src/services/derivation-engine.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { ViewCheckpointStore } from "../../src/services/view-checkpoint-store.js";
import { FilterLibrary } from "../../src/services/filter-library.js";
import { FilterNotFound } from "../../src/domain/errors.js";
import { CliInputError } from "../../src/cli/errors.js";
import { IdentityResolver } from "../../src/services/identity-resolver.js";
import { IdentityInfo } from "../../src/domain/bsky.js";
import { makeOutputCapture } from "../support/cli-output-capture.js";
import { buildCliTestLayer } from "../support/layers.js";
import { withTempDir } from "../support/temp-dir.js";

const engineLayer = Layer.succeed(
  DerivationEngine,
  DerivationEngine.make({
    derive: () =>
      Effect.succeed(
        DerivationResult.make({
          eventsProcessed: 0,
          eventsMatched: 0,
          eventsSkipped: 0,
          deletesPropagated: 0,
          durationMs: 0
        })
      )
  })
);

const checkpointsLayer = Layer.succeed(
  ViewCheckpointStore,
  ViewCheckpointStore.make({
    load: () => Effect.succeed(Option.none()),
    save: () => Effect.void,
    remove: () => Effect.void
  })
);

const outputManagerLayer = Layer.succeed(
  OutputManager,
  OutputManager.make({
    materializeStore: (store) =>
      Effect.succeed({ store: store.name, filters: [] }),
    materializeFilters: () => Effect.succeed([])
  })
);

const filterLibraryLayer = Layer.succeed(
  FilterLibrary,
  FilterLibrary.make({
    list: () => Effect.succeed([]),
    get: (name) => Effect.fail(FilterNotFound.make({ name })),
    save: () => Effect.void,
    remove: () => Effect.void,
    validateAll: () => Effect.succeed([])
  })
);

const stubDid = Schema.decodeUnknownSync(Did)("did:plc:example");
const stubHandle = Schema.decodeUnknownSync(Handle)("example.bsky");

const identityLayer = Layer.succeed(
  IdentityResolver,
  IdentityResolver.make({
    lookupDid: () => Effect.succeed(Option.none()),
    lookupHandle: () => Effect.succeed(Option.none()),
    resolveDid: () => Effect.succeed(stubDid),
    resolveHandle: () => Effect.succeed(stubHandle),
    resolveIdentity: () =>
      Effect.succeed(
        IdentityInfo.make({ did: stubDid, handle: stubHandle, didDoc: {} })
      ),
    cacheProfile: () => Effect.void
  })
);

const buildDeriveAppLayer = (storeRoot: string) => {
  const { layer: outputLayer } = makeOutputCapture();
  return buildCliTestLayer({
    storeRoot,
    outputLayer,
    extraLayers: [
      engineLayer,
      checkpointsLayer,
      outputManagerLayer,
      filterLibraryLayer,
      identityLayer
    ]
  });
};

describe("CLI derive command", () => {
  test("auto-creates target store when missing", async () => {
    const run = Command.run(deriveCommand, {
      name: "skygent",
      version: "0.0.0"
    });
    await withTempDir(async (storeRoot) => {
      const appLayer = buildDeriveAppLayer(storeRoot);
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          const sourceName = Schema.decodeUnknownSync(StoreName)("source");
          const targetName = Schema.decodeUnknownSync(StoreName)("target");

          yield* manager.createStore(sourceName, defaultStoreConfig);
          yield* run([
            "node",
            "skygent",
            "source",
            "target",
            "--filter-json",
            "{\"_tag\":\"All\"}"
          ]);

          return yield* manager.getStore(targetName);
        }).pipe(Effect.provide(appLayer))
      );

      expect(Option.isSome(result)).toBe(true);
    });
  });

  test("shows contextual hint when source looks like a subcommand", async () => {
    const run = Command.run(deriveCommand, {
      name: "skygent",
      version: "0.0.0"
    });
    await withTempDir(async (storeRoot) => {
      const appLayer = buildDeriveAppLayer(storeRoot);
      const result = await Effect.runPromise(
        run([
          "node",
          "skygent",
          "list",
          "target",
          "--dry-run"
        ]).pipe(
          Effect.provide(appLayer),
          Effect.either
        )
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(CliInputError);
        expect(result.left.message).toContain("not subcommands");
        expect(result.left.message).toContain("derive");
        expect(result.left.message).toContain("<source> <target>");
      }
    });
  });
});
