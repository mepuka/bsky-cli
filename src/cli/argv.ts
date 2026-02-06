import { globalOptionNames } from "./config.js";

const subcommandNames = new Set([
  "config", "store", "sync", "query", "watch", "derive", "view",
  "filter", "search", "graph", "feed", "post", "image-cache",
  "pipe", "digest", "actor", "capabilities"
]);

const booleanGlobals = new Set(["--full", "--compact"]);
const globalNames = new Set(globalOptionNames as ReadonlyArray<string>);

const findSubcommandIndex = (tokens: ReadonlyArray<string>): number => {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;

    if (token === "--") {
      return -1;
    }

    if (token.startsWith("--")) {
      const eqIndex = token.indexOf("=");
      const flagPart = eqIndex >= 0 ? token.slice(0, eqIndex) : token;
      if (globalNames.has(flagPart)) {
        if (eqIndex >= 0 || booleanGlobals.has(flagPart)) {
          i += 1;
        } else {
          i += i + 1 < tokens.length ? 2 : 1;
        }
        continue;
      }
    }

    if (subcommandNames.has(token)) {
      return i;
    }

    i += 1;
  }

  return -1;
};

/**
 * Relocate global options found after a known subcommand to before it.
 * Commands with `Args.repeated` swallow trailing flags as positional args;
 * moving globals before the subcommand ensures they are parsed correctly.
 */
export const relocateGlobalOptions = (
  argv: ReadonlyArray<string>
): ReadonlyArray<string> => {
  // argv[0] = runtime, argv[1] = script path — real tokens start at index 2
  const prefix = argv.slice(0, 2);
  const tokens = argv.slice(2);

  const subcommandIndex = findSubcommandIndex(tokens);
  if (subcommandIndex < 0) return [...argv];

  const beforeSub = tokens.slice(0, subcommandIndex);
  const subAndAfter = tokens.slice(subcommandIndex);

  const relocated: string[] = [];
  const remaining: string[] = [];

  let i = 0;
  // Keep the subcommand token itself
  remaining.push(subAndAfter[0]!);
  i = 1;

  while (i < subAndAfter.length) {
    const token = subAndAfter[i]!;

    // Check for --flag=value form
    const eqIndex = token.indexOf("=");
    const flagPart = eqIndex >= 0 ? token.slice(0, eqIndex) : token;

    if (globalNames.has(flagPart)) {
      if (eqIndex >= 0) {
        // --flag=value — single token
        relocated.push(token);
        i++;
      } else if (booleanGlobals.has(flagPart)) {
        // Boolean flag — no value
        relocated.push(token);
        i++;
      } else {
        // Value flag — consume next token as value
        relocated.push(token);
        if (i + 1 < subAndAfter.length) {
          relocated.push(subAndAfter[i + 1]!);
          i += 2;
        } else {
          i++;
        }
      }
    } else {
      remaining.push(token);
      i++;
    }
  }

  return [...prefix, ...beforeSub, ...relocated, ...remaining];
};
