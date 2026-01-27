import { ParseResult } from "effect";
import { formatAgentError } from "./errors.js";

const storeConfigExample = {
  format: { json: true, markdown: false },
  autoSync: false,
  filters: [
    {
      name: "tech",
      expr: { _tag: "Hashtag", tag: "#tech" },
      output: { path: "views/tech", json: true, markdown: true }
    }
  ]
};

const safeParseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const hasPath = (issue: { readonly path: ReadonlyArray<unknown> }, key: string) =>
  issue.path.length > 0 && issue.path[0] === key;

const issueDetails = (
  issues: ReadonlyArray<{ readonly path: ReadonlyArray<unknown>; readonly message: string }>
) =>
  issues.map((issue) => {
    const path =
      issue.path.length > 0 ? issue.path.map((entry) => String(entry)).join(".") : "value";
    return `${path}: ${issue.message}`;
  });

export const formatStoreConfigParseError = (
  error: ParseResult.ParseError,
  raw: string
): string => {
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error);
  const received = safeParseJson(raw);
  const receivedValue = received === undefined ? raw : received;

  const jsonParseIssue = issues.find(
    (issue) =>
      issue._tag === "Transformation" &&
      typeof issue.message === "string" &&
      issue.message.startsWith("JSON Parse error")
  );
  if (jsonParseIssue) {
    return formatAgentError({
      error: "StoreConfigJsonParseError",
      message: "Invalid JSON in --config-json.",
      received: raw,
      details: [
        jsonParseIssue.message,
        "Tip: wrap JSON in single quotes to avoid shell escaping issues."
      ],
      expected: storeConfigExample
    });
  }

  if (issues.some((issue) => issue._tag === "Missing" && hasPath(issue, "filters"))) {
    return formatAgentError({
      error: "StoreConfigValidationError",
      message: "Store config requires a filters array.",
      received: receivedValue,
      expected: storeConfigExample,
      fix:
        "Add a filters array. Store config filters are materialized views; use --filter/--filter-json for sync-time filters."
    });
  }

  if (issues.some((issue) => hasPath(issue, "filters"))) {
    return formatAgentError({
      error: "StoreConfigValidationError",
      message: "Store config filters must include name, expr, and output fields.",
      received: receivedValue,
      expected: storeConfigExample,
      fix: "Each filter requires name, expr (filter JSON), and output (path/json/markdown).",
      details: issueDetails(issues)
    });
  }

  return formatAgentError({
    error: "StoreConfigValidationError",
    message: "Store config failed validation.",
    received: receivedValue,
    expected: storeConfigExample,
    details: issueDetails(issues),
    fix:
      "Check required fields (format, autoSync, filters). For ingestion filters, use --filter/--filter-json on sync/query."
  });
};
