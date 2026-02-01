import { Duration, Match, Predicate } from "effect";
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
  return Match.type<FilterErrorPolicy>().pipe(
    Match.tagsExhaustive({
      Include: () => "include",
      Exclude: () => "exclude",
      Retry: (retryPolicy) => {
        const delayMs = Duration.toMillis(retryPolicy.baseDelay);
        const delayValue = formatValue(`${delayMs} millis`);
        return `retry,maxRetries=${retryPolicy.maxRetries},baseDelay=${delayValue}`;
      }
    })
  )(policy);
};

const isDefaultPolicy = (tag: "HasValidLinks" | "Trending", policy: FilterErrorPolicy) => {
  return Match.type<FilterErrorPolicy>().pipe(
    Match.tagsExhaustive({
      Include: () => tag === "Trending",
      Exclude: () => tag === "HasValidLinks",
      Retry: () => false
    })
  )(policy);
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

const formatLeafValue = (expr: FilterExpr): string =>
  Match.type<FilterExpr>().pipe(
    Match.tagsExhaustive({
      Author: (author) => author.handle,
      Hashtag: (hashtag) => hashtag.tag,
      AuthorIn: (authorIn) => authorIn.handles.join(", "),
      HashtagIn: (hashtagIn) => hashtagIn.tags.join(", "),
      Contains: (contains) => {
        const text = formatValue(contains.text);
        return contains.caseSensitive !== undefined
          ? `${text} (caseSensitive=${contains.caseSensitive})`
          : text;
      },
      IsReply: () => "reply",
      IsQuote: () => "quote",
      IsRepost: () => "repost",
      IsOriginal: () => "original",
      Engagement: (engagement) => formatEngagement(engagement),
      HasImages: () => "images",
      MinImages: (minImages) => `${minImages.min}`,
      HasAltText: () => "alt text",
      NoAltText: () => "missing alt text",
      AltText: (altText) => formatValue(altText.text),
      AltTextRegex: (altText) => formatRegex(altText.pattern, altText.flags),
      HasVideo: () => "video",
      HasLinks: () => "links",
      HasMedia: () => "media",
      HasEmbed: () => "embed",
      Language: (language) => language.langs.join(", "),
      Regex: (regexExpr) => {
        const pattern =
          regexExpr.patterns.length > 1
            ? regexExpr.patterns.join("|")
            : regexExpr.patterns[0] ?? "";
        return formatRegex(pattern, regexExpr.flags);
      },
      DateRange: (dateRange) =>
        `${dateRange.start.toISOString()}..${dateRange.end.toISOString()}`,
      HasValidLinks: () => "valid links",
      Trending: (trending) => trending.tag,
      All: () => "all",
      None: () => "none",
      And: (andExpr) => formatFilterExpr(andExpr),
      Or: (orExpr) => formatFilterExpr(orExpr),
      Not: (notExpr) => formatFilterExpr(notExpr)
    })
  )(expr);

const formatLeafPhrase = (expr: FilterExpr): string =>
  Match.type<FilterExpr>().pipe(
    Match.tagsExhaustive({
      Author: (author) => `from ${author.handle}`,
      Hashtag: (hashtag) => `with hashtag ${hashtag.tag}`,
      AuthorIn: (authorIn) => `from authors ${authorIn.handles.join(", ")}`,
      HashtagIn: (hashtagIn) => `with hashtags ${hashtagIn.tags.join(", ")}`,
      Contains: (contains) => `containing ${formatValue(contains.text)}`,
      IsReply: () => "that are replies",
      IsQuote: () => "that are quotes",
      IsRepost: () => "that are reposts",
      IsOriginal: () => "that are original posts",
      Engagement: (engagement) => `with ${formatEngagement(engagement)} engagement`,
      HasImages: () => "with images",
      MinImages: (minImages) => `with at least ${minImages.min} images`,
      HasAltText: () => "with alt text on all images",
      NoAltText: () => "with missing alt text",
      AltText: (altText) => `with alt text containing ${formatValue(altText.text)}`,
      AltTextRegex: (altText) =>
        `with alt text matching regex ${formatRegex(altText.pattern, altText.flags)}`,
      HasVideo: () => "with video",
      HasLinks: () => "with links",
      HasMedia: () => "with media",
      HasEmbed: () => "with embeds",
      Language: (language) => `in ${language.langs.join(", ")} language`,
      Regex: (regexExpr) => {
        const pattern =
          regexExpr.patterns.length > 1
            ? regexExpr.patterns.join("|")
            : regexExpr.patterns[0] ?? "";
        return `matching regex ${formatRegex(pattern, regexExpr.flags)}`;
      },
      DateRange: (dateRange) =>
        `between ${dateRange.start.toISOString()} and ${dateRange.end.toISOString()}`,
      HasValidLinks: () => "with valid links",
      Trending: (trending) => `matching trending ${trending.tag}`,
      All: () => "that match all posts",
      None: () => "that match no posts",
      And: (andExpr) => `matching ${formatFilterExpr(andExpr)}`,
      Or: (orExpr) => `matching ${formatFilterExpr(orExpr)}`,
      Not: (notExpr) => `matching ${formatFilterExpr(notExpr)}`
    })
  )(expr);

const precedence = (expr: FilterExpr) =>
  Match.type<FilterExpr>().pipe(
    Match.tags({
      Or: () => 1,
      And: () => 2,
      Not: () => 3
    }),
    Match.orElse(() => 4)
  )(expr);

const parenthesize = (value: string, parentPrec: number, currentPrec: number) =>
  currentPrec < parentPrec ? `(${value})` : value;

export const formatFilterExpr = (expr: FilterExpr, parentPrec = 0): string => {
  return Match.type<FilterExpr>().pipe(
    Match.tagsExhaustive({
      All: () => "all",
      None: () => "none",
      And: (andExpr) => {
        const prec = precedence(andExpr);
        const value = `${formatFilterExpr(andExpr.left, prec)} AND ${formatFilterExpr(andExpr.right, prec)}`;
        return parenthesize(value, parentPrec, prec);
      },
      Or: (orExpr) => {
        const prec = precedence(orExpr);
        const value = `${formatFilterExpr(orExpr.left, prec)} OR ${formatFilterExpr(orExpr.right, prec)}`;
        return parenthesize(value, parentPrec, prec);
      },
      Not: (notExpr) => {
        const prec = precedence(notExpr);
        const value = `NOT ${formatFilterExpr(notExpr.expr, prec)}`;
        return parenthesize(value, parentPrec, prec);
      },
      Author: (author) => `author:${author.handle}`,
      Hashtag: (hashtag) => `hashtag:${hashtag.tag}`,
      AuthorIn: (authorIn) => `authorin:${authorIn.handles.join(",")}`,
      HashtagIn: (hashtagIn) => `hashtagin:${hashtagIn.tags.join(",")}`,
      Contains: (contains) => {
        const options: string[] = [];
        if (contains.caseSensitive !== undefined) {
          options.push(`caseSensitive=${contains.caseSensitive}`);
        }
        return formatWithOptions("contains", formatValue(contains.text), options);
      },
      IsReply: () => "is:reply",
      IsQuote: () => "is:quote",
      IsRepost: () => "is:repost",
      IsOriginal: () => "is:original",
      Engagement: (engagement) => {
        const options = formatEngagement(engagement);
        return formatWithOptions("engagement", "", options.length > 0 ? [options] : []);
      },
      HasImages: () => "hasimages",
      MinImages: (minImages) => `min-images:${minImages.min}`,
      HasAltText: () => "has:alt-text",
      NoAltText: () => "no-alt-text",
      AltText: (altText) => formatWithOptions("alt-text", formatValue(altText.text), []),
      AltTextRegex: (altText) =>
        formatWithOptions("alt-text", formatRegex(altText.pattern, altText.flags), []),
      HasVideo: () => "hasvideo",
      HasLinks: () => "haslinks",
      HasMedia: () => "hasmedia",
      HasEmbed: () => "hasembed",
      Language: (language) => `language:${language.langs.join(",")}`,
      Regex: (regexExpr) => {
        const pattern =
          regexExpr.patterns.length > 1
            ? regexExpr.patterns.join("|")
            : regexExpr.patterns[0] ?? "";
        return `regex:${formatRegex(pattern, regexExpr.flags)}`;
      },
      DateRange: (dateRange) =>
        `date:${dateRange.start.toISOString()}..${dateRange.end.toISOString()}`,
      HasValidLinks: (hasValidLinks) => {
        const options = isDefaultPolicy("HasValidLinks", hasValidLinks.onError)
          ? []
          : [`onError=${formatPolicy(hasValidLinks.onError)}`];
        return formatWithOptions("links", "", options);
      },
      Trending: (trending) => {
        const options = isDefaultPolicy("Trending", trending.onError)
          ? []
          : [`onError=${formatPolicy(trending.onError)}`];
        return formatWithOptions("trending", trending.tag, options);
      }
    })
  )(expr);
};

const flattenAnd = (expr: FilterExpr): ReadonlyArray<FilterExpr> =>
  Match.type<FilterExpr>().pipe(
    Match.tags({
      And: (andExpr) => [...flattenAnd(andExpr.left), ...flattenAnd(andExpr.right)]
    }),
    Match.orElse((expr) => [expr])
  )(expr);

const flattenOr = (expr: FilterExpr): ReadonlyArray<FilterExpr> =>
  Match.type<FilterExpr>().pipe(
    Match.tags({
      Or: (orExpr) => [...flattenOr(orExpr.left), ...flattenOr(orExpr.right)]
    }),
    Match.orElse((expr) => [expr])
  )(expr);

const countConditions = (expr: FilterExpr): number =>
  Match.type<FilterExpr>().pipe(
    Match.tags({
      And: (andExpr) => countConditions(andExpr.left) + countConditions(andExpr.right),
      Or: (orExpr) => countConditions(orExpr.left) + countConditions(orExpr.right),
      Not: (notExpr) => countConditions(notExpr.expr),
      All: () => 0,
      None: () => 0
    }),
    Match.orElse(() => 1)
  )(expr);

const countNegations = (expr: FilterExpr): number =>
  Match.type<FilterExpr>().pipe(
    Match.tags({
      And: (andExpr) => countNegations(andExpr.left) + countNegations(andExpr.right),
      Or: (orExpr) => countNegations(orExpr.left) + countNegations(orExpr.right),
      Not: (notExpr) => 1 + countNegations(notExpr.expr)
    }),
    Match.orElse(() => 0)
  )(expr);

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

const describeClause = (expr: FilterExpr): FilterCondition =>
  Match.type<FilterExpr>().pipe(
    Match.withReturnType<FilterCondition>(),
    Match.tags({
      Not: (notExpr) => {
        const base = describeClause(notExpr.expr);
        return { ...base, negated: true };
      },
      Or: (orExpr) => {
        const terms = flattenOr(orExpr);
        const firstType = terms[0]?._tag;
        const allSame =
          firstType !== undefined &&
          terms.every((term) => Predicate.isTagged(term, firstType));
        if (allSame && firstType) {
          return {
            type: firstType,
            value: terms.map(formatLeafValue).join(" OR "),
            operator: "OR"
          };
        }
        return {
          type: "Group",
          value: formatFilterExpr(orExpr),
          operator: "OR"
        };
      },
      And: (andExpr) => ({
        type: "Group",
        value: formatFilterExpr(andExpr),
        operator: "AND"
      })
    }),
    Match.orElse((expr) => ({
      type: expr._tag,
      value: formatLeafValue(expr)
    }))
  )(expr);

const clausePhrase = (expr: FilterExpr): string =>
  Match.type<FilterExpr>().pipe(
    Match.tags({
      Not: (notExpr) => {
        const base = clausePhrase(notExpr.expr);
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
      },
      Or: (orExpr) => {
        const terms = flattenOr(orExpr);
        const firstType = terms[0]?._tag;
        const allSame =
          firstType !== undefined &&
          terms.every((term) => Predicate.isTagged(term, firstType));
        if (allSame && firstType) {
          const values = terms.map(formatLeafValue).join(" or ");
          const sample = terms[0]!;
          return Match.type<FilterExpr>().pipe(
            Match.tags({
              Hashtag: () => `with hashtags ${values}`,
              Author: () => `from ${values}`
            }),
            Match.orElse(() => `matching ${values}`)
          )(sample);
        }
        return `matching ${formatFilterExpr(orExpr)}`;
      },
      And: (andExpr) => `matching ${formatFilterExpr(andExpr)}`
    }),
    Match.orElse((expr) => formatLeafPhrase(expr))
  )(expr);

const summaryFor = (expr: FilterExpr): string =>
  Match.type<FilterExpr>().pipe(
    Match.tags({
      All: () => "All posts",
      None: () => "No posts"
    }),
    Match.orElse((expr) => {
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
    })
  )(expr);

export const describeFilter = (expr: FilterExpr): FilterDescription => {
  const effectful = isEffectfulFilter(expr);
  const conditionCount = countConditions(expr);
  const negationCount = countNegations(expr);
  const complexity = complexityFor(conditionCount, negationCount);
  const estimatedCost = estimatedCostFor(effectful, conditionCount);
  const conditions = Match.type<FilterExpr>().pipe(
    Match.tags({
      All: () => [] as ReadonlyArray<FilterCondition>,
      None: () => [] as ReadonlyArray<FilterCondition>
    }),
    Match.orElse((expr) => flattenAnd(expr).map(describeClause))
  )(expr);
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
