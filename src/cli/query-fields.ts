import { Effect, Option } from "effect";
import { CliInputError } from "./errors.js";

type FieldSelector = {
  readonly prefix: ReadonlyArray<string>;
  readonly suffix: ReadonlyArray<string>;
  readonly wildcard: "none" | "object" | "array";
  readonly raw: string;
};

export type FieldSelectorsResolution = {
  readonly selectors: Option.Option<ReadonlyArray<FieldSelector>>;
  readonly source: "implicit" | "explicit";
};

const fieldPresets: Record<string, ReadonlyArray<string>> = {
  minimal: ["uri", "author", "text", "createdAt", "embedSummary"],
  social: ["uri", "author", "text", "metrics", "hashtags", "embedSummary"],
  images: ["uri", "author", "text", "createdAt", "images"],
  embeds: ["uri", "author", "text", "createdAt", "embedSummary"],
  media: ["uri", "author", "text", "createdAt", "images", "embedSummary"],
  full: []
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ensureNonEmpty = (value: string, message: string, cause: unknown) => {
  if (value.length === 0) {
    return Effect.fail(CliInputError.make({ message, cause }));
  }
  return Effect.void;
};

const scalarFieldHeads = new Set([
  "uri",
  "cid",
  "author",
  "authorDid",
  "text",
  "createdAt",
  "hashtags",
  "mentions",
  "mentionDids",
  "links",
  "facets",
  "langs",
  "tags",
  "selfLabels",
  "labels",
  "indexedAt"
]);

const parseFieldToken = (token: string) =>
  Effect.gen(function* () {
    const parts = token.split(".").map((segment) => segment.trim());
    if (parts.length === 0) {
      return yield* CliInputError.make({
        message: "Field token cannot be empty.",
        cause: token
      });
    }
    for (const part of parts) {
      yield* ensureNonEmpty(
        part,
        `Invalid field token "${token}".`,
        token
      );
    }
    if (parts.length > 1) {
      const head = parts[0] ?? "";
      if (scalarFieldHeads.has(head)) {
        const suggestion =
          head === "author"
            ? ' Use "author" or "authorProfile.handle".'
            : " Remove the dot path.";
        return yield* CliInputError.make({
          message: `Field "${token}" is not a valid path. "${head}" is a scalar field.${suggestion}`,
          cause: token
        });
      }
    }
    const wildcardIndex = parts.indexOf("*");
    const wildcardCount = parts.filter((part) => part === "*").length;
    if (wildcardCount > 1) {
      return yield* CliInputError.make({
        message: `Wildcard "*" can only appear once in "${token}".`,
        cause: token
      });
    }
    if (wildcardIndex === 0) {
      return yield* CliInputError.make({
        message: `Wildcard "*" cannot be the first segment in "${token}".`,
        cause: token
      });
    }
    if (wildcardIndex >= 0) {
      if (wildcardIndex === parts.length - 1) {
        return {
          prefix: parts.slice(0, -1),
          suffix: [],
          wildcard: "object",
          raw: token
        } satisfies FieldSelector;
      }
      return {
        prefix: parts.slice(0, wildcardIndex),
        suffix: parts.slice(wildcardIndex + 1),
        wildcard: "array",
        raw: token
      } satisfies FieldSelector;
    }
    return {
      prefix: parts,
      suffix: [],
      wildcard: "none",
      raw: token
    } satisfies FieldSelector;
  });

const normalizeTokens = (raw: string) =>
  raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

const expandPresets = (tokens: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const expanded: string[] = [];
    let fullRequested = false;

    for (const token of tokens) {
      if (token.startsWith("@")) {
        const name = token.slice(1);
        const preset = fieldPresets[name];
        if (!preset) {
          return yield* CliInputError.make({
            message: `Unknown fields preset "${token}".`,
            cause: token
          });
        }
        if (name === "full") {
          fullRequested = true;
        } else {
          expanded.push(...preset);
        }
      } else {
        expanded.push(token);
      }
    }

    if (fullRequested) {
      if (expanded.length > 0) {
        return yield* CliInputError.make({
          message: "Preset @full cannot be combined with other fields.",
          cause: tokens
        });
      }
      return { kind: "full" as const, tokens: [] as ReadonlyArray<string> };
    }

    if (expanded.length === 0) {
      return yield* CliInputError.make({
        message: "Fields list cannot be empty.",
        cause: tokens
      });
    }

    return { kind: "partial" as const, tokens: expanded };
  });

