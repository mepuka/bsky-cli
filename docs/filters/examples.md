# Filter Examples

## Tech posts with engagement

```json
{
  "_tag": "And",
  "left": { "_tag": "Hashtag", "tag": "#tech" },
  "right": { "_tag": "Engagement", "minLikes": 50 }
}
```

DSL:

```
hashtag:#tech AND engagement:minLikes=50
```

## Exclude reposts

```
is:original AND NOT hashtag:#spam
```

## Author allowlist

```
authorin:alice.bsky.social,bob.bsky.social
```

## English posts with links

```
language:en AND haslinks
```


