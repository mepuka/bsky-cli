import { Command, HelpDoc, ValidationError } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { app } from "./src/cli/app.js";
import { CliInputError, CliJsonError } from "./src/cli/errors.js";
import { logErrorEvent } from "./src/cli/logging.js";
import { CliOutput } from "./src/cli/output.js";
import { exitCodeFor, exitCodeFromExit } from "./src/cli/exit-codes.js";

const cli = Command.run(app, {
  name: "skygent",
  version: "0.0.0"
});

const stripAnsi = (value: string) =>
  value.replace(/\u001b\[[0-9;]*m/g, "");

const formatValidationError = (error: ValidationError.ValidationError) => {
  const text = HelpDoc.toAnsiText(error.error).trimEnd();
  return stripAnsi(text.length > 0 ? text : "Invalid command input. Use --help for usage.");
};

const formatError = (error: unknown) => {
  if (ValidationError.isValidationError(error)) {
    return formatValidationError(error);
  }
  if (error instanceof CliJsonError) {
    return error.message;
  }
  if (error instanceof CliInputError) {
    return error.message;
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

const errorType = (error: unknown): string => {
  if (ValidationError.isValidationError(error)) return "ValidationError";
  if (error instanceof Error) return error.name;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return String((error as { readonly _tag?: unknown })._tag ?? "UnknownError");
  }
  return "UnknownError";
};

const errorDetails = (error: unknown): Record<string, unknown> | undefined => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return { error };
  }
  return undefined;
};

const program = cli(process.argv).pipe(
  Effect.tapError((error) =>
    ValidationError.isValidationError(error)
      ? Effect.void
      : logErrorEvent(formatError(error), {
          code: exitCodeFor(error),
          type: errorType(error),
          ...errorDetails(error)
        })
  ),
  Effect.provide(Layer.mergeAll(BunContext.layer, CliOutput.layer))
);

BunRuntime.runMain({
  disableErrorReporting: true,
  disablePrettyLogger: true,
  teardown: (exit, onExit) => onExit(exitCodeFromExit(exit))
})(program);
