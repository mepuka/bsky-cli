# Filter Testing Tools

Use these commands for fast feedback before running a full sync.

## Validate

```
skygent filter validate --filter-json '{"_tag":"Hashtag","tag":"#tech"}'
```

## Test against a post URI

```
skygent filter test \
  --filter 'hashtag:#tech' \
  --post-uri 'at://did:plc:.../app.bsky.feed.post/xyz'
```

## Explain a decision

```
skygent filter explain \
  --filter 'hashtag:#tech AND author:alice.bsky.social' \
  --post-uri 'at://did:plc:.../app.bsky.feed.post/xyz'
```

## Benchmark against a store

```
skygent filter benchmark \
  --store my-store \
  --filter 'hashtag:#tech' \
  --sample-size 1000
```

