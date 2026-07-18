import { describe, it, expect } from "vitest";
import * as env from "./env";

describe("bool", () => {
  const b = env.bool();

  it.each(["1", "true", "TRUE", " yes ", "on"])("reads %s as true", (v) => {
    expect(b.parse(v)).toBe(true);
  });

  it.each(["0", "false", "No", "off"])("reads %s as false", (v) => {
    expect(b.parse(v)).toBe(false);
  });

  it("rejects garbage", () => {
    expect(b.safeParse("maybe").success).toBe(false);
  });

  it("honors a default when combined", () => {
    expect(env.bool().default(true).parse(undefined)).toBe(true);
  });
});

describe("integer", () => {
  it("parses signed integers", () => {
    expect(env.integer().parse("-42")).toBe(-42);
    expect(env.integer().parse("+7")).toBe(7);
  });

  it("rejects decimals and words", () => {
    expect(env.integer().safeParse("1.5").success).toBe(false);
    expect(env.integer().safeParse("abc").success).toBe(false);
  });
});

describe("port", () => {
  const p = env.port();

  it("accepts the valid range boundaries", () => {
    expect(p.parse("1")).toBe(1);
    expect(p.parse("65535")).toBe(65535);
  });

  it("rejects out-of-range ports", () => {
    expect(p.safeParse("0").success).toBe(false);
    expect(p.safeParse("65536").success).toBe(false);
  });
});

describe("url / nonEmpty / oneOf", () => {
  it("validates urls", () => {
    expect(env.url().parse("https://x.dev")).toBe("https://x.dev");
    expect(env.url().safeParse("not-a-url").success).toBe(false);
  });

  it("trims and rejects empty strings", () => {
    expect(env.nonEmpty().parse("  hi ")).toBe("hi");
    expect(env.nonEmpty().safeParse("   ").success).toBe(false);
  });

  it("constrains to an enum", () => {
    const level = env.oneOf(["debug", "info", "error"]);
    expect(level.parse("info")).toBe("info");
    expect(level.safeParse("trace").success).toBe(false);
  });
});
