import migration_001 from "./001_init.js";
import migration_002 from "./002_add_description.js";

export const storeCatalogMigrations = {
  "001_init": migration_001,
  "002_add_description": migration_002
};
