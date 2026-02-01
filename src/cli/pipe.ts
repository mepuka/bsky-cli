import { Command, Options } from "@effect/cli";
import { Chunk, Effect, Option, Ref, Stream } from "effect";
import { ParseResult } from "effect";
import type { Post } from "../domain/post.js";
import { FilterRuntime } from "../services/filter-runtime.js";
import { PostParser } from "../services/post-parser.js";
import { CliInput } from "./input.js";
import { CliInputError, CliJsonError } from "./errors.js";
import { parseFilterExpr } from "./filter-input.js";
import { decodeJson } from "./parse.js";
import { PipeInput, isRawPostInput, isStorePostInput } from "./pipe-input.js";
import { withExamples } from "./help.js";
import { filterOption, filterJsonOption } from "./shared-options.js";
import { formatSchemaError } from "./shared.js";
import { writeJsonStream } from "./output.js";
import { filterByFlags } from "../typeclass/chunk.js";
import { logErrorEvent, logWarn } from "./logging.js";
import { PositiveInt } from "./option-schemas.js";

const onErrorOption = Options.choice("on-error", ["fail", "skip", "report"]).pipe(
  Options.withDescription("Behavior on invalid input lines"),
  Options.withDefault("fail" as const)
);

const batchSizeOption = Options.integer("batch-size").pipe(
  Options.withSchema(PositiveInt),
  Options.withDescription("Posts per filter batch (default: 50)"),
  Options.optional
);

const requireFilterExpr = (
  filter: Option.Option<string>,
  filterJson: Option.Option<string>
) =>
  Option.isNone(filter) && Option.isNone(filterJson)
    ? Effect.fail(
        CliInputError.make({
          message: "Provide --filter or --filter-json.",
          cause: { filter: null, filterJson: null }
        })
      )
    : Effect.void;

const truncate = (value: string, max = 500) =>
  value.length > max ? `${value.slice(0, max)}...` : value;

const formatPipeError = (error: unknown) => {
  if (error instanceof CliJsonError || error instanceof CliInputError) {
    return error.message;
  }
  if (ParseResult.isParseError(error)) {
    return formatSchemaError(error);
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return String(error);
};

export const pipeCommand = Command.make(
  "pipe",
  { filter: filterOption, filterJson: filterJsonOption, onError: onErrorOption, batchSize: batchSizeOption },
  ({ filter, filterJson, onError, batchSize }) =>
    Effect.gen(function* () {
      const input = yield* CliInput;
      if (input.isTTY) {
        return yield* CliInputError.make({
          message: "stdin is a TTY. Pipe NDJSON input into skygent pipe.",
          cause: { isTTY: true }
        });
      }
      yield* requireFilterExpr(filter, filterJson);
      const parser = yield* PostParser;
      const runtime = yield* FilterRuntime;
      const expr = yield* parseFilterExpr(filter, filterJson);
      const evaluateBatch = yield* runtime.evaluateBatch(expr);

      const size = Option.getOrElse(batchSize, () => 50);

      const lineRef = yield* Ref.make(0);
      const parsed = input.lines.pipe(
        Stream.map((line) => line.trim()),
        Stream.filter((line) => line.length > 0),
        Stream.mapEffect((line) =>
          Ref.updateAndGet(lineRef, (value) => value + 1).pipe(
            Effect.map((lineNumber) => ({ line, lineNumber }))
          )
        ),
        Stream.mapEffect(({ line, lineNumber }) =>
          decodeJson(PipeInput, line).pipe(
            Effect.flatMap((inputPost) => {
              if (isRawPostInput(inputPost)) {
                return parser.parsePost(inputPost);
              }
              if (isStorePostInput(inputPost)) {
                return Effect.succeed(inputPost.post);
              }
              return Effect.succeed(inputPost);
            }),
            Effect.map(Option.some),
            Effect.catchAll((error) => {
              if (onError === "fail") {
                return Effect.fail(error);
              }
              const message = formatPipeError(error);
              const payload = {
                line: lineNumber,
                message,
                input: truncate(line)
              };
              const log =
                onError === "report"
                  ? logErrorEvent("Invalid input line", payload)
                  : logWarn("Skipping invalid input line", payload);
              return log.pipe(
                Effect.ignore,
                Effect.as(Option.none<Post>())
              );
            })
          )
        ),
        Stream.filterMap((value) => value)
      );

      const filtered = parsed.pipe(
        Stream.grouped(size),
        Stream.mapEffect((batch) =>
          evaluateBatch(batch).pipe(
            Effect.map((flags) => filterByFlags(batch, flags))
          )
        ),
        Stream.mapConcat((chunk) => Chunk.toReadonlyArray(chunk))
      );

      yield* writeJsonStream(filtered);
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Filter raw post NDJSON from stdin",
      [
        "skygent pipe --filter 'hashtag:#ai' < posts.ndjson",
        "cat posts.ndjson | skygent pipe --filter-json '{\"_tag\":\"All\"}'"
      ],
      [
        "Accepts three input formats: raw Bluesky API post NDJSON (with record field),",
        "skygent Post NDJSON (from query --format ndjson), or {store, post} NDJSON",
        "(from query --format ndjson --include-store).",
        "Note: compact query output (default) is not compatible — use --full:",
        "skygent --full query ... --format ndjson | skygent pipe ..."
      ]
    )
  )
);
