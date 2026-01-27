import { Effect, ParseResult, Schema } from "effect";
import { CliJsonError } from "./errors.js";

const formatParseError = (error: ParseResult.ParseError) => {
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error);
  if (issues.length === 0) {
    return ParseResult.TreeFormatter.formatErrorSync(error);
  }
  return issues
    .map((issue) => {
      const path =
        issue.path.length > 0
          ? issue.path.map((entry) => String(entry)).join(".")
          : "value";
      return `${path}: ${issue.message}`;
    })
    .join("\n");
};

type DecodeJsonOptions = {
  readonly formatter?: (error: ParseResult.ParseError, raw: string) => string;
};

export const decodeJson = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  input: string,
  options?: DecodeJsonOptions
) =>
  Schema.decodeUnknown(Schema.parseJson(schema))(input).pipe(
    Effect.mapError((error) => {
      const message = ParseResult.isParseError(error)
        ? options?.formatter
          ? options.formatter(error, input)
          : formatParseError(error)
        : String(error);
      return CliJsonError.make({ message, cause: error });
    })
  );
