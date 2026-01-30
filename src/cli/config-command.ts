import { Command } from "@effect/cli";
import { FileSystem, Path } from "@effect/platform";
import { Options } from "@effect/cli";
import { Clock, Effect, Option, Stream } from "effect";
import { withExamples } from "./help.js";
import { writeJson, writeText } from "./output.js";
import { renderTableLegacy } from "./doc/table.js";
import { AppConfigService } from "../services/app-config.js";
import { CredentialStore } from "../services/credential-store.js";
import { BskyClient } from "../services/bsky-client.js";
import { jsonTableFormats, resolveOutputFormat } from "./output-format.js";

type CheckStatus = "ok" | "warn" | "error";

type CheckResult = {
  readonly name: string;
  readonly status: CheckStatus;
  readonly message?: string;
};

const checkOk = (name: string, message?: string): CheckResult =>
  message ? { name, status: "ok", message } : { name, status: "ok" };

const checkWarn = (name: string, message: string): CheckResult => ({
  name,
  status: "warn",
  message
});

const checkError = (name: string, message: string): CheckResult => ({
  name,
  status: "error",
  message
});

const checkFormatOption = Options.choice("format", jsonTableFormats).pipe(
  Options.withDescription("Output format (default: json)"),
  Options.optional
);

const configCheckCommand = Command.make("check", { format: checkFormatOption }, ({ format }) =>
  Effect.gen(function* () {
    const results: Array<CheckResult> = [];

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* AppConfigService;
    const credentials = yield* CredentialStore;
    const bsky = yield* BskyClient;
    // Store root writable
    const rootCheck = yield* Effect.gen(function* () {
      yield* fs.makeDirectory(config.storeRoot, { recursive: true });
      const now = yield* Clock.currentTimeMillis;
      const probePath = path.join(
        config.storeRoot,
        `.skygent-check-${now}`
      );
      yield* fs.writeFileString(probePath, "ok");
      yield* fs.remove(probePath);
      return checkOk("store-root", "Store root is writable.");
    }).pipe(
      Effect.catchAll((error) =>
        Effect.succeed(
          checkError(
            "store-root",
            error instanceof Error ? error.message : String(error)
          )
        )
      )
    );
    results.push(rootCheck);

    // Credential file + key
    const credentialCheck = yield* credentials.get().pipe(
      Effect.match({
        onFailure: (error) =>
          checkError("credentials", error.message ?? "Failed to load credentials"),
        onSuccess: (value) =>
          Option.isSome(value)
            ? checkOk("credentials", "Credentials loaded.")
            : checkWarn("credentials", "No credentials configured.")
      })
    );
    results.push(credentialCheck);

    // Bluesky auth
    if (credentialCheck.status === "ok") {
      const bskyCheck = yield* bsky
        .getTimeline({ limit: 1 })
        .pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.as(checkOk("bluesky", "Bluesky login succeeded.")),
          Effect.catchAll((error) =>
            Effect.succeed(
              checkError(
                "bluesky",
                error instanceof Error ? error.message : String(error)
              )
            )
          )
        );
      results.push(bskyCheck);
    } else {
      results.push(
        checkWarn("bluesky", "Skipped Bluesky login (credentials missing).")
      );
    }

    const ok = results.every((result) => result.status !== "error");
    const outputFormat = resolveOutputFormat(
      format,
      config.outputFormat,
      jsonTableFormats,
      "json"
    );
    
    if (outputFormat === "table") {
      const rows = results.map((r) => [
        r.status === "ok" ? "✓" : r.status === "warn" ? "⚠" : "✗",
        r.name,
        r.message || r.status
      ]);
      const table = renderTableLegacy(["STATUS", "CHECK", "DETAILS"], rows);
      yield* writeText(`${ok ? "✓ Config valid" : "✗ Config has errors"}\n\n${table}`);
      return;
    }
    
    yield* writeJson({ ok, checks: results });
  })
).pipe(
  Command.withDescription("Run health checks (store root, credentials, Bluesky auth)")
);

export const configCommand = Command.make("config", {}).pipe(
  Command.withSubcommands([configCheckCommand]),
  Command.withDescription(
    withExamples("Configuration helpers", ["skygent config check"])
  )
);
