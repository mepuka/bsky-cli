import { Effect, Layer, Redacted } from "effect";
import { ConfigOverrides } from "../../src/services/app-config.js";
import { CredentialsOverrides } from "../../src/services/credential-store.js";

type Fixtures = {
  readonly timeline: unknown;
  readonly feed: unknown;
  readonly notifications: unknown;
  readonly session?: unknown;
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
      return jsonResponse(fixtures.timeline);
    }

    if (method === "GET" && pathname === "/xrpc/app.bsky.feed.getFeed") {
      return jsonResponse(fixtures.feed);
    }

    if (
      method === "GET" &&
      pathname === "/xrpc/app.bsky.notification.listNotifications"
    ) {
      return jsonResponse(fixtures.notifications);
    }

    return new Response("not found", { status: 404 });
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
