import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { CliInputError, CliJsonError } from "../../src/cli/errors.js";
import { errorCode, makeErrorEnvelope } from "../../src/cli/error-envelope.js";
import { BskyError, StoreNotFound } from "../../src/domain/errors.js";
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
