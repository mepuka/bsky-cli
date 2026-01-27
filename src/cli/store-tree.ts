import * as Doc from "@effect/printer/Doc";
import { Chunk, Context, Effect, Option } from "effect";
import { StoreIndex } from "../services/store-index.js";
import { StoreManager } from "../services/store-manager.js";
import { LineageStore } from "../services/lineage-store.js";
import { DerivationValidator } from "../services/derivation-validator.js";
import { SyncCheckpointStore } from "../services/sync-checkpoint-store.js";
import { StoreEventLog } from "../services/store-event-log.js";
import { DataSource } from "../domain/sync.js";
import type { FilterExpr } from "../domain/filter.js";
import { formatFilterExpr } from "../domain/filter-describe.js";
import type { StoreName } from "../domain/primitives.js";
import type { StoreRef } from "../domain/store.js";
import type { StoreLineage } from "../domain/derivation.js";

export type StoreTreeFormat = "tree" | "table" | "json";

type StoreTreeNode = {
  readonly name: StoreName;
  readonly posts: number;
  readonly derived: boolean;
  readonly status: "source" | "ready" | "stale" | "unknown";
  readonly syncStatus?: "current" | "stale" | "unknown" | "empty";
  readonly lastSync?: string;
};

type StoreTreeEdge = {
  readonly source: StoreName;
  readonly target: StoreName;
  readonly filter: FilterExpr;
  readonly mode: string;
  readonly derivedAt?: string;
};

export type StoreTreeData = {
  readonly roots: ReadonlyArray<StoreName>;
  readonly stores: ReadonlyArray<StoreTreeNode>;
  readonly edges: ReadonlyArray<StoreTreeEdge>;
};

const formatCount = (value: number) =>
  new Intl.NumberFormat("en-US").format(value);

const formatPercent = (value: number) => {
  if (!Number.isFinite(value)) return "0%";
  const rounded = value < 1 ? value.toFixed(2) : value.toFixed(1);
  return `${rounded}%`;
};

const statusLabel = (status: StoreTreeNode["status"]) =>
  status === "source" ? "SOURCE" : status.toUpperCase();

const syncLabel = (status: StoreTreeNode["syncStatus"]) =>
  status ? status.toUpperCase() : "UNKNOWN";

const formatMode = (mode: string) =>
  mode === "EventTime"
    ? "event-time"
    : mode === "DeriveTime"
      ? "derive-time"
      : mode.toLowerCase();

const formatMatchRate = (
  source: StoreTreeNode | undefined,
  target: StoreTreeNode | undefined
) => {
  if (!source || !target || source.posts <= 0) return "-";
  const rate = (target.posts / source.posts) * 100;
  return formatPercent(rate);
};

type DerivationValidatorService = Context.Tag.Service<typeof DerivationValidator>;
type StoreEventLogService = Context.Tag.Service<typeof StoreEventLog>;
type SyncCheckpointStoreService = Context.Tag.Service<typeof SyncCheckpointStore>;

const resolveDerivedStatus = (
  store: StoreName,
  lineage: Option.Option<StoreLineage>,
  validator: DerivationValidatorService
) =>
  Effect.gen(function* () {
    if (Option.isNone(lineage) || !lineage.value.isDerived) {
      return "source" as const;
    }
    const sources = lineage.value.sources;
    if (sources.length === 0) {
      return "unknown" as const;
    }
    const staleFlags = yield* Effect.forEach(
      sources,
      (source) => validator.isStale(store, source.storeName),
      { discard: false }
    );
    return staleFlags.some(Boolean) ? ("stale" as const) : ("ready" as const);
  });

const resolveSyncInfo = (
  storeRef: StoreRef,
  eventLog: StoreEventLogService,
  checkpoints: SyncCheckpointStoreService
) =>
  Effect.gen(function* () {
    const lastEventIdOption = yield* eventLog.getLastEventId(storeRef);
    if (Option.isNone(lastEventIdOption)) {
      return { syncStatus: "empty" as const };
    }
    const [timelineCheckpoint, notificationsCheckpoint] = yield* Effect.all([
      checkpoints.load(storeRef, DataSource.timeline()),
      checkpoints.load(storeRef, DataSource.notifications())
    ]);
    const candidates = [timelineCheckpoint, notificationsCheckpoint]
      .filter(Option.isSome)
      .map((option) => option.value);
    if (candidates.length === 0) {
      return { syncStatus: "unknown" as const };
    }
    const latest = candidates.sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
    )[0];
    if (!latest) {
      return { syncStatus: "unknown" as const };
    }
    const current =
      latest.lastEventId && latest.lastEventId === lastEventIdOption.value
        ? ("current" as const)
        : ("stale" as const);
    return { syncStatus: current, lastSync: latest.updatedAt.toISOString() };
  });

