# Skygent CLI — Read-Only API Gap Analysis

> Generated 2026-01-29. Covers the full `app.bsky.*` and `com.atproto.*` read-only API surface against the current Skygent CLI implementation.

## Executive Summary

The Skygent CLI currently calls **12 Bluesky API endpoints** across 4 namespaces (`feed`, `actor`, `notification`, `unspecced`). The full AT Protocol exposes ~159 read-only endpoints, though many are admin/moderation/internal. Focusing on the **user-facing `app.bsky.*` namespace**, the CLI has solid coverage of feed ingestion and post querying but significant gaps in **social graph**, **engagement details**, **list support**, **feed discovery**, and **network search**.

---

## Current API Coverage

### Endpoints Currently Used

| Endpoint | CLI Command(s) | Notes |
|----------|----------------|-------|
| `app.bsky.feed.getTimeline` | `sync timeline`, `watch timeline` | Home timeline ingestion |
| `app.bsky.feed.getFeed` | `sync feed`, `watch feed` | Custom feed ingestion |
| `app.bsky.feed.getAuthorFeed` | `sync author`, `watch author` | Author feed with filter modes (`posts_with_replies`, `posts_no_replies`, `posts_with_media`, `posts_and_author_threads`) |
| `app.bsky.feed.getPosts` | Internal hydration | Batch post fetch by URI |
| `app.bsky.feed.getPostThread` | `sync thread`, `watch thread`, `view thread` | Thread retrieval with configurable depth |
| `app.bsky.notification.listNotifications` | `sync notifications`, `watch notifications` | Notification listing |
| `app.bsky.actor.getProfiles` | Internal (ProfileResolver) | Batch profile resolution (up to 25) |
| `app.bsky.actor.searchActors` | `search handles` | Profile search |
| `app.bsky.actor.searchActorsTypeahead` | `search handles --typeahead` | Prefix search for handles |
| `app.bsky.unspecced.getPopularFeedGenerators` | `search feeds` | Feed discovery search |
| `app.bsky.unspecced.getTrendingTopics` | `TrendingTopics` service | Powers the `Trending` filter DSL node |
| `com.atproto.server.createSession` | Auth flow (via `AtpAgent.login`) | Session creation |

### Namespace Coverage Summary

| Namespace | Available Endpoints | Used | Coverage |
|-----------|-------------------|------|----------|
| `app.bsky.feed` | 17 | 5 | 29% |
| `app.bsky.actor` | 6 | 3 | 50% |
| `app.bsky.graph` | 17 | 0 | **0%** |
| `app.bsky.notification` | 4 | 1 | 25% |
| `app.bsky.labeler` | 1 | 0 | 0% |
| `app.bsky.video` | 2 | 0 | 0% |
| `app.bsky.bookmark` | 1 | 0 | 0% |
| `app.bsky.unspecced` | 21 | 2 | 10% |
| `com.atproto.identity` | 4 | 0 | 0% |
| `com.atproto.repo` | 4 | 0 | 0% |

---

## High-Value Gaps

### 1. Social Graph — `app.bsky.graph.*`

**Coverage: 0 of 17 endpoints. This is the single largest gap.**

The CLI has zero graph support. Users cannot explore relationships, view lists, discover starter packs, or understand their social network. The social graph is a core Bluesky feature and its absence makes the CLI feel incomplete for any use case beyond feed consumption.

#### Missing Endpoints

| Endpoint | Description | Auth Required |
|----------|-------------|---------------|
| `app.bsky.graph.getFollowers` | Enumerate accounts that follow a given actor | No |
| `app.bsky.graph.getFollows` | Enumerate accounts that a given actor follows | No |
| `app.bsky.graph.getKnownFollowers` | Find mutual follows (accounts that follow the target AND are followed by the viewer) | Yes |
| `app.bsky.graph.getRelationships` | Check follow/block/mute status between accounts (public, no auth for basic info) | No |
| `app.bsky.graph.getList` | Get a view of a specific list (curation or moderation) | No |
| `app.bsky.graph.getLists` | Enumerate lists created by an actor | No |
| `app.bsky.graph.getListFeed` | Get posts from a curated list — functions like a custom feed | No |
| `app.bsky.graph.getListBlocks` | Enumerate mod lists that the user is blocking | Yes |
| `app.bsky.graph.getListMutes` | Enumerate mod lists that the user has muted | Yes |
| `app.bsky.graph.getListsWithMembership` | Lists created by the user, with membership info for a given actor | Yes |
| `app.bsky.graph.getBlocks` | Enumerate accounts the user is blocking | Yes |
| `app.bsky.graph.getMutes` | Enumerate accounts the user has muted | Yes |
| `app.bsky.graph.getStarterPack` | Get a single starter pack view | No |
| `app.bsky.graph.getStarterPacks` | Batch fetch starter pack views | No |
| `app.bsky.graph.getActorStarterPacks` | List starter packs created by an actor | No |
| `app.bsky.graph.getStarterPacksWithMembership` | User's starter packs with membership info for a given actor | Yes |
| `app.bsky.graph.getSuggestedFollowsByActor` | "More like this" follow recommendations after following someone | Yes |
| `app.bsky.graph.searchStarterPacks` | Search starter packs by query | No |

