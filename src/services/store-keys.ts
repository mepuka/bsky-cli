import type { StoreRef } from "../domain/store.js";

export const storePrefix = (store: StoreRef): string =>
  store.root.endsWith("/") ? store.root : `${store.root}/`;