export const buildStoreTreeData = Effect.gen(function* () {
  const index = yield* StoreIndex;
  const manager = yield* StoreManager;
  const lineageStore = yield* LineageStore;
  const validator = yield* DerivationValidator;
  const eventLog = yield* StoreEventLog;
  const checkpoints = yield* SyncCheckpointStore;

  const stores = yield* manager.listStores();
  const storeRefs = Chunk.toReadonlyArray(stores).map((meta) => ({
    name: meta.name,
    root: meta.root
  }));

  const storeInfo = yield* Effect.forEach(
    storeRefs,
    (storeRef) =>
      Effect.gen(function* () {
        const posts = yield* index.count(storeRef);
        const lineage = yield* lineageStore.get(storeRef.name);
        const status = yield* resolveDerivedStatus(storeRef.name, lineage, validator);
        const syncInfo =
          status === "source"
            ? yield* resolveSyncInfo(storeRef, eventLog, checkpoints)
            : undefined;

        const info: StoreTreeNode = {
          name: storeRef.name,
          posts,
          derived: Option.isSome(lineage) && lineage.value.isDerived,
          status,
          ...(syncInfo ? syncInfo : {})
        } satisfies StoreTreeNode;
        return info;
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

  const edges: StoreTreeEdge[] = [];
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
    stores: storeInfo,
    edges
  } satisfies StoreTreeData;
});

const buildMaps = (data: StoreTreeData) => {
  const storeMap = new Map<string, StoreTreeNode>(
    data.stores.map((store) => [store.name, store])
  );
  const edgeMap = new Map<string, StoreTreeEdge[]>();
  for (const edge of data.edges) {
    const key = edge.source;
    const existing = edgeMap.get(key) ?? [];
    edgeMap.set(key, [...existing, edge]);
  }
  return { storeMap, edgeMap };
};

export const renderStoreTree = (data: StoreTreeData): string => {
  const { storeMap, edgeMap } = buildMaps(data);
  const docs: Array<Doc.Doc<never>> = [];

  const edgeLabel = (edge: StoreTreeEdge, target: StoreTreeNode | undefined) => {
    const sourceInfo = storeMap.get(edge.source);
    const parts = [
      `filter:${formatFilterExpr(edge.filter)}`,
      `mode:${formatMode(edge.mode)}`
    ];
    const match = formatMatchRate(sourceInfo, target);
    if (match !== "-") {
      parts.push(`match:${match}`);
    }
    return `[${parts.join(" | ")}] ->`;
  };

  const renderNode = (
    name: StoreName,
    prefix: string,
    isLast: boolean,
    edge?: StoreTreeEdge,
    path: ReadonlyArray<StoreName> = [],
    isRoot = false
  ) => {
    const info = storeMap.get(name);
    const derived = info?.derived ?? false;
    const arrowLabel = edge ? edgeLabel(edge, info) : "";
    const labelDoc = Doc.hsep(
      [
        arrowLabel ? Doc.text(arrowLabel) : null,
        Doc.text(name),
        Doc.text(`(${derived ? "derived" : "source"})`)
      ].filter((value): value is Doc.Doc<never> => value !== null)
    );
    const connector = isRoot ? "" : isLast ? "`-- " : "|-- ";
    docs.push(Doc.cat(Doc.text(`${prefix}${connector}`), labelDoc));

    if (path.includes(name)) {
      const loopPrefix = prefix + (prefix.length === 0 ? "" : isLast ? "    " : "|   ");
      docs.push(Doc.text(`${loopPrefix}|-- (cycle detected)`));
      return;
    }

    const nextPrefix = prefix + (isRoot ? "" : isLast ? "    " : "|   ");
    const details: string[] = [];

    if (info) {
      let postsLine = `Posts: ${formatCount(info.posts)}`;
      if (edge) {
        const sourceInfo = storeMap.get(edge.source);
        const match = formatMatchRate(sourceInfo, info);
        if (match !== "-") {
          postsLine += ` (${match} match)`;
        }
      }
      details.push(postsLine);
      if (derived) {
        details.push(`Status: ${statusLabel(info.status)}`);
      } else {
        details.push(`Sync: ${syncLabel(info.syncStatus)}`);
        if (info.lastSync) {
          details.push(`Last sync: ${info.lastSync}`);
        }
      }
    }

    if (edge?.derivedAt) {
      details.push(`Derived at: ${edge.derivedAt}`);
    }

    const children = edgeMap.get(name) ?? [];
    const items = [
      ...details.map((detail) => ({ type: "detail" as const, detail })),
      ...children.map((child) => ({ type: "child" as const, child }))
    ];

    const nextPath = [...path, name];
    items.forEach((item, index) => {
      const lastItem = index === items.length - 1;
      if (item.type === "detail") {
        const line = `${nextPrefix}${lastItem ? "`-- " : "|-- "}${item.detail}`;
        docs.push(Doc.text(line));
      } else {
        renderNode(item.child.target, nextPrefix, lastItem, item.child, nextPath);
      }
    });
  };

  data.roots.forEach((root, index) => {
    renderNode(root, "", index === data.roots.length - 1, undefined, [], true);
    if (index < data.roots.length - 1) {
      docs.push(Doc.text(""));
    }
  });

  return Doc.render(Doc.vsep(docs), { style: "pretty" });
};

const renderTable = (
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>
) => {
  const widths = headers.map((value, index) =>
    Math.max(
      value.length,
      ...rows.map((row) => (row[index] ?? "").length)
    )
  );
  const formatRow = (row: ReadonlyArray<string>) =>
    row
      .map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0))
      .join("  ");
  const header = formatRow(headers);
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  const body = rows.map(formatRow);
  return [header, separator, ...body].join("\n");
};

