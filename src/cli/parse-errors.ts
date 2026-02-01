import { Predicate } from "effect";

type ParseIssue = { readonly _tag: string; readonly message?: string };

const isTransformationIssue = (
  issue: ParseIssue
): issue is ParseIssue & { readonly _tag: "Transformation" } =>
  Predicate.isTagged(issue, "Transformation");

/** Safely parse JSON, returning `undefined` on failure. */
export const safeParseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

export const jsonParseTip = "Tip: wrap JSON in single quotes to avoid shell escaping issues.";

export const findJsonParseIssue = (issues: ReadonlyArray<ParseIssue>) =>
  issues.find(
    (issue) =>
      isTransformationIssue(issue) &&
      typeof issue.message === "string" &&
      issue.message.startsWith("JSON Parse error")
  );

/** Format schema issues into an array of "path: message" strings. */
export const issueDetails = (
  issues: ReadonlyArray<{ readonly path: ReadonlyArray<unknown>; readonly message: string }>
) =>
  issues.map((issue) => {
    const path =
      issue.path.length > 0 ? issue.path.map((entry) => String(entry)).join(".") : "value";
    return `${path}: ${issue.message}`;
  });
