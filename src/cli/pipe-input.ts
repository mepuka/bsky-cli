import { Schema } from "effect";
import { RawPost } from "../domain/raw.js";
import { Post } from "../domain/post.js";
import { StoreName } from "../domain/primitives.js";

export class StorePostInput extends Schema.Class<StorePostInput>("StorePostInput")({
  store: StoreName,
  post: Post
}) {}

export const PipeInput = Schema.Union(RawPost, Post, StorePostInput);
export type PipeInput = typeof PipeInput.Type;

export const isRawPostInput = (value: PipeInput): value is RawPost =>
  typeof value === "object" && value !== null && "record" in value;

export const isStorePostInput = (value: PipeInput): value is StorePostInput =>
  typeof value === "object" && value !== null && "post" in value;
