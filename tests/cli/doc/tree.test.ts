import { describe, expect, test } from "bun:test";
import { renderTree } from "../../../src/cli/doc/tree.js";
import { renderPlain } from "../../../src/cli/doc/render.js";
import * as Doc from "@effect/printer/Doc";
import type { Annotation } from "../../../src/cli/doc/annotation.js";

type Node = { id: string; children: Array<{ node: Node; edge: void }> };

const node = (id: string, ...kids: Node[]): Node => ({
  id,
  children: kids.map((k) => ({ node: k, edge: undefined as void }))
});

const simpleConfig = {
  children: (n: Node) => n.children,
  renderNode: (n: Node) => Doc.text(n.id) as Doc.Doc<Annotation>,
  key: (n: Node) => n.id,
};

describe("tree renderer", () => {
  test("simple tree with connectors", () => {
    const root = node("A", node("B", node("C")));
    const output = renderPlain(renderTree([root], simpleConfig));
    expect(output).toContain("A");
    expect(output).toContain("└── B");
    expect(output).toContain("    └── C");
  });

  test("multiple children", () => {
    const root = node("A", node("B"), node("C"));
    const output = renderPlain(renderTree([root], simpleConfig));
    expect(output).toContain("├── B");
    expect(output).toContain("└── C");
  });

  test("DAG — shared child appears under both parents (not a cycle)", () => {
    // A→C and B→C: C appears twice, neither is a cycle
    const c1 = node("C");
    const c2 = node("C");
    const a = node("A", c1);
    const b = node("B", c2);
    const output = renderPlain(renderTree([a, b], simpleConfig));
    // C should appear under both without cycle detection
    const matches = output.match(/\bC\b/g);
    expect(matches?.length).toBe(2);
    expect(output).not.toContain("cycle detected");
  });

  test("actual cycle: A→B→A shows cycle detected", () => {
    const a: Node = { id: "A", children: [] };
    const b: Node = { id: "B", children: [{ node: a, edge: undefined as void }] };
    a.children = [{ node: b, edge: undefined as void }];
    const output = renderPlain(renderTree([a], simpleConfig));
    expect(output).toContain("cycle detected");
  });

  test("edge context passed to renderNode", () => {
    type ENode = { id: string; kids: Array<{ node: ENode; edge: string }> };
    const root: ENode = {
      id: "root",
      kids: [{ node: { id: "child", kids: [] }, edge: "my-edge" }]
    };
    const edges: string[] = [];
    renderTree<ENode, string>([root], {
      children: (n) => n.kids,
      renderNode: (n, ctx) => {
        if (ctx.edge) edges.push(ctx.edge);
        return Doc.text(n.id) as Doc.Doc<Annotation>;
      },
      key: (n) => n.id,
    });
    expect(edges).toEqual(["my-edge"]);
  });

  test("empty tree produces empty doc", () => {
    const output = renderPlain(renderTree([], simpleConfig));
    expect(output).toBe("");
  });
});
