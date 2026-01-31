import { Effect, ParseResult, Schema } from "effect";
import { CliJsonError } from "./errors.js";
import { formatParseError } from "./shared.js";

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
