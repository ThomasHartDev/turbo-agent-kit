import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

describe("loadComposeFile healthcheck.test", () => {
  it("treats a CMD scalar as CMD-SHELL of the whole string", () => {
    const loaded = loadComposeFile(`services:
  redis:
    image: redis:7.4-alpine
    healthcheck:
      test: CMD redis-cli ping
`);
    expect(loaded.services.redis?.healthcheck?.test).toEqual(["CMD-SHELL", "CMD redis-cli ping"]);
  });

  it("keeps a JSON exec list and a YAML exec list", () => {
    const loaded = loadComposeFile(`services:
  redis:
    image: redis:7.4-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
  server:
    image: agent-server:local
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - fetch('http://127.0.0.1:8787/healthz')
`);
    expect(loaded.services.redis?.healthcheck?.test).toEqual(["CMD", "redis-cli", "ping"]);
    expect(loaded.services.server?.healthcheck?.test).toEqual([
      "CMD",
      "node",
      "-e",
      "fetch('http://127.0.0.1:8787/healthz')",
    ]);
  });

  it("treats a non-CMD scalar as CMD-SHELL", () => {
    const loaded = loadComposeFile(`services:
  redis:
    image: redis:7.4-alpine
    healthcheck:
      test: redis-cli ping
`);
    expect(loaded.services.redis?.healthcheck?.test).toEqual(["CMD-SHELL", "redis-cli ping"]);
  });
});

const COMPOSE_PROBES: Record<string, string[]> = {
  redis: ["CMD", "redis-cli", "ping"],
  "otel-collector": ["CMD", "wget", "-qO-", "http://127.0.0.1:13133/"],
  server: [
    "CMD",
    "node",
    "-e",
    "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
  ],
  console: [
    "CMD",
    "node",
    "-e",
    "fetch('http://127.0.0.1:3001/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
  ],
};

describe("committed stack", () => {
  it("parses docker-compose.yml and the image recipes", () => {
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
    for (const [name, test] of Object.entries(COMPOSE_PROBES)) {
      expect(loaded.services[name]?.healthcheck?.test).toEqual(test);
      expect(loaded.services[name]?.healthcheck?.test[0]).toBe("CMD");
    }
    expect(existsSync(path.join(root, "apps/server/Dockerfile"))).toBe(true);
    expect(existsSync(path.join(root, "apps/console/package.json"))).toBe(true);
    expect(
      JSON.parse(readFileSync(path.join(root, "apps/console/package.json"), "utf8")).name,
    ).toBe("@agent/console");
    expect(readFileSync(path.join(root, "apps/console/next.config.mjs"), "utf8")).toMatch(
      /output:\s*["']standalone["']/,
    );
    expect(
      inspectDockerfile(readFileSync(path.join(root, "apps/console/Dockerfile"), "utf8")),
    ).toMatchObject({
      stages: 4,
      finalUser: "console",
      hasHealthcheck: true,
      usesAdd: false,
    });
    expect(
      inspectDockerfile(readFileSync(path.join(root, "apps/server/Dockerfile"), "utf8")),
    ).toMatchObject({
      stages: 4,
      finalUser: "agent",
      hasHealthcheck: true,
      usesAdd: false,
    });
  });

  it("locks docker compose config test arrays as exec form", () => {
    const res = spawnSync("docker", ["compose", "config", "--format", "json"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(res.status, res.stderr).toBe(0);
    const cfg = JSON.parse(res.stdout) as {
      services: Record<string, { healthcheck?: { test?: string[] } }>;
    };
    for (const [name, test] of Object.entries(COMPOSE_PROBES)) {
      expect(cfg.services[name]?.healthcheck?.test).toEqual(test);
      expect(cfg.services[name]?.healthcheck?.test?.[0]).toBe("CMD");
    }
  });
});