const renderTableSection = (
  label: string,
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>
) => {
  if (rows.length === 0) {
    return `${label}\n(no rows)`;
  }
  return `${label}\n${renderTable(headers, rows)}`;
};

export const renderStoreTreeTable = (data: StoreTreeData): string => {
  const rows: Array<ReadonlyArray<string>> = [];
  const edgeRows: Array<ReadonlyArray<string>> = [];

  const rootSet = new Set(data.roots);
  const { storeMap } = buildMaps(data);

  const storeRows = [...data.stores].sort((a, b) =>
    String(a.name).localeCompare(String(b.name))
  );
  for (const store of storeRows) {
    rows.push([
      store.name,
      store.derived ? "derived" : "source",
      rootSet.has(store.name) ? "yes" : "no",
      formatCount(store.posts),
      statusLabel(store.status),
      store.derived ? "-" : syncLabel(store.syncStatus),
      store.derived ? "-" : store.lastSync ?? "-"
    ]);
  }

  const sortedEdges = [...data.edges].sort((a, b) =>
    `${a.source}-${a.target}`.localeCompare(`${b.source}-${b.target}`)
  );
  for (const edge of sortedEdges) {
    const sourceInfo = storeMap.get(edge.source);
    const targetInfo = storeMap.get(edge.target);
    edgeRows.push([
      edge.source,
      edge.target,
      formatFilterExpr(edge.filter),
      formatMode(edge.mode),
      formatMatchRate(sourceInfo, targetInfo),
      edge.derivedAt ?? "-"
    ]);
  }

  const sections = [
    renderTableSection(
      "Stores",
      ["Store", "Kind", "Root", "Posts", "Status", "Sync", "Last Sync"],
      rows
    ),
    renderTableSection(
      "Derivations",
      ["Source", "Target", "Filter", "Mode", "Match", "Derived At"],
      edgeRows
    )
  ];

  return sections.join("\n\n");
};

export const renderStoreTreeJson = (data: StoreTreeData) => ({
  roots: data.roots,
  stores: data.stores,
  edges: data.edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    filter: formatFilterExpr(edge.filter),
    mode: formatMode(edge.mode),
    derivedAt: edge.derivedAt
  }))
});
