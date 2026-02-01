import { Duration } from "effect";
import { type FilterExpr, isEffectfulFilter } from "./filter.js";
import type { FilterErrorPolicy } from "./policies.js";

export type FilterCondition = {
  readonly type: string;
  readonly value: string;
  readonly operator?: "AND" | "OR";
  readonly negated?: boolean;
};

export type FilterDescription = {
  readonly filter: string;
  readonly summary: string;
  readonly conditions: ReadonlyArray<FilterCondition>;
  readonly effectful: boolean;
  readonly eventTimeCompatible: boolean;
  readonly deriveTimeCompatible: boolean;
  readonly complexity: "low" | "medium" | "high";
  readonly conditionCount: number;
  readonly negationCount: number;
  readonly estimatedCost: "very low" | "low" | "medium" | "high";
};

const quoteValue = (value: string) => {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  return `"${escaped}"`;
};

const needsQuotes = (value: string) => /[\s,():]/.test(value);

const formatValue = (value: string) => (needsQuotes(value) ? quoteValue(value) : value);

const formatWithOptions = (key: string, value: string, options: string[]) => {
  if (value.length === 0) {
    return options.length > 0 ? `${key}:${options.join(",")}` : key;
  }
  const optionSuffix = options.length > 0 ? `,${options.join(",")}` : "";
  return `${key}:${value}${optionSuffix}`;
};

const formatPolicy = (policy: FilterErrorPolicy) => {
  switch (policy._tag) {
    case "Include":
      return "include";
    case "Exclude":
      return "exclude";
    case "Retry": {
      const delayMs = Duration.toMillis(policy.baseDelay);
      const delayValue = formatValue(`${delayMs} millis`);
      return `retry,maxRetries=${policy.maxRetries},baseDelay=${delayValue}`;
    }
  }
};

const isDefaultPolicy = (tag: "HasValidLinks" | "Trending", policy: FilterErrorPolicy) => {
  switch (tag) {
    case "HasValidLinks":
      return policy._tag === "Exclude";
    case "Trending":
      return policy._tag === "Include";
  }
};

const formatEngagement = (expr: {
  readonly minLikes?: number;
  readonly minReposts?: number;
  readonly minReplies?: number;
}) => {
  const parts: string[] = [];
  if (expr.minLikes !== undefined) parts.push(`minLikes=${expr.minLikes}`);
  if (expr.minReposts !== undefined) parts.push(`minReposts=${expr.minReposts}`);
  if (expr.minReplies !== undefined) parts.push(`minReplies=${expr.minReplies}`);
  return parts.join(",");
};

