import { Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { CliInputError } from "./errors.js";

const defaultFormatDescription = "Output format (default: config output format)";

export const makeFormatOption = <T extends readonly [string, ...Array<string>]>(
  formats: T,
  description: string = defaultFormatDescription
) =>
  Options.choice("format", formats).pipe(
    Options.withDescription(description),
    Options.optional
  );

export const rejectImplicitUnsupportedFormat = <T extends string>(args: {
  readonly explicitFormat: Option.Option<T>;
  readonly configFormat: string;
  readonly unsupported: ReadonlyArray<string>;
  readonly commandName: string;
  readonly supportedHint?: string;
}) =>
  Option.isNone(args.explicitFormat) && args.unsupported.includes(args.configFormat)
    ? CliInputError.make({
        message: `Output format "${args.configFormat}" is not supported for ${args.commandName} commands.${args.supportedHint ? ` Use --format ${args.supportedHint}.` : " Use --format to select a supported format."}`,
        cause: { format: args.configFormat }
      })
    : Effect.void;
