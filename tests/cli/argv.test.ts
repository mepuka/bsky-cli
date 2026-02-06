import { describe, expect, test } from "bun:test";
import { relocateGlobalOptions } from "../../src/cli/argv.js";

describe("relocateGlobalOptions", () => {
  test("relocates boolean global after subcommand", () => {
    const input = ["node", "skygent", "query", "my-store", "--compact"];
    expect(relocateGlobalOptions(input)).toEqual([
      "node", "skygent", "--compact", "query", "my-store"
    ]);
  });

  test("relocates value global (separate tokens) after subcommand", () => {
    const input = ["node", "skygent", "query", "my-store", "--output-format", "json"];
    expect(relocateGlobalOptions(input)).toEqual([
      "node", "skygent", "--output-format", "json", "query", "my-store"
    ]);
  });

  test("relocates value global (--flag=value form) after subcommand", () => {
    const input = ["node", "skygent", "query", "my-store", "--output-format=json"];
    expect(relocateGlobalOptions(input)).toEqual([
      "node", "skygent", "--output-format=json", "query", "my-store"
    ]);
  });

  test("leaves globals already before subcommand unchanged", () => {
    const input = ["node", "skygent", "--compact", "query", "my-store"];
    expect(relocateGlobalOptions(input)).toEqual([
      "node", "skygent", "--compact", "query", "my-store"
    ]);
  });

  test("relocates global for non-repeated commands (harmless no-op)", () => {
    const input = ["node", "skygent", "store", "list", "--compact"];
    expect(relocateGlobalOptions(input)).toEqual([
      "node", "skygent", "--compact", "store", "list"
    ]);
  });

  test("returns unchanged when no subcommand found", () => {
    const input = ["node", "skygent", "--help"];
    expect(relocateGlobalOptions(input)).toEqual([
      "node", "skygent", "--help"
    ]);
  });

  test("does not treat a global option value as the subcommand", () => {
    const input = [
      "node", "skygent",
      "--identifier", "store",
      "query", "my-store",
      "--compact"
    ];
    expect(relocateGlobalOptions(input)).toEqual([
      "node", "skygent",
      "--identifier", "store",
      "--compact",
      "query", "my-store"
    ]);
  });

  test("relocates multiple globals", () => {
    const input = ["node", "skygent", "query", "my-store", "--compact", "--output-format", "ndjson"];
    expect(relocateGlobalOptions(input)).toEqual([
      "node", "skygent", "--compact", "--output-format", "ndjson", "query", "my-store"
    ]);
  });

  test("preserves non-global options after subcommand", () => {
    const input = ["node", "skygent", "query", "my-store", "--limit", "10", "--compact"];
    expect(relocateGlobalOptions(input)).toEqual([
      "node", "skygent", "--compact", "query", "my-store", "--limit", "10"
    ]);
  });
});
