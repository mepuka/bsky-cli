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

## Effectful filters (network or AI)

These may involve HTTP requests or model inference:

- HasValidLinks
- Trending
- Llm

## Best practices

1. **Short-circuit**: AND/OR short-circuit, so put cheap filters first.
2. **Batching**: LLM decisions are batched; prefer evaluating in batches.
3. **Policies**: Use onError=include or onError=exclude to control failures.
4. **Benchmark**: Use `skygent filter benchmark` against a store sample.

