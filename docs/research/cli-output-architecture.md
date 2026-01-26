# CLI Output + Streaming Architecture (Effect/Bun)

This document outlines the recommended architecture for CLI output and streaming in this repo.
The goal is to keep stdout pipe-friendly, preserve stderr for logs/progress, and use Effect
stream/sink patterns for efficient backpressure-aware output.

## Goals

- Keep machine-readable output on stdout only.
- Route logs, progress, and diagnostics to stderr.
- Prefer `Stream.run` with sinks for streaming output to avoid per-element `Console.log` overhead.
- Provide a single Output service for consistent behavior across CLI commands.
- Preserve existing JSON/NDJSON and human-readable formats while supporting large streams.

## Current State (Summary)

- NDJSON output uses `Stream.runForEach` with `Console.log`.
- Non-NDJSON formats collect the entire stream before formatting.
- Logging and progress already go to stderr.

## Proposed Architecture

### 1) Output Service

Create a `CliOutput` service to centralize stdout/stderr behavior. It should expose:

- `stdout: Sink<void, string | Uint8Array, never, PlatformError>`
- `stderr: Sink<void, string | Uint8Array, never, PlatformError>`
- `writeJson(value, pretty?)`
- `writeText(value)`
- `writeJsonStream(stream)`

The service implementation should use Bun sinks:

- `BunSink.stdout` for stdout
- `BunSink.stderr` for stderr

This keeps output behavior consistent and makes stdout/stderr separation explicit.

### 2) Stream-to-sink for NDJSON

Prefer `Stream.run` over `Stream.runForEach` for stream output. Example shape:

```ts
import { Sink, Stream } from "effect";
import { BunSink } from "@effect/platform-bun";

const ndjsonSink = BunSink.stdout;

const writeJsonStream = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream
    .pipe(Stream.map((value) => JSON.stringify(value) + "\n"))
    .pipe(Stream.run(ndjsonSink));
```

This is backpressure-aware and avoids per-element `Console.log` calls.

### 3) Logging/Progress to stderr

Keep structured logs/progress on stderr. Consolidate into the Output service or a dedicated
`CliLog` service that uses `BunSink.stderr` (or `Console.error` if staying with Console). This
keeps stdout clean for piping and supports `--quiet`/`--verbose` behavior.

### 4) TTY-aware behavior (optional)

When stdout is not a TTY, consider suppressing progress logs by default unless `--verbose` is
passed. Use a Terminal service from `@effect/platform` to detect TTY.

### 5) Non-stream formats

For `json`, `markdown`, `table` formats that require full data:

- Keep `Stream.runCollect` for now.
- Consider adding a `--limit` or pagination to avoid unbounded memory for huge datasets.

## Suggested Module Layout

```
src/cli/output.ts
  - CliOutput Tag
  - layer using BunSink.stdout/stderr
  - writeJson / writeText / writeJsonStream

src/cli/logging.ts
  - use CliOutput.stderr for structured logs
```

## Adoption Plan

1) Add `CliOutput` service and layer (uses `BunSink.stdout/stderr`).
2) Update `writeJsonStream` to use `Stream.run` + sink.
3) Refactor `logInfo/logError/logProgress` to write through `CliOutput`.
4) Optionally add TTY-based progress suppression.

## Notes

- Keep stdout strictly for command output (JSON, NDJSON, tables, markdown).
- Keep stderr for logs/progress/errors so pipes remain stable.
- This architecture aligns with Effect CLI patterns and keeps output composable.
