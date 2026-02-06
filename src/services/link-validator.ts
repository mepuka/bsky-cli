/**
 * Link Validator Service
 *
 * Validates external URLs found in Bluesky posts by performing HTTP HEAD requests.
 * Used by the HasValidLinks filter to check if post links are accessible.
 *
 * **Validation Process:**
 * 1. Checks URL format (must be http:// or https://)
 * 2. Attempts HEAD request
 * 3. Falls back to GET if HEAD returns 405 (Method Not Allowed) or 501 (Not Implemented)
 * 4. Returns true for 2xx-3xx status codes
 *
 * **Caching:**
 * Results are cached for 6 hours (configurable via cacheTtl) to avoid
 * repeated requests to the same URLs. Cache entries include:
 * - URL (encoded as cache key)
 * - ok: boolean (whether link is valid)
 * - status: number (HTTP status code, optional)
 * - checkedAt: Date (when validation occurred)
 *
 * **Performance:**
 * Cached results are used if entry is fresh (within TTL).
 * hasValidLink returns true on first valid URL in the array (short-circuits).
 *
 * @module services/link-validator
 *
 * @example
 * ```typescript
 * import { LinkValidator } from "./services/link-validator.js";
 * import { Effect } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   const validator = yield* LinkValidator;
 *
 *   // Validate a single link
 *   const isValid = yield* validator.isValid("https://example.com");
 *   console.log(`Link valid: ${isValid}`);
 *
 *   // Check if any link in array is valid
 *   const hasValid = yield* validator.hasValidLink([
 *     "https://example.com",
 *     "https://invalid-url.xyz"
 *   ]);
 *   console.log(`Has valid link: ${hasValid}`); // true if at least one valid
 * }).pipe(Effect.provide(LinkValidator.layer));
 * ```
 */

import { HttpClient } from "@effect/platform";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { Clock, Duration, Effect, Layer, Option, Schema } from "effect";
import { FilterEvalError } from "../domain/errors.js";

const cachePrefix = "cache/links/";
const cacheTtl = Duration.hours(6);

const toFilterEvalError = (message: string) => (cause: unknown) =>
  FilterEvalError.make({ message, cause });

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const isValidStatus = (status: number) => status >= 200 && status < 400;

const cacheKey = (url: string) => encodeURIComponent(url);

class LinkCacheEntry extends Schema.Class<LinkCacheEntry>("LinkCacheEntry")({
  url: Schema.String,
  ok: Schema.Boolean,
  status: Schema.optional(Schema.Number),
  checkedAt: Schema.DateFromString
}) {}

/**
 * Interface for the link validator service.
 * Provides URL validation with caching support.
 */
export type LinkValidatorService = {
  /**
   * Validates a single URL by checking HTTP accessibility.
   * Returns cached result if available and fresh (within 6 hour TTL).
   *
   * @param url - The URL to validate
   * @returns Effect resolving to true if link is accessible (2xx-3xx status), false otherwise
   * @throws {FilterEvalError} When HTTP request fails unexpectedly or cache operations fail
   */
  readonly isValid: (url: string) => Effect.Effect<boolean, FilterEvalError>;

  /**
   * Checks if any URL in the array is valid.
   * Short-circuits on first valid URL for performance.
   * Non-HTTP URLs are skipped (not considered valid).
   *
   * @param urls - Array of URLs to check
   * @returns Effect resolving to true if at least one URL is valid
   * @throws {FilterEvalError} When validation fails
   */
  readonly hasValidLink: (
    urls: ReadonlyArray<string>
  ) => Effect.Effect<boolean, FilterEvalError>;
};

