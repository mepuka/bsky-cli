import type { EmbedImage, EmbedRecordTarget, PostEmbed } from "./bsky.js";
import { isEmbedExternal, isEmbedImages } from "./bsky.js";
import { EmbedExternalSummary, EmbedRecordSummary, EmbedSummary, ImageRef, ImageSummary } from "./images.js";

const normalizeAlt = (alt: string) => {
  const trimmed = alt.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const toImageRef = (image: EmbedImage) =>
  new ImageRef({
    fullsizeUrl: image.fullsize,
    thumbUrl: image.thumb,
    alt: normalizeAlt(image.alt),
    aspectRatio: image.aspectRatio
  });

const hasAltText = (image: ImageRef) =>
  typeof image.alt === "string" && image.alt.trim().length > 0;

const summarizeImages = (images: ReadonlyArray<ImageRef>) => {
  const thumbnailUrl = images.find((image) => image.thumbUrl.length > 0)?.thumbUrl;
  return new ImageSummary({
    imageCount: images.length,
    hasAltText: images.length > 0 && images.every(hasAltText),
    thumbnailUrl
  });
};

export const extractImageAltText = (embed?: PostEmbed): ReadonlyArray<string> => {
  const refs = extractImageRefs(embed);
  const alts: string[] = [];
  for (const ref of refs) {
    if (ref.alt) {
      alts.push(ref.alt);
    }
  }
  return alts;
};

const summarizeRecord = (record: EmbedRecordTarget) => {
  const uri = "uri" in record ? record.uri : undefined;
  const authorHandle = record._tag === "RecordView" ? record.author.handle : undefined;
  return new EmbedRecordSummary({ uri, authorHandle });
};

export const extractImageRefs = (embed?: PostEmbed): ReadonlyArray<ImageRef> => {
  if (!embed) return [];
  switch (embed._tag) {
    case "Images":
      return embed.images.map(toImageRef);
    case "RecordWithMedia":
      return isEmbedImages(embed.media) ? embed.media.images.map(toImageRef) : [];
    default:
      return [];
  }
};

export const summarizeEmbed = (embed?: PostEmbed): EmbedSummary | undefined => {
  if (!embed) return undefined;

  switch (embed._tag) {
    case "Images": {
      const images = embed.images.map(toImageRef);
      return new EmbedSummary({
        type: "images",
        imageSummary: summarizeImages(images)
      });
    }
    case "External":
      return new EmbedSummary({
        type: "external",
        external: new EmbedExternalSummary({
          uri: embed.uri,
          title: embed.title,
          description: embed.description,
          thumb: embed.thumb
        })
      });
    case "Video":
      return new EmbedSummary({ type: "video" });
    case "Record":
      return new EmbedSummary({
        type: "record",
        record: summarizeRecord(embed.record)
      });
    case "RecordWithMedia": {
      const base = {
        type: "record_with_media" as const,
        record: summarizeRecord(embed.record)
      };
      if (isEmbedImages(embed.media)) {
        const images = embed.media.images.map(toImageRef);
        return new EmbedSummary({
          ...base,
          imageSummary: summarizeImages(images)
        });
      }
      if (isEmbedExternal(embed.media)) {
        return new EmbedSummary({
          ...base,
          external: new EmbedExternalSummary({
            uri: embed.media.uri,
            title: embed.media.title,
            description: embed.media.description,
            thumb: embed.media.thumb
          })
        });
      }
      return new EmbedSummary(base);
    }
    default:
      return new EmbedSummary({ type: "unknown" });
  }
};
