import { Args, Command, Options } from "@effect/cli";
import { Effect, Option, Schema, Stream } from "effect";
import { AppConfigService } from "../services/app-config.js";
import { BskyClient } from "../services/bsky-client.js";
import { IdentityResolver } from "../services/identity-resolver.js";
import { ActorId } from "../domain/primitives.js";
import { BskyError } from "../domain/errors.js";
import { CliInputError } from "./errors.js";
import { renderTableLegacy } from "./doc/table.js";
import { withExamples } from "./help.js";
import { writeJson, writeJsonStream, writeText } from "./output.js";
import { jsonNdjsonTableFormats } from "./output-format.js";
import { emitWithFormat } from "./output-render.js";

const identifiersArg = Args.text({ name: "identifier" }).pipe(
  Args.repeated,
  Args.withSchema(Schema.mutable(Schema.Array(ActorId))),
  Args.withDescription("Handle or DID to resolve (repeatable)")
);

const formatOption = Options.choice("format", jsonNdjsonTableFormats).pipe(
  Options.withDescription("Output format (default: config output format)"),
  Options.optional
);

const cacheOnlyOption = Options.boolean("cache-only").pipe(
  Options.withDescription("Only check local cache, don't fetch from network")
);

const strictOption = Options.boolean("strict").pipe(
  Options.withDescription("Use strict verification (resolveIdentity API)")
);

const normalizeHandle = (value: string) => {
  const trimmed = value.trim();
  const raw = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return raw.toLowerCase();
};

type ActorResolution = {
  readonly did: string;
  readonly handle: string;
};

const renderResolveTable = (rows: ReadonlyArray<ActorResolution>) =>
  renderTableLegacy(
    ["DID", "HANDLE"],
    rows.map((row) => [row.did, row.handle])
  );

const resolveCommand = Command.make(
  "resolve",
  {
    identifiers: identifiersArg,
    format: formatOption,
    cacheOnly: cacheOnlyOption,
    strict: strictOption
  },
  ({ identifiers, format, cacheOnly, strict }) =>
    Effect.gen(function* () {
      if (identifiers.length === 0) {
        return yield* CliInputError.make({
          message: "Provide at least one handle or DID to resolve.",
          cause: { identifiers }
        });
      }
      if (cacheOnly && strict) {
        return yield* CliInputError.make({
          message: "--cache-only cannot be combined with --strict.",
          cause: { cacheOnly, strict }
        });
      }

      const appConfig = yield* AppConfigService;

      const identities = yield* IdentityResolver;
      const client = strict ? yield* BskyClient : undefined;

      const resolveCached = (identifier: string) =>
        Effect.gen(function* () {
          if (identifier.startsWith("did:")) {
            const handleOption = yield* identities.lookupHandle(identifier);
            if (Option.isNone(handleOption)) {
              return yield* BskyError.make({
                message: `Handle not found in cache for DID ${identifier}.`,
                error: "DidNotFound",
                operation: "lookupHandle"
              });
            }
            return { did: identifier, handle: String(handleOption.value) };
          }
          const didOption = yield* identities.lookupDid(identifier);
          if (Option.isNone(didOption)) {
            return yield* BskyError.make({
              message: `Handle not found in cache: ${identifier}.`,
              error: "HandleNotFound",
              operation: "lookupDid"
            });
          }
          return { did: String(didOption.value), handle: normalizeHandle(identifier) };
        });

      const resolveLive = (identifier: string) =>
        strict
          ? client!.resolveIdentity(identifier).pipe(
              Effect.map((info) => ({
                did: String(info.did),
                handle: String(info.handle)
              }))
            )
          : identities.resolveIdentity(identifier).pipe(
              Effect.map((info) => ({
                did: String(info.did),
                handle: String(info.handle)
              }))
            );

      const resolver = cacheOnly ? resolveCached : resolveLive;
      const results = yield* Effect.forEach(identifiers, resolver, {
        concurrency: "unbounded",
        discard: false
      });

      const payload = identifiers.length === 1 ? results[0]! : results;

      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(payload),
          ndjson: writeJsonStream(Stream.fromIterable(results)),
          table: writeText(renderResolveTable(results))
        }
      );
    })
).pipe(
  Command.withDescription(
    withExamples("Resolve handles and DIDs", [
      "skygent actor resolve alice.bsky.social",
      "skygent actor resolve did:plc:example",
      "skygent actor resolve alice.bsky.social bob.bsky.social --format table"
    ])
  )
);

export const actorCommand = Command.make("actor", {}).pipe(
  Command.withSubcommands([resolveCommand]),
  Command.withDescription(
    withExamples("Identity resolution helpers", [
      "skygent actor resolve alice.bsky.social"
    ])
  )
);