/**
 * Context tag and Layer implementation for the link validator service.
 * Performs HTTP validation with caching via KeyValueStore.
 *
 * **HTTP Behavior:**
 * - Uses HEAD requests for efficiency
 * - Falls back to GET for servers that don't support HEAD (405/501)
 * - Considers 2xx-3xx status codes as valid
 * - Non-HTTP URLs (ftp://, file://, etc.) are considered invalid
 *
 * **Caching:**
 * Uses KeyValueStore with "cache/links/" prefix.
 * Cache entries expire after 6 hours.
 *
 * **Dependencies:**
 * - KeyValueStore.KeyValueStore: For caching
 * - HttpClient.HttpClient: For making requests
 *
 * @example
 * ```typescript
 * // Basic usage
 * const isValid = yield* validator.isValid("https://example.com");
 *
 * // Check multiple links (stops at first valid)
 * const hasAnyValid = yield* validator.hasValidLink([
 *   "https://broken.example",
 *   "https://working.example"
 * ]);
 *
 * // Testing with mock responses
 * const testLayer = Layer.succeed(
 *   LinkValidator,
 *   LinkValidator.make({
 *     isValid: (url) => Effect.succeed(url.includes("ok")),
 *     hasValidLink: (urls) => Effect.succeed(urls.some(u => u.includes("ok")))
 *   })
 * );
 * ```
 */
export class LinkValidator extends Effect.Service<LinkValidator>()("@skygent/LinkValidator", {
  effect: Effect.gen(function* () {
    const kv = yield* KeyValueStore.KeyValueStore;
    const http = yield* HttpClient.HttpClient;
    const store = KeyValueStore.prefix(kv.forSchema(LinkCacheEntry), cachePrefix);

    const isFresh = (entry: LinkCacheEntry, now: number) =>
      now - entry.checkedAt.getTime() < Duration.toMillis(cacheTtl);

    const fetchStatus = (url: string) =>
      http.head(url).pipe(
        Effect.map((response) => response.status),
        Effect.flatMap((status) =>
          status === 405 || status === 501
            ? http.get(url).pipe(Effect.map((response) => response.status))
            : Effect.succeed(status)
        ),
        Effect.mapError(toFilterEvalError("Link validation failed"))
      );

    const isValid = Effect.fn("LinkValidator.isValid")((url: string) =>
      Effect.gen(function* () {
        if (!isHttpUrl(url)) {
          return false;
        }

        const now = yield* Clock.currentTimeMillis;
        const cached = yield* store
          .get(cacheKey(url))
          .pipe(Effect.mapError(toFilterEvalError("Link cache read failed")));

        if (Option.isSome(cached) && isFresh(cached.value, now)) {
          return cached.value.ok;
        }

        const status = yield* fetchStatus(url);
        const ok = isValidStatus(status);
        const entry = LinkCacheEntry.make({
          url,
          ok,
          status,
          checkedAt: new Date(now)
        });

        yield* store
          .set(cacheKey(url), entry)
          .pipe(Effect.mapError(toFilterEvalError("Link cache write failed")));

        return ok;
      })
    );

    const hasValidLink = Effect.fn("LinkValidator.hasValidLink")(
      (urls: ReadonlyArray<string>) =>
        Effect.findFirst(urls, (url) => isValid(url)).pipe(
          Effect.map(Option.isSome)
        )
    );

    return { isValid, hasValidLink };
  })
}) {
  static readonly layer = LinkValidator.Default;

  /**
   * Test layer that provides a mock link validator.
   * URLs containing "ok" are considered valid.
   * Useful for testing without making actual HTTP requests.
   *
   * @example
   * ```typescript
   * // Mock validator that considers URLs with "ok" as valid
   * const testProgram = program.pipe(
   *   Effect.provide(LinkValidator.testLayer)
   * );
   *
   * // "https://example.com/ok" -> true
   * // "https://broken.example" -> false
   * ```
   */
  static readonly testLayer = Layer.succeed(
    LinkValidator,
    LinkValidator.make({
      isValid: (url) => Effect.succeed(url.includes("ok")),
      hasValidLink: (urls) =>
        Effect.succeed(urls.some((url) => url.includes("ok")))
    })
  );
}
