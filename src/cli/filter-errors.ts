import { ParseResult } from "effect";
import { formatAgentError, type AgentErrorPayload } from "./errors.js";

const validFilterTags = [
  "All",
  "None",
  "And",
  "Or",
  "Not",
  "Author",
  "Hashtag",
  "AuthorIn",
  "HashtagIn",
  "Contains",
  "IsReply",
  "IsQuote",
  "IsRepost",
  "IsOriginal",
  "Engagement",
  "HasImages",
  "HasVideo",
  "HasLinks",
  "HasMedia",
  "Language",
  "Regex",
  "DateRange",
  "HasValidLinks",
  "Trending"
];

const filterDocs = "docs/filters/README.md";

const safeParseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const getTag = (raw: string): string | undefined => {
  const parsed = safeParseJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  if (!("_tag" in parsed)) {
    return undefined;
  }
  const tag = (parsed as { readonly _tag?: unknown })._tag;
  return typeof tag === "string" ? tag : undefined;
};

const hasPath = (issue: { readonly path: ReadonlyArray<unknown> }, key: string) =>
  issue.path.length === 1 && issue.path[0] === key;

const validationError = (
  payload: Omit<AgentErrorPayload, "error">
) => formatAgentError({ error: "FilterValidationError", ...payload });

const jsonParseError = (
  payload: Omit<AgentErrorPayload, "error">
) => formatAgentError({ error: "FilterJsonParseError", ...payload });

const issueDetails = (
  issues: ReadonlyArray<{ readonly path: ReadonlyArray<unknown>; readonly message: string }>
) =>
  issues.map((issue) => {
    const path =
      issue.path.length > 0 ? issue.path.map((entry) => String(entry)).join(".") : "value";
    return `${path}: ${issue.message}`;
  });

export const formatFilterParseError = (error: ParseResult.ParseError, raw: string): string => {
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error);
  if (issues.length === 0) {
    return validationError({
      message: "Filter expression failed validation.",
      details: [ParseResult.TreeFormatter.formatErrorSync(error)]
    });
  }

  const tag = getTag(raw);
  const received = safeParseJson(raw);
  const receivedValue = received === undefined ? raw : received;

  const jsonParseIssue = issues.find(
    (issue) =>
      issue._tag === "Transformation" &&
      typeof issue.message === "string" &&
      issue.message.startsWith("JSON Parse error")
  );
  if (jsonParseIssue) {
    return jsonParseError({
      message: "Invalid JSON in --filter-json.",
      received: raw,
      details: [
        jsonParseIssue.message,
        "Tip: wrap JSON in single quotes to avoid shell escaping issues."
      ]
    });
  }

  const tagMissing = issues.some((issue) => issue._tag === "Missing" && hasPath(issue, "_tag"));
  if (tagMissing) {
    return validationError({
      message: "Filter expression requires a _tag field.",
      received: receivedValue,
      expected: { _tag: "Hashtag", tag: "#ai" },
      fix:
        "Add a valid _tag such as Hashtag, Author, Regex, or DateRange.",
      details: [`See ${filterDocs} for filter examples.`],
      validTags: validFilterTags
    });
  }

  const tagInvalid = issues.some((issue) => issue._tag === "Type" && hasPath(issue, "_tag"));
  if (tagInvalid) {
    return validationError({
      message: `Invalid filter type${tag ? ` "${tag}"` : ""}.`,
      received: receivedValue,
      expected: { _tag: "Hashtag", tag: "#ai" },
      fix: "Use a valid filter _tag.",
      details: [`See ${filterDocs} for the full list of filters.`],
      validTags: validFilterTags
    });
  }

  if (tag === "Regex" && issues.some((issue) => hasPath(issue, "patterns"))) {
    const hasPatternField =
      received && typeof received === "object" && "pattern" in received;
    return validationError({
      message: "Regex filter requires a patterns field (array of strings).",
      received: receivedValue,
      expected: { _tag: "Regex", patterns: ["[Tt]rump"], flags: "i" },
      fix: hasPatternField
        ? "Change 'pattern' to 'patterns' and wrap the value in an array."
        : "Add a patterns array with at least one regex pattern."
    });
  }
  if (tag === "AuthorIn" && issues.some((issue) => hasPath(issue, "handles"))) {
    return validationError({
      message: "AuthorIn filter requires a handles array.",
      received: receivedValue,
      expected: { _tag: "AuthorIn", handles: ["alice.bsky.social", "bob.bsky.social"] },
      fix: "Provide at least one handle in handles."
    });
  }
  if (tag === "HashtagIn" && issues.some((issue) => hasPath(issue, "tags"))) {
    return validationError({
      message: "HashtagIn filter requires a tags array.",
      received: receivedValue,
      expected: { _tag: "HashtagIn", tags: ["#tech", "#coding"] },
      fix: "Provide at least one hashtag in tags."
    });
  }
  if (tag === "Contains" && issues.some((issue) => hasPath(issue, "text"))) {
    return validationError({
      message: "Contains filter requires a text string.",
      received: receivedValue,
      expected: { _tag: "Contains", text: "typescript", caseSensitive: false },
      fix: "Provide a non-empty text value to search for."
    });
  }
  if (tag === "Hashtag" && issues.some((issue) => hasPath(issue, "tag"))) {
    return validationError({
      message: "Hashtag filter requires a tag field.",
      received: receivedValue,
      expected: { _tag: "Hashtag", tag: "#ai" },
      fix: "Add tag with a leading #, e.g. #ai."
    });
  }
  if (tag === "Author" && issues.some((issue) => hasPath(issue, "handle"))) {
    return validationError({
      message: "Author filter requires a handle field.",
      received: receivedValue,
      expected: { _tag: "Author", handle: "user.bsky.social" },
      fix: "Add handle with the full Bluesky handle."
    });
  }
  if (tag === "DateRange" && issues.some((issue) => hasPath(issue, "start") || hasPath(issue, "end"))) {
    return validationError({
      message: "DateRange filter requires start and end ISO timestamps with timezone.",
      received: receivedValue,
      expected: {
        _tag: "DateRange",
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-31T23:59:59Z"
      },
      fix: "Provide ISO timestamps for start and end with timezone (e.g. Z).",
      details: [`See ${filterDocs} for range examples.`]
    });
  }
  if (tag === "Language" && issues.some((issue) => hasPath(issue, "langs"))) {
    return validationError({
      message: "Language filter requires a langs array.",
      received: receivedValue,
      expected: { _tag: "Language", langs: ["en", "es"] },
      fix: "Provide one or more language codes in langs."
    });
  }
  if (
    (tag === "HasValidLinks" || tag === "Trending") &&
    issues.some((issue) => hasPath(issue, "onError"))
  ) {
    return validationError({
      message: "Effectful filters require an onError policy.",
      received: receivedValue,
      expected: {
        _tag: tag,
        onError: { _tag: "Retry", maxRetries: 3, baseDelay: "1 second" }
      },
      fix: "Add an onError policy (Include, Exclude, or Retry with maxRetries/baseDelay)."
    });
  }

  return validationError({
    message: "Filter expression failed validation.",
    received: receivedValue,
    details: issueDetails(issues)
  });
};
