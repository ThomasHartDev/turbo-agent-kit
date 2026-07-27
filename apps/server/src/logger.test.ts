import { describe, expect, it } from "vitest";
import { createLogger, parseLogLevel, type LogLevel } from "./logger";

function capture() {
  const lines: string[] = [];
  const logger = createLogger({
    service: "test",
    level: "debug",
    clock: () => Date.parse("2026-01-15T12:00:00.000Z"),
    write: (line) => lines.push(line),
  });
  return { lines, logger };
}

function parseLast(lines: string[]): Record<string, unknown> {
  expect(lines.length).toBeGreaterThan(0);
  const last = lines[lines.length - 1]!;
  expect(last.endsWith("\n")).toBe(true);
  return JSON.parse(last.trim()) as Record<string, unknown>;
}

describe("createLogger", () => {
  it("emits one JSON object per line with standard fields", () => {
    const { lines, logger } = capture();
    logger.info("request complete", { method: "GET", path: "/healthz", status: 200 });
    const entry = parseLast(lines);
    expect(entry).toEqual({
      ts: "2026-01-15T12:00:00.000Z",
      level: "info",
      service: "test",
      msg: "request complete",
      method: "GET",
      path: "/healthz",
      status: 200,
    });
  });

  it("respects min level and still writes error when level is warn", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "warn",
      write: (line) => lines.push(line),
      clock: () => 0,
    });
    logger.debug("skip");
    logger.info("skip");
    logger.warn("keep");
    logger.error("also keep");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!.trim()).level).toBe("warn");
    expect(JSON.parse(lines[1]!.trim()).level).toBe("error");
  });

  it("child merges base fields without mutating the parent", () => {
    const lines: string[] = [];
    const root = createLogger({
      write: (line) => lines.push(line),
      clock: () => Date.parse("2026-01-15T12:00:00.000Z"),
      base: { service_role: "api" },
    });
    const child = root.child({ requestId: "r1" });
    child.info("nested");
    root.info("root only");
    expect(JSON.parse(lines[0]!.trim())).toMatchObject({
      requestId: "r1",
      service_role: "api",
      msg: "nested",
    });
    expect(JSON.parse(lines[1]!.trim())).toMatchObject({
      service_role: "api",
      msg: "root only",
    });
    expect(JSON.parse(lines[1]!.trim()).requestId).toBeUndefined();
  });

  it("field overrides on the call win over child base", () => {
    const lines: string[] = [];
    const logger = createLogger({
      write: (line) => lines.push(line),
      clock: () => 0,
      base: { path: "/old" },
    });
    logger.info("x", { path: "/new" });
    expect(JSON.parse(lines[0]!.trim()).path).toBe("/new");
  });
});

describe("parseLogLevel", () => {
  it.each([
    [undefined, "info"],
    ["", "info"],
    ["DEBUG", "debug"],
    ["Warn", "warn"],
    ["nope", "info"],
  ] as const)("parseLogLevel(%j) → %s", (raw, expected: LogLevel) => {
    expect(parseLogLevel(raw)).toBe(expected);
  });
});
