import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { CliInputError, CliJsonError } from "../../src/cli/errors.js";
import {
  errorCode,
  errorType,
  errorSuggestion,
  formatErrorMessage,
  makeErrorEnvelope
} from "../../src/cli/error-envelope.js";
import { BskyError, StoreAlreadyExists, StoreNotFound } from "../../src/domain/errors.js";
import { StoreName } from "../../src/domain/primitives.js";

describe("error envelope", () => {
  test("maps CliInputError to CLI_INPUT", () => {
    const error = CliInputError.make({
      message: "bad input",
      cause: { value: "x" }
    });
    expect(errorCode(error)).toBe("CLI_INPUT");
    const envelope = makeErrorEnvelope(error, 2);
    expect(envelope.error.code).toBe("CLI_INPUT");
    expect(envelope.error.exitCode).toBe(2);
    expect(envelope.error.message).toContain("bad input");
  });

  test("maps CliJsonError to CLI_JSON", () => {
    const error = CliJsonError.make({
      message: "bad json",
      cause: { value: "x" }
    });
    expect(errorCode(error)).toBe("CLI_JSON");
  });

  test("maps StoreNotFound to STORE_NOT_FOUND", () => {
    const name = Schema.decodeUnknownSync(StoreName)("missing");
    const error = StoreNotFound.make({ name });
    const envelope = makeErrorEnvelope(error, 2);
    expect(envelope.error.code).toBe("STORE_NOT_FOUND");
    expect(envelope.error.message).toContain("does not exist");
  });

  test("maps BskyError to BSKY_ERROR", () => {
    const error = BskyError.make({
      message: "boom",
      operation: "getPost"
    });
    const envelope = makeErrorEnvelope(error, 1);
    expect(envelope.error.code).toBe("BSKY_ERROR");
    expect(envelope.error.exitCode).toBe(1);
  });
});

describe("errorType", () => {
  const sn = (s: string) => Schema.decodeUnknownSync(StoreName)(s);

  test("returns _tag for StoreNotFound (not the shadowed name field)", () => {
    const error = StoreNotFound.make({ name: sn("posts") });
    expect(errorType(error)).toBe("StoreNotFound");
  });

  test("returns _tag for StoreAlreadyExists (not the shadowed name field)", () => {
    const error = StoreAlreadyExists.make({ name: sn("test") });
    expect(errorType(error)).toBe("StoreAlreadyExists");
  });

  test("returns Error.name for plain Error", () => {
    expect(errorType(new TypeError("bad"))).toBe("TypeError");
  });

  test("returns UnknownError for non-object", () => {
    expect(errorType("string")).toBe("UnknownError");
  });

  test("uses agentPayload when provided", () => {
    expect(errorType(new Error("x"), { error: "AgentErr", message: "m" })).toBe("AgentErr");
  });
});

describe("formatErrorMessage — verb detection", () => {
  const sn = (s: string) => Schema.decodeUnknownSync(StoreName)(s);

  test("adds subcommand hint for verb-like store name", () => {
    const error = StoreNotFound.make({ name: sn("list") });
    const msg = formatErrorMessage(error);
    expect(msg).toContain("looks like a subcommand");
    expect(msg).toContain('Store "list" does not exist.');
  });

  test("no subcommand hint for normal store name", () => {
    const error = StoreNotFound.make({ name: sn("my-feed") });
    const msg = formatErrorMessage(error);
    expect(msg).toBe('Store "my-feed" does not exist.');
  });
});

describe("errorSuggestion — verb detection", () => {
  const sn = (s: string) => Schema.decodeUnknownSync(StoreName)(s);

  test("suggests --help for verb-like store name", () => {
    const error = StoreNotFound.make({ name: sn("list") });
    expect(errorSuggestion(error)).toBe("Run: skygent --help");
  });

  test("suggests store list for normal store name", () => {
    const error = StoreNotFound.make({ name: sn("my-feed") });
    expect(errorSuggestion(error)).toBe("Run: skygent store list (to see available stores)");
  });
});
