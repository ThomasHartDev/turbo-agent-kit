import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  dockerfileCopySources,
  imageRefTag,
  missingWorkspaceCopies,
  smokeHelmTemplate,
  workspaceDirsFor,
} from "./ci-gates";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function k8s(opts?: {
  image?: string;
  name?: string;
  podApp?: string;
  user?: number;
  probe?: boolean;
}): string {
  const image = opts?.image ?? "agent-server:0.1.0";
  const name = opts?.name ?? "ci-server";
  const podApp = opts?.podApp ?? "server";
  const user = opts?.user ?? 999;
  const probe =
    opts?.probe === false
      ? ""
      : "          livenessProbe:\n            httpGet:\n              path: /healthz\n";
  return `apiVersion: v1
kind: Service
metadata:
  name: ${name}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  selector:
    matchLabels:
      app: server
  template:
    metadata:
      labels:
        app: ${podApp}
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: ${user}
      containers:
        - name: server
          image: ${image}
${probe}`;
}

function rules(src: string): string[] {
  return smokeHelmTemplate(src).findings.map((f) => f.rule);
}

describe("smokeHelmTemplate", () => {
  it("accepts pinned manifests and skips empty docs", () => {
    const ok = smokeHelmTemplate(`---\n---\n${k8s()}`);
    expect(ok.findings).toEqual([]);
    expect(ok.kinds.sort()).toEqual(["Deployment", "Service"]);
    expect(ok.documents).toBe(2);
  });

  it("fails empty, broken, and incomplete streams", () => {
    expect(rules("")).toContain("empty-render");
    expect(rules("\n---\n\n")).toContain("missing-kind");
    expect(rules("this: [unterminated")).toContain("yaml");
    expect(rules("- just a list\n")).toContain("mapping");
    expect(rules("apiVersion: v1\nkind: Service\nmetadata:\n  name: only\n")).toContain(
      "missing-kind",
    );
  });

  it("rejects latest tags, selector drift, uid 0, missing probes, and bad names", () => {
    expect(rules(k8s({ image: "agent-server:latest" }))).toContain("image-tag");
    expect(rules(k8s({ image: "agent-server" }))).toContain("image-tag");
    expect(rules(k8s({ image: "agent-server@sha256:abc" }))).not.toContain("image-tag");
    expect(smokeHelmTemplate(k8s({ image: "ghcr.io:5000/agent-server:sha-1" })).ok).toBe(true);
    expect(rules(k8s({ podApp: "other" }))).toContain("selector");
    expect(rules(k8s({ user: 0 }))).toContain("run-as-root");
    expect(rules(k8s({ probe: false }))).toContain("probe");
    expect(rules(k8s({ name: "CI_SERVER" }))).toContain("dns-1123");
    expect(imageRefTag("app:0.1.0")).toEqual({ kind: "tag", value: "0.1.0" });
    expect(imageRefTag("app@sha256:ff")).toEqual({ kind: "digest", value: "sha256:ff" });
    expect(imageRefTag("app")).toEqual({ kind: "none", value: "" });
  });
});

describe("workspace COPY vs server image", () => {
  it("requires every workspace:* dep of the server in a COPY", () => {
    expect(dockerfileCopySources("FROM x\nRUN echo\n")).toEqual([]);
    expect(
      dockerfileCopySources(
        "COPY --chown=a:a packages/llm packages/llm\nCOPY apps/server apps/server\n",
      ),
    ).toEqual(["packages/llm", "apps/server"]);
    expect(
      workspaceDirsFor(
        { "@agent/core": "workspace:*", hono: "^4.0.0", "@agent/ghost": "workspace:*" },
        [
          { name: "@agent/core", dir: "packages/agent-core" },
          { name: "@agent/llm", dir: "packages/llm" },
        ],
      ),
    ).toEqual(["packages/agent-core"]);
    const dockerfile = readFileSync(resolve(repoRoot, "apps/server/Dockerfile"), "utf8");
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "apps/server/package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const required = workspaceDirsFor(pkg.dependencies, [
      { name: "@agent/core", dir: "packages/agent-core" },
      { name: "@agent/llm", dir: "packages/llm" },
      { name: "@agent/rate-limiter", dir: "packages/rate-limiter" },
      { name: "@agent/telemetry", dir: "packages/telemetry" },
    ]);
    expect(required).toContain("packages/telemetry");
    expect(missingWorkspaceCopies(dockerfile, required)).toEqual([]);
    expect(missingWorkspaceCopies("FROM x\nCOPY apps/server apps/server\n", required)).toEqual(
      required,
    );
  });
});

describe("deploy/ci/smoke-chart", () => {
  it("is a v2 application chart with a pinned default tag", () => {
    const chart = parse(
      readFileSync(resolve(repoRoot, "deploy/ci/smoke-chart/Chart.yaml"), "utf8"),
    ) as {
      apiVersion: string;
      name: string;
      type: string;
    };
    expect(chart).toMatchObject({ apiVersion: "v2", name: "smoke-chart", type: "application" });
    const values = parse(
      readFileSync(resolve(repoRoot, "deploy/ci/smoke-chart/values.yaml"), "utf8"),
    ) as { image: { tag: string } };
    expect(values.image.tag).not.toBe("latest");
  });
});
