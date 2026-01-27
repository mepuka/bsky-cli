import { Duration, Effect, ParseResult, Schema } from "effect";
import type { FilterExpr } from "../domain/filter.js";
import { all, and, none, not, or } from "../domain/filter.js";
import type { FilterErrorPolicy } from "../domain/policies.js";
import { ExcludeOnError, IncludeOnError, RetryOnError } from "../domain/policies.js";
import { Handle, Hashtag } from "../domain/primitives.js";
import { CliInputError } from "./errors.js";
import { parseRange } from "./range.js";

type Token =
  | { readonly _tag: "Word"; readonly value: string; readonly position: number }
  | { readonly _tag: "LParen"; readonly position: number }
  | { readonly _tag: "RParen"; readonly position: number }
  | { readonly _tag: "And"; readonly position: number }
  | { readonly _tag: "Or"; readonly position: number }
  | { readonly _tag: "Not"; readonly position: number };

const formatSchemaError = (error: unknown) => {
  if (ParseResult.isParseError(error)) {
    return ParseResult.TreeFormatter.formatErrorSync(error);
  }
  return String(error);
};

const formatDslError = (input: string, position: number | undefined, message: string) => {
  if (position === undefined) {
    return message;
  }
  const caret = `${" ".repeat(Math.max(0, position))}^`;
  return `${message}\n${input}\n${caret}`;
};

const failAt = (input: string, position: number | undefined, message: string) =>
  CliInputError.make({
    message: formatDslError(input, position, message),
    cause: { input, position, message }
  });

const isWhitespace = (char: string) => /\s/.test(char);

const tokenize = (input: string): Effect.Effect<ReadonlyArray<Token>, CliInputError> =>
  Effect.suspend(() => {
    const tokens: Array<Token> = [];
    let index = 0;
    const length = input.length;

    const pushWord = (value: string, position: number) => {
      const upper = value.toUpperCase();
      if (upper === "AND") {
        tokens.push({ _tag: "And", position });
        return;
      }
      if (upper === "OR") {
        tokens.push({ _tag: "Or", position });
        return;
      }
      if (upper === "NOT") {
        tokens.push({ _tag: "Not", position });
        return;
      }
      tokens.push({ _tag: "Word", value, position });
    };

    while (index < length) {
      const char = input[index];
      if (char === undefined) {
        break;
      }
      if (isWhitespace(char)) {
        index += 1;
        continue;
      }
      if (char === "(") {
        tokens.push({ _tag: "LParen", position: index });
        index += 1;
        continue;
      }
      if (char === ")") {
        tokens.push({ _tag: "RParen", position: index });
        index += 1;
        continue;
      }
      if (char === "!") {
        tokens.push({ _tag: "Not", position: index });
        index += 1;
        continue;
      }
      if (char === "&") {
        if (input.slice(index, index + 2) !== "&&") {
          return Effect.fail(failAt(input, index, "Unexpected '&'. Use '&&' or AND."));
        }
        tokens.push({ _tag: "And", position: index });
        index += 2;
        continue;
      }
      if (char === "|") {
        if (input.slice(index, index + 2) !== "||") {
          return Effect.fail(failAt(input, index, "Unexpected '|'. Use '||' or OR."));
        }
        tokens.push({ _tag: "Or", position: index });
        index += 2;
        continue;
      }

      const start = index;
      let word = "";
      let inQuotes = false;
      let quoteChar: string | null = null;
      let quoteStart = -1;

      while (index < length) {
        const current = input[index];
        if (current === undefined) {
          break;
        }
        if ((current === "\"" || current === "'") && input[index - 1] !== "\\") {
          if (!inQuotes) {
            inQuotes = true;
            quoteChar = current;
            quoteStart = index;
          } else if (quoteChar === current) {
            inQuotes = false;
            quoteChar = null;
            quoteStart = -1;
          }
          word += current;
          index += 1;
          continue;
        }
        if (!inQuotes && (isWhitespace(current) || current === "(" || current === ")")) {
          break;
        }
        word += current;
        index += 1;
      }

      if (inQuotes) {
        return Effect.fail(
          failAt(input, quoteStart >= 0 ? quoteStart : start, "Unterminated quote.")
        );
      }

      if (word.length === 0) {
        return Effect.fail(failAt(input, start, "Unexpected token."));
      }
      pushWord(word, start);
    }

    return Effect.succeed(tokens);
  });

