# Usability Improvements: Logging, Interactive Prompts, and Config Validation

**Severity:** Low/Medium
**Type:** Enhancement / UX
**Files:** `src/cli/logging.ts`, `src/cli/store.ts`, `src/cli/app.ts`

## Description

Several usability issues make the CLI difficult to use for human operators, particularly during initial setup and long-running operations.

### 1. JSON-only Logging
The `logInfo`, `logErrorEvent`, and `logProgress` functions in `src/cli/logging.ts` unconditionally output structured JSON to stderr.

```typescript
// src/cli/logging.ts
const encodeLog = (level: LogLevel, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: nowIso(), level, ...payload });
```

While this is excellent for machine consumption (e.g., piping to jq or a log aggregator), it creates a wall of unreadable text for a user watching a sync process in their terminal.

**Recommendation:**
*   Detect if stderr is a TTY.
*   If TTY, default to human-readable output (e.g., `[INFO] Starting sync for store 'my-store'`).
*   If not TTY (or if `--log-format=json` is passed), keep JSON.

### 2. Missing Interactive Confirmation
The `store delete` command fails immediately if `--force` is not provided.

```typescript
// src/cli/store.ts
if (!force) {
  return yield* CliInputError.make({ message: "--force is required..." });
}
```

**Recommendation:**
*   If running in an interactive terminal and `--force` is missing, prompt the user: `Are you sure you want to delete store 'name'? [y/N]`.
*   Proceed only on 'y'.

### 3. Missing Configuration Verification
Users setting up the tool for the first time have no easy way to verify their environment variables (credentials key, LLM keys, Bluesky auth) without running a command that might fail halfway through.

**Recommendation:**
*   Add a `skygent config check` command.
*   It should verify:
    *   `SKYGENT_CREDENTIALS_KEY` is a valid AES key.
    *   Bluesky credentials allow successful login.
    *   LLM API keys are accepted (simple ping/list models).
    *   Store root path is writable.
