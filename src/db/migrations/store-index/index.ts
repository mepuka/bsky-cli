import migration_001 from "./001_init.js";
import migration_002 from "./002_event_log.js";
import migration_003 from "./003_fts_and_derived.js";
import migration_004 from "./004_query_indexes.js";
import migration_005 from "./005_post_lang.js";
import migration_006 from "./006_has_embed.js";
import migration_007 from "./007_event_seq_and_checkpoints.js";
import migration_008 from "./008_image_alt_text.js";
import migration_009 from "./009_store_sources.js";
import migration_010 from "./010_quote_count.js";
import migration_011 from "./011_reply_refs.js";

export const storeIndexMigrations = {
  "001_init": migration_001,
  "002_event_log": migration_002,
  "003_fts_and_derived": migration_003,
  "004_query_indexes": migration_004,
  "005_post_lang": migration_005,
  "006_has_embed": migration_006,
  "007_event_seq_and_checkpoints": migration_007,
  "008_image_alt_text": migration_008,
  "009_store_sources": migration_009,
  "010_quote_count": migration_010,
  "011_reply_refs": migration_011
};
