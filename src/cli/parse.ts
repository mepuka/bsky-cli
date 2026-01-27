import { Effect, ParseResult, Schema } from "effect";
import { CliJsonError } from "./errors.js";

type FormatParseErrorOptions = {
  readonly label?: string;
  readonly maxIssues?: number;
};

const formatPath = (path: ReadonlyArray<unknown>) =>
  path.length > 0 ? path.map((entry) => String(entry)).join(".") : "value";

const formatParseError = (
  error: ParseResult.ParseError,
  options?: FormatParseErrorOptions
) => {
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error);
  if (issues.length === 0) {
    return ParseResult.TreeFormatter.formatErrorSync(error);
  }

  const jsonParseIssue = issues.find(
    (issue) =>
      issue._tag === "Transformation" &&
      typeof issue.message === "string" &&
      issue.message.startsWith("JSON Parse error")
  );
  if (jsonParseIssue) {
    const header = options?.label
      ? `Invalid JSON input for ${options.label}.`
      : "Invalid JSON input.";
    return [
      header,
      jsonParseIssue.message,
      "Tip: wrap JSON in single quotes to avoid shell escaping issues."
    ].join("\n");
  }

  const maxIssues = options?.maxIssues ?? 6;
  const lines = issues.slice(0, maxIssues).map((issue) => {
    const path = formatPath(issue.path);
    return `${path}: ${issue.message}`;
  });
  if (issues.length > maxIssues) {
    lines.push(`Additional issues: ${issues.length - maxIssues}`);
  }

  const header = options?.label ? `Invalid ${options.label}.` : undefined;
  return header ? [header, ...lines].join("\n") : lines.join("\n");
};

type DecodeJsonOptions = {
  readonly formatter?: (error: ParseResult.ParseError, raw: string) => string;
  readonly label?: string;
  readonly maxIssues?: number;
};

export const decodeJson = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  input: string,
  options?: DecodeJsonOptions
) =>
  Schema.decodeUnknown(Schema.parseJson(schema))(input).pipe(
    Effect.mapError((error) => {
      const formatOptions =
        options?.label !== undefined || options?.maxIssues !== undefined
          ? {
              ...(options?.label !== undefined ? { label: options.label } : {}),
              ...(options?.maxIssues !== undefined
                ? { maxIssues: options.maxIssues }
                : {})
            }
          : undefined;
      const message = ParseResult.isParseError(error)
        ? options?.formatter
          ? options.formatter(error, input)
          : formatParseError(error, formatOptions)
        : String(error);
      return CliJsonError.make({ message, cause: error });
    })
  );
