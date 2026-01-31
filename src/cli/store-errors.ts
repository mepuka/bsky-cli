import { ParseResult } from "effect";
import { safeParseJson, issueDetails } from "./parse-errors.js";
import { formatAgentError } from "./errors.js";

const storeConfigExample = {
  format: { json: true, markdown: false },
  autoSync: false,
  filters: []
};

const storeConfigExampleJson = JSON.stringify(storeConfigExample);
const storeConfigDocHint = "See docs/cli.md for a minimal StoreConfig JSON example.";


const hasPath = (issue: { readonly path: ReadonlyArray<unknown> }, key: string) =>
  issue.path.length > 0 && issue.path[0] === key;

export const formatStoreConfigHelp = (
  message: string,
  error = "StoreConfigValidationError"
): string =>
  formatAgentError({
    error,
    message: `${message} ${storeConfigDocHint}`,
    expected: storeConfigExample,
    fix: `Start with: --config-json '${storeConfigExampleJson}'`
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
      message: `Invalid JSON in --config-json. ${storeConfigDocHint}`,
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
      message: `Store config requires a filters array. ${storeConfigDocHint}`,
      received: receivedValue,
      expected: storeConfigExample,
      fix:
        "Add a filters array. Store config filters are materialized views; use --filter/--filter-json for sync-time filters."
    });
  }

  if (issues.some((issue) => hasPath(issue, "filters"))) {
    return formatAgentError({
      error: "StoreConfigValidationError",
      message: `Store config filters must include name, expr, and output fields. ${storeConfigDocHint}`,
      received: receivedValue,
      expected: storeConfigExample,
      fix: "Each filter requires name, expr (filter JSON), and output (path/json/markdown).",
      details: issueDetails(issues)
    });
  }

  const details = issueDetails(issues);
  const primaryIssue = details[0];
  const issueHint = primaryIssue ? ` (${primaryIssue})` : "";
  return formatAgentError({
    error: "StoreConfigValidationError",
    message: `Store config failed validation${issueHint}. ${storeConfigDocHint}`,
    received: receivedValue,
    expected: storeConfigExample,
    details,
    fix:
      "Check required fields (format, autoSync, filters). For ingestion filters, use --filter/--filter-json on sync/query."
  });
};
