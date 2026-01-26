# Testing Quick Reference for Skygent-Bsky

**Last Updated:** 2026-01-25

## Test Commands

```bash
# Run all tests
bun test

# Watch mode
bun test --watch

# Type check
bun run typecheck

# Run property tests with more iterations
bun test --filter="*.prop.*" --runs=1000
```

---

## Test Patterns Cheat Sheet

### 1. Basic Effect Test

```typescript
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

test("service test", async () => {
  const program = Effect.gen(function* () {
    const service = yield* MyService;
    return yield* service.operation();
  });

  const result = await Effect.runPromise(
    program.pipe(Effect.provide(MyService.layer))
  );

  expect(result).toBe(expectedValue);
});
```

### 2. Effect Vitest Test

```typescript
import { it } from "@effect/vitest";

it.effect("test with TestContext", () =>
  Effect.gen(function*() {
    const service = yield* MyService;
    const result = yield* service.operation();
    expect(result).toBe(expectedValue);
  }).pipe(Effect.provide(MyService.layer))
)
```

### 3. Test with TestClock

```typescript
it.effect("time-dependent test", () =>
  Effect.gen(function*() {
    yield* TestClock.adjust("1000 millis");
    const time = yield* Clock.currentTimeMillis;
    expect(time).toBe(1000);
  })
)
```

### 4. Property-Based Test

```typescript
import { FastCheck } from "effect";

const MyArbitrary = FastCheck.make(MySchema);

it.prop(
  "property holds for all values",
  [MyArbitrary],
  ([value], ctx) => {
    ctx.expect(property(value)).toBe(true);
  }
);
```

### 5. Testing Error Paths

```typescript
test("error path", async () => {
  const program = Effect.gen(function* () {
    const service = yield* MyService;
    return yield* service.failingOperation();
  });

  const result = await Effect.runPromise(
    Effect.either(program.pipe(Effect.provide(testLayer)))
  );

  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left._tag).toBe("MyError");
  }
});
```

### 6. Testing with Exit

```typescript
it.effect("exit test", () =>
  Effect.gen(function*() {
    const result = yield* Effect.exit(operation());
    expect(result).toStrictEqual(Exit.succeed(expectedValue));
  })
)
```

### 7. Mock Service Layer

```typescript
const testLayer = Layer.succeed(
  MyService,
  MyService.of({
    operation: () => Effect.succeed(mockValue),
    anotherOperation: () => Effect.fail(mockError)
  })
);
```

### 8. Spy Layer with Ref

```typescript
const makeSpyLayer = () => {
  const calls: Array<unknown> = [];

  const layer = Layer.sync(MyService, () =>
    MyService.of({
      operation: (arg) => Effect.sync(() => {
        calls.push(arg); // Record calls
        return mockResult;
      })
    })
  );

  return { layer, calls };
};
```

### 9. Scoped Test (Resource Cleanup)

```typescript
it.scoped("resource test", () =>
  Effect.gen(function*() {
    const resource = yield* acquireResource();
    const result = yield* useResource(resource);
    // Resource automatically released
    expect(result).toBeDefined();
  }).pipe(Effect.provide(resourceLayer))
)
```

### 10. Layer Composition Test

```typescript
layer(TestAppLayer)("app tests", (it) => {
  it.effect("test 1", () =>
    Effect.gen(function*() {
      // All services from TestAppLayer available
      const service1 = yield* Service1;
      const service2 = yield* Service2;
      // ...
    })
  );
});
```

---

## Filter Law Tests (Priority 1)

```typescript
import { FastCheck } from "effect";

const FilterArb = FastCheck.make(FilterExprSchema);
const PostArb = FastCheck.make(Post);

describe("Filter algebraic laws", () => {
  it.prop("And is associative",
    [FilterArb, FilterArb, FilterArb, PostArb],
    async ([f1, f2, f3, post], ctx) => {
      const left = await eval(And(And(f1, f2), f3), post);
      const right = await eval(And(f1, And(f2, f3)), post);
      ctx.expect(left).toBe(right);
    }
  );

  it.prop("All is identity for And",
    [FilterArb, PostArb],
    async ([f, post], ctx) => {
      const left = await eval(And(All, f), post);
      const right = await eval(f, post);
      ctx.expect(left).toBe(right);
    }
  );

  it.prop("And is commutative",
    [FilterArb, FilterArb, PostArb],
    async ([f1, f2, post], ctx) => {
      const left = await eval(And(f1, f2), post);
      const right = await eval(And(f2, f1), post);
      ctx.expect(left).toBe(right);
    }
  );
});
```

