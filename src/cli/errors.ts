import { Schema } from "effect";

export class CliJsonError extends Schema.TaggedError<CliJsonError>()(
  "CliJsonError",
  {
    message: Schema.String,
    cause: Schema.Defect
  }
) {}

export class CliInputError extends Schema.TaggedError<CliInputError>()(
  "CliInputError",
  {
    message: Schema.String,
    cause: Schema.Defect
  }
) {}

export type AgentErrorPayload = {
  readonly error: string;
  readonly message: string;
  readonly received?: unknown;
  readonly expected?: unknown;
  readonly fix?: string;
  readonly details?: ReadonlyArray<string>;
  readonly validTags?: ReadonlyArray<string>;
};

export const formatAgentError = (payload: AgentErrorPayload) =>
  JSON.stringify(payload, null, 2);

const looksLikeJson = (value: string) => {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
};

const isAgentErrorPayload = (value: unknown): value is AgentErrorPayload => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("error" in value) || !("message" in value)) {
    return false;
  }
  const error = (value as { readonly error?: unknown }).error;
  const message = (value as { readonly message?: unknown }).message;
  return typeof error === "string" && typeof message === "string";
};

export const parseAgentErrorPayload = (message: string): AgentErrorPayload | undefined => {
  if (!looksLikeJson(message)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(message) as unknown;
    return isAgentErrorPayload(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};
