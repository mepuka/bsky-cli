const hashtagRegex =
  /#[\p{L}\p{M}\p{Pc}\p{Po}\p{Pd}\p{S}\p{Extended_Pictographic}][\p{L}\p{M}\p{N}\p{Pc}\p{Po}\p{Pd}\p{S}\p{Extended_Pictographic}]*/gu;
const mentionRegex = /@([a-z0-9][a-z0-9.-]{1,63})/gi;
const urlRegex = /https?:\/\/[^\s)]+/g;

export const extractHashtags = (text: string): ReadonlyArray<string> => {
  const matches = text.match(hashtagRegex) ?? [];
  return Array.from(new Set(matches));
};

export const extractMentions = (text: string): ReadonlyArray<string> => {
  const matches = text.matchAll(mentionRegex);
  const handles: Array<string> = [];
  for (const match of matches) {
    const handle = match[1];
    if (handle) {
      handles.push(handle.toLowerCase());
    }
  }
  return Array.from(new Set(handles));
};

export const extractLinks = (text: string): ReadonlyArray<string> => {
  const matches = text.match(urlRegex) ?? [];
  return Array.from(new Set(matches));
};

import type { RichTextFacet } from "./bsky.js";

export const extractFromFacets = (facets?: ReadonlyArray<RichTextFacet>) => {
  const hashtags = new Set<string>();
  const links = new Set<string>();
  const mentionDids = new Set<string>();

  for (const facet of facets ?? []) {
    for (const feature of facet.features) {
      switch (feature.$type) {
        case "app.bsky.richtext.facet#mention":
          if (feature.did.length > 0) {
            mentionDids.add(feature.did);
          }
          break;
        case "app.bsky.richtext.facet#link":
          if (feature.uri.length > 0) {
            links.add(feature.uri);
          }
          break;
        case "app.bsky.richtext.facet#tag":
          if (feature.tag.length > 0) {
            const tag = feature.tag.startsWith("#")
              ? feature.tag
              : `#${feature.tag}`;
            hashtags.add(tag);
          }
          break;
        // Unknown feature types are intentionally ignored
      }
    }
  }

  return {
    hashtags: Array.from(hashtags),
    links: Array.from(links),
    mentionDids: Array.from(mentionDids)
  };
};
