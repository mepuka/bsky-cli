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

import { Effect, Schema } from "effect";
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
export class PostParser extends Effect.Service<PostParser>()("@skygent/PostParser", {
  succeed: {
    parsePost: Effect.fn("PostParser.parsePost")((raw: unknown) =>
      Schema.decodeUnknown(PostFromRaw)(raw)
    )
  }
}) {
  static readonly layer = PostParser.Default;
}
