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
});
