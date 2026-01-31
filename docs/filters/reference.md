# Filter Reference

Each entry shows a DSL example and the equivalent JSON.
Need a quick predicate list? Run `skygent filter help`.

## Basics

- All: `all`
  - `{"_tag":"All"}`
- None: `none`
  - `{"_tag":"None"}`
- Author: `author:user.bsky.social`
  - `{"_tag":"Author","handle":"user.bsky.social"}`
- Hashtag: `hashtag:#ai`
  - `{"_tag":"Hashtag","tag":"#ai"}`
- Author list: `authorin:alice,bob`
  - `{"_tag":"AuthorIn","handles":["alice","bob"]}`
- Hashtag list: `hashtagin:#ai,#ml`
  - `{"_tag":"HashtagIn","tags":["#ai","#ml"]}`
- Contains: `contains:"typescript",caseSensitive=false`
  - `{"_tag":"Contains","text":"typescript","caseSensitive":false}`

## Post type

- Reply: `is:reply` or `reply`
  - `{"_tag":"IsReply"}`
- Quote: `is:quote` or `quote`
  - `{"_tag":"IsQuote"}`
- Repost: `is:repost` or `repost`
  - `{"_tag":"IsRepost"}`
- Original: `is:original` or `original`
  - `{"_tag":"IsOriginal"}`

## Engagement and media

- Engagement: `engagement:minLikes=100,minReplies=5`
  - `{"_tag":"Engagement","minLikes":100,"minReplies":5}`
- Images: `hasimages`
  - `{"_tag":"HasImages"}`
- Video: `hasvideo`
  - `{"_tag":"HasVideo"}`
- Links: `haslinks`
  - `{"_tag":"HasLinks"}`
- Media: `hasmedia`
  - `{"_tag":"HasMedia"}`
- Embed: `hasembed`
  - `{"_tag":"HasEmbed"}`
- Language: `language:en,es`
  - `{"_tag":"Language","langs":["en","es"]}`

## Regex and date range

- Regex: `regex:/pattern/i`
  - `{"_tag":"Regex","patterns":["pattern"],"flags":"i"}`
- Date range: `date:2026-01-01T00:00:00Z..2026-01-31T23:59:59Z`
  - `{"_tag":"DateRange","start":"2026-01-01T00:00:00Z","end":"2026-01-31T23:59:59Z"}`

## Effectful filters

Effectful filters require an `onError` policy in JSON or `onError=` in the DSL:

- Valid links: `links:onError=exclude`
  - `{"_tag":"HasValidLinks","onError":{"_tag":"Exclude"}}`
- Trending: `trending:#ai,onError=include`
  - `{"_tag":"Trending","tag":"#ai","onError":{"_tag":"Include"}}`

Error policies:

- `Include` (`onError=include`)
- `Exclude` (`onError=exclude`)
- `Retry` (`onError=retry,maxRetries=3,baseDelay="1 second"`)

Defaults:

- `trending`: include on error
- `links` / `validlinks`: exclude on error

## Composition

- AND: `expr1 AND expr2`
  - `{"_tag":"And","left":{...},"right":{...}}`
- OR: `expr1 OR expr2`
  - `{"_tag":"Or","left":{...},"right":{...}}`
- NOT: `NOT expr`
  - `{"_tag":"Not","expr":{...}}`

## Aliases

- `from:alice` → `author:alice`
- `tag:#ai` → `hashtag:#ai`
- `text:"hello"` → `contains:"hello"`
- `lang:en` → `language:en`
- `authors:alice,bob` → `authorin:alice,bob`
- `tags:#ai,#ml` → `hashtagin:#ai,#ml`
- `is:reply|quote|repost|original`
- `has:images|video|links|media|embed`

## Named filters

- Save: `skygent filter create tech --filter 'hashtag:#tech'`
- Use: `@tech AND author:user.bsky.social`
