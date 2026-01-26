import { Effect, ParseResult, Schema } from "effect";
import { CliJsonError } from "./errors.js";

export const decodeJson = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  input: string
) =>
  Schema.decodeUnknown(Schema.parseJson(schema))(input).pipe(
    Effect.mapError((error) => {
      const message = ParseResult.isParseError(error)
        ? ParseResult.TreeFormatter.formatErrorSync(error)
        : String(error);
      return CliJsonError.make({ message, cause: error });
    })
  );
