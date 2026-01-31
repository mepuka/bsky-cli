import { Command, Options } from "@effect/cli";
import { Chunk, Effect, Option, Ref, Stream } from "effect";
import { ParseResult } from "effect";
import { RawPost } from "../domain/raw.js";
import type { Post } from "../domain/post.js";
import { FilterRuntime } from "../services/filter-runtime.js";
import { PostParser } from "../services/post-parser.js";
import { CliInput } from "./input.js";
import { CliInputError, CliJsonError } from "./errors.js";
import { parseFilterExpr } from "./filter-input.js";
import { decodeJson } from "./parse.js";
import { withExamples } from "./help.js";
import { filterOption, filterJsonOption } from "./shared-options.js";
import { formatSchemaError } from "./shared.js";
import { writeJsonStream, writeText } from "./output.js";
import { filterByFlags } from "../typeclass/chunk.js";
import { logErrorEvent, logWarn } from "./logging.js";

const onErrorOption = Options.choice("on-error", ["fail", "skip", "report"]).pipe(
  Options.withDescription("Behavior on invalid input lines"),
  Options.withDefault("fail" as const)
);

const batchSizeOption = Options.integer("batch-size").pipe(
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
      if (process.stdin.isTTY) {
        return yield* CliInputError.make({
          message: "stdin is a TTY. Pipe NDJSON input into skygent pipe.",
          cause: { isTTY: true }
        });
      }
      yield* requireFilterExpr(filter, filterJson);

      const input = yield* CliInput;
      const parser = yield* PostParser;
      const runtime = yield* FilterRuntime;
      const expr = yield* parseFilterExpr(filter, filterJson);
      const evaluateBatch = yield* runtime.evaluateBatch(expr);

      const size = Option.getOrElse(batchSize, () => 50);
      if (size <= 0) {
        return yield* CliInputError.make({
          message: "--batch-size must be a positive integer.",
          cause: { batchSize: size }
        });
      }

      const lineRef = yield* Ref.make(0);
      const countRef = yield* Ref.make(0);

      const parsed = input.lines.pipe(
        Stream.map((line) => line.trim()),
        Stream.filter((line) => line.length > 0),
        Stream.mapEffect((line) =>
          Ref.updateAndGet(lineRef, (value) => value + 1).pipe(
            Effect.map((lineNumber) => ({ line, lineNumber }))
          )
        ),
        Stream.mapEffect(({ line, lineNumber }) =>
          decodeJson(RawPost, line).pipe(
            Effect.flatMap((raw) => parser.parsePost(raw)),
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
        Stream.mapConcat((chunk) => Chunk.toReadonlyArray(chunk)),
        Stream.tap(() => Ref.update(countRef, (count) => count + 1))
      );

      yield* writeJsonStream(filtered);
      const count = yield* Ref.get(countRef);
      if (count === 0) {
        yield* writeText("[]");
      }
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
        "Note: stdin must be raw post NDJSON (app.bsky.feed.getPosts result)."
      ]
    )
  )
);
