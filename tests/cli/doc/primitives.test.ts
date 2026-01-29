import { describe, expect, test } from "bun:test";
import { renderPlain } from "../../../src/cli/doc/render.js";
import { label, value, field, badge, connector, metric } from "../../../src/cli/doc/primitives.js";

describe("primitives", () => {
  test("label renders text", () => {
    expect(renderPlain(label("Name:"))).toBe("Name:");
  });

  test("value renders text", () => {
    expect(renderPlain(value("hello"))).toBe("hello");
  });

  test("field renders key-value pair", () => {
    expect(renderPlain(field("Posts", "42"))).toBe("Posts: 42");
  });

  test("badge renders bracketed text", () => {
    expect(renderPlain(badge("OK", "accent"))).toBe("[OK]");
  });

  test("connector renders text", () => {
    expect(renderPlain(connector("├── "))).toBe("├── ");
  });

  test("metric formats number with icon", () => {
    expect(renderPlain(metric("♥", 1234))).toBe("♥ 1,234");
  });
});
