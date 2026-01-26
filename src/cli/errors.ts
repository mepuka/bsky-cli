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