#### Impact

- **Filtering is limited:** The filter DSL supports `author:handle` and `authorIn(...)` but cannot express graph-relative predicates like "posts from people I follow" or "posts from members of list X" because graph data is unavailable.
- **No list-as-data-source:** Lists are a major organizational primitive on Bluesky. `getListFeed` is functionally equivalent to a custom feed and would be a natural addition to `sync` and `watch` commands.
- **No relationship inspection:** Users can't check if two accounts follow each other, or view their own block/mute state.

---

### 2. Feed Discovery & Metadata

**3 endpoints missing from `app.bsky.feed.*`**

Users can sync a feed by AT-URI (`sync feed at://...`) but cannot discover or inspect feeds before syncing.

| Endpoint | Description | Auth Required |
|----------|-------------|---------------|
| `app.bsky.feed.getFeedGenerator` | Get metadata for a single feed generator (name, description, avatar, like count, creator) | No |
| `app.bsky.feed.getFeedGenerators` | Batch fetch feed generator metadata | No |
| `app.bsky.feed.getActorFeeds` | List feeds published by a given actor | No |

#### Impact

- **Blind syncing:** Users must know a feed URI upfront. They can search feeds via `search feeds` (which calls `getPopularFeedGenerators`) but can't inspect a specific feed's metadata or list all feeds by a creator.
- **No feed catalog:** Building a local catalog of interesting feeds requires external tooling.

#### Existing Partial Coverage

`search feeds` calls `app.bsky.unspecced.getPopularFeedGenerators`, which returns feed generator views. This partially covers discovery but doesn't cover per-actor feed listing or single-feed inspection.

---

### 3. Engagement Details

**4 endpoints missing from `app.bsky.feed.*`**

The CLI tracks engagement *counts* via `PostMetrics` (likes, reposts, replies, quotes, bookmarks) but cannot drill into *who* engaged with a post.

| Endpoint | Description | Auth Required |
|----------|-------------|---------------|
| `app.bsky.feed.getLikes` | List accounts that liked a specific post (by AT-URI) | No |
| `app.bsky.feed.getRepostedBy` | List accounts that reposted a specific post | No |
| `app.bsky.feed.getQuotes` | List quote-posts of a specific post | No |
| `app.bsky.feed.getActorLikes` | List posts liked by an actor (self only) | Yes |

#### Impact

- **Incomplete engagement analysis:** Users can see "500 likes" but can't answer "did user X like this?" or "who are the top engagers?"
- **No liked-posts sync:** `getActorLikes` would be a natural sync source — "sync all posts I've liked" for archival or analysis.

---

### 4. Bookmarks — `app.bsky.bookmark.*`

**1 endpoint missing. Recently added to the Bluesky API.**

| Endpoint | Description | Auth Required |
|----------|-------------|---------------|
| `app.bsky.bookmark.getBookmarks` | Fetch the authenticated user's bookmarked posts | Yes |

#### Impact

Bookmarks are a natural fit for the store model. Users could sync bookmarks into a local store, query them with the filter DSL, and derive views from bookmarked content. This is likely a frequently-requested data source.

---

### 5. Network Search — `app.bsky.feed.searchPosts`

**1 endpoint missing.**

| Endpoint | Description | Auth Required |
|----------|-------------|---------------|
| `app.bsky.feed.searchPosts` | Full-text search across the entire Bluesky network | Varies by provider |

#### Impact

The CLI has robust local full-text search (FTS5-backed `search posts`), but this only covers posts already synced to a local store. Network search would let users find posts across all of Bluesky, which is essential for discovery, research, and monitoring use cases.

---

### 6. Notifications Depth

**2 endpoints missing from `app.bsky.notification.*`**

| Endpoint | Description | Auth Required |
|----------|-------------|---------------|
| `app.bsky.notification.getUnreadCount` | Quick unread notification count | Yes |
| `app.bsky.notification.getPreferences` | View notification filter preferences | Yes |

Additionally, `app.bsky.notification.listActivitySubscriptions` (enumerate notification subscription targets) is missing but is a niche feature.

#### Impact

Minor. `listNotifications` covers most use cases. Unread count is useful for lightweight status checks without a full sync.

---

