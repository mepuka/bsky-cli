import { describe, expect, test } from "bun:test";
import { DataSource, dataSourceKey } from "../../src/domain/sync.js";

describe("dataSourceKey", () => {
  test("normalizes jetstream lists for stable keys", () => {
    const first = DataSource.jetstream({
      endpoint: "wss://example",
      collections: ["b", "a"],
      dids: ["did:plc:two", "did:plc:one"],
      compress: true,
      maxMessageSizeBytes: 2048
    });
    const second = DataSource.jetstream({
      endpoint: "wss://example",
      collections: ["a", "b"],
      dids: ["did:plc:one", "did:plc:two"],
      compress: true,
      maxMessageSizeBytes: 2048
    });

    expect(dataSourceKey(first)).toBe(dataSourceKey(second));
  });

  test("includes author feed options in the key", () => {
    const base = DataSource.author("alice.bsky.social");
    const filtered = DataSource.author("alice.bsky.social", {
      filter: "posts_no_replies"
    });
    const includePins = DataSource.author("alice.bsky.social", {
      includePins: true
    });

    expect(dataSourceKey(base)).not.toBe(dataSourceKey(filtered));
    expect(dataSourceKey(base)).not.toBe(dataSourceKey(includePins));
  });

  test("includes thread options in the key", () => {
    const base = DataSource.thread("at://did:plc:example/app.bsky.feed.post/xyz");
    const withDepth = DataSource.thread(
      "at://did:plc:example/app.bsky.feed.post/xyz",
      { depth: 10 }
    );
    const withParentHeight = DataSource.thread(
      "at://did:plc:example/app.bsky.feed.post/xyz",
      { parentHeight: 5 }
    );

    expect(dataSourceKey(base)).not.toBe(dataSourceKey(withDepth));
    expect(dataSourceKey(base)).not.toBe(dataSourceKey(withParentHeight));
  });
});
