import { Command, ValidationError } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Cause, Effect, Exit, Option } from "effect";
import { app } from "./src/cli/app.js";
import { CliInputError, CliJsonError } from "./src/cli/errors.js";
import { logErrorEvent } from "./src/cli/logging.js";
import {
  BskyError,
  ConfigError,
  FilterCompileError,
  FilterEvalError,
  StoreIndexError,
  StoreIoError,
  StoreNotFound
} from "./src/domain/errors.js";
import { SyncError } from "./src/domain/sync.js";

const cli = Command.run(app, {
  name: "skygent",
  version: "0.0.0"
});

const formatError = (error: unknown) => {
  if (ValidationError.isValidationError(error)) {
    return "Invalid command input. Use --help for usage.";
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

const exitCodeFor = (error: unknown): number => {
  if (ValidationError.isValidationError(error)) return 2;
  if (error instanceof CliJsonError) return 2;
  if (error instanceof CliInputError) return 2;
  if (error instanceof ConfigError) return 2;
  if (error instanceof StoreNotFound) return 3;
  if (error instanceof StoreIoError || error instanceof StoreIndexError) return 7;
  if (error instanceof FilterCompileError || error instanceof FilterEvalError) return 8;
  if (error instanceof SyncError) {
    switch (error.stage) {
      case "source":
        return 5;
      case "filter":
        return 8;
      case "store":
        return 7;
      default:
        return 1;
    }
  }
  if (error instanceof BskyError) return 5;
  return 1;
};

const exitCodeFromExit = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return 0;
  const failure = Cause.failureOption(exit.cause);
  return Option.match(failure, {
    onNone: () => 1,
    onSome: exitCodeFor
  });
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
  Effect.provide(BunContext.layer)
);

BunRuntime.runMain({
  disableErrorReporting: true,
  disablePrettyLogger: true,
  teardown: (exit, onExit) => onExit(exitCodeFromExit(exit))
})(program);
