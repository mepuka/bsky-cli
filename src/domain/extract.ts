const hashtagRegex = /#[a-zA-Z0-9_]+/g;
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

export const extractFromFacets = (facets?: ReadonlyArray<unknown>) => {
  const hashtags = new Set<string>();
  const links = new Set<string>();
  const mentionDids = new Set<string>();

  for (const facet of facets ?? []) {
    if (!facet || typeof facet !== "object") continue;
    const features = (facet as { readonly features?: ReadonlyArray<unknown> })
      .features ?? [];
    for (const feature of features) {
      if (!feature || typeof feature !== "object") continue;
      const candidate = feature as {
        readonly did?: unknown;
        readonly uri?: unknown;
        readonly tag?: unknown;
      };
      if (typeof candidate.did === "string" && candidate.did.length > 0) {
        mentionDids.add(candidate.did);
      }
      if (typeof candidate.uri === "string" && candidate.uri.length > 0) {
        links.add(candidate.uri);
      }
      if (typeof candidate.tag === "string" && candidate.tag.length > 0) {
        const tag = candidate.tag.startsWith("#")
          ? candidate.tag
          : `#${candidate.tag}`;
        hashtags.add(tag);
      }
    }
  }

  return {
    hashtags: Array.from(hashtags),
    links: Array.from(links),
    mentionDids: Array.from(mentionDids)
  };
};