## Medium-Value Gaps

### 7. Single Profile Fetch

The CLI uses `app.bsky.actor.getProfiles` (batch, up to 25) internally via `ProfileResolver`, but there is no CLI command to inspect a single profile. `app.bsky.actor.getProfile` returns a richer view including description, follower/following counts, and associated lists.

**Awkwardness:** To check a profile, users must use `search handles` and hope for a match, or rely on `sync author` which fetches posts rather than profile metadata.

### 8. Follow Suggestions

`app.bsky.actor.getSuggestions` returns suggested accounts for follow discovery. This could complement `search handles` for account discovery workflows.

### 9. Suggested Feeds

`app.bsky.feed.getSuggestedFeeds` returns recommended feeds for the authenticated user. This is distinct from `search feeds` (which searches by query) — it provides personalized recommendations.

### 10. Identity Resolution

The AT Protocol provides several identity endpoints that could be useful for debugging and verification:

| Endpoint | Description |
|----------|-------------|
| `com.atproto.identity.resolveHandle` | Resolve handle → DID |
| `com.atproto.identity.resolveDid` | Resolve DID → DID document |
| `com.atproto.identity.resolveIdentity` | Full bidirectional identity resolution |

The CLI has `ProfileResolver` for DID-to-handle mapping, but protocol-level resolution isn't exposed as a command.

---

## Low-Value / Out of Scope

These namespaces are available but likely not appropriate for a consumer read-only CLI:

| Namespace | Endpoints | Reason |
|-----------|-----------|--------|
| `chat.bsky.convo.*` | 6 | Direct messaging. Different UX paradigm, privacy-sensitive. |
| `chat.bsky.actor.*` | 1 | Chat data export. Admin-oriented. |
| `chat.bsky.moderation.*` | 2 | Chat moderation. Admin-only. |
| `tools.ozone.*` | 25+ | Ozone moderation tooling. Requires elevated permissions. |
| `com.atproto.admin.*` | 5 | Server administration. Elevated permissions. |
| `com.atproto.sync.*` | 13 | Low-level repo sync (CAR files, MST blocks). Only relevant for repo-level exports. |
| `com.atproto.server.*` (most) | 5 | Server description, invite codes, app passwords. Niche. |
| `com.atproto.label.*` | 1 | Label queries. Niche unless building moderation tooling. |
| `com.atproto.lexicon.*` | 1 | Schema resolution. Developer tooling. |
| `app.bsky.labeler.*` | 1 | Labeler service metadata. Niche. |
| `app.bsky.video.*` | 2 | Video upload status/limits. Write-oriented. |
| `app.bsky.ageassurance.*` | 2 | Age verification. Client-specific. |
| `app.bsky.unspecced.*` (most) | ~19 | Internal hydration skeletons, onboarding flows. Most are plumbing. |

### Notable `unspecced` Endpoints Worth Watching

- `app.bsky.unspecced.getPostThreadV2` — Experimental improved thread API. May supersede `getPostThread`.
- `app.bsky.unspecced.getTrends` — Richer trending data beyond `getTrendingTopics`.

---

## Awkwardness & Efficiency Issues

### 1. No Graph-Aware Filters

The filter DSL is powerful (24 node types) but entirely post-intrinsic. It cannot express:

- "Posts from accounts I follow"
- "Posts from members of list X"
- "Posts from accounts with > 1000 followers"

Adding graph-aware filters would require caching graph data locally, which is a significant architectural addition but would unlock powerful query capabilities.

### 2. No Network Search

Local FTS5 search only covers synced data. For monitoring or research use cases (e.g., "find all posts about X topic"), users must first sync a relevant feed and then search locally, rather than querying the network directly.

### 3. Lists Not a Data Source

Lists (`getListFeed`) function identically to custom feeds from a data perspective. Not having them as a sync/watch source means users can't build stores from curated lists without manually syncing each list member's author feed.

### 4. No Engagement Drill-Down

The pipeline goes: sync posts → query locally → see counts. There's no way to go from "this post has 500 likes" to "who liked it?" without leaving the CLI.

### 5. Bookmarks as Archive Source

Many users bookmark posts for later reference. Without `getBookmarks` as a sync source, there's no way to build a searchable local archive of bookmarked content.

---

## Recommended Priorities

### P1 — Core Gaps (High impact, frequent use cases)

| Feature | Endpoints | Rationale |
|---------|-----------|-----------|
| **Social graph commands** | `getFollows`, `getFollowers`, `getRelationships`, `getKnownFollowers` | Core social feature with zero coverage. Enables relationship inspection, mutual follow discovery, and lays groundwork for graph-aware filtering. |
| **List support** | `getLists`, `getList`, `getListFeed` | Lists are a major Bluesky organizational primitive. `getListFeed` is a natural sync/watch data source, equivalent to custom feeds. |