const stripQuotes = (value: string) => {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return trimmed
        .slice(1, -1)
        .replace(/\\(["'\\])/g, "$1");
    }
  }
  return trimmed;
};

type OptionValue = {
  readonly key: string;
  readonly rawKey: string;
  readonly value: string;
  readonly position: number;
};

const normalizeOptionKey = (key: string) =>
  key.trim().toLowerCase().replace(/[-_]/g, "");

const splitOptionSegments = (
  raw: string,
  position: number
): Array<{ readonly text: string; readonly position: number }> => {
  const segments: Array<{ readonly text: string; readonly position: number }> = [];
  let start = 0;
  let inQuotes = false;
  let quoteChar: string | null = null;

  const pushSegment = (end: number) => {
    const slice = raw.slice(start, end);
    const trimmed = slice.trim();
    const leading = slice.length - slice.trimStart().length;
    segments.push({
      text: trimmed,
      position: position + start + leading
    });
  };

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'") {
      if (!inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (quoteChar === char) {
        inQuotes = false;
        quoteChar = null;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      pushSegment(index);
      start = index + 1;
    }
  }

  pushSegment(raw.length);
  return segments;
};

const parseValueOptions = (input: string, raw: string, position: number) =>
  Effect.suspend(() => {
    const segments = splitOptionSegments(raw, position);
    if (segments.length === 0) {
      return Effect.succeed({ value: "", valuePosition: position, options: new Map() });
    }

    const base = segments[0] ?? { text: "", position };
    const rest = segments.slice(1);
    const options = new Map<string, OptionValue>();

    for (const segment of rest) {
      if (segment.text.length === 0) {
        return Effect.fail(
          failAt(input, segment.position, "Empty option segment. Use key=value.")
        );
      }
      const equalsIndex = segment.text.indexOf("=");
      const colonIndex = segment.text.indexOf(":");
      const separatorIndex = equalsIndex >= 0 ? equalsIndex : colonIndex;
      if (separatorIndex === -1) {
        return Effect.fail(
          failAt(input, segment.position, "Options must be in key=value form.")
        );
      }
      const rawKey = segment.text.slice(0, separatorIndex).trim();
      const rawValue = segment.text.slice(separatorIndex + 1).trim();
      if (rawKey.length === 0) {
        return Effect.fail(
          failAt(input, segment.position, "Option key cannot be empty.")
        );
      }
      if (rawValue.length === 0) {
        return Effect.fail(
          failAt(input, segment.position, `Option "${rawKey}" must have a value.`)
        );
      }
      const key = normalizeOptionKey(rawKey);
      if (options.has(key)) {
        return Effect.fail(
          failAt(input, segment.position, `Duplicate option "${rawKey}".`)
        );
      }
      options.set(key, { key, rawKey, value: rawValue, position: segment.position });
    }

    return Effect.succeed({
      value: base.text,
      valuePosition: base.position,
      options
    });
  });

const looksLikeOptionSegment = (raw: string) => {
  const equalsIndex = raw.indexOf("=");
  const colonIndex = raw.indexOf(":");
  const separatorIndex = equalsIndex >= 0 ? equalsIndex : colonIndex;
  if (separatorIndex <= 0) {
    return false;
  }
  const key = raw.slice(0, separatorIndex).trim();
  const value = raw.slice(separatorIndex + 1).trim();
  return key.length > 0 && value.length > 0;
};

const takeOption = (
  options: Map<string, OptionValue>,
  keys: ReadonlyArray<string>,
  label: string,
  input: string
) =>
  Effect.suspend(() => {
    const normalizedKeys = keys.map(normalizeOptionKey);
    const matches = normalizedKeys
      .map((key) => options.get(key))
      .filter((value): value is OptionValue => value !== undefined);

    if (matches.length > 1) {
      const duplicate = matches[1]!;
      return Effect.fail(
        failAt(
          input,
          duplicate.position,
          `Multiple "${label}" options specified.`
        )
      );
    }

    const match = matches[0];
    if (match) {
      options.delete(match.key);
    }
    return Effect.succeed(match);
  });

const ensureNoUnknownOptions = (
  options: Map<string, OptionValue>,
  input: string
) => {
  if (options.size === 0) {
    return Effect.void;
  }
  const first = options.values().next().value as OptionValue;
  return Effect.fail(
    failAt(input, first.position, `Unknown option "${first.rawKey}".`)
  );
};

const parseNumberOption = (
  option: OptionValue,
  input: string,
  label: string
) => {
  const raw = stripQuotes(option.value);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return Effect.fail(
      failAt(input, option.position, `${label} must be a number.`)
    );
  }
  return Effect.succeed(parsed);
};

