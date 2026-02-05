import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { ActorId, Did, Handle, Hashtag, StoreName, Timestamp } from "../../src/domain/primitives.js";

describe("primitives", () => {
  test("Handle accepts valid values", () => {
    const decoded = Schema.decodeUnknownSync(Handle)("alice.bsky");
    expect(String(decoded)).toBe("alice.bsky");
  });

  test("Handle rejects invalid values", () => {
    expect(() => Schema.decodeUnknownSync(Handle)("@bad")).toThrow();
  });

  test("Hashtag accepts valid values", () => {
    const decoded = Schema.decodeUnknownSync(Hashtag)("#effect");
    expect(String(decoded)).toBe("#effect");
  });

  test("StoreName accepts valid values", () => {
    const decoded = Schema.decodeUnknownSync(StoreName)("arsenal");
    expect(String(decoded)).toBe("arsenal");
  });

  test("Did accepts valid values", () => {
    const decoded = Schema.decodeUnknownSync(Did)("did:plc:example");
    expect(String(decoded)).toBe("did:plc:example");
  });

  test("Timestamp decodes ISO string", () => {
    const decoded = Schema.decodeUnknownSync(Timestamp)("2024-01-01T00:00:00.000Z");
    expect(decoded).toBeInstanceOf(Date);
  });

  test("ActorId lowercases non-DID input", () => {
    const decoded = Schema.decodeUnknownSync(ActorId)("Alice.bsky.social");
    expect(String(decoded)).toBe("alice.bsky.social");
  });

  test("ActorId preserves DID case", () => {
    const decoded = Schema.decodeUnknownSync(ActorId)("did:plc:ABC123");
    expect(String(decoded)).toBe("did:plc:ABC123");
  });

  test("ActorId preserves uppercase DID scheme", () => {
    const decoded = Schema.decodeUnknownSync(ActorId)("DID:plc:abc");
    expect(String(decoded)).toBe("DID:plc:abc");
  });

  test("ActorId accepts already-lowercase handle", () => {
    const decoded = Schema.decodeUnknownSync(ActorId)("alice.bsky.social");
    expect(String(decoded)).toBe("alice.bsky.social");
  });
});
