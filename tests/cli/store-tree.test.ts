import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { renderStoreTree, renderStoreTreeTable, type StoreTreeData } from "../../src/cli/store-tree.js";
import { Handle, StoreName } from "../../src/domain/primitives.js";

describe("store tree rendering", () => {
  test("renders ASCII tree output", () => {
    const source = Schema.decodeUnknownSync(StoreName)("source-store");
    const child = Schema.decodeUnknownSync(StoreName)("child-store");
    const handle = Schema.decodeUnknownSync(Handle)("alice.bsky.social");

    const data: StoreTreeData = {
      roots: [source],
      stores: [
        { name: source, posts: 10, derived: false, status: "source" },
        { name: child, posts: 2, derived: true, status: "ready" }
      ],
      edges: [
        {
          source,
          target: child,
          filter: { _tag: "Author", handle },
          mode: "EventTime"
        }
      ]
    };

    const output = renderStoreTree(data);
    expect(output).toContain("source-store (source)");
    expect(output).toContain("-> child-store (derived)");
    expect(output).toContain("filter:author:alice.bsky.social");
  });

  test("renders table output", () => {
    const source = Schema.decodeUnknownSync(StoreName)("root");
    const child = Schema.decodeUnknownSync(StoreName)("leaf");
    const handle = Schema.decodeUnknownSync(Handle)("bob.bsky.social");

    const data: StoreTreeData = {
      roots: [source],
      stores: [
        { name: source, posts: 5, derived: false, status: "source" },
        { name: child, posts: 1, derived: true, status: "ready" }
      ],
      edges: [
        {
          source,
          target: child,
          filter: { _tag: "Author", handle },
          mode: "EventTime"
        }
      ]
    };

    const output = renderStoreTreeTable(data);
    expect(output).toContain("Store");
    expect(output).toContain("root");
    expect(output).toContain("leaf");
  });
});
