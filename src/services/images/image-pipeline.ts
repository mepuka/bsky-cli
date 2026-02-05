import { Context, Effect, Layer, Option } from "effect";
import { ImageAsset, ImageVariant } from "../../domain/images.js";
import { ImageCacheError } from "../../domain/errors.js";
import { ImageCache } from "./image-cache.js";
import { ImageConfig } from "./image-config.js";

export class ImagePipeline extends Context.Tag("@skygent/ImagePipeline")<
  ImagePipeline,
  {
    readonly getCached: (url: string, variant?: ImageVariant) => Effect.Effect<Option.Option<ImageAsset>, ImageCacheError>;
    readonly ensureCached: (url: string, variant?: ImageVariant) => Effect.Effect<Option.Option<ImageAsset>, ImageCacheError>;
    readonly ensureCachedMany: (urls: ReadonlyArray<string>, variant?: ImageVariant) => Effect.Effect<ReadonlyArray<ImageAsset>, ImageCacheError>;
  }
>() {
  static readonly layer = Layer.effect(
    ImagePipeline,
    Effect.gen(function* () {
      const config = yield* ImageConfig;
      const cache = yield* ImageCache;

      const getCached = Effect.fn("ImagePipeline.getCached")(
        (url: string, variant: ImageVariant = "original") =>
          config.enabled
            ? cache.getCached(url, variant)
            : Effect.succeed(Option.none<ImageAsset>())
      );

      const ensureCached = Effect.fn("ImagePipeline.ensureCached")(
        (url: string, variant: ImageVariant = "original") =>
          config.enabled
            ? cache.get(url, variant).pipe(Effect.map(Option.some))
            : Effect.succeed(Option.none<ImageAsset>())
      );

      const ensureCachedMany = Effect.fn("ImagePipeline.ensureCachedMany")(
        (urls: ReadonlyArray<string>, variant: ImageVariant = "original") =>
          config.enabled
            ? Effect.forEach(urls, (url) => cache.get(url, variant), {
                concurrency: 10
              })
            : Effect.succeed([])
      );

      return ImagePipeline.of({ getCached, ensureCached, ensureCachedMany });
    })
  );
}
