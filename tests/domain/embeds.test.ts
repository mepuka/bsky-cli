import { describe, expect, test } from "bun:test";
import {
  EmbedExternal,
  EmbedImage,
  EmbedImages,
  EmbedRecord,
  EmbedRecordView,
  EmbedRecordWithMedia,
  ProfileBasic
} from "../../src/domain/bsky.js";
import { extractImageRefs, summarizeEmbed } from "../../src/domain/embeds.js";

const makeImage = (alt: string) => new EmbedImage({
  thumb: "https://cdn.example/thumb.jpg",
  fullsize: "https://cdn.example/full.jpg",
  alt,
  aspectRatio: undefined
});

const makeRecordView = () => new EmbedRecordView({
  uri: "at://did:plc:abc/app.bsky.feed.post/1" as any,
  cid: "bafycid" as any,
  author: new ProfileBasic({
    did: "did:plc:abc" as any,
    handle: "alice.test" as any
  }),
  value: {},
  indexedAt: new Date()
});

describe("extractImageRefs", () => {
  test("returns empty for undefined embed", () => {
    expect(extractImageRefs(undefined)).toEqual([]);
  });

  test("normalizes empty alt text", () => {
    const embed = new EmbedImages({ images: [makeImage(""), makeImage("Alt text")] });
    const result = extractImageRefs(embed);
    expect(result).toHaveLength(2);
    expect(result[0]?.alt).toBeUndefined();
    expect(result[1]?.alt).toBe("Alt text");
  });

  test("extracts images from record with media", () => {
    const embed = new EmbedRecordWithMedia({
      recordType: "app.bsky.feed.post",
      record: makeRecordView(),
      media: new EmbedImages({ images: [makeImage("Alt")] })
    });
    const result = extractImageRefs(embed);
    expect(result).toHaveLength(1);
    expect(result[0]?.thumbUrl).toContain("thumb.jpg");
  });
});

describe("summarizeEmbed", () => {
  test("summarizes image embeds", () => {
    const embed = new EmbedImages({ images: [makeImage(""), makeImage("Alt")] });
    const summary = summarizeEmbed(embed);
    expect(summary?.type).toBe("images");
    expect(summary?.imageSummary?.imageCount).toBe(2);
    expect(summary?.imageSummary?.hasAltText).toBe(false);
  });

  test("summarizes external embeds", () => {
    const embed = new EmbedExternal({
      uri: "https://example.com",
      title: "Example",
      description: "Example site",
      thumb: "https://example.com/thumb.jpg"
    });
    const summary = summarizeEmbed(embed);
    expect(summary?.type).toBe("external");
    expect(summary?.external?.uri).toBe("https://example.com");
  });

  test("summarizes record embeds with author handle", () => {
    const record = new EmbedRecord({ recordType: "app.bsky.feed.post", record: makeRecordView() });
    const summary = summarizeEmbed(record);
    expect(summary?.type).toBe("record");
    expect(summary?.record?.authorHandle).toBe("alice.test");
  });
});
