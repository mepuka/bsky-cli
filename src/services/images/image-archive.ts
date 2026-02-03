import { FileSystem, Path } from "@effect/platform";
import { Clock, Context, Effect, Layer } from "effect";
import { createHash } from "node:crypto";
import { ImageAsset, ImageVariant } from "../../domain/images.js";
import { ImageArchiveError } from "../../domain/errors.js";
import { messageFromCause } from "../shared.js";
import { ImageConfig } from "./image-config.js";

const privateDirMode = 0o700;

export type ImageArchiveInput = {
  readonly url: string;
  readonly bytes: Uint8Array;
  readonly contentType?: string;
  readonly variant?: ImageVariant;
};

const normalizeContentType = (value: string | undefined) =>
  value ? value.split(";")[0]?.trim().toLowerCase() : undefined;

const extensionFromContentType = (value: string | undefined) => {
  const normalized = normalizeContentType(value);
  if (!normalized) return undefined;
  switch (normalized) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    case "image/svg+xml":
      return "svg";
    default: {
      const slash = normalized.indexOf("/");
      if (slash >= 0 && slash < normalized.length - 1) {
        return normalized.slice(slash + 1);
      }
      return undefined;
    }
  }
};

const extensionFromUrl = (path: Path.Path, url: string) => {
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname);
    if (!ext) return undefined;
    return ext.startsWith(".") ? ext.slice(1) : ext;
  } catch {
    return undefined;
  }
};

const hashBytes = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const toArchiveError = (message: string, path?: string, operation?: string) =>
  (cause: unknown) =>
    ImageArchiveError.make({
      message: messageFromCause(message, cause),
      path,
      operation,
      cause
    });

export class ImageArchive extends Context.Tag("@skygent/ImageArchive")<
  ImageArchive,
  {
    readonly store: (input: ImageArchiveInput) => Effect.Effect<ImageAsset, ImageArchiveError>;
    readonly resolvePath: (asset: ImageAsset) => string;
    readonly exists: (asset: ImageAsset) => Effect.Effect<boolean, ImageArchiveError>;
    readonly remove: (asset: ImageAsset) => Effect.Effect<void, ImageArchiveError>;
  }
>() {
  static readonly layer = Layer.effect(
    ImageArchive,
    Effect.gen(function* () {
      const config = yield* ImageConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const resolvePath = (asset: ImageAsset) =>
        path.isAbsolute(asset.path)
          ? asset.path
          : path.join(config.cacheRoot, asset.path);

      const ensureDir = (dir: string) =>
        fs.makeDirectory(dir, { recursive: true, mode: privateDirMode }).pipe(
          Effect.mapError(toArchiveError("Failed to create image cache directory", dir, "imageArchiveMkdir"))
        );

      const store = Effect.fn("ImageArchive.store")((input: ImageArchiveInput) =>
        Effect.gen(function* () {
          const variant = input.variant ?? "original";
          const now = yield* Clock.currentTimeMillis;

          const ext =
            extensionFromContentType(input.contentType) ??
            extensionFromUrl(path, input.url) ??
            "bin";
          const hash = hashBytes(input.bytes);
          const fileName = `${hash}.${ext}`;
          const relativePath = path.join(variant, fileName);
          const absolutePath = path.join(config.cacheRoot, relativePath);

          const baseDir =
            variant === "thumb" ? config.thumbsRoot : config.originalsRoot;

          yield* ensureDir(baseDir);

          const exists = yield* fs
            .exists(absolutePath)
            .pipe(Effect.mapError(toArchiveError("Failed to check image cache", absolutePath, "imageArchiveExists")));

          if (!exists) {
            yield* fs
              .writeFile(absolutePath, input.bytes)
              .pipe(Effect.mapError(toArchiveError("Failed to write image cache", absolutePath, "imageArchiveWrite")));
          }

          return ImageAsset.make({
            url: input.url,
            variant,
            path: relativePath,
            contentType: input.contentType,
            size: input.bytes.length,
            cachedAt: new Date(now)
          });
        })
      );

      const exists = Effect.fn("ImageArchive.exists")((asset: ImageAsset) =>
        fs
          .exists(resolvePath(asset))
          .pipe(Effect.mapError(toArchiveError("Failed to check image cache", asset.path, "imageArchiveExists")))
      );

      const remove = Effect.fn("ImageArchive.remove")((asset: ImageAsset) =>
        fs
          .remove(resolvePath(asset))
          .pipe(
            Effect.catchTag("SystemError", (error) =>
              error.reason === "NotFound" ? Effect.void : Effect.fail(error)
            ),
            Effect.mapError(toArchiveError("Failed to remove image cache", asset.path, "imageArchiveRemove"))
          )
      );

      return ImageArchive.of({ store, resolvePath, exists, remove });
    })
  );
}
