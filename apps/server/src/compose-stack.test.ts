import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateStack,
  inspectDockerfile,
  loadComposeFile,
  parseDuration,
  type ServiceSpec,
} from "./compose-stack";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
function svc(name: string, patch: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    name,
    image: "example:latest",
    environment: {},
    dependsOn: {},
    healthcheck: { test: ["CMD", "true"], intervalMs: 5000, timeoutMs: 2000, retries: 3 },
    privileged: false,
    ...patch,
  };
}

function four(extra: Record<string, Partial<ServiceSpec>> = {}) {
  return {
    services: Object.fromEntries(
      ["redis", "otel-collector", "server", "console"].map((n) => [n, svc(n, extra[n])]),
    ),
  };
}

describe("evaluateStack", () => {
  it("parses durations", () => {
    expect(parseDuration("5s")).toBe(5000);
    expect(() => parseDuration("5")).toThrow(/invalid duration/);
  });

  it("accepts a healthy DAG and interpolated secrets", () => {
    expect(
      evaluateStack(
        four({
          server: {
            image: undefined,
            build: { context: ".", dockerfile: "apps/server/Dockerfile" },
            dependsOn: { redis: "service_healthy", "otel-collector": "service_healthy" },
            environment: { OPENAI_API_KEY: "${OPENAI_API_KEY:-}" },
          },
          console: {
            image: undefined,
            build: { context: ".", dockerfile: "apps/console/Dockerfile" },
            dependsOn: { server: "service_healthy" },
          },
        }),
      ),
    ).toEqual({ ok: true, findings: [] });
  });

  it("flags missing services, probes, edges, cycles, and unsafe knobs", () => {
    expect(evaluateStack({ services: {} }).findings.map((f) => f.rule)).toEqual(
      Array(4).fill("required-service"),
    );
    const rules = evaluateStack(
      four({
        redis: {
          healthcheck: undefined,
          privileged: true,
          dependsOn: { console: "service_healthy" },
        },
        "otel-collector": { networkMode: "host" },
        server: {
          image: undefined,
          dependsOn: { redis: "service_started" },
          environment: { OPENAI_API_KEY: "sk-live" },
        },
        console: {
          dependsOn: { ghost: "service_healthy", server: "service_healthy" },
          healthcheck: { test: ["CMD", "true"], intervalMs: 1000, timeoutMs: 1000, retries: 0 },
        },
      }),
    ).findings.map((f) => f.rule);
    expect(rules).toEqual(
      expect.arrayContaining([
        "healthcheck",
        "depends-healthy",
        "unknown-dep",
        "cycle",
        "no-privileged",
        "no-host-network",
        "no-secret-env",
        "build-or-image",
        "probe-budget",
      ]),
    );
  });
});

describe("committed stack", () => {
  it("parses docker-compose.yml and the console image recipe", () => {
    const loaded = loadComposeFile(readFileSync(path.join(root, "docker-compose.yml"), "utf8"));
    expect(Object.keys(loaded.services).sort()).toEqual([
      "console",
      "otel-collector",
      "redis",
      "server",
    ]);
    expect(loaded.services.server?.dependsOn).toEqual({
      redis: "service_healthy",
      "otel-collector": "service_healthy",
    });
    expect(loaded.services["otel-collector"]?.build?.dockerfile).toBe("otel-collector.Dockerfile");
    expect(loaded.services.server?.environment.OPENAI_API_KEY).toBe("${OPENAI_API_KEY:-}");
    expect(evaluateStack(loaded)).toEqual({ ok: true, findings: [] });
    expect(
      inspectDockerfile(readFileSync(path.join(root, "apps/console/Dockerfile"), "utf8")),
    ).toMatchObject({
      stages: 4,
      finalUser: "console",
      hasHealthcheck: true,
      usesAdd: false,
    });
  });
});
