import { Schema } from "effect";

export const Handle = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9.-]{1,63}$/i),
  Schema.brand("Handle")
);
export type Handle = typeof Handle.Type;

// Bluesky's lexicon only requires: maxLength 640 bytes, maxGraphemes 64
// The extraction regex is stricter, but facets can contain anything
// We accept whatever Bluesky sends to avoid losing posts
// Require at least one non-whitespace character after #
export const Hashtag = Schema.String.pipe(
  Schema.pattern(/^#\S.*$/u),
  Schema.brand("Hashtag")
);
export type Hashtag = typeof Hashtag.Type;

export const AtUri = Schema.String.pipe(Schema.brand("AtUri"));
export type AtUri = typeof AtUri.Type;

export const PostUri = Schema.String.pipe(Schema.brand("PostUri"));
export type PostUri = typeof PostUri.Type;

export const PostCid = Schema.String.pipe(Schema.brand("PostCid"));
export type PostCid = typeof PostCid.Type;

export const Did = Schema.String.pipe(Schema.brand("Did"));
export type Did = typeof Did.Type;

export const Timestamp = Schema.Union(
  Schema.DateFromString,
  Schema.DateFromSelf
).pipe(Schema.brand("Timestamp"));
export type Timestamp = typeof Timestamp.Type;

export const EventId = Schema.ULID.pipe(Schema.brand("EventId"));
export type EventId = typeof EventId.Type;

export const StoreName = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9-_]{1,63}$/),
  Schema.brand("StoreName")
);
export type StoreName = typeof StoreName.Type;

export const StorePath = Schema.String.pipe(Schema.brand("StorePath"));
export type StorePath = typeof StorePath.Type;