const parseIntOption = (option: OptionValue, input: string, label: string) =>
  Effect.gen(function* () {
    const value = yield* parseNumberOption(option, input, label);
    if (!Number.isInteger(value) || value < 0) {
      return yield* failAt(
        input,
        option.position,
        `${label} must be a non-negative integer.`
      );
    }
    return value;
  });

const parseDurationOption = (option: OptionValue, input: string, label: string) =>
  Effect.try({
    try: () => Duration.decode(stripQuotes(option.value) as Duration.DurationInput),
    catch: () =>
      failAt(
        input,
        option.position,
        `Invalid ${label} duration. Use formats like "30 seconds" or "500 millis".`
      )
  }).pipe(
    Effect.flatMap((duration) => {
      if (!Duration.isFinite(duration)) {
        return Effect.fail(
          failAt(input, option.position, `${label} must be a finite duration.`)
        );
      }
      if (Duration.toMillis(duration) < 0) {
        return Effect.fail(
          failAt(input, option.position, `${label} must be non-negative.`)
        );
      }
      return Effect.succeed(duration);
    })
  );

const parsePolicy = (
  options: Map<string, OptionValue>,
  fallback: FilterErrorPolicy,
  input: string,
  position: number
) =>
  Effect.gen(function* () {
    const onError = yield* takeOption(options, ["onError"], "onError", input);
    const maxRetries = yield* takeOption(
      options,
      ["maxRetries", "retries"],
      "maxRetries",
      input
    );
    const baseDelay = yield* takeOption(
      options,
      ["baseDelay", "delay"],
      "baseDelay",
      input
    );

    if (!onError && !maxRetries && !baseDelay) {
      return fallback;
    }

    const mode = onError ? stripQuotes(onError.value).toLowerCase() : "retry";

    switch (mode) {
      case "include":
        if (maxRetries || baseDelay) {
          return yield* failAt(
            input,
            onError?.position ?? position,
            "Retry options can only be used with onError=retry."
          );
        }
        return IncludeOnError.make({});
      case "exclude":
        if (maxRetries || baseDelay) {
          return yield* failAt(
            input,
            onError?.position ?? position,
            "Retry options can only be used with onError=retry."
          );
        }
        return ExcludeOnError.make({});
      case "retry": {
        if (!maxRetries) {
          return yield* failAt(
            input,
            onError?.position ?? position,
            "Retry policy requires maxRetries."
          );
        }
        if (!baseDelay) {
          return yield* failAt(
            input,
            onError?.position ?? position,
            "Retry policy requires baseDelay."
          );
        }
        const retries = yield* parseIntOption(
          maxRetries,
          input,
          "maxRetries"
        );
        const delay = yield* parseDurationOption(baseDelay, input, "baseDelay");
        return RetryOnError.make({ maxRetries: retries, baseDelay: delay });
      }
      default:
        return yield* failAt(
          input,
          onError?.position ?? position,
          `Unknown onError policy "${mode}".`
        );
    }
  });

const DEFAULT_LLM_MIN_CONFIDENCE = 0.7;

const defaultLinksPolicy = () => ExcludeOnError.make({});
const defaultTrendingPolicy = () => IncludeOnError.make({});
const defaultLlmPolicy = () => IncludeOnError.make({});

const decodeHandle = (raw: string, source: string, position: number) =>
  Schema.decodeUnknown(Handle)(raw).pipe(
    Effect.mapError((error) =>
      failAt(source, position, `Invalid handle: ${formatSchemaError(error)}`)
    )
  );

const decodeHashtag = (raw: string, source: string, position: number) =>
  Schema.decodeUnknown(Hashtag)(raw).pipe(
    Effect.mapError((error) =>
      failAt(source, position, `Invalid hashtag: ${formatSchemaError(error)}`)
    )
  );

const parseRegexValue = (raw: string) => {
  const trimmed = stripQuotes(raw);
  if (trimmed.length === 0) {
    return { pattern: "", flags: undefined };
  }
  if (trimmed.startsWith("/")) {
    const lastSlash = trimmed.lastIndexOf("/");
    if (lastSlash > 0) {
      const pattern = trimmed.slice(1, lastSlash);
      const flags = trimmed.slice(lastSlash + 1);
      return { pattern, flags: flags.length > 0 ? flags : undefined };
    }
  }
  return { pattern: trimmed, flags: undefined };
};

class Parser {
  private index = 0;

