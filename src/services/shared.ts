import { FileSystem, Path } from "@effect/platform";
import { Effect, ParseResult } from "effect";
import { ConfigError } from "../domain/errors.js";

/** Extract a human-readable message from an unknown cause, falling back to the given string. */
export const messageFromCause = (fallback: string, cause: unknown) => {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return fallback;
};

/** Strip `undefined` values from a record, returning a Partial<T>. */
export const pickDefined = <T extends Record<string, unknown>>(input: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as Partial<T>;

type FormatParseErrorOptions = {
  readonly label?: string;
  readonly maxIssues?: number;
};

const formatPath = (path: ReadonlyArray<unknown>) =>
  path.length > 0 ? path.map((entry) => String(entry)).join(".") : "value";

export const formatParseError = (
  error: ParseResult.ParseError,
  options?: FormatParseErrorOptions
) => {
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error);
  if (issues.length === 0) {
    return ParseResult.TreeFormatter.formatErrorSync(error);
  }

  const jsonParseIssue = issues.find(
    (issue) =>
      issue._tag === "Transformation" &&
      typeof issue.message === "string" &&
      issue.message.startsWith("JSON Parse error")
  );
  if (jsonParseIssue) {
    const header = options?.label
      ? `Invalid JSON input for ${options.label}.`
      : "Invalid JSON input.";
    return [
      header,
      jsonParseIssue.message,
      "Tip: wrap JSON in single quotes to avoid shell escaping issues."
    ].join("\n");
  }

  const maxIssues = options?.maxIssues ?? 6;
  const lines = issues.slice(0, maxIssues).map((issue) => {
    const path = formatPath(issue.path);
    return `${path}: ${issue.message}`;
  });
  if (issues.length > maxIssues) {
    lines.push(`Additional issues: ${issues.length - maxIssues}`);
  }

  const header = options?.label ? `Invalid ${options.label}.` : undefined;
  return header ? [header, ...lines].join("\n") : lines.join("\n");
};

/** Format a Schema parse error (or arbitrary unknown) as a readable string. */
export const formatSchemaError = (error: unknown) => {
  if (ParseResult.isParseError(error)) {
    return formatParseError(error);
  }
  return String(error);
};

/** Recursively compute the total byte-size of all files under a directory. */
export const directorySize = (fs: FileSystem.FileSystem, path: Path.Path, root: string) =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return 0;
    }
    const entries = yield* fs
      .readDirectory(root, { recursive: true })
      .pipe(Effect.orElseSucceed(() => []));
    if (entries.length === 0) {
      return 0;
    }
    const sizes = yield* Effect.forEach(
      entries,
      (entry) =>
        fs
          .stat(path.join(root, entry))
          .pipe(
            Effect.map((info) => (info.type === "File" ? Number(info.size) : 0)),
            Effect.orElseSucceed(() => 0)
          ),
      { concurrency: 10 }
    );
    return sizes.reduce((total, size) => total + size, 0);
  });

/** Validate that a numeric config value is >= 1. */
export const validatePositive = (name: string, value: number) => {
  if (!Number.isFinite(value) || value < 1) {
    return ConfigError.make({ message: `${name} must be >= 1.` });
  }
};

/** Validate that a numeric config value is >= 0. */
export const validateNonNegative = (name: string, value: number) => {
  if (!Number.isFinite(value) || value < 0) {
    return ConfigError.make({ message: `${name} must be >= 0.` });
  }
};