export const parseFieldSelectors = (
  raw: string
): Effect.Effect<Option.Option<ReadonlyArray<FieldSelector>>, CliInputError> =>
  Effect.gen(function* () {
    const tokens = normalizeTokens(raw);
    yield* ensureNonEmpty(raw.trim(), "Fields list cannot be empty.", raw);
    const expanded = yield* expandPresets(tokens);
    if (expanded.kind === "full") {
      return Option.none();
    }
    const selectors = yield* Effect.forEach(
      expanded.tokens,
      (token) => parseFieldToken(token),
      { discard: false }
    );
    return Option.some(selectors);
  });

export const resolveFieldSelectors = (
  fields: Option.Option<string>,
  compact: boolean
): Effect.Effect<FieldSelectorsResolution, CliInputError> =>
  Option.match(fields, {
    onNone: () =>
      (compact ? parseFieldSelectors("@minimal") : Effect.succeed(Option.none())).pipe(
        Effect.map((selectors) => ({ selectors, source: "implicit" as const }))
      ),
    onSome: (raw) =>
      parseFieldSelectors(raw).pipe(
        Effect.map((selectors) => ({ selectors, source: "explicit" as const }))
      )
  });

const getPathValue = (source: unknown, path: ReadonlyArray<string>): unknown => {
  let current: unknown = source;
  for (const segment of path) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
};

const ensureObjectPath = (target: Record<string, unknown>, path: string[]) => {
  let current: Record<string, unknown> = target;
  for (const segment of path) {
    const existing = current[segment];
    if (!isObject(existing)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  return current;
};

const setPathValue = (
  target: Record<string, unknown>,
  path: ReadonlyArray<string>,
  value: unknown
) => {
  if (path.length === 0) {
    return;
  }
  const head = path.slice(0, -1);
  const tail = path[path.length - 1]!;
  const container = ensureObjectPath(target, head);
  container[tail] = value;
};

const mergeObjects = (
  left: Record<string, unknown>,
  right: Record<string, unknown>
): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const existing = result[key];
    if (isObject(existing) && isObject(value)) {
      result[key] = mergeObjects(existing, value);
    } else {
      result[key] = value;
    }
  }
  return result;
};

const mergeArrayValues = (
  existing: Array<unknown> | undefined,
  next: Array<unknown>
) => {
  if (!existing) return next;
  const max = Math.max(existing.length, next.length);
  const merged = new Array<unknown>(max);
  for (let index = 0; index < max; index += 1) {
    const left = existing[index];
    const right = next[index];
    if (right === undefined) {
      merged[index] = left;
    } else if (left === undefined) {
      merged[index] = right;
    } else if (isObject(left) && isObject(right)) {
      merged[index] = mergeObjects(left, right);
    } else {
      merged[index] = right;
    }
  }
  return merged;
};

const setArrayPathValue = (
  target: Record<string, unknown>,
  path: ReadonlyArray<string>,
  value: Array<unknown>
) => {
  if (path.length === 0) {
    return;
  }
  const head = path.slice(0, -1);
  const tail = path[path.length - 1]!;
  const container = ensureObjectPath(target, head);
  const existing = container[tail];
  container[tail] = Array.isArray(existing)
    ? mergeArrayValues(existing, value)
    : value;
};

const projectArraySuffix = (item: unknown, suffix: ReadonlyArray<string>) => {
  const projected: Record<string, unknown> = {};
  if (!isObject(item)) {
    return projected;
  }
  const value = getPathValue(item, suffix);
  if (value === undefined) {
    return projected;
  }
  setPathValue(projected, suffix, value);
  return projected;
};

const applySelector = (
  target: Record<string, unknown>,
  source: unknown,
  selector: FieldSelector
) => {
  switch (selector.wildcard) {
    case "object": {
      const value = getPathValue(source, selector.prefix);
      if (value === undefined) return;
      if (Array.isArray(value)) {
        setPathValue(target, selector.prefix, value);
        return;
      }
      if (!isObject(value)) {
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (child !== undefined) {
          setPathValue(target, [...selector.prefix, key], child);
        }
      }
      return;
    }
    case "array": {
      const value = getPathValue(source, selector.prefix);
      if (!Array.isArray(value)) {
        return;
      }
      const projected = value.map((item) =>
        projectArraySuffix(item, selector.suffix)
      );
      setArrayPathValue(target, selector.prefix, projected);
      return;
    }
    case "none": {
      const value = getPathValue(source, selector.prefix);
      if (value !== undefined) {
        setPathValue(target, selector.prefix, value);
      }
      return;
    }
  }
};

export const projectFields = (
  source: unknown,
  selectors: ReadonlyArray<FieldSelector>
): Record<string, unknown> => {
  const target: Record<string, unknown> = {};
  for (const selector of selectors) {
    applySelector(target, source, selector);
  }
  return target;
};
