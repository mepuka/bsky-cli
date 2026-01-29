import * as Doc from "@effect/printer/Doc";
import type { Annotation } from "./annotation.js";
import { connector } from "./primitives.js";

type SDoc = Doc.Doc<Annotation>;

export interface RenderContext<E> {
  readonly depth: number;
  readonly isRoot: boolean;
  readonly isLast: boolean;
  readonly edge?: E;
}

export interface TreeConfig<T, E = void> {
  readonly children: (node: T) => ReadonlyArray<{ node: T; edge: E }>;
  /** Return a single Doc (single-line) or an array of Docs (multi-line node).
   *  First element is the headline; subsequent elements are continuation lines
   *  that receive the content prefix (│ or spaces) without a connector. */
  readonly renderNode: (node: T, ctx: RenderContext<E>) => SDoc | ReadonlyArray<SDoc>;
  readonly details?: (node: T, ctx: RenderContext<E>) => ReadonlyArray<SDoc>;
  readonly key: (node: T) => string;
}

interface WalkParams<T, E> {
  readonly prefix: string;
  readonly isLast: boolean;
  readonly isRoot: boolean;
  readonly path: ReadonlyArray<string>;
  readonly edge: E | undefined;
  readonly depth: number;
  readonly docs: Array<SDoc>;
}

const walkNode = <T, E>(
  node: T,
  config: TreeConfig<T, E>,
  params: WalkParams<T, E>
): void => {
  const { prefix, isLast, isRoot, path, edge, depth, docs } = params;
  const key = config.key(node);
  const ctx: RenderContext<E> = { depth, isRoot, isLast, edge: edge as E };

  // 1. Headline with connector prefix (+ continuation lines for multi-line nodes)
  const rendered = config.renderNode(node, ctx);
  const nodeLines = Array.isArray(rendered) ? rendered : [rendered];
  const connectorStr = isRoot ? "" : isLast ? "└── " : "├── ";
  const contentPrefix = prefix + (isRoot ? "" : isLast ? "    " : "│   ");
  nodeLines.forEach((line, i) => {
    if (i === 0) {
      docs.push(Doc.cat(connector(prefix + connectorStr), line));
    } else {
      docs.push(Doc.cat(connector(contentPrefix), line));
    }
  });

  // 2. Cycle check: path-based
  if (path.includes(key)) {
    const nextPrefix = prefix + (isRoot ? "" : isLast ? "    " : "│   ");
    docs.push(Doc.cat(
      connector(nextPrefix + "└── "),
      Doc.annotate(Doc.text("(cycle detected)"), "cycle" as Annotation)
    ));
    return;
  }

  // 3. Compute child prefix
  const nextPrefix = prefix + (isRoot ? "" : isLast ? "    " : "│   ");
  const nextPath = [...path, key];

  // 4. Collect detail lines and children
  const detailDocs = config.details?.(node, ctx) ?? [];
  const childEntries = config.children(node);
  const items: Array<
    | { readonly type: "detail"; readonly doc: SDoc }
    | { readonly type: "child"; readonly node: T; readonly edge: E }
  > = [
    ...detailDocs.map((d) => ({ type: "detail" as const, doc: d })),
    ...childEntries.map((c) => ({ type: "child" as const, node: c.node, edge: c.edge }))
  ];

  // 5. Render each item with proper connectors
  items.forEach((item, i) => {
    const itemIsLast = i === items.length - 1;
    if (item.type === "detail") {
      const itemConnector = itemIsLast ? "└── " : "├── ";
      docs.push(Doc.cat(
        connector(nextPrefix + itemConnector),
        item.doc
      ));
    } else {
      walkNode(item.node, config, {
        prefix: nextPrefix,
        isLast: itemIsLast,
        isRoot: false,
        path: nextPath,
        edge: item.edge,
        depth: depth + 1,
        docs
      });
    }
  });
};

export const renderTree = <T, E = void>(
  roots: ReadonlyArray<T>,
  config: TreeConfig<T, E>
): SDoc => {
  const docs: Array<SDoc> = [];

  roots.forEach((root, i) => {
    walkNode(root, config, {
      prefix: "",
      isLast: i === roots.length - 1,
      isRoot: true,
      path: [],
      edge: undefined,
      depth: 0,
      docs
    });
    if (i < roots.length - 1) {
      docs.push(Doc.empty);
    }
  });

  return Doc.vsep(docs);
};