const formatRegex = (pattern: string, flags?: string) => {
  const escaped = pattern.replace(/\//g, "\\/");
  return `/${escaped}/${flags ?? ""}`;
};

const formatLeafValue = (expr: FilterExpr): string => {
  switch (expr._tag) {
    case "Author":
      return expr.handle;
    case "Hashtag":
      return expr.tag;
    case "AuthorIn":
      return expr.handles.join(", ");
    case "HashtagIn":
      return expr.tags.join(", ");
    case "Contains": {
      const text = formatValue(expr.text);
      return expr.caseSensitive !== undefined
        ? `${text} (caseSensitive=${expr.caseSensitive})`
        : text;
    }
    case "IsReply":
      return "reply";
    case "IsQuote":
      return "quote";
    case "IsRepost":
      return "repost";
    case "IsOriginal":
      return "original";
    case "Engagement":
      return formatEngagement(expr);
    case "HasImages":
      return "images";
    case "MinImages":
      return `${expr.min}`;
    case "HasAltText":
      return "alt text";
    case "NoAltText":
      return "missing alt text";
    case "AltText":
      return formatValue(expr.text);
    case "AltTextRegex":
      return formatRegex(expr.pattern, expr.flags);
    case "HasVideo":
      return "video";
    case "HasLinks":
      return "links";
    case "HasMedia":
      return "media";
    case "HasEmbed":
      return "embed";
    case "Language":
      return expr.langs.join(", ");
    case "Regex": {
      const pattern = expr.patterns.length > 1 ? expr.patterns.join("|") : expr.patterns[0] ?? "";
      return formatRegex(pattern, expr.flags);
    }
    case "DateRange":
      return `${expr.start.toISOString()}..${expr.end.toISOString()}`;
    case "HasValidLinks":
      return "valid links";
    case "Trending":
      return expr.tag;
    case "All":
      return "all";
    case "None":
      return "none";
    case "And":
    case "Or":
    case "Not":
      return formatFilterExpr(expr);
  }
};

const formatLeafPhrase = (expr: FilterExpr): string => {
  switch (expr._tag) {
    case "Author":
      return `from ${expr.handle}`;
    case "Hashtag":
      return `with hashtag ${expr.tag}`;
    case "AuthorIn":
      return `from authors ${expr.handles.join(", ")}`;
    case "HashtagIn":
      return `with hashtags ${expr.tags.join(", ")}`;
    case "Contains":
      return `containing ${formatValue(expr.text)}`;
    case "IsReply":
      return "that are replies";
    case "IsQuote":
      return "that are quotes";
    case "IsRepost":
      return "that are reposts";
    case "IsOriginal":
      return "that are original posts";
    case "Engagement":
      return `with ${formatEngagement(expr)} engagement`;
    case "HasImages":
      return "with images";
    case "MinImages":
      return `with at least ${expr.min} images`;
    case "HasAltText":
      return "with alt text on all images";
    case "NoAltText":
      return "with missing alt text";
    case "AltText":
      return `with alt text containing ${formatValue(expr.text)}`;
    case "AltTextRegex":
      return `with alt text matching regex ${formatRegex(expr.pattern, expr.flags)}`;
    case "HasVideo":
      return "with video";
    case "HasLinks":
      return "with links";
    case "HasMedia":
      return "with media";
    case "HasEmbed":
      return "with embeds";
    case "Language":
      return `in ${expr.langs.join(", ")} language`;
    case "Regex": {
      const pattern = expr.patterns.length > 1 ? expr.patterns.join("|") : expr.patterns[0] ?? "";
      return `matching regex ${formatRegex(pattern, expr.flags)}`;
    }
    case "DateRange":
      return `between ${expr.start.toISOString()} and ${expr.end.toISOString()}`;
    case "HasValidLinks":
      return "with valid links";
    case "Trending":
      return `matching trending ${expr.tag}`;
    case "All":
      return "that match all posts";
    case "None":
      return "that match no posts";
    case "And":
    case "Or":
    case "Not":
      return `matching ${formatFilterExpr(expr)}`;
  }
};

const precedence = (expr: FilterExpr) => {
  switch (expr._tag) {
    case "Or":
      return 1;
    case "And":
      return 2;
    case "Not":
      return 3;
    default:
      return 4;
  }
};

const parenthesize = (value: string, parentPrec: number, currentPrec: number) =>
  currentPrec < parentPrec ? `(${value})` : value;

export const formatFilterExpr = (expr: FilterExpr, parentPrec = 0): string => {
  switch (expr._tag) {
    case "All":
      return "all";
    case "None":
      return "none";
    case "And": {
      const prec = precedence(expr);
      const value = `${formatFilterExpr(expr.left, prec)} AND ${formatFilterExpr(expr.right, prec)}`;
      return parenthesize(value, parentPrec, prec);
    }
    case "Or": {
      const prec = precedence(expr);
      const value = `${formatFilterExpr(expr.left, prec)} OR ${formatFilterExpr(expr.right, prec)}`;
      return parenthesize(value, parentPrec, prec);
    }
    case "Not": {
      const prec = precedence(expr);
      const value = `NOT ${formatFilterExpr(expr.expr, prec)}`;
      return parenthesize(value, parentPrec, prec);
    }
    case "Author":
      return `author:${expr.handle}`;
    case "Hashtag":
      return `hashtag:${expr.tag}`;
    case "AuthorIn":
      return `authorin:${expr.handles.join(",")}`;
    case "HashtagIn":
      return `hashtagin:${expr.tags.join(",")}`;
    case "Contains": {
      const options: string[] = [];
      if (expr.caseSensitive !== undefined) {
        options.push(`caseSensitive=${expr.caseSensitive}`);
      }
      return formatWithOptions("contains", formatValue(expr.text), options);
    }
    case "IsReply":
      return "is:reply";
    case "IsQuote":
      return "is:quote";
    case "IsRepost":
      return "is:repost";
    case "IsOriginal":
      return "is:original";
    case "Engagement": {
      const options = formatEngagement(expr);
      return formatWithOptions("engagement", "", options.length > 0 ? [options] : []);
    }
    case "HasImages":
      return "hasimages";
    case "MinImages":
      return `min-images:${expr.min}`;
    case "HasAltText":
      return "has:alt-text";
    case "NoAltText":
      return "no-alt-text";
    case "AltText":
      return formatWithOptions("alt-text", formatValue(expr.text), []);
    case "AltTextRegex":
      return formatWithOptions("alt-text", formatRegex(expr.pattern, expr.flags), []);
    case "HasVideo":
      return "hasvideo";
    case "HasLinks":
      return "haslinks";
    case "HasMedia":
      return "hasmedia";
    case "HasEmbed":
      return "hasembed";
    case "Language":
      return `language:${expr.langs.join(",")}`;
    case "Regex": {
      const pattern = expr.patterns.length > 1 ? expr.patterns.join("|") : expr.patterns[0] ?? "";
      return `regex:${formatRegex(pattern, expr.flags)}`;
    }
    case "DateRange":
      return `date:${expr.start.toISOString()}..${expr.end.toISOString()}`;
    case "HasValidLinks": {
      const options = isDefaultPolicy("HasValidLinks", expr.onError)
        ? []
        : [`onError=${formatPolicy(expr.onError)}`];
      return formatWithOptions("links", "", options);
    }
    case "Trending": {
      const options = isDefaultPolicy("Trending", expr.onError)
        ? []
        : [`onError=${formatPolicy(expr.onError)}`];
      return formatWithOptions("trending", expr.tag, options);
    }
  }
};

const flattenAnd = (expr: FilterExpr): ReadonlyArray<FilterExpr> => {
  if (expr._tag === "And") {
    return [...flattenAnd(expr.left), ...flattenAnd(expr.right)];
  }
  return [expr];
};

const flattenOr = (expr: FilterExpr): ReadonlyArray<FilterExpr> => {
  if (expr._tag === "Or") {
    return [...flattenOr(expr.left), ...flattenOr(expr.right)];
  }
  return [expr];
};

const countConditions = (expr: FilterExpr): number => {
  switch (expr._tag) {
    case "And":
    case "Or":
      return countConditions(expr.left) + countConditions(expr.right);
    case "Not":
      return countConditions(expr.expr);
    case "All":
    case "None":
      return 0;
    default:
      return 1;
  }
};

const countNegations = (expr: FilterExpr): number => {
  switch (expr._tag) {
    case "And":
    case "Or":
      return countNegations(expr.left) + countNegations(expr.right);
    case "Not":
      return 1 + countNegations(expr.expr);
    default:
      return 0;
  }
};

const complexityFor = (conditions: number, negations: number): "low" | "medium" | "high" => {
  if (conditions <= 2 && negations === 0) return "low";
  if (conditions <= 4 && negations <= 1) return "medium";
  return "high";
};

const estimatedCostFor = (
  effectful: boolean,
  conditions: number
): "very low" | "low" | "medium" | "high" => {
  if (effectful) return "high";
  if (conditions <= 1) return "very low";
  if (conditions <= 3) return "low";
  if (conditions <= 6) return "medium";
  return "high";
};

const describeClause = (expr: FilterExpr): FilterCondition => {
  if (expr._tag === "Not") {
    const base = describeClause(expr.expr);
    return { ...base, negated: true };
  }
  if (expr._tag === "Or") {
    const terms = flattenOr(expr);
    const firstType = terms[0]?._tag;
    const allSame = terms.every((term) => term._tag === firstType);
    if (allSame && firstType) {
      return {
        type: firstType,
        value: terms.map(formatLeafValue).join(" OR "),
        operator: "OR"
      };
    }
    return {
      type: "Group",
      value: formatFilterExpr(expr),
      operator: "OR"
    };
  }
  if (expr._tag === "And") {
    return {
      type: "Group",
      value: formatFilterExpr(expr),
      operator: "AND"
    };
  }
  return {
    type: expr._tag,
    value: formatLeafValue(expr)
  };
};

const clausePhrase = (expr: FilterExpr): string => {
  if (expr._tag === "Not") {
    const base = clausePhrase(expr.expr);
    const normalized = base.trim();
    if (normalized.startsWith("that are ")) {
      return `that are not ${normalized.slice("that are ".length)}`;
    }
    if (normalized.startsWith("that is ")) {
      return `that is not ${normalized.slice("that is ".length)}`;
    }
    if (normalized.startsWith("with ")) {
      return `without ${normalized.slice("with ".length)}`;
    }
    if (normalized.startsWith("containing ")) {
      return `not containing ${normalized.slice("containing ".length)}`;
    }
    if (normalized.startsWith("matching ")) {
      return `not matching ${normalized.slice("matching ".length)}`;
    }
    if (normalized.startsWith("from ")) {
      return `not from ${normalized.slice("from ".length)}`;
    }
    if (normalized.startsWith("in ")) {
      return `not in ${normalized.slice("in ".length)}`;
    }
    return `not ${normalized}`;
  }
  if (expr._tag === "Or") {
    const terms = flattenOr(expr);
    const firstType = terms[0]?._tag;
    const allSame = terms.every((term) => term._tag === firstType);
    if (allSame && firstType) {
      const values = terms.map(formatLeafValue).join(" or ");
      const sample = terms[0]!;
      switch (sample._tag) {
        case "Hashtag":
          return `with hashtags ${values}`;
        case "Author":
          return `from ${values}`;
        default:
          return `matching ${values}`;
      }
    }
    return `matching ${formatFilterExpr(expr)}`;
  }
  if (expr._tag === "And") {
    return `matching ${formatFilterExpr(expr)}`;
  }
  return formatLeafPhrase(expr);
};

const summaryFor = (expr: FilterExpr): string => {
  if (expr._tag === "All") return "All posts";
  if (expr._tag === "None") return "No posts";
  const clauses = flattenAnd(expr);
  const phrases = clauses.map(clausePhrase);
  const summary = phrases.reduce((acc, phrase, index) => {
    if (index === 0) return phrase;
    if (phrase.startsWith("that ")) {
      return `${acc} ${phrase}`;
    }
    return `${acc} and ${phrase}`;
  }, "");
  return `Posts ${summary}`;
};

export const describeFilter = (expr: FilterExpr): FilterDescription => {
  const effectful = isEffectfulFilter(expr);
  const conditionCount = countConditions(expr);
  const negationCount = countNegations(expr);
  const complexity = complexityFor(conditionCount, negationCount);
  const estimatedCost = estimatedCostFor(effectful, conditionCount);
  const conditions =
    expr._tag === "All" || expr._tag === "None"
      ? []
      : flattenAnd(expr).map(describeClause);
  return {
    filter: formatFilterExpr(expr),
    summary: summaryFor(expr),
    conditions,
    effectful,
    eventTimeCompatible: !effectful,
    deriveTimeCompatible: true,
    complexity,
    conditionCount,
    negationCount,
    estimatedCost
  };
};

const conditionLine = (condition: FilterCondition) => {
  const prefix = condition.negated ? "Must NOT " : "Must ";
  switch (condition.type) {
    case "Hashtag":
      return `${prefix}have hashtag: ${condition.value}`;
    case "Author":
      return `${prefix}be from: ${condition.value}`;
    case "AuthorIn":
      return `${prefix}be from one of: ${condition.value}`;
    case "HashtagIn":
      return `${prefix}have hashtag in: ${condition.value}`;
    case "Contains":
      return `${prefix}contain: ${condition.value}`;
    case "IsReply":
      return `${prefix}be a reply`;
    case "IsQuote":
      return `${prefix}be a quote`;
    case "IsRepost":
      return `${prefix}be a repost`;
    case "IsOriginal":
      return `${prefix}be an original post`;
    case "Engagement":
      return `${prefix}meet engagement: ${condition.value}`;
    case "HasImages":
      return `${prefix}include images`;
    case "MinImages":
      return `${prefix}include at least ${condition.value} images`;
    case "HasAltText":
      return `${prefix}include alt text on all images`;
    case "NoAltText":
      return `${prefix}include images missing alt text`;
    case "AltText":
      return `${prefix}include alt text containing: ${condition.value}`;
    case "AltTextRegex":
      return `${prefix}include alt text matching regex: ${condition.value}`;
    case "HasVideo":
      return `${prefix}include video`;
    case "HasLinks":
      return `${prefix}include links`;
    case "HasMedia":
      return `${prefix}include media`;
    case "HasEmbed":
      return `${prefix}include embeds`;
    case "Language":
      return `${prefix}be in: ${condition.value}`;
    case "Regex":
      return `${prefix}match regex: ${condition.value}`;
    case "DateRange":
      return `${prefix}be in date range: ${condition.value}`;
    case "HasValidLinks":
      return `${prefix}have valid links`;
    case "Trending":
      return `${prefix}match trending: ${condition.value}`;
    default:
      return `${prefix}match ${condition.type}: ${condition.value}`;
  }
};

const titleCase = (value: string) => value.replace(/\b\w/g, (char) => char.toUpperCase());

export const renderFilterDescription = (description: FilterDescription): string => {
  const lines: string[] = [];
  lines.push(description.summary);

  if (description.conditions.length > 0) {
    lines.push("");
    lines.push("Breakdown:");
    for (const condition of description.conditions) {
      lines.push(`- ${conditionLine(condition)}`);
    }
  }

  lines.push("");
  lines.push("Mode compatibility:");
  lines.push(`- EventTime: ${description.eventTimeCompatible ? "YES" : "NO"}`);
  lines.push("- DeriveTime: YES");

  lines.push("");
  lines.push(`Effectful: ${description.effectful ? "Yes" : "No"}`);
  lines.push(`Estimated cost: ${titleCase(description.estimatedCost)}`);
  lines.push(
    `Complexity: ${titleCase(description.complexity)} (${description.conditionCount} conditions, ${description.negationCount} negations)`
  );

  return lines.join("\n");
};
