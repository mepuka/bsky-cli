import { FileSystem, Path } from "@effect/platform";
import { Chunk, Clock, Effect, Option, Ref, Schema, Stream } from "effect";
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
import { renderPostMarkdownRow, renderPostsMarkdownHeader } from "../domain/format.js";
import {
  StoreIoError
} from "../domain/errors.js";
import { defaultStoreConfig } from "../domain/defaults.js";
import { StorePath, Timestamp } from "../domain/primitives.js";
import { FilterSettings } from "./filter-settings.js";

const privateDirMode = 0o700;

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

const encodePostJson = (post: Post) =>
  Schema.encode(Schema.parseJson(PostSchema))(post).pipe(Effect.orDie);

const encodeManifestJson = (manifest: unknown) =>
  Schema.encode(Schema.parseJson(Schema.Unknown))(manifest).pipe(Effect.orDie);

const appendFileString = (
  fs: FileSystem.FileSystem,
  targetPath: string,
  value: string
) =>
  fs
    .writeFileString(targetPath, value, { flag: "a" })
    .pipe(Effect.mapError(toStoreIoError(targetPath)));

const resolveOutputDir = (
  path: Path.Path,
  storeRoot: string,
  store: StoreRef,
  outputPath: string
) =>
  Effect.suspend(() => {
    const base = path.resolve(storeRoot, store.root);
    const resolved = path.isAbsolute(outputPath)
      ? path.resolve(outputPath)
      : path.resolve(base, outputPath);
    const withinBase =
      resolved === base || resolved.startsWith(`${base}${path.sep}`);
    if (!withinBase) {
      return Effect.fail(
        StoreIoError.make({
          path: Schema.decodeUnknownSync(StorePath)(resolved),
          cause: "Output path must be within store root."
        })
      );
    }
    return Effect.succeed(resolved);
  });

const materializeFilter = Effect.fn("OutputManager.materializeFilter")(
  (store: StoreRef, spec: FilterSpec) =>
    Effect.gen(function* () {
      const config = yield* AppConfigService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const compiler = yield* FilterCompiler;
      const runtime = yield* FilterRuntime;
      const index = yield* StoreIndex;
      const filterSettings = yield* FilterSettings;

      const outputDir = yield* resolveOutputDir(path, config.storeRoot, store, spec.output.path);
      yield* fs
        .makeDirectory(outputDir, { recursive: true, mode: privateDirMode })
        .pipe(Effect.mapError(toStoreIoError(outputDir)));

      const expr = yield* compiler.compile(spec);
      const stream = index.query(store, StoreQuery.make({ filter: expr }));
      const predicate = yield* runtime.evaluate(expr);
      const filtered = stream.pipe(
        Stream.grouped(50),
        Stream.mapEffect((batch) =>
          traverseFilterEffect(batch, predicate, {
            concurrency: filterSettings.concurrency,
            batching: true
          }).pipe(Effect.withRequestBatching(true))
        ),
        Stream.mapConcat((chunk) => Chunk.toReadonlyArray(chunk))
      );
      const jsonPath = spec.output.json ? path.join(outputDir, "posts.json") : undefined;
      const markdownPath = spec.output.markdown ? path.join(outputDir, "posts.md") : undefined;

      if (jsonPath) {
        yield* fs
          .writeFileString(jsonPath, "[")
          .pipe(Effect.mapError(toStoreIoError(jsonPath)));
      }
      if (markdownPath) {
        const header = `${renderPostsMarkdownHeader()}\n`;
        yield* fs
          .writeFileString(markdownPath, header)
          .pipe(Effect.mapError(toStoreIoError(markdownPath)));
      }

      const countRef = yield* Ref.make(0);
      const jsonFirstRef = jsonPath ? yield* Ref.make(true) : undefined;

      const writeBatch = (batch: Chunk.Chunk<Post>) =>
        Effect.gen(function* () {
          const posts = Chunk.toReadonlyArray(batch);
          if (posts.length === 0) {
            return;
          }
          if (jsonPath && jsonFirstRef) {
            const isFirst = yield* Ref.get(jsonFirstRef);
            let first = isFirst;
            const encodedParts = yield* Effect.forEach(posts, (post) =>
              encodePostJson(post).pipe(
                Effect.map((encoded) => {
                  const prefix = first ? "" : ",";
                  first = false;
                  return `${prefix}${encoded}`;
                })
              )
            );
            yield* appendFileString(fs, jsonPath, encodedParts.join(""));
            if (isFirst) {
              yield* Ref.set(jsonFirstRef, false);
            }
          }
          if (markdownPath) {
            const markdownChunk = posts
              .map((post) => `${renderPostMarkdownRow(post)}\n`)
              .join("");
            yield* appendFileString(fs, markdownPath, markdownChunk);
          }
          yield* Ref.update(countRef, (count) => count + posts.length);
        });

      yield* filtered.pipe(Stream.grouped(50), Stream.runForEach(writeBatch));

      if (jsonPath && jsonFirstRef) {
        yield* appendFileString(fs, jsonPath, "]\n");
      }

      const postsCount = yield* Ref.get(countRef);

      const updatedAt = yield* Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Schema.decodeUnknown(Timestamp)(new Date(now).toISOString())
        ),
        Effect.orDie
      );

      const manifest = {
        name: spec.name,
        count: postsCount,
        updatedAt: updatedAt.toISOString(),
        output: {
          json: jsonPath ? path.basename(jsonPath) : undefined,
          markdown: markdownPath ? path.basename(markdownPath) : undefined
        }
      };
      const manifestPath = path.join(outputDir, "manifest.json");
      const manifestJson = yield* encodeManifestJson(manifest);
      yield* fs
        .writeFileString(
          manifestPath,
          ensureTrailingNewline(manifestJson)
        )
        .pipe(Effect.mapError(toStoreIoError(manifestPath)));

      return {
        name: spec.name,
        outputPath: outputDir,
        jsonPath,
        markdownPath,
        count: postsCount,
        updatedAt
      } satisfies MaterializedFilterOutput;
    })
);

const materializeFilters = (store: StoreRef, filters: ReadonlyArray<FilterSpec>) =>
  Effect.forEach(filters, (spec) => materializeFilter(store, spec), {
    discard: false
  });

export class OutputManager extends Effect.Service<OutputManager>()("@skygent/OutputManager", {
  effect: Effect.gen(function* () {
    const appConfig = yield* AppConfigService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const compiler = yield* FilterCompiler;
    const runtime = yield* FilterRuntime;
    const index = yield* StoreIndex;
    const manager = yield* StoreManager;
    const filterSettings = yield* FilterSettings;

    type OutputManagerDeps =
      | AppConfigService
      | FileSystem.FileSystem
      | Path.Path
      | FilterCompiler
      | FilterRuntime
      | StoreIndex
      | FilterSettings;

    const provideDeps = <A, E>(effect: Effect.Effect<A, E, OutputManagerDeps>) =>
      effect.pipe(
        Effect.provideService(AppConfigService, appConfig),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(FilterCompiler, compiler),
        Effect.provideService(FilterRuntime, runtime),
        Effect.provideService(StoreIndex, index),
        Effect.provideService(FilterSettings, filterSettings)
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

    return {
      materializeStore,
      materializeFilters: materializeFiltersFn
    };
  })
}) {
  static readonly layer = OutputManager.Default;
}
