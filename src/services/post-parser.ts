/**
 * Post Parser Service Module
 *
 * This module provides the PostParser service, which is responsible for parsing
 * raw post data into normalized Post domain objects. It uses Effect's Schema
 * validation to ensure type safety and data integrity during the parsing process.
 *
 * Key responsibilities:
 * - Decode unknown/raw data into typed Post objects
 * - Schema validation and error handling via ParseResult
 * - Centralized parsing logic for post data ingestion
 */

import { Context, Effect, Layer, ParseResult, Schema } from "effect";
import { Post } from "../domain/post.js";
import { PostFromRaw } from "../domain/raw.js";

/**
 * Service for parsing raw post data into normalized Post domain objects.
 *
 * The PostParser provides a single `parsePost` method that uses Effect's Schema
 * decoding to transform unknown/raw data into properly typed Post objects.
 * This ensures type safety and validation during data ingestion.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const parser = yield* PostParser;
 *   const rawData = { uri: "at://...", cid: "...", text: "Hello" };
 *
 *   const post = yield* parser.parsePost(rawData);
 *   return post;
 * });
 * ```
 */
export class PostParser extends Context.Tag("@skygent/PostParser")<
  PostParser,
  {
    /**
     * Parse raw post data into a normalized Post object.
     *
     * This method uses Schema.decodeUnknown with the PostFromRaw schema to:
     * 1. Validate the input data structure
     * 2. Transform raw fields into the normalized Post type
     * 3. Return a typed Post object or a ParseError on failure
     *
     * @param raw - The raw, unknown data to parse (typically from an external source)
     * @returns Effect that resolves to a validated Post object, or fails with ParseError
     * @throws ParseResult.ParseError if the input data doesn't match the expected schema
     */
    readonly parsePost: (raw: unknown) => Effect.Effect<Post, ParseResult.ParseError>;
  }
>() {
  static readonly layer = Layer.succeed(
    PostParser,
    PostParser.of({
      parsePost: Effect.fn("PostParser.parsePost")((raw: unknown) =>
        Schema.decodeUnknown(PostFromRaw)(raw)
      )
    })
  );
}
