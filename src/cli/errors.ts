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