  constructor(
    private readonly input: string,
    private readonly tokens: ReadonlyArray<Token>
  ) {}

  parse = (): Effect.Effect<FilterExpr, CliInputError> => {
    const self = this;
    return Effect.gen(function* () {
      if (self.tokens.length === 0) {
        return yield* failAt(self.input, 0, "Empty filter expression.");
      }
      const expr = yield* self.parseOr();
      const next = self.peek();
      if (next) {
        return yield* self.fail(`Unexpected token "${self.describe(next)}".`, next.position);
      }
      return expr;
    });
  };

  private parseOr(): Effect.Effect<FilterExpr, CliInputError> {
    const self = this;
    return Effect.gen(function* () {
      let expr = yield* self.parseAnd();
      while (self.match("Or")) {
        const right = yield* self.parseAnd();
        expr = or(expr, right);
      }
      return expr;
    });
  }

  private parseAnd(): Effect.Effect<FilterExpr, CliInputError> {
    const self = this;
    return Effect.gen(function* () {
      let expr = yield* self.parseUnary();
      while (self.match("And")) {
        const right = yield* self.parseUnary();
        expr = and(expr, right);
      }
      return expr;
    });
  }

  private parseUnary(): Effect.Effect<FilterExpr, CliInputError> {
    const self = this;
    return Effect.gen(function* () {
      if (self.match("Not")) {
        const expr = yield* self.parseUnary();
        return not(expr);
      }
      return yield* self.parsePrimary();
    });
  }

  private parsePrimary(): Effect.Effect<FilterExpr, CliInputError> {
    const self = this;
    return Effect.gen(function* () {
      const current = self.peek();
      if (!current) {
        return yield* self.fail("Unexpected end of input.", self.input.length);
      }
      if (current._tag === "LParen") {
        self.advance();
        const expr = yield* self.parseOr();
        const closing = self.peek();
        if (!closing || closing._tag !== "RParen") {
          return yield* self.fail("Expected ')'.", self.input.length);
        }
        self.advance();
        return expr;
      }
      if (current._tag === "Word") {
        self.advance();
        return yield* self.parseWord(current);
      }
      return yield* self.fail(`Unexpected token "${self.describe(current)}".`, current.position);
    });
  }

