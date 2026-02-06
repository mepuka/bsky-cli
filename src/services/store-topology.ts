import { Chunk, Effect, Option } from "effect";
import type { FilterExpr } from "../domain/filter.js";
import type { StoreName } from "../domain/primitives.js";
import { StoreRef } from "../domain/store.js";
import type { StoreSource as DerivationSource } from "../domain/derivation.js";
import { StoreIndexError, StoreIoError, StoreSourcesError } from "../domain/errors.js";
import { StoreManager } from "./store-manager.js";
import { StoreIndex } from "./store-index.js";
import { LineageStore } from "./lineage-store.js";
import { StoreSources } from "./store-sources.js";

export type StoreTopologyNode = {
  readonly name: StoreName;
  readonly derived: boolean;
  readonly posts: number;
  readonly sources: number;
};

export type StoreTopologyEdge = {
  readonly source: StoreName;
  readonly target: StoreName;
  readonly filter: FilterExpr;
  readonly mode: DerivationSource["evaluationMode"];
  readonly derivedAt?: string;
};

export type StoreTopologyData = {
  readonly roots: ReadonlyArray<StoreName>;
  readonly nodes: ReadonlyArray<StoreTopologyNode>;
  readonly edges: ReadonlyArray<StoreTopologyEdge>;
};

export type StoreTopologyError = StoreIoError | StoreIndexError | StoreSourcesError;

export class StoreTopology extends Effect.Service<StoreTopology>()("@skygent/StoreTopology", {
  effect: Effect.gen(function* () {
      const manager = yield* StoreManager;
      const index = yield* StoreIndex;
      const lineageStore = yield* LineageStore;
      const storeSources = yield* StoreSources;

      const build = Effect.fn("StoreTopology.build")(() =>
        Effect.gen(function* () {
          const stores = yield* manager.listStores();
          const storeRefs = Chunk.toReadonlyArray(stores).map((meta) =>
            StoreRef.make({ name: meta.name, root: meta.root })
          );

          const nodes = yield* Effect.forEach(
            storeRefs,
            (storeRef) =>
              Effect.gen(function* () {
                const posts = yield* index.count(storeRef);
                const lineage = yield* lineageStore.get(storeRef.name);
                const sources = yield* storeSources.list(storeRef);
                return {
                  name: storeRef.name,
                  derived: Option.isSome(lineage) && lineage.value.isDerived,
                  posts,
                  sources: sources.length
                } satisfies StoreTopologyNode;
              }),
            { discard: false }
          );

          const lineageEntries = yield* Effect.forEach(
            storeRefs,
            (storeRef) =>
              lineageStore.get(storeRef.name).pipe(
                Effect.map((lineage) => ({ store: storeRef.name, lineage }))
              ),
            { discard: false }
          );

          const edges: StoreTopologyEdge[] = [];
          for (const entry of lineageEntries) {
            if (Option.isNone(entry.lineage) || !entry.lineage.value.isDerived) {
              continue;
            }
            for (const source of entry.lineage.value.sources) {
              edges.push({
                source: source.storeName,
                target: entry.store,
                filter: source.filter,
                mode: source.evaluationMode,
                derivedAt: source.derivedAt.toISOString()
              });
            }
          }

          const targets = new Set(edges.map((edge) => edge.target));
          const roots = storeRefs
            .map((store) => store.name)
            .filter((name) => !targets.has(name));

          return {
            roots,
            nodes,
            edges
          } satisfies StoreTopologyData;
        })
      );

    return { build };
  })
}) {
  static readonly layer = StoreTopology.Default;
}
