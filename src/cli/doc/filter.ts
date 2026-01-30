import * as Doc from "@effect/printer/Doc";
import type { Annotation } from "./annotation.js";
import { ann, field } from "./primitives.js";
import type { FilterCondition, FilterDescription } from "../../domain/filter-describe.js";

type SDoc = Doc.Doc<Annotation>;

const titleCase = (value: string) => value.replace(/\b\w/g, (char) => char.toUpperCase());

const conditionLine = (condition: FilterCondition): string => {
  const prefix = condition.negated ? "Must NOT " : "Must ";
  switch (condition.type) {
    case "Hashtag":       return `${prefix}have hashtag: ${condition.value}`;
    case "Author":        return `${prefix}be from: ${condition.value}`;
    case "AuthorIn":      return `${prefix}be from one of: ${condition.value}`;
    case "HashtagIn":     return `${prefix}have hashtag in: ${condition.value}`;
    case "Contains":      return `${prefix}contain: ${condition.value}`;
    case "IsReply":       return `${prefix}be a reply`;
    case "IsQuote":       return `${prefix}be a quote`;
    case "IsRepost":      return `${prefix}be a repost`;
    case "IsOriginal":    return `${prefix}be an original post`;
    case "Engagement":    return `${prefix}meet engagement: ${condition.value}`;
    case "HasImages":     return `${prefix}include images`;
    case "HasVideo":      return `${prefix}include video`;
    case "HasLinks":      return `${prefix}include links`;
    case "HasMedia":      return `${prefix}include media`;
    case "HasEmbed":      return `${prefix}include embeds`;
    case "Language":      return `${prefix}be in: ${condition.value}`;
    case "Regex":         return `${prefix}match regex: ${condition.value}`;
    case "DateRange":     return `${prefix}be in date range: ${condition.value}`;
    case "HasValidLinks": return `${prefix}have valid links`;
    case "Trending":      return `${prefix}match trending: ${condition.value}`;
    default:              return `${prefix}match ${condition.type}: ${condition.value}`;
  }
};

export const renderFilterDescriptionDoc = (description: FilterDescription): SDoc => {
  const lines: SDoc[] = [];
  lines.push(ann("value", Doc.text(description.summary)));

  if (description.conditions.length > 0) {
    lines.push(Doc.empty);
    lines.push(ann("label", Doc.text("Breakdown:")));
    for (const condition of description.conditions) {
      lines.push(Doc.hsep([ann("dim", Doc.text("-")), Doc.text(conditionLine(condition))]));
    }
  }

  lines.push(Doc.empty);
  lines.push(ann("label", Doc.text("Mode compatibility:")));
  lines.push(Doc.hsep([
    ann("dim", Doc.text("-")),
    Doc.text("EventTime:"),
    ann(description.eventTimeCompatible ? "status:ready" : "status:stale",
      Doc.text(description.eventTimeCompatible ? "YES" : "NO"))
  ]));
  lines.push(Doc.hsep([
    ann("dim", Doc.text("-")),
    Doc.text("DeriveTime:"),
    ann("status:ready", Doc.text("YES"))
  ]));

  lines.push(Doc.empty);
  lines.push(field("Effectful", description.effectful ? "Yes" : "No"));
  lines.push(field("Estimated cost", titleCase(description.estimatedCost)));
  lines.push(field("Complexity", `${titleCase(description.complexity)} (${description.conditionCount} conditions, ${description.negationCount} negations)`));

  return Doc.vsep(lines);
};
