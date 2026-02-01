import type { EmbedImage, EmbedRecordTarget, PostEmbed } from "./bsky.js";
import {
  isEmbedExternal,
  isEmbedImages,
  isEmbedRecord,
  isEmbedRecordView,
  isEmbedRecordWithMedia,
  isEmbedVideo
} from "./bsky.js";
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
  const authorHandle = isEmbedRecordView(record) ? record.author.handle : undefined;
  return new EmbedRecordSummary({ uri, authorHandle });
};

export const embedMedia = (embed?: PostEmbed): PostEmbed | undefined => {
  if (!embed || !isEmbedRecordWithMedia(embed)) return undefined;
  const media = embed.media;
  if (isEmbedImages(media) || isEmbedExternal(media) || isEmbedVideo(media)) {
    return media;
  }
  return undefined;
};

export const hasExternalEmbed = (embed?: PostEmbed): boolean => {
  if (!embed) return false;
  if (isEmbedExternal(embed)) return true;
  const media = embedMedia(embed);
  return media ? isEmbedExternal(media) : false;
};

export const hasVideoEmbed = (embed?: PostEmbed): boolean => {
  if (!embed) return false;
  if (isEmbedVideo(embed)) return true;
  const media = embedMedia(embed);
  return media ? isEmbedVideo(media) : false;
};

export const isQuoteEmbed = (embed?: PostEmbed): boolean =>
  Boolean(embed && (isEmbedRecord(embed) || isEmbedRecordWithMedia(embed)));

export const extractImageRefs = (embed?: PostEmbed): ReadonlyArray<ImageRef> => {
  if (!embed) return [];
  if (isEmbedImages(embed)) {
    return embed.images.map(toImageRef);
  }
  if (isEmbedRecordWithMedia(embed)) {
    const media = embedMedia(embed);
    return media && isEmbedImages(media) ? media.images.map(toImageRef) : [];
  }
  return [];
};

export const summarizeEmbed = (embed?: PostEmbed): EmbedSummary | undefined => {
  if (!embed) return undefined;

  if (isEmbedImages(embed)) {
    const images = embed.images.map(toImageRef);
    return new EmbedSummary({
      type: "images",
      imageSummary: summarizeImages(images)
    });
  }
  if (isEmbedExternal(embed)) {
    return new EmbedSummary({
      type: "external",
      external: new EmbedExternalSummary({
        uri: embed.uri,
        title: embed.title,
        description: embed.description,
        thumb: embed.thumb
      })
    });
  }
  if (isEmbedVideo(embed)) {
    return new EmbedSummary({ type: "video" });
  }
  if (isEmbedRecord(embed)) {
    return new EmbedSummary({
      type: "record",
      record: summarizeRecord(embed.record)
    });
  }
  if (isEmbedRecordWithMedia(embed)) {
    const base = {
      type: "record_with_media" as const,
      record: summarizeRecord(embed.record)
    };
    const media = embedMedia(embed);
    if (media && isEmbedImages(media)) {
      const images = media.images.map(toImageRef);
      return new EmbedSummary({
        ...base,
        imageSummary: summarizeImages(images)
      });
    }
    if (media && isEmbedExternal(media)) {
      return new EmbedSummary({
        ...base,
        external: new EmbedExternalSummary({
          uri: media.uri,
          title: media.title,
          description: media.description,
          thumb: media.thumb
        })
      });
    }
    if (media && isEmbedVideo(media)) {
      return new EmbedSummary({ ...base });
    }
    return new EmbedSummary(base);
  }
  return new EmbedSummary({ type: "unknown" });
};
