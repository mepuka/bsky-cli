# Filters

For the full guide and reference, see:

- docs/filters/README.md
- docs/filters/reference.md
- docs/filters/performance.md
- docs/filters/examples.md
- docs/filters/testing.md

Filters are used in three places:

- Ingest filters: `sync` and `watch` apply filters before storing posts.
- Query filters: `query` filters stored posts at read time.
- Stored filters: `filter create` saves named filters, referenced as `@name` in the DSL.
- Store config filters: `StoreConfig.filters` define materialized outputs via `store materialize`.

There are two input formats:

- DSL: `--filter 'hashtag:#ai AND author:user.bsky.social'`
- JSON: `--filter-json '{"_tag":"Hashtag","tag":"#ai"}'`

Use only one of `--filter` or `--filter-json`.
Wrap JSON in single quotes to avoid shell escaping issues.

Testing and validation tools are documented in `docs/filters/testing.md`.

## DSL rules

- Combine with `AND`/`OR`/`NOT` or `&&`/`||`/`!`.
- Parentheses are supported.
- Options are comma-separated (no spaces).
- Quote values that include spaces.
- Lists use commas or semicolons; `authorin:alice,bob` or `authorin:[alice;bob]`.
- Named filters use `@name` and load from `skygent filter list`.
- Filter names use the same pattern as store names (`^[a-z0-9][a-z0-9-_]{1,63}$`).

## Filter types

Each entry shows a DSL example and the equivalent JSON shape.

- All: `all`
  - `{ "_tag": "All" }`
- None: `none`
  - `{ "_tag": "None" }`
- Author: `author:user.bsky.social`
  - `{ "_tag": "Author", "handle": "user.bsky.social" }`
- Hashtag: `hashtag:#ai` or `tag:#ai`
  - `{ "_tag": "Hashtag", "tag": "#ai" }`
- Author list: `authorin:alice,bob`
  - `{ "_tag": "AuthorIn", "handles": ["alice","bob"] }`
- Hashtag list: `hashtagin:#ai,#ml` or `tags:#ai,#ml`
  - `{ "_tag": "HashtagIn", "tags": ["#ai","#ml"] }`
- Contains: `contains:"typescript",caseSensitive=false`
  - `{ "_tag": "Contains", "text": "typescript", "caseSensitive": false }`
- Post type: `is:reply`, `is:quote`, `is:repost`, `is:original`
  - `{ "_tag": "IsReply" }` (etc)
- Engagement: `engagement:minLikes=100,minReplies=5`
  - `{ "_tag": "Engagement", "minLikes": 100, "minReplies": 5 }`
- Images: `hasimages` or `images`
  - `{ "_tag": "HasImages" }`
- Video: `hasvideo` or `video`
  - `{ "_tag": "HasVideo" }`
- Links: `haslinks`
  - `{ "_tag": "HasLinks" }`
- Media: `hasmedia` or `media`
  - `{ "_tag": "HasMedia" }`
- Language: `language:en,es`
  - `{ "_tag": "Language", "langs": ["en","es"] }`
- Regex: `regex:/pattern/i` or `regex:pattern,flags=i`
  - `{ "_tag": "Regex", "patterns": ["pattern"], "flags": "i" }`
- Date range: `date:2024-01-01T00:00:00Z..2024-01-31T00:00:00Z`
  - `{ "_tag": "DateRange", "start": "...", "end": "..." }`
- Valid links (effectful): `links:onError=exclude`
  - `{ "_tag": "HasValidLinks", "onError": { "_tag": "Exclude" } }`
- Trending (effectful): `trending:#ai,onError=include`
  - `{ "_tag": "Trending", "tag": "#ai", "onError": { "_tag": "Include" } }`
- LLM (effectful): `llm:"score tech",minConfidence=0.7,onError=include`
  - `{ "_tag": "Llm", "prompt": "score tech", "minConfidence": 0.7, "onError": { "_tag": "Include" } }`

Note: `haslinks` only checks for link presence. `links`/`validlinks` validates HTTP status (effectful and cached).

## Error policies for effectful filters

Use `onError` with `HasValidLinks`, `Trending`, or `Llm`:

- `onError=include`
- `onError=exclude`
- `onError=retry,maxRetries=3,baseDelay="1 second"`

Defaults:

- `llm` and `trending`: include on error
- `links`/`validlinks`: exclude on error
- `llm` default `minConfidence` is 0.7
