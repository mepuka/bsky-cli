#!/usr/bin/env bun
import { Command, HelpDoc, ValidationError } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { app } from "./src/cli/app.js";
import pkg from "./package.json" with { type: "json" };
import {
  type AgentErrorPayload,
  CliInputError,
  CliJsonError,
  parseAgentErrorPayload
} from "./src/cli/errors.js";
import { logErrorEvent } from "./src/cli/logging.js";
import { CliOutput } from "./src/cli/output.js";
import { exitCodeFor, exitCodeFromExit } from "./src/cli/exit-codes.js";
import { BskyError, StoreNotFound } from "./src/domain/errors.js";

const cli = Command.run(app, {
  name: "skygent",
  version: pkg.version
});

const stripAnsi = (value: string) =>
  value.replace(/\u001b\[[0-9;]*m/g, "");

const formatValidationError = (error: ValidationError.ValidationError) => {
  const text = HelpDoc.toAnsiText(error.error).trimEnd();
  return stripAnsi(text.length > 0 ? text : "Invalid command input. Use --help for usage.");
};

const getAgentPayload = (error: unknown): AgentErrorPayload | undefined => {
  if (error instanceof CliJsonError || error instanceof CliInputError) {
    return parseAgentErrorPayload(error.message);
  }
  return undefined;
};

const formatError = (error: unknown, agentPayload?: AgentErrorPayload) => {
  if (agentPayload) {
    return agentPayload.message;
  }
  if (ValidationError.isValidationError(error)) {
    return formatValidationError(error);
  }
  if (error instanceof CliJsonError) {
    return error.message;
  }
  if (error instanceof CliInputError) {
    return error.message;
  }
  if (error instanceof StoreNotFound) {
    return `Store \"${error.name}\" does not exist.`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { readonly message?: unknown }).message === "string"
  ) {
    return (error as { readonly message: string }).message;
  }
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return JSON.stringify(error);
  }
  return String(error);
};

const errorType = (error: unknown, agentPayload?: AgentErrorPayload): string => {
  if (agentPayload) return agentPayload.error;
  if (ValidationError.isValidationError(error)) return "ValidationError";
  if (error instanceof Error) return error.name;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return String((error as { readonly _tag?: unknown })._tag ?? "UnknownError");
  }
  return "UnknownError";
};

const errorDetails = (
  error: unknown,
  agentPayload?: AgentErrorPayload
): Record<string, unknown> | undefined => {
  if (agentPayload) {
    return { error: agentPayload };
  }
  if (error instanceof StoreNotFound) {
    return { error: { _tag: "StoreNotFound", name: error.name } };
  }
  if (error instanceof BskyError) {
    return {
      error: {
        _tag: "BskyError",
        ...(error.operation ? { operation: error.operation } : {}),
        ...(typeof error.status === "number" ? { status: error.status } : {})
      }
    };
  }
  if (error instanceof CliJsonError || error instanceof CliInputError) {
    return undefined;
  }
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return { error };
  }
  return undefined;
};

const errorSuggestion = (
  error: unknown,
  agentPayload?: AgentErrorPayload
): string | undefined => {
  if (agentPayload?.fix) return agentPayload.fix;
  if (error instanceof StoreNotFound) {
    return `Run: skygent store create ${error.name}`;
  }
  return undefined;
};

const program = cli(process.argv).pipe(
  Effect.tapError((error) => {
    if (ValidationError.isValidationError(error)) {
      return Effect.void;
    }
    const agentPayload = getAgentPayload(error);
    return logErrorEvent(formatError(error, agentPayload), {
      code: exitCodeFor(error),
      type: errorType(error, agentPayload),
      suggestion: errorSuggestion(error, agentPayload),
      ...errorDetails(error, agentPayload)
    });
  }),
  Effect.provide(Layer.mergeAll(BunContext.layer, CliOutput.layer))
);

BunRuntime.runMain({
  disableErrorReporting: true,
  disablePrettyLogger: true,
  teardown: (exit, onExit) => {
    const code = exitCodeFromExit(exit);
    onExit(code);
    if (typeof process !== "undefined") {
      process.exit(code);
    }
  }
})(program);
