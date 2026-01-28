# Filter Performance

## Fast filters (pure)

These are local checks and typically complete in < 1ms:

- All / None
- Author / AuthorIn
- Hashtag / HashtagIn
- Contains
- IsReply / IsQuote / IsRepost / IsOriginal
- Engagement
- HasImages / HasVideo / HasLinks / HasMedia
- Language
- Regex
- DateRange

## Effectful filters (network)

These may involve HTTP requests:

- HasValidLinks
- Trending

## Best practices

1. **Short-circuit**: AND/OR short-circuit, so put cheap filters first.
2. **Policies**: Use onError=include or onError=exclude to control failures.
4. **Benchmark**: Use `skygent filter benchmark` against a store sample.