  private parseWord(
    token: Extract<Token, { _tag: "Word" }>
  ): Effect.Effect<FilterExpr, CliInputError> {
    const self = this;
    return Effect.gen(function* () {
      const value = token.value;
      const lower = value.toLowerCase();
      if (lower === "all") {
        return all();
      }
      if (lower === "none") {
        return none();
      }
      if (lower === "links" || lower === "validlinks" || lower === "hasvalidlinks") {
        return { _tag: "HasValidLinks", onError: defaultLinksPolicy() };
      }

      const colonIndex = value.indexOf(":");
      if (colonIndex === -1) {
        return yield* self.fail(
          "Expected a filter expression like 'hashtag:#ai' or 'author:handle'.",
          token.position
        );
      }

      const key = value.slice(0, colonIndex).toLowerCase();
      let rawValue = value.slice(colonIndex + 1);
      let valuePosition = token.position + colonIndex + 1;
      if (rawValue.length === 0) {
        const next = self.peek();
        if (next && next._tag === "Word") {
          rawValue = next.value;
          valuePosition = next.position;
          self.advance();
        }
      }

      const { value: baseValueRaw, valuePosition: basePosition, options } =
        yield* parseValueOptions(self.input, rawValue, valuePosition);
      const baseValue = stripQuotes(baseValueRaw);

      switch (key) {
        case "author": {
          if (baseValue.length === 0) {
            return yield* self.fail(`Missing value for "${key}".`, token.position);
          }
          const handle = yield* decodeHandle(baseValue, self.input, basePosition);
          yield* ensureNoUnknownOptions(options, self.input);
          return { _tag: "Author", handle };
        }
        case "hashtag":
        case "tag": {
          if (baseValue.length === 0) {
            return yield* self.fail(`Missing value for "${key}".`, token.position);
          }
          const tag = yield* decodeHashtag(baseValue, self.input, basePosition);
          yield* ensureNoUnknownOptions(options, self.input);
          return { _tag: "Hashtag", tag };
        }
        case "regex": {
          const flagsOption = yield* takeOption(options, ["flags"], "flags", self.input);
          const { pattern, flags } = parseRegexValue(baseValueRaw);
          if (pattern.length === 0) {
            return yield* self.fail("Regex pattern cannot be empty.", token.position);
          }
          if (flags && flagsOption) {
            return yield* self.fail("Regex flags specified twice.", flagsOption.position);
          }
          const optionFlags = flagsOption ? stripQuotes(flagsOption.value) : undefined;
          if (flagsOption && optionFlags !== undefined && optionFlags.length === 0) {
            return yield* self.fail("Regex flags cannot be empty.", flagsOption.position);
          }
          yield* ensureNoUnknownOptions(options, self.input);
          const base = { _tag: "Regex", patterns: [pattern] } as const;
          const resolvedFlags = optionFlags ?? flags;
          return resolvedFlags ? { ...base, flags: resolvedFlags } : base;
        }
        case "date":
        case "range":
        case "daterange": {
          if (baseValue.length === 0) {
            return yield* self.fail("Date range must be <start>..<end>.", token.position);
          }
          const range = yield* parseRange(baseValue).pipe(
            Effect.mapError((error) =>
              failAt(self.input, basePosition, error.message)
            )
          );
          yield* ensureNoUnknownOptions(options, self.input);
          return { _tag: "DateRange", start: range.start, end: range.end };
        }
        case "links":
        case "validlinks":
        case "hasvalidlinks": {
          let resolvedValue = baseValue;
          let resolvedOptions = options;
          if (rawValue.length > 0 && looksLikeOptionSegment(rawValue)) {
            const reparsed = yield* parseValueOptions(
              self.input,
              `,${rawValue}`,
              Math.max(0, valuePosition - 1)
            );
            resolvedValue = stripQuotes(reparsed.value);
            resolvedOptions = reparsed.options;
          }
          if (resolvedValue.length > 0) {
            return yield* self.fail(
              "HasValidLinks does not take a value.",
              token.position
            );
          }
          const policy = yield* parsePolicy(
            resolvedOptions,
            defaultLinksPolicy(),
            self.input,
            token.position
          );
          yield* ensureNoUnknownOptions(resolvedOptions, self.input);
          return { _tag: "HasValidLinks", onError: policy };
        }
        case "trending":
        case "trend": {
          if (baseValue.length === 0) {
            return yield* self.fail(`Missing value for "${key}".`, token.position);
          }
          const tag = yield* decodeHashtag(baseValue, self.input, basePosition);
          const policy = yield* parsePolicy(
            options,
            defaultTrendingPolicy(),
            self.input,
            token.position
          );
          yield* ensureNoUnknownOptions(options, self.input);
          return { _tag: "Trending", tag, onError: policy };
        }
        case "llm": {
          if (baseValue.length === 0) {
            return yield* self.fail("LLM prompt cannot be empty.", token.position);
          }
          const minConfidenceOption = yield* takeOption(
            options,
            ["minConfidence", "min", "confidence"],
            "minConfidence",
            self.input
          );
          const minConfidence = minConfidenceOption
            ? yield* parseNumberOption(
                minConfidenceOption,
                self.input,
                "minConfidence"
              )
            : DEFAULT_LLM_MIN_CONFIDENCE;
          if (minConfidence < 0 || minConfidence > 1) {
            return yield* self.fail(
              "minConfidence must be between 0 and 1.",
              minConfidenceOption?.position ?? token.position
            );
          }
          const policy = yield* parsePolicy(
            options,
            defaultLlmPolicy(),
            self.input,
            token.position
          );
          yield* ensureNoUnknownOptions(options, self.input);
          return {
            _tag: "Llm",
            prompt: baseValue,
            minConfidence,
            onError: policy
          };
        }
        default:
          return yield* self.fail(`Unknown filter type "${key}".`, token.position);
      }
    });
  }

  private fail(message: string, position: number): Effect.Effect<never, CliInputError> {
    return Effect.fail(failAt(this.input, position, message));
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private advance(): Token | undefined {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }

  private match(tag: Token["_tag"]): boolean {
    const token = this.peek();
    if (token && token._tag === tag) {
      this.advance();
      return true;
    }
    return false;
  }

  private describe(token: Token): string {
    switch (token._tag) {
      case "Word":
        return token.value;
      case "LParen":
        return "(";
      case "RParen":
        return ")";
      case "And":
        return "AND";
      case "Or":
        return "OR";
      case "Not":
        return "NOT";
    }
  }
}

export const parseFilterDsl = Effect.fn("FilterDsl.parse")((input: string) =>
  tokenize(input).pipe(
    Effect.flatMap((tokens) => new Parser(input, tokens).parse())
  )
);
