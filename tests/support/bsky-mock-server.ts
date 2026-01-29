import { Effect, Layer, Redacted } from "effect";
import { ConfigOverrides } from "../../src/services/app-config.js";
import { CredentialsOverrides } from "../../src/services/credential-store.js";

type Fixtures = {
  readonly timeline?: unknown;
  readonly feed?: unknown;
  readonly notifications?: unknown;
  readonly authorFeed?: unknown;
  readonly postThread?: unknown;
  readonly session?: unknown;
  readonly followers?: unknown;
  readonly follows?: unknown;
  readonly knownFollowers?: unknown;
  readonly relationships?: unknown;
  readonly lists?: unknown;
  readonly list?: unknown;
  readonly blocks?: unknown;
  readonly mutes?: unknown;
  readonly searchPosts?: unknown;
  readonly resolveHandle?: unknown;
  readonly likes?: unknown;
  readonly repostedBy?: unknown;
  readonly quotes?: unknown;
  readonly feedGenerator?: unknown;
  readonly listFeed?: unknown;
};

const defaultSession = {
  accessJwt: "test-access",
  refreshJwt: "test-refresh",
  handle: "test.bsky",
  did: "did:plc:test",
  active: true
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

const makeMockFetch = (fixtures: Fixtures, fallback: typeof fetch): typeof fetch => {
  const handler = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const request =
      input instanceof Request
        ? input
        : new Request(
            typeof input === "string" || input instanceof URL
              ? input
              : String(input),
            init
          );

    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();

    if (
      method === "POST" &&
      pathname === "/xrpc/com.atproto.server.createSession"
    ) {
      await request.json().catch(() => undefined);
      return jsonResponse(fixtures.session ?? defaultSession);
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.feed.getTimeline") {
      return fixtures.timeline
        ? jsonResponse(fixtures.timeline)
        : new Response("not found", { status: 404 });
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.feed.getFeed") {
      return fixtures.feed
        ? jsonResponse(fixtures.feed)
        : new Response("not found", { status: 404 });
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.feed.getListFeed") {
      return fixtures.listFeed
        ? jsonResponse(fixtures.listFeed)
        : new Response("not found", { status: 404 });
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.feed.getAuthorFeed") {
      return fixtures.authorFeed
        ? jsonResponse(fixtures.authorFeed)
        : new Response("not found", { status: 404 });
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.feed.getPostThread") {
      return fixtures.postThread
        ? jsonResponse(fixtures.postThread)
        : new Response("not found", { status: 404 });
    }

    if (
      method === "GET" &&
      pathname === "/xrpc/app.bsky.notification.listNotifications"
    ) {
      return fixtures.notifications
        ? jsonResponse(fixtures.notifications)
        : new Response("not found", { status: 404 });
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.graph.getFollowers") {
      return fixtures.followers
        ? jsonResponse(fixtures.followers)
        : new Response("not found", { status: 404 });
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.graph.getFollows") {
      return fixtures.follows
        ? jsonResponse(fixtures.follows)
        : new Response("not found", { status: 404 });
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.graph.getKnownFollowers") {
      return fixtures.knownFollowers
        ? jsonResponse(fixtures.knownFollowers)
        : new Response("not found", { status: 404 });
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.graph.getRelationships") {
      return fixtures.relationships
        ? jsonResponse(fixtures.relationships)
        : new Response("not found", { status: 404 });
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.graph.getLists") {
      return fixtures.lists
        ? jsonResponse(fixtures.lists)
        : new Response("not found", { status: 404 });
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.graph.getList") {
      return fixtures.list
        ? jsonResponse(fixtures.list)
        : new Response("not found", { status: 404 });
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.graph.getBlocks") {
      return fixtures.blocks
        ? jsonResponse(fixtures.blocks)
        : new Response("not found", { status: 404 });
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.graph.getMutes") {
      return fixtures.mutes
        ? jsonResponse(fixtures.mutes)
        : new Response("not found", { status: 404 });
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.feed.searchPosts") {
      return fixtures.searchPosts
        ? jsonResponse(fixtures.searchPosts)
        : new Response("not found", { status: 404 });
    }

    if (method === "GET" && pathname === "/xrpc/com.atproto.identity.resolveHandle") {
      return fixtures.resolveHandle
        ? jsonResponse(fixtures.resolveHandle)
        : new Response("not found", { status: 404 });
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.feed.getLikes") {
      return fixtures.likes
        ? jsonResponse(fixtures.likes)
        : new Response("not found", { status: 404 });
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.feed.getRepostedBy") {
      return fixtures.repostedBy
        ? jsonResponse(fixtures.repostedBy)
        : new Response("not found", { status: 404 });
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.feed.getQuotes") {
      return fixtures.quotes
        ? jsonResponse(fixtures.quotes)
        : new Response("not found", { status: 404 });
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.feed.getFeedGenerator") {
      return fixtures.feedGenerator
        ? jsonResponse(fixtures.feedGenerator)
        : new Response("not found", { status: 404 });
    }

    return new Response(`not found: ${pathname}`, { status: 404 });
  };

  const mock = (handler as unknown) as typeof fetch;
  mock.preconnect = fallback.preconnect.bind(fallback);
  return mock;
};

export const makeBskyMockLayer = (
  fixtures: Fixtures,
  credentials: { readonly identifier: string; readonly password: string } = {
    identifier: "test.bsky",
    password: "password"
  }
) => {
  const fetchLayer = Layer.scopedDiscard(
    Effect.acquireRelease(
      Effect.sync(() => {
        const previous = globalThis.fetch;
        const mockFetch = makeMockFetch(fixtures, previous);
        globalThis.fetch = mockFetch;
        return previous;
      }),
      (previous) =>
        Effect.sync(() => {
          globalThis.fetch = previous;
        })
    )
  );

  const configLayer = Layer.succeed(ConfigOverrides, {
    service: "https://bsky.test",
    identifier: credentials.identifier
  });

  const credentialLayer = Layer.succeed(CredentialsOverrides, {
    identifier: credentials.identifier,
    password: Redacted.make(credentials.password)
  });

  return Layer.mergeAll(fetchLayer, configLayer, credentialLayer);
};
