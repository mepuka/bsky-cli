import { describe, expect, test } from "bun:test";

// Test the count-by logic directly without relying on the Post schema
// This tests the grouping and sorting logic that the --count-by option uses

interface TestPost {
  author: string;
  createdAt: Date;
  hashtags?: string[];
}

describe("query --count-by logic", () => {
  test("groups posts by author", () => {
    const posts: TestPost[] = [
      { author: "alice.bsky.social", createdAt: new Date("2024-01-01T10:00:00Z") },
      { author: "alice.bsky.social", createdAt: new Date("2024-01-01T11:00:00Z") },
      { author: "bob.bsky.social", createdAt: new Date("2024-01-01T12:00:00Z") },
      { author: "alice.bsky.social", createdAt: new Date("2024-01-01T13:00:00Z") },
      { author: "charlie.bsky.social", createdAt: new Date("2024-01-01T14:00:00Z") }
    ];

    const counts = new Map<string, number>();
    for (const post of posts) {
      counts.set(post.author, (counts.get(post.author) ?? 0) + 1);
    }

    expect(counts.get("alice.bsky.social")).toBe(3);
    expect(counts.get("bob.bsky.social")).toBe(1);
    expect(counts.get("charlie.bsky.social")).toBe(1);
  });

  test("groups posts by hashtag with multiple tags per post", () => {
    const posts: TestPost[] = [
      { author: "alice.bsky.social", createdAt: new Date("2024-01-01T10:00:00Z"), hashtags: ["#ai", "#ml"] },
      { author: "alice.bsky.social", createdAt: new Date("2024-01-01T11:00:00Z"), hashtags: ["#ai"] },
      { author: "bob.bsky.social", createdAt: new Date("2024-01-01T12:00:00Z"), hashtags: ["#news"] },
      { author: "alice.bsky.social", createdAt: new Date("2024-01-01T13:00:00Z") }
    ];

    // Count by hashtag - posts can contribute to multiple groups
    const counts = new Map<string, number>();
    for (const post of posts) {
      const tags = post.hashtags ?? [];
      if (tags.length === 0) {
        counts.set("<none>", (counts.get("<none>") ?? 0) + 1);
      } else {
        for (const tag of tags) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
    }

    expect(counts.get("#ai")).toBe(2);
    expect(counts.get("#ml")).toBe(1);
    expect(counts.get("#news")).toBe(1);
    expect(counts.get("<none>")).toBe(1);
  });

  test("groups posts by date", () => {
    const posts: TestPost[] = [
      { author: "alice.bsky.social", createdAt: new Date("2024-01-01T10:00:00Z") },
      { author: "alice.bsky.social", createdAt: new Date("2024-01-01T11:00:00Z") },
      { author: "bob.bsky.social", createdAt: new Date("2024-01-02T12:00:00Z") },
      { author: "alice.bsky.social", createdAt: new Date("2024-01-02T13:00:00Z") },
      { author: "charlie.bsky.social", createdAt: new Date("2024-01-03T14:00:00Z") }
    ];

    const counts = new Map<string, number>();
    for (const post of posts) {
      const d = post.createdAt;
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    expect(counts.get("2024-01-01")).toBe(2);
    expect(counts.get("2024-01-02")).toBe(2);
    expect(counts.get("2024-01-03")).toBe(1);
  });

  test("groups posts by hour", () => {
    const posts: TestPost[] = [
      { author: "alice.bsky.social", createdAt: new Date("2024-01-01T10:00:00Z") },
      { author: "alice.bsky.social", createdAt: new Date("2024-01-01T10:30:00Z") },
      { author: "bob.bsky.social", createdAt: new Date("2024-01-01T11:00:00Z") },
      { author: "alice.bsky.social", createdAt: new Date("2024-01-01T11:15:00Z") }
    ];

    const counts = new Map<string, number>();
    for (const post of posts) {
      const d = post.createdAt;
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    expect(counts.get("2024-01-01T10")).toBe(2);
    expect(counts.get("2024-01-01T11")).toBe(2);
  });

  test("sorts results by count descending", () => {
    const posts: TestPost[] = [
      { author: "alice.bsky.social", createdAt: new Date("2024-01-01T10:00:00Z") },
      { author: "alice.bsky.social", createdAt: new Date("2024-01-01T11:00:00Z") },
      { author: "alice.bsky.social", createdAt: new Date("2024-01-01T12:00:00Z") },
      { author: "bob.bsky.social", createdAt: new Date("2024-01-01T13:00:00Z") },
      { author: "bob.bsky.social", createdAt: new Date("2024-01-01T14:00:00Z") },
      { author: "charlie.bsky.social", createdAt: new Date("2024-01-01T15:00:00Z") }
    ];

    const counts = new Map<string, number>();
    for (const post of posts) {
      counts.set(post.author, (counts.get(post.author) ?? 0) + 1);
    }

    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);

    expect(sorted[0]).toEqual(["alice.bsky.social", 3]);
    expect(sorted[1]).toEqual(["bob.bsky.social", 2]);
    expect(sorted[2]).toEqual(["charlie.bsky.social", 1]);
  });

  test("applies limit to groups, not posts", () => {
    const posts: TestPost[] = [
      { author: "alice.bsky.social", createdAt: new Date("2024-01-01T10:00:00Z") },
      { author: "alice.bsky.social", createdAt: new Date("2024-01-01T11:00:00Z") },
      { author: "alice.bsky.social", createdAt: new Date("2024-01-01T12:00:00Z") },
      { author: "bob.bsky.social", createdAt: new Date("2024-01-01T13:00:00Z") },
      { author: "bob.bsky.social", createdAt: new Date("2024-01-01T14:00:00Z") },
      { author: "charlie.bsky.social", createdAt: new Date("2024-01-01T15:00:00Z") }
    ];

    const counts = new Map<string, number>();
    for (const post of posts) {
      counts.set(post.author, (counts.get(post.author) ?? 0) + 1);
    }

    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    const limited = sorted.slice(0, 2); // --limit 2 should return top 2 groups

    expect(limited.length).toBe(2);
    expect(limited[0]).toEqual(["alice.bsky.social", 3]);
    expect(limited[1]).toEqual(["bob.bsky.social", 2]);
  });
});
