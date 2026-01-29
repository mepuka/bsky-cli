import { FileSystem, Path } from "@effect/platform";
import { Chunk, Clock, Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { StoreQuery } from "../domain/events.js";
import type { Post } from "../domain/post.js";
import { Post as PostSchema } from "../domain/post.js";
import type { FilterSpec, StoreRef } from "../domain/store.js";
import { FilterCompiler } from "./filter-compiler.js";
import { FilterRuntime } from "./filter-runtime.js";
import { StoreIndex } from "./store-index.js";
import { StoreManager } from "./store-manager.js";
import { AppConfigService } from "./app-config.js";
import { traverseFilterEffect } from "../typeclass/chunk.js";
import { renderPostsMarkdown } from "../domain/format.js";
import {
  FilterCompileError,
  FilterEvalError,
  StoreIndexError,
  StoreIoError
} from "../domain/errors.js";
import { defaultStoreConfig } from "../domain/defaults.js";
import { StorePath, Timestamp } from "../domain/primitives.js";

export interface MaterializedFilterOutput {
  readonly name: string;
  readonly outputPath: string;
  readonly jsonPath: string | undefined;
  readonly markdownPath: string | undefined;
  readonly count: number;
  readonly updatedAt: Date;
}

export interface MaterializedStoreOutput {
  readonly store: string;
  readonly filters: ReadonlyArray<MaterializedFilterOutput>;
}

const toStoreIoError = (path: string) => (cause: unknown) =>
  StoreIoError.make({
    path: Schema.decodeUnknownSync(StorePath)(path),
    cause
  });

const ensureTrailingNewline = (value: string) =>
  value.endsWith("\n") ? value : `${value}\n`;

const encodePostsJson = (posts: ReadonlyArray<Post>) =>
  Schema.encodeSync(Schema.parseJson(Schema.Array(PostSchema)))(posts);

const encodeManifestJson = (manifest: unknown) =>
  Schema.encodeSync(Schema.parseJson(Schema.Unknown))(manifest);

const materializePosts = (
  posts: ReadonlyArray<Post>,
  outputDir: string,
  output: FilterSpec["output"],
  fs: FileSystem.FileSystem,
  path: Path.Path
) =>
  Effect.gen(function* () {
    const jsonPath = output.json ? path.join(outputDir, "posts.json") : undefined;
    const markdownPath = output.markdown ? path.join(outputDir, "posts.md") : undefined;

    if (jsonPath) {
      const json = ensureTrailingNewline(encodePostsJson(posts));
      yield* fs
        .writeFileString(jsonPath, json)
        .pipe(Effect.mapError(toStoreIoError(jsonPath)));
    }

    if (markdownPath) {
      const markdown = ensureTrailingNewline(renderPostsMarkdown(posts));
      yield* fs
        .writeFileString(markdownPath, markdown)
        .pipe(Effect.mapError(toStoreIoError(markdownPath)));
    }

    return { jsonPath, markdownPath } as const;
  });

const resolveOutputDir = (
  path: Path.Path,
  storeRoot: string,
  store: StoreRef,
  outputPath: string
) => {
  if (path.isAbsolute(outputPath)) {
    return outputPath;
  }
  return path.join(storeRoot, store.root, outputPath);
};

const materializeFilter = Effect.fn("OutputManager.materializeFilter")(
  (store: StoreRef, spec: FilterSpec) =>
    Effect.gen(function* () {
      const config = yield* AppConfigService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const compiler = yield* FilterCompiler;
      const runtime = yield* FilterRuntime;
      const index = yield* StoreIndex;

      const outputDir = resolveOutputDir(path, config.storeRoot, store, spec.output.path);
      yield* fs
        .makeDirectory(outputDir, { recursive: true })
        .pipe(Effect.mapError(toStoreIoError(outputDir)));

      const expr = yield* compiler.compile(spec);
      const stream = index.query(store, StoreQuery.make({}));
      const predicate = yield* runtime.evaluate(expr);
      const filtered = stream.pipe(
        Stream.grouped(50),
        Stream.mapEffect((batch) =>
          traverseFilterEffect(batch, predicate, {
            concurrency: "unbounded",
            batching: true
          }).pipe(Effect.withRequestBatching(true))
        ),
        Stream.mapConcat((chunk) => Chunk.toReadonlyArray(chunk))
      );
      const collected = yield* Stream.runCollect(filtered);
      const posts = Chunk.toReadonlyArray(collected);

      const { jsonPath, markdownPath } = yield* materializePosts(
        posts,
        outputDir,
        spec.output,
        fs,
        path
      );

      const updatedAt = yield* Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Schema.decodeUnknown(Timestamp)(new Date(now).toISOString())
        ),
        Effect.orDie
      );

      const manifest = {
        name: spec.name,
        count: posts.length,
        updatedAt: updatedAt.toISOString(),
        output: {
          json: jsonPath ? path.basename(jsonPath) : undefined,
          markdown: markdownPath ? path.basename(markdownPath) : undefined
        }
      };
      const manifestPath = path.join(outputDir, "manifest.json");
      yield* fs
        .writeFileString(
          manifestPath,
          ensureTrailingNewline(encodeManifestJson(manifest))
        )
        .pipe(Effect.mapError(toStoreIoError(manifestPath)));

      return {
        name: spec.name,
        outputPath: outputDir,
        jsonPath,
        markdownPath,
        count: posts.length,
        updatedAt
      } satisfies MaterializedFilterOutput;
    })
);

