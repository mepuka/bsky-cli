const filterJsonExamples = [
  "Examples:",
  "  All posts:       '{\"_tag\":\"All\"}'",
  "  By author:       '{\"_tag\":\"Author\",\"handle\":\"user.bsky.social\"}'",
  "  By hashtag:      '{\"_tag\":\"Hashtag\",\"tag\":\"#ai\"}'",
  "  Authors list:    '{\"_tag\":\"AuthorIn\",\"handles\":[\"alice.bsky.social\",\"bob.bsky.social\"]}'",
  "  Tags list:       '{\"_tag\":\"HashtagIn\",\"tags\":[\"#tech\",\"#coding\"]}'",
  "  Contains text:   '{\"_tag\":\"Contains\",\"text\":\"typescript\",\"caseSensitive\":false}'",
  "  Is reply:        '{\"_tag\":\"IsReply\"}'",
  "  Engagement:      '{\"_tag\":\"Engagement\",\"minLikes\":100}'",
  "  Has media:       '{\"_tag\":\"HasMedia\"}'",
  "  Has embed:       '{\"_tag\":\"HasEmbed\"}'",
  "  Min images:      '{\"_tag\":\"MinImages\",\"min\":2}'",
  "  Has alt text:    '{\"_tag\":\"HasAltText\"}'",
  "  No alt text:     '{\"_tag\":\"NoAltText\"}'",
  "  Alt text:        '{\"_tag\":\"AltText\",\"text\":\"diagram\"}'",
  "  Link contains:   '{\"_tag\":\"LinkContains\",\"text\":\"substack.com\"}'",
  "  Link regex:      '{\"_tag\":\"LinkRegex\",\"pattern\":\"substack\\\\.com\",\"flags\":\"i\"}'",
  "  Language:        '{\"_tag\":\"Language\",\"langs\":[\"en\",\"es\"]}'",
  "  By regex:        '{\"_tag\":\"Regex\",\"patterns\":[\"pattern\"],\"flags\":\"i\"}'",
  "  Trending tag:    '{\"_tag\":\"Trending\",\"tag\":\"#ai\",\"onError\":{\"_tag\":\"Include\"}}'",
  "  Valid links:     '{\"_tag\":\"HasValidLinks\",\"onError\":{\"_tag\":\"Exclude\"}}'",
  "  Combined (AND):  '{\"_tag\":\"And\",\"left\":{...},\"right\":{...}}'",
  "  Combined (OR):   '{\"_tag\":\"Or\",\"left\":{...},\"right\":{...}}'",
  "  Inverted (NOT):  '{\"_tag\":\"Not\",\"expr\":{...}}'"
].join("\n");

export const filterJsonDescription = (extra?: string) =>
  [
    "Filter expression as JSON string.",
    "Sync/query filters run at ingestion or query time; store config filters are materialized views.",
    ...(extra ? [extra] : []),
    "Tip: run \"skygent filter help\" for all predicates and aliases.",
    "",
    filterJsonExamples
  ].join("\n");

const filterDslExamples = [
  "Examples:",
  "  hashtag:#ai AND author:user.bsky.social",
  "  from:alice.bsky.social",
  "  authorin:alice.bsky.social,bob.bsky.social",
  "  hashtagin:#tech,#coding",
  "  contains:\"typescript\",caseSensitive=false",
  "  NOT hashtag:#spam",
  "  regex:/pattern/i",
  "  is:reply",
  "  engagement:minLikes=100,minReplies=5",
  "  hasmedia",
  "  hasembed",
  "  has:images",
  "  min-images:2",
  "  has:alt-text",
  "  no-alt-text",
  "  alt-text:\"diagram\"",
  "  language:en,es",
  "  @tech AND author:user.bsky.social",
  "  date:2024-01-01T00:00:00Z..2024-01-31T00:00:00Z",
  "  since:24h",
  "  until:2024-01-15",
  "  age:<72h",
  "  links:onError=exclude",
  "  links:/substack\\.com/i",
  "  link-contains:substack.com",
  "  trending:#ai,onError=include",
  "  (hashtag:#ai OR hashtag:#ml) AND author:user.bsky.social",
  "",
  "Aliases:",
  "  from:alice.bsky.social        -> author:alice.bsky.social",
  "  tag:#ai                       -> hashtag:#ai",
  "  text:\"hello\"                 -> contains:\"hello\"",
  "  lang:en                       -> language:en",
  "  authors:alice,bob             -> authorin:alice,bob",
  "  tags:#ai,#ml                  -> hashtagin:#ai,#ml",
  "  is:reply|quote|repost|original",
  "  has:images|video|links|media|embed|alt-text"
].join("\n");

export const filterDslDescription = () =>
  [
    "Filter expression using the DSL.",
    "Sync/query filters run at ingestion or query time; store config filters are materialized views.",
    "Options are comma-separated (no spaces); quote values with spaces.",
    "Lists use commas (e.g. authorin:alice,bob). Named filters use @name.",
    "Defaults: onError defaults to include for trending and exclude for links.",
    "Tip: run \"skygent filter help\" for all predicates and aliases.",
    "",
    filterDslExamples
  ].join("\n");

export const filterHelpText = () =>
  [filterDslDescription(), "", filterJsonDescription()].join("\n");
