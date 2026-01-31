import { ValidationError } from "@effect/cli";
import { Cause, Exit, Option } from "effect";
import { CliInputError, CliJsonError } from "./errors.js";
import {
  BskyError,
  ConfigError,
  FilterCompileError,
  FilterEvalError,
  FilterLibraryError,
  FilterNotFound,
  StoreAlreadyExists,
  StoreIoError,
  StoreIndexError,
  StoreNotFound
} from "../domain/errors.js";
import { SyncError } from "../domain/sync.js";
import { DerivationError } from "../domain/derivation.js";

export const exitCodeFor = (error: unknown): number => {
  if (ValidationError.isValidationError(error)) return 2;
  if (error instanceof CliJsonError) return 2;
  if (error instanceof CliInputError) return 2;
  if (error instanceof ConfigError) return 2;
  if (error instanceof StoreNotFound) return 3;
  if (error instanceof StoreAlreadyExists) return 2;
  if (error instanceof FilterNotFound) return 2;
  if (error instanceof FilterLibraryError) return 2;
  if (error instanceof StoreIoError || error instanceof StoreIndexError) return 7;
  if (error instanceof FilterCompileError || error instanceof FilterEvalError) return 8;
  if (error instanceof DerivationError) return 2;
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

export const exitCodeFromExit = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return 0;
  const failure = Cause.failureOption(exit.cause);
  return Option.match(failure, {
    onNone: () => 1,
    onSome: exitCodeFor
  });
};
