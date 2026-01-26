import { HttpClient } from "@effect/platform";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { Clock, Context, Duration, Effect, Layer, Option, Schema } from "effect";
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

export type LinkValidatorService = {
  readonly isValid: (url: string) => Effect.Effect<boolean, FilterEvalError>;
  readonly hasValidLink: (
    urls: ReadonlyArray<string>
  ) => Effect.Effect<boolean, FilterEvalError>;
};

export class LinkValidator extends Context.Tag("@skygent/LinkValidator")<
  LinkValidator,
  LinkValidatorService
>() {
  static readonly layer = Layer.effect(
    LinkValidator,
    Effect.gen(function* () {
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

      return LinkValidator.of({ isValid, hasValidLink });
    })
  );

  static readonly testLayer = Layer.succeed(
    LinkValidator,
    LinkValidator.of({
      isValid: (url) => Effect.succeed(url.includes("ok")),
      hasValidLink: (urls) =>
        Effect.succeed(urls.some((url) => url.includes("ok")))
    })
  );
}
