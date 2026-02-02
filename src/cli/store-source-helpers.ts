import { Effect, Option } from "effect";
import { DataSource } from "../domain/sync.js";
import type { StoreSource } from "../domain/store-sources.js";
import { parseFilterExpr } from "./filter-input.js";
import { CliInputError } from "./errors.js";

export type StoreSourceSelection = {
  readonly authorsOnly: boolean;
  readonly feedsOnly: boolean;
  readonly listsOnly: boolean;
};

export const resolveStoreSources = (
  sources: ReadonlyArray<StoreSource>,
  selection: StoreSourceSelection
) => {
  const { authorsOnly, feedsOnly, listsOnly } = selection;
  const enabled = sources.filter((source) => source.enabled);

  if (enabled.length === 0) {
    return Effect.fail(
      CliInputError.make({
        message: "No enabled sources are configured for this store.",
        cause: { sources: sources.length }
      })
    );
  }

  const flags = [authorsOnly, feedsOnly, listsOnly].filter(Boolean).length;
  if (flags > 1) {
    return Effect.fail(
      CliInputError.make({
        message: "Use only one of --authors-only, --feeds-only, or --lists-only.",
        cause: { authorsOnly, feedsOnly, listsOnly }
      })
    );
  }

  if (flags === 0) {
    return Effect.succeed(enabled);
  }

  const filtered = enabled.filter((source) => {
    switch (source._tag) {
      case "AuthorSource":
        return authorsOnly;
      case "FeedSource":
        return feedsOnly;
      case "ListSource":
        return listsOnly;
      default:
        return false;
    }
  });

  if (filtered.length === 0) {
    return Effect.fail(
      CliInputError.make({
        message: "No sources matched the selection flags.",
        cause: { authorsOnly, feedsOnly, listsOnly }
      })
    );
  }

  return Effect.succeed(filtered);
};

export const storeSourceDataSource = (source: StoreSource): DataSource => {
  switch (source._tag) {
    case "AuthorSource":
      return DataSource.author(source.actor, {
        ...(source.filter ? { filter: source.filter } : {})
      });
    case "FeedSource":
      return DataSource.feed(source.uri);
    case "ListSource":
      return DataSource.list(source.uri);
    case "TimelineSource":
      return DataSource.timeline();
    case "JetstreamSource":
      return DataSource.jetstream();
  }
};

export const storeSourceFilterExpr = (source: StoreSource) => {
  switch (source._tag) {
    case "AuthorSource":
      return parseFilterExpr(
        Option.fromNullable(source.postFilter),
        Option.fromNullable(source.postFilterJson)
      );
    case "FeedSource":
    case "ListSource":
      return parseFilterExpr(
        Option.fromNullable(source.filter),
        Option.fromNullable(source.filterJson)
      );
    case "TimelineSource":
    case "JetstreamSource":
      return parseFilterExpr(Option.none(), Option.none());
  }
};
