/** Safely parse JSON, returning `undefined` on failure. */
export const safeParseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/** Format schema issues into an array of "path: message" strings. */
export const issueDetails = (
  issues: ReadonlyArray<{ readonly path: ReadonlyArray<unknown>; readonly message: string }>
) =>
  issues.map((issue) => {
    const path =
      issue.path.length > 0 ? issue.path.map((entry) => String(entry)).join(".") : "value";
    return `${path}: ${issue.message}`;
  });