const materializeFilters = (store: StoreRef, filters: ReadonlyArray<FilterSpec>) =>
  Effect.forEach(filters, (spec) => materializeFilter(store, spec), {
    discard: false
  });

export class OutputManager extends Context.Tag("@skygent/OutputManager")<
  OutputManager,
  {
    readonly materializeStore: (
      store: StoreRef
    ) => Effect.Effect<
      MaterializedStoreOutput,
      FilterCompileError | FilterEvalError | StoreIndexError | StoreIoError
    >;
    readonly materializeFilters: (
      store: StoreRef,
      filters: ReadonlyArray<FilterSpec>
    ) => Effect.Effect<
      ReadonlyArray<MaterializedFilterOutput>,
      FilterCompileError | FilterEvalError | StoreIndexError | StoreIoError
    >;
  }
>() {
  static readonly layer = Layer.effect(
    OutputManager,
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const compiler = yield* FilterCompiler;
      const runtime = yield* FilterRuntime;
      const index = yield* StoreIndex;
      const manager = yield* StoreManager;

      type OutputManagerDeps =
        | AppConfigService
        | FileSystem.FileSystem
        | Path.Path
        | FilterCompiler
        | FilterRuntime
        | StoreIndex;

      const provideDeps = <A, E>(effect: Effect.Effect<A, E, OutputManagerDeps>) =>
        effect.pipe(
          Effect.provideService(AppConfigService, appConfig),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(FilterCompiler, compiler),
          Effect.provideService(FilterRuntime, runtime),
          Effect.provideService(StoreIndex, index)
        );

      const materializeStore = Effect.fn("OutputManager.materializeStore")(
        (store: StoreRef) =>
          Effect.gen(function* () {
            const configOption = yield* manager.getConfig(store.name);
            const config = Option.getOrElse(configOption, () => defaultStoreConfig);

            const results = yield* provideDeps(materializeFilters(store, config.filters));
            return {
              store: store.name,
              filters: results
            } satisfies MaterializedStoreOutput;
          })
      );

      const materializeFiltersFn = Effect.fn("OutputManager.materializeFilters")(
        (store: StoreRef, filters: ReadonlyArray<FilterSpec>) =>
          provideDeps(materializeFilters(store, filters))
      );

      return OutputManager.of({
        materializeStore,
        materializeFilters: materializeFiltersFn
      });
    })
  );
}
