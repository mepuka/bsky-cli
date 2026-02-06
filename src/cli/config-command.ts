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
import { BskyCredentials } from "../domain/credentials.js";

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
  Options.withDescription("Output format (default: config output format)"),
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
      yield* fs.makeDirectory(config.storeRoot, { recursive: true, mode: 0o700 });
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

const configShowCommand = Command.make("show", { format: checkFormatOption }, ({ format }) =>
  Effect.gen(function* () {
    const config = yield* AppConfigService;
    const outputFormat = resolveOutputFormat(
      format,
      config.outputFormat,
      jsonTableFormats,
      "json"
    );

    if (outputFormat === "table") {
      const rows = [
        ["service", config.service],
        ["storeRoot", config.storeRoot],
        ["outputFormat", config.outputFormat],
        ["identifier", config.identifier ?? "(none)"]
      ];
      const table = renderTableLegacy(["KEY", "VALUE"], rows);
      yield* writeText(table);
      return;
    }

    yield* writeJson(config);
  })
).pipe(
  Command.withDescription("Show resolved configuration values")
);

const credentialStatusCommand = Command.make("status", { format: checkFormatOption }, ({ format }) =>
  Effect.gen(function* () {
    const config = yield* AppConfigService;
    const credentials = yield* CredentialStore;
    const status = yield* credentials.status();
    const outputFormat = resolveOutputFormat(
      format,
      config.outputFormat,
      jsonTableFormats,
      "json"
    );

    if (outputFormat === "table") {
      const rows = [
        ["source", status.source],
        ["identifierSource", status.identifierSource],
        ["passwordSource", status.passwordSource],
        ["hasCredentials", status.hasCredentials ? "yes" : "no"],
        ["fileExists", status.fileExists ? "yes" : "no"],
        ["fileReadable", status.fileReadable ? "yes" : "no"],
        ["keyPresent", status.keyPresent ? "yes" : "no"],
        ["keySource", status.keySource],
        ["keyFileExists", status.keyFileExists ? "yes" : "no"],
        ["keyFileReadable", status.keyFileReadable ? "yes" : "no"]
      ];
      if (status.fileError) {
        rows.push(["fileError", status.fileError]);
      }
      if (status.keyFileError) {
        rows.push(["keyFileError", status.keyFileError]);
      }
      const table = renderTableLegacy(["FIELD", "VALUE"], rows);
      yield* writeText(table);
      return;
    }

    yield* writeJson(status);
  })
).pipe(
  Command.withDescription("Show credential resolution status")
);

const credentialKeyStatusCommand = Command.make(
  "status",
  { format: checkFormatOption },
  ({ format }) =>
    Effect.gen(function* () {
      const config = yield* AppConfigService;
      const credentials = yield* CredentialStore;
      const status = yield* credentials.status();
      const outputFormat = resolveOutputFormat(
        format,
        config.outputFormat,
        jsonTableFormats,
        "json"
      );

      if (outputFormat === "table") {
        const rows = [
          ["keyPresent", status.keyPresent ? "yes" : "no"],
          ["keySource", status.keySource],
          ["keyFileExists", status.keyFileExists ? "yes" : "no"],
          ["keyFileReadable", status.keyFileReadable ? "yes" : "no"]
        ];
        if (status.keyFileError) {
          rows.push(["keyFileError", status.keyFileError]);
        }
        const table = renderTableLegacy(["FIELD", "VALUE"], rows);
        yield* writeText(table);
        return;
      }

      yield* writeJson({
        keyPresent: status.keyPresent,
        keySource: status.keySource,
        keyFileExists: status.keyFileExists,
        keyFileReadable: status.keyFileReadable,
        ...(status.keyFileError ? { keyFileError: status.keyFileError } : {})
      });
    })
).pipe(
  Command.withDescription("Show credential key status")
);

const credentialKeySetCommand = Command.make(
  "set",
  {
    value: Options.text("value").pipe(
      Options.withDescription("Base64 credentials key (optional)"),
      Options.optional
    ),
    force: Options.boolean("force").pipe(
      Options.withAlias("f"),
      Options.withDescription("Overwrite existing key file")
    )
  },
  ({ value, force }) =>
    Effect.gen(function* () {
      const credentials = yield* CredentialStore;
      const result = yield* credentials.setKey({
        ...(Option.isSome(value) ? { value: value.value } : {}),
        overwrite: force
      });
      yield* writeJson({ saved: true, overwritten: result.overwritten });
    })
).pipe(
  Command.withDescription("Save credentials key to disk")
);

const credentialKeyClearCommand = Command.make("clear", {}, () =>
  Effect.gen(function* () {
    const credentials = yield* CredentialStore;
    yield* credentials.clearKey();
    yield* writeJson({ cleared: true });
  })
).pipe(
  Command.withDescription("Remove stored credentials key file")
);

const configCredentialsKeyCommand = Command.make("key", {}).pipe(
  Command.withSubcommands([
    credentialKeyStatusCommand,
    credentialKeySetCommand,
    credentialKeyClearCommand
  ]),
  Command.withDescription(
    withExamples("Manage credentials key", [
      "skygent config credentials key status",
      "skygent config credentials key set",
      "skygent config credentials key clear"
    ])
  )
);

const credentialSetCommand = Command.make(
  "set",
  {
    identifier: Options.text("id").pipe(
      Options.withDescription("Bluesky handle or DID")
    ),
    password: Options.redacted("pw").pipe(
      Options.withDescription("Bluesky app password (redacted)")
    )
  },
  ({ identifier, password }) =>
    Effect.gen(function* () {
      const credentials = yield* CredentialStore;
      const value = BskyCredentials.make({
        identifier,
        password
      });
      yield* credentials.save(value);
      yield* writeJson({ saved: true, identifier });
    })
).pipe(
  Command.withDescription("Save encrypted credentials to disk")
);

const credentialClearCommand = Command.make("clear", {}, () =>
  Effect.gen(function* () {
    const credentials = yield* CredentialStore;
    yield* credentials.clear();
    yield* writeJson({ cleared: true });
  })
).pipe(
  Command.withDescription("Remove stored credentials file")
);

const configCredentialsCommand = Command.make("credentials", {}).pipe(
  Command.withSubcommands([
    credentialStatusCommand,
    credentialSetCommand,
    credentialClearCommand,
    configCredentialsKeyCommand
  ]),
  Command.withDescription(
    withExamples("Manage stored credentials", [
      "skygent config credentials status",
      "skygent config credentials set --id handle.bsky.social --pw app-password",
      "skygent config credentials clear",
      "skygent config credentials key set"
    ])
  )
);

export const configCommand = Command.make("config", {}).pipe(
  Command.withSubcommands([configCheckCommand, configShowCommand, configCredentialsCommand]),
  Command.withDescription(
    withExamples("Configuration helpers", [
      "skygent config check",
      "skygent config show",
      "skygent config credentials status"
    ])
  )
);