### P2 — Important Enrichment (Completes existing features)

| Feature | Endpoints | Rationale |
|---------|-----------|-----------|
| **Engagement details** | `getLikes`, `getRepostedBy`, `getQuotes` | Completes the engagement story beyond counts. Enables "who liked/reposted this?" drill-down. |
| **Feed discovery** | `getFeedGenerator`, `getFeedGenerators`, `getActorFeeds` | Lets users inspect and discover feeds before syncing. Currently requires knowing URIs upfront. |
| **Network search** | `searchPosts` | Extends search beyond local store to the full Bluesky network. Essential for discovery and monitoring. |
| **Liked posts sync** | `getActorLikes` | Natural sync source for archiving posts the user has liked. |

### P3 — Nice-to-Have (Quality of life improvements)

| Feature | Endpoints | Rationale |
|---------|-----------|-----------|
| **Bookmarks** | `getBookmarks` | Recently added feature, natural sync source for archival. |
| **Single profile view** | `getProfile` | CLI ergonomics — inspect one profile without batch API. |
| **Unread count** | `getUnreadCount` | Quick status check without full notification sync. |
| **Block/mute lists** | `getBlocks`, `getMutes`, `getListBlocks`, `getListMutes` | View moderation state. Useful for account management. |
| **Starter packs** | `getStarterPack(s)`, `getActorStarterPacks`, `searchStarterPacks` | Discovery feature. Lower priority than core graph. |
| **Follow suggestions** | `getSuggestions`, `getSuggestedFollowsByActor` | Account discovery. |
| **Identity resolution** | `resolveHandle`, `resolveDid`, `resolveIdentity` | Debugging and verification. Partially covered by `ProfileResolver`. |

### P4 — Future Consideration

| Feature | Endpoints | Rationale |
|---------|-----------|-----------|
| **Thread V2** | `unspecced.getPostThreadV2` | Experimental. Monitor for stabilization. |
| **Trends** | `unspecced.getTrends` | Richer trending data. Monitor for stabilization. |
| **Suggested feeds** | `getSuggestedFeeds` | Personalized feed recommendations. |

---

## Appendix: Full Endpoint Inventory

### All `app.bsky.feed.*` Read Endpoints (17)

| Endpoint | Status |
|----------|--------|
| `describeFeedGenerator` | Not used (Feed Generator service endpoint) |
| `getActorFeeds` | **Missing** |
| `getActorLikes` | **Missing** |
| `getAuthorFeed` | ✅ Used |
| `getFeed` | ✅ Used |
| `getFeedGenerator` | **Missing** |
| `getFeedGenerators` | **Missing** |
| `getFeedSkeleton` | Not applicable (Feed Generator service endpoint) |
| `getLikes` | **Missing** |
| `getListFeed` | **Missing** |
| `getPosts` | ✅ Used |
| `getPostThread` | ✅ Used |
| `getQuotes` | **Missing** |
| `getRepostedBy` | **Missing** |
| `getSuggestedFeeds` | **Missing** |
| `getTimeline` | ✅ Used |
| `searchPosts` | **Missing** |

### All `app.bsky.actor.*` Read Endpoints (6)

| Endpoint | Status |
|----------|--------|
| `getPreferences` | **Missing** |
| `getProfile` | **Missing** |
| `getProfiles` | ✅ Used |
| `getSuggestions` | **Missing** |
| `searchActors` | ✅ Used |
| `searchActorsTypeahead` | ✅ Used |

### All `app.bsky.graph.*` Read Endpoints (17)

| Endpoint | Status |
|----------|--------|
| `getActorStarterPacks` | **Missing** |
| `getBlocks` | **Missing** |
| `getFollowers` | **Missing** |
| `getFollows` | **Missing** |
| `getKnownFollowers` | **Missing** |
| `getList` | **Missing** |
| `getListBlocks` | **Missing** |
| `getListMutes` | **Missing** |
| `getLists` | **Missing** |
| `getListsWithMembership` | **Missing** |
| `getMutes` | **Missing** |
| `getRelationships` | **Missing** |
| `getStarterPack` | **Missing** |
| `getStarterPacks` | **Missing** |
| `getStarterPacksWithMembership` | **Missing** |
| `getSuggestedFollowsByActor` | **Missing** |
| `searchStarterPacks` | **Missing** |

### All `app.bsky.notification.*` Read Endpoints (4)

| Endpoint | Status |
|----------|--------|
| `getPreferences` | **Missing** |
| `getUnreadCount` | **Missing** |
| `listActivitySubscriptions` | **Missing** |
| `listNotifications` | ✅ Used |
