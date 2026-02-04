#!/usr/bin/env bun
import { Command, ValidationError } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Clock, Effect, Layer } from "effect";
import { app } from "./src/cli/app.js";
import pkg from "./package.json" with { type: "json" };
import { logErrorEvent } from "./src/cli/logging.js";
import { CliOutput } from "./src/cli/output.js";
import { exitCodeFor, exitCodeFromExit } from "./src/cli/exit-codes.js";
import {
  errorDetails,
  errorCode,
  errorSuggestion,
  errorType,
  formatErrorEnvelope,
  formatErrorMessage,
  getAgentPayload,
  jsonErrorsEnabled,
  makeErrorEnvelope
} from "./src/cli/error-envelope.js";

const cli = Command.run(app, {
  name: "skygent",
  version: pkg.version
});

const program = cli(process.argv).pipe(
  Effect.tapError((error) => {
    const agentPayload = getAgentPayload(error);
    const code = exitCodeFor(error);
    if (jsonErrorsEnabled()) {
      const envelope = makeErrorEnvelope(error, code, agentPayload);
      return Effect.flatMap(CliOutput, (output) =>
        output.writeStderr(formatErrorEnvelope(envelope))
      );
    }
    if (ValidationError.isValidationError(error)) {
      return Effect.void;
    }
    return logErrorEvent(formatErrorMessage(error, agentPayload), {
      code,
      errorCode: errorCode(error, agentPayload),
      type: errorType(error, agentPayload),
      suggestion: errorSuggestion(error, agentPayload),
      ...errorDetails(error, agentPayload)
    });
  }),
  Effect.provide(
    Layer.mergeAll(
      BunContext.layer,
      CliOutput.layer,
      Layer.succeed(Clock.Clock, Clock.make())
    )
  )
);

BunRuntime.runMain({
  disableErrorReporting: true,
  disablePrettyLogger: true,
  teardown: (exit, onExit) => {
    const code = exitCodeFromExit(exit);
    onExit(code);
    if (typeof process !== "undefined") {
      process.exit(code);
    }
  }
})(program);
