import { describe, it, expect } from "vitest";
import { z } from "zod";
import * as env from "./env";
import { loadConfig, ConfigError } from "./loader";

const shape = {
  NODE_ENV: env.oneOf(["development", "production", "test"]).default("development"),
  PORT: env.port().default(3000),
  DEBUG: env.bool().default(false),
  DATABASE_URL: env.url(),
  OPENAI_API_KEY: env.nonEmpty(),
};

function base(): Record<string, string> {
  return {
    DATABASE_URL: "postgres://localhost:5432/app",
    OPENAI_API_KEY: "sk-live-secret",
  };
}

describe("loadConfig", () => {
  it("coerces values and applies defaults", () => {
    const { values } = loadConfig(shape, {
      source: { ...base(), PORT: "8080", DEBUG: "yes" },
    });
    expect(values).toEqual({
      NODE_ENV: "development",
      PORT: 8080,
      DEBUG: true,
      DATABASE_URL: "postgres://localhost:5432/app",
      OPENAI_API_KEY: "sk-live-secret",
    });
  });

  it("freezes the returned values", () => {
    const { values } = loadConfig(shape, { source: base() });
    expect(() => {
      (values as { PORT: number }).PORT = 1;
    }).toThrow();
  });

  it("reads process.env when no source is given", () => {
    process.env.DATABASE_URL = base().DATABASE_URL;
    process.env.OPENAI_API_KEY = base().OPENAI_API_KEY;
    try {
      const { values } = loadConfig(shape);
      expect(values.PORT).toBe(3000);
    } finally {
      delete process.env.DATABASE_URL;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("aggregates every failure instead of stopping at the first", () => {
    try {
      loadConfig(shape, { source: { PORT: "abc" } });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as ConfigError;
      expect(err).toBeInstanceOf(ConfigError);
      const paths = err.issues.map((i) => i.path).sort();
      expect(paths).toEqual(["DATABASE_URL", "OPENAI_API_KEY", "PORT"]);
    }
  });

  it("labels a set-but-invalid value distinctly from a missing one", () => {
    try {
      loadConfig(shape, { source: { ...base(), PORT: "abc" } });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as ConfigError;
      const port = err.issues.find((i) => i.path === "PORT");
      expect(port?.received).toBe('"abc"');
      expect(port?.message).not.toBe("required but not set");
    }
  });

  it("redacts secret values in the error output", () => {
    try {
      loadConfig(shape, {
        source: { DATABASE_URL: "postgres://x", OPENAI_API_KEY: "  " },
        secrets: ["OPENAI_API_KEY"],
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as ConfigError;
      const key = err.issues.find((i) => i.path === "OPENAI_API_KEY");
      expect(key?.received).toBe("[redacted]");
      expect(err.message).not.toContain("sk-live");
    }
  });

  it("masks secrets in the redacted view but keeps the real values", () => {
    const cfg = loadConfig(shape, {
      source: base(),
      secrets: ["OPENAI_API_KEY"],
    });
    expect(cfg.values.OPENAI_API_KEY).toBe("sk-live-secret");
    expect(cfg.redacted()).toMatchObject({
      OPENAI_API_KEY: "[redacted]",
      DATABASE_URL: "postgres://localhost:5432/app",
      PORT: 3000,
    });
  });

  it("composes with refinements on the object schema", () => {
    const shaped = {
      START: env.integer(),
      END: env.integer(),
    };
    const ok = loadConfig(shaped, { source: { START: "1", END: "9" } });
    expect(ok.values).toEqual({ START: 1, END: 9 });
    // sanity: the helpers really are zod schemas that can be extended
    const schema = z.object(shaped).refine((c) => c.END > c.START, "END must exceed START");
    expect(schema.safeParse({ START: "5", END: "2" }).success).toBe(false);
  });
});
