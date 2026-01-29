import { StoreConfig } from "./store.js";

export const defaultStoreConfig = StoreConfig.make({
  format: { json: true, markdown: false },
  autoSync: false,
  syncPolicy: "dedupe",
  filters: []
});
