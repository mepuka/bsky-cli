import { HelpDoc, ValidationError } from "@effect/cli";
import { BskyError, StoreAlreadyExists, StoreNotFound } from "../domain/errors.js";
import {
  type AgentErrorPayload,
  CliInputError,
  CliJsonError,
  parseAgentErrorPayload
} from "./errors.js";

export type CliErrorEnvelope = {
  readonly error: {
    readonly type: string;
    readonly code: string;
    readonly exitCode: number;
    readonly message: string;
    readonly suggestion?: string;
    readonly details?: Record<string, unknown>;
  };
};

const stripAnsi = (value: string) =>
  value.replace(/\u001b\[[0-9;]*m/g, "");

const formatValidationError = (error: ValidationError.ValidationError) => {
  const text = HelpDoc.toAnsiText(error.error).trimEnd();
  return stripAnsi(text.length > 0 ? text : "Invalid command input. Use --help for usage.");
};

export const getAgentPayload = (error: unknown): AgentErrorPayload | undefined => {
  if (error instanceof CliJsonError || error instanceof CliInputError) {
    return parseAgentErrorPayload(error.message);
  }
  return undefined;
};

export const formatErrorMessage = (error: unknown, agentPayload?: AgentErrorPayload) => {
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
    return `Store "${error.name}" does not exist.`;
  }
  if (error instanceof StoreAlreadyExists) {
    return `Store "${error.name}" already exists.`;
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

export const errorType = (error: unknown, agentPayload?: AgentErrorPayload): string => {
  if (agentPayload) return agentPayload.error;
  if (ValidationError.isValidationError(error)) return "ValidationError";
  if (error instanceof Error) return error.name;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return String((error as { readonly _tag?: unknown })._tag ?? "UnknownError");
  }
  return "UnknownError";
};

export const errorCode = (error: unknown, agentPayload?: AgentErrorPayload): string => {
  if (agentPayload) return agentPayload.error;
  if (ValidationError.isValidationError(error)) return "CLI_VALIDATION";
  if (error instanceof CliInputError) return "CLI_INPUT";
  if (error instanceof CliJsonError) return "CLI_JSON";
  if (error instanceof StoreNotFound) return "STORE_NOT_FOUND";
  if (error instanceof StoreAlreadyExists) return "STORE_ALREADY_EXISTS";
  if (error instanceof BskyError) return "BSKY_ERROR";
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return String((error as { readonly _tag?: unknown })._tag ?? "UNKNOWN");
  }
  return "UNKNOWN";
};

export const errorDetails = (
  error: unknown,
  agentPayload?: AgentErrorPayload
): Record<string, unknown> | undefined => {
  if (agentPayload) {
    return { error: agentPayload };
  }
  if (error instanceof StoreNotFound) {
    return { error: { _tag: "StoreNotFound", name: error.name } };
  }
  if (error instanceof StoreAlreadyExists) {
    return { error: { _tag: "StoreAlreadyExists", name: error.name } };
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

export const errorSuggestion = (
  error: unknown,
  agentPayload?: AgentErrorPayload
): string | undefined => {
  if (agentPayload?.fix) return agentPayload.fix;
  if (error instanceof StoreNotFound) {
    return `Run: skygent store create ${error.name}`;
  }
  if (error instanceof StoreAlreadyExists) {
    return "Run: skygent store list";
  }
  return undefined;
};

export const makeErrorEnvelope = (
  error: unknown,
  code: number,
  agentPayload?: AgentErrorPayload
): CliErrorEnvelope => {
  const message = formatErrorMessage(error, agentPayload);
  const type = errorType(error, agentPayload);
  const stableCode = errorCode(error, agentPayload);
  const suggestion = errorSuggestion(error, agentPayload);
  const details = errorDetails(error, agentPayload);
  return {
    error: {
      type,
      code: stableCode,
      exitCode: code,
      message,
      ...(suggestion ? { suggestion } : {}),
      ...(details ? { details } : {})
    }
  };
};

export const formatErrorEnvelope = (envelope: CliErrorEnvelope) =>
  JSON.stringify(envelope, null, 2);

export const jsonErrorsEnabled = () => {
  const value = process.env.SKYGENT_JSON_ERRORS;
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
};