---

## Storage Rebuild Test (Priority 2)

```typescript
describe("EventLog rebuild", () => {
  it.scoped("rebuilds index from event log", () =>
    Effect.gen(function*() {
      const log = yield* EventLog;
      const index = yield* PostIndex;

      // Append events
      yield* Effect.forEach(
        events,
        (event) => log.append(event),
        { discard: true }
      );

      // Clear and rebuild
      yield* index.clear();
      yield* index.rebuild();

      // Verify
      const count = yield* index.count();
      expect(count).toBe(events.length);
    }).pipe(Effect.provide(TestStorageLayer))
  );
});
```

---

## CLI Smoke Test (Priority 3)

```typescript
describe("CLI commands", () => {
  test("sync command runs successfully", async () => {
    const program = Effect.gen(function* () {
      const cli = yield* CliApp;
      return yield* cli(["sync", "--store", "test", "--limit", "10"]);
    });

    const exitCode = await Effect.runPromise(
      program.pipe(Effect.provide(TestAppLayer))
    );

    expect(exitCode).toBe(0);
  });
});
```

---

## Common Test Fixtures

```typescript
// Sample Post
export const samplePost = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:test/app.bsky.feed.post/1",
  author: "test.bsky",
  text: "Test post #effect",
  createdAt: new Date().toISOString(),
  hashtags: ["#effect"],
  mentions: [],
  links: []
});

// Post Factory
export const makeTestPost = (overrides?: Partial<Post>) =>
  Schema.decodeUnknownSync(Post)({
    ...defaultPostData,
    ...overrides
  });

// Sample Filter
export const sampleFilter = Schema.decodeUnknownSync(FilterExprSchema)({
  _tag: "And",
  left: { _tag: "Author", handle: "test.bsky" },
  right: { _tag: "Hashtag", tag: "#effect" }
});
```

---

## Test Organization

```
tests/
├── domain/              # Pure domain logic
│   ├── filter.test.ts
│   ├── filter-laws.test.ts  # Property-based tests
│   └── primitives.test.ts
├── services/            # Service behavior
│   ├── filter-compiler.test.ts
│   ├── filter-runtime.test.ts
│   └── post-parser.test.ts
├── integration/         # Layer composition, storage
│   ├── storage-rebuild.test.ts
│   └── pipeline.test.ts
└── e2e/                 # CLI smoke tests
    └── cli-commands.test.ts
```

---

## Anti-Patterns to Avoid

1. **Don't test implementation details**
   - Test public API, not internal state

2. **Don't mock what you don't own**
   - Wrap external APIs in your services

3. **Don't use magic values**
   - Use factories and named constants

4. **Don't skip error path tests**
   - Test failures as first-class citizens

5. **Don't make tests dependent on each other**
   - Each test should be isolated

---

## CI Configuration

```yaml
# .github/workflows/test.yml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun test
      - run: bun run typecheck
```

---

## Phase 9 Checklist

### Week 5
- [ ] Property-based tests for filter laws (associativity, identity, commutativity)
- [ ] Storage rebuild integration tests
- [ ] Error path coverage for all services
- [ ] CI setup with bun test

### Week 6
- [ ] Layer composition integration tests
- [ ] CLI smoke tests with MockConsole
- [ ] Contract tests for BskyClient
- [ ] Performance benchmarks (optional)

### Week 7+
- [ ] Mutation testing on core logic
- [ ] 80%+ test coverage
- [ ] TESTING.md documentation
- [ ] Pre-commit hooks

---

## Quick Links

- Full Research: [docs/research/2026-01-25-testing-strategies-research.md](./2026-01-25-testing-strategies-research.md)
- Effect Vitest: https://effect.website/docs/testing/testclock/
- Bun Test Docs: https://bun.com/docs/test
- Property-Based Testing: https://dev.to/mokkapps/property-based-testing-with-typescript-2ljj
