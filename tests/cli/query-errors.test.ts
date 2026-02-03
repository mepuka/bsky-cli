import { describe, expect, test } from "bun:test";
import { looksLikeFilterExpression } from "../../src/cli/filter-dsl.js";

describe("looksLikeFilterExpression", () => {
  test("detects text: prefix", () => {
    expect(looksLikeFilterExpression("text:epstein")).toBe(true);
    expect(looksLikeFilterExpression("text:hello world")).toBe(true);
  });

  test("detects hashtag: prefix", () => {
    expect(looksLikeFilterExpression("hashtag:#ai")).toBe(true);
    expect(looksLikeFilterExpression("tag:#news")).toBe(true);
  });

  test("detects author: prefix", () => {
    expect(looksLikeFilterExpression("author:alice.bsky.social")).toBe(true);
    expect(looksLikeFilterExpression("from:bob")).toBe(true);
  });

  test("detects date/time prefixes", () => {
    expect(looksLikeFilterExpression("since:24h")).toBe(true);
    expect(looksLikeFilterExpression("until:2024-01-01")).toBe(true);
    expect(looksLikeFilterExpression("age:<24h")).toBe(true);
    expect(looksLikeFilterExpression("date:2024-01-01..2024-01-31")).toBe(true);
  });

  test("detects has: prefix", () => {
    expect(looksLikeFilterExpression("has:images")).toBe(true);
  });

  test("detects language: prefix", () => {
    expect(looksLikeFilterExpression("language:en")).toBe(true);
    expect(looksLikeFilterExpression("lang:ja")).toBe(true);
  });

  test("detects engagement: prefix", () => {
    expect(looksLikeFilterExpression("engagement:minLikes=100")).toBe(true);
  });

  test("detects regex: prefix", () => {
    expect(looksLikeFilterExpression("regex:/hello/i")).toBe(true);
  });

  test("returns false for valid store names", () => {
    expect(looksLikeFilterExpression("my-store")).toBe(false);
    expect(looksLikeFilterExpression("epstein-news")).toBe(false);
    expect(looksLikeFilterExpression("bsky-ai-feed")).toBe(false);
  });

  test("returns false for strings without colons", () => {
    expect(looksLikeFilterExpression("hashtag")).toBe(false);
    expect(looksLikeFilterExpression("text")).toBe(false);
    expect(looksLikeFilterExpression("author")).toBe(false);
  });

  test("returns false for unknown prefixes with colons", () => {
    expect(looksLikeFilterExpression("foo:bar")).toBe(false);
    expect(looksLikeFilterExpression("unknown:value")).toBe(false);
    expect(looksLikeFilterExpression("custom:filter")).toBe(false);
  });

  test("is case insensitive for prefix", () => {
    expect(looksLikeFilterExpression("TEXT:epstein")).toBe(true);
    expect(looksLikeFilterExpression("Hashtag:#ai")).toBe(true);
    expect(looksLikeFilterExpression("AUTHOR:alice")).toBe(true);
  });
});
