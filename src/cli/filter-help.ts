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
    "",
    filterJsonExamples
  ].join("\n");

const filterDslExamples = [
  "Examples:",
  "  hashtag:#ai AND author:user.bsky.social",
  "  authorin:alice.bsky.social,bob.bsky.social",
  "  hashtagin:#tech,#coding",
  "  contains:\"typescript\",caseSensitive=false",
  "  NOT hashtag:#spam",
  "  regex:/pattern/i",
  "  is:reply",
  "  engagement:minLikes=100,minReplies=5",
  "  hasmedia",
  "  language:en,es",
  "  @tech AND author:user.bsky.social",
  "  date:2024-01-01T00:00:00Z..2024-01-31T00:00:00Z",
  "  links:onError=exclude",
  "  trending:#ai,onError=include",
  "  (hashtag:#ai OR hashtag:#ml) AND author:user.bsky.social"
].join("\n");

export const filterDslDescription = () =>
  [
    "Filter expression using the DSL.",
    "Sync/query filters run at ingestion or query time; store config filters are materialized views.",
    "Options are comma-separated (no spaces); quote values with spaces.",
    "Lists use commas (e.g. authorin:alice,bob). Named filters use @name.",
    "Defaults: onError defaults to include for trending and exclude for links.",
    "",
    filterDslExamples
  ].join("\n");
