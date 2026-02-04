import { Command, Options } from "@effect/cli";
import { Effect } from "effect";
import pkg from "../../package.json" with { type: "json" };
import { AppConfigService } from "../services/app-config.js";
import { filterSuggestions } from "./filter-dsl.js";
import { renderTableLegacy } from "./doc/table.js";
import { withExamples } from "./help.js";
import { writeJson, writeText } from "./output.js";
import {
  jsonNdjsonTableFormats,
  jsonTableFormats,
  queryOutputFormats,
  resolveOutputFormat,
  treeTableJsonFormats
} from "./output-format.js";

const formatOption = Options.choice("format", jsonTableFormats).pipe(
  Options.withDescription("Output format (default: config output format)"),
  Options.optional
);

const unique = (items: ReadonlyArray<string>) => Array.from(new Set(items));

const buildPredicateExamples = () => {
  const examples = new Map<string, string>();
  for (const entry of filterSuggestions) {
    const example = entry.suggestions[0];
    if (!example) continue;
    for (const key of entry.keys) {
      if (!examples.has(key)) {
        examples.set(key, example);
      }
    }
  }
  return Object.fromEntries(examples.entries());
};

const predicateKeys = unique(
  filterSuggestions.flatMap((entry) => entry.keys)
).sort();

const commandNames = [
  "config",
  "store",
  "sync",
  "query",
  "watch",
  "derive",
  "view",
  "filter",
  "search",
  "graph",
  "feed",
  "post",
  "image-cache",
  "pipe",
  "digest",
  "actor",
  "capabilities"
];

const sourceTypes = [
  "AuthorSource",
  "FeedSource",
  "ListSource",
  "TimelineSource",
  "JetstreamSource"
];

export const capabilitiesCommand = Command.make(
  "capabilities",
  { format: formatOption },
  ({ format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const outputFormat = resolveOutputFormat(
        format,
        appConfig.outputFormat,
        jsonTableFormats,
        "json"
      );
      const payload = {
        version: pkg.version,
        commands: commandNames,
        filters: {
          predicates: predicateKeys,
          operators: ["AND", "OR", "NOT", "!", "&&", "||"],
          examples: buildPredicateExamples()
        },
        outputFormats: {
          query: queryOutputFormats,
          jsonNdjsonTable: jsonNdjsonTableFormats,
          jsonTable: jsonTableFormats,
          treeTableJson: treeTableJsonFormats
        },
        sourceTypes
      };

      if (outputFormat === "json") {
        yield* writeJson(payload);
        return;
      }

      const rows = [
        ["version", pkg.version],
        ["commands", String(commandNames.length)],
        ["predicates", String(predicateKeys.length)],
        ["source types", sourceTypes.join(", ")]
      ];
      yield* writeText(renderTableLegacy(["FIELD", "VALUE"], rows));
    })
).pipe(
  Command.withDescription(
    withExamples("Show CLI capability metadata", [
      "skygent capabilities",
      "skygent capabilities --format table"
    ])
  )
);
