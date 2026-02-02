import { Order } from "effect";
import type { Post } from "./post.js";
import type { StoreRef } from "./store.js";

export const LocaleStringOrder = Order.make<string>((left, right) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
});

export const PostOrder = Order.mapInput(
  Order.tuple(Order.Date, LocaleStringOrder),
  (post: Post) => [post.createdAt, post.uri] as const
);

export const StorePostOrder = Order.mapInput(
  Order.tuple(Order.Date, LocaleStringOrder, LocaleStringOrder),
  (entry: { readonly post: Post; readonly store: StoreRef }) =>
    [entry.post.createdAt, entry.post.uri, entry.store.name] as const
);

export const updatedAtOrder = <A extends { readonly updatedAt: Date }>() =>
  Order.mapInput(Order.Date, (value: A) => value.updatedAt);
