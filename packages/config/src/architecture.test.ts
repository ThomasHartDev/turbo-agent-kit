import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ArchGraph,
  COMPOSE_FILES,
  DEPLOY_SERVICES,
  HELM_CHART,
  LOCAL_COMMANDS,
  PROD_TOPOLOGY,
  findCycle,
  findWorkspaceRoot,
  hpaEnabled,
  invariants,
  kitGraph,
  layerViolations,
  loadWorkspace,
  renderMermaid,
  topoSort,
  type NodeKind,
} from "./architecture";

const root = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));

function parse(spec: string): ArchGraph {
  const g = new ArchGraph();
  for (const token of spec.trim().split(/\s+/)) {
    if (token.includes("->")) {
      const [from, to] = token.split("->");
      g.addEdge(from ?? "", to ?? "", "workspace");
    } else {
      const [id, kind] = token.split(":");
      g.addNode({ id: id ?? "", kind: (kind ?? "package") as NodeKind });
    }
  }
  return g;
}

describe("ArchGraph", () => {
  it("sorts empty, linear, and diamond graphs; reports cycles and layer violations", () => {
    expect(topoSort(new ArchGraph())).toEqual([]);
    expect(findCycle(new ArchGraph())).toBeNull();
    expect(topoSort(parse("solo:package"))).toEqual(["solo"]);
    expect(topoSort(parse("a:app b:package c:package a->b b->c"))).toEqual(["c", "b", "a"]);
    const diamond = parse(
      "app:app left:package right:package core:package app->left app->right left->core right->core",
    );
    expect(topoSort(diamond)).toEqual(["core", "left", "right", "app"]);

    const loop = parse("p:package q:package p->q q->p");
    expect(findCycle(loop)).toEqual(["p", "q", "p"]);
    expect(() => topoSort(loop)).toThrow(/cycle: p -> q -> p/);
    expect(findCycle(parse("z:package z->z"))).toEqual(["z", "z"]);

    const g = new ArchGraph().addNode({ id: "a", kind: "package" });
    expect(() => g.addNode({ id: "a", kind: "app" })).toThrow(/duplicate node: a/);
    expect(() => g.addEdge("a", "nope", "workspace")).toThrow(/unknown node: nope/);
    g.addNode({ id: "b", kind: "package" });
    g.addEdge("a", "b", "workspace");
    g.addEdge("a", "b", "runtime");
    expect(g.edges()).toEqual([{ from: "a", to: "b", via: "runtime" }]);

    const layered = parse("core:package api:app redis:infra core->api");
    layered.addEdge("redis", "api", "runtime");
    expect(layerViolations(layered).map((e) => `${e.from}->${e.to}`)).toEqual([
      "core->api",
      "redis->api",
    ]);
  });
});

describe("workspace kit, deploy overlay, docs", () => {
  it("loads the repo DAG, compose vs helm overlay, and living docs", () => {
    const pkgs = loadWorkspace(root);
    const names = new Set(pkgs.map((p) => p.name));
    expect(names.has("@agent/config")).toBe(true);
    expect(pkgs.some((p) => p.name === "@agent/server" && p.kind === "app")).toBe(true);
    for (const pkg of pkgs) {
      for (const dep of pkg.workspaceDeps) expect(names.has(dep)).toBe(true);
    }
    const kit = kitGraph(root);
    expect(invariants(kit)).toEqual([]);
    expect(topoSort(kit)).toHaveLength(kit.ids().length);
    expect(kit.ids()).not.toContain("redis");
    expect(kit.ids()).not.toContain("otel-collector");
    expect(kit.edges()).toContainEqual({
      from: "@agent/console",
      to: "@agent/server",
      via: "runtime",
    });
    expect(kit.edges().some((e) => e.to === "redis" || e.to === "otel-collector")).toBe(false);
    const diagram = renderMermaid(kit);
    for (const id of kit.ids()) expect(diagram).toContain(`["${id}"]`);
    expect(diagram).not.toContain('["redis"]');
    expect(diagram).not.toContain('["otel-collector"]');
    expect(diagram).not.toMatch(/subgraph infra/);

    for (const svc of DEPLOY_SERVICES) {
      expect(svc.composeReplicas).toBe(1);
      if (svc.helm) expect(svc.helmMin).toBeGreaterThanOrEqual(1);
    }
    const byName = Object.fromEntries(DEPLOY_SERVICES.map((s) => [s.name, s]));
    expect(hpaEnabled(byName.server!)).toBe(true);
    expect(byName.redis?.helmWorkload).toBe("StatefulSet");
    expect(byName["otel-collector"]?.helm).toBe(false);
    expect(DEPLOY_SERVICES.filter(hpaEnabled).map((s) => s.name)).toEqual(["server"]);

    const architecture = readFileSync(join(root, "docs/architecture.md"), "utf8");
    expect(architecture).toContain(diagram);
    const runbook = readFileSync(join(root, "docs/runbook.md"), "utf8");
    for (const cmd of Object.values(LOCAL_COMMANDS)) {
      expect(runbook).toContain(cmd);
    }
    for (const note of Object.values(PROD_TOPOLOGY)) {
      expect(runbook).toContain(note);
    }
    expect(runbook).toContain("intended");
    expect(runbook).toContain("HorizontalPodAutoscaler");
    expect(runbook).toContain("in-process");
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain("apps/console");
    expect(readme).not.toMatch(/apps\/console.*planned/i);
    const advertised = [
      runbook,
      architecture,
      readme,
      ...Object.values(LOCAL_COMMANDS),
      ...Object.values(PROD_TOPOLOGY),
    ].join("\n");
    const hasCompose = COMPOSE_FILES.some((file) => existsSync(join(root, file)));
    const hasHelm = existsSync(join(root, HELM_CHART));
    if (!hasCompose) {
      expect(advertised).not.toMatch(/docker compose up/);
      expect(runbook).not.toContain("service_healthy");
      expect(runbook).not.toContain("${OPENAI_API_KEY:-}");
    } else {
      expect(runbook).toMatch(/docker compose up --build --wait/);
    }
    if (!hasHelm) {
      expect(advertised).not.toMatch(/helm (template|upgrade)/);
    } else {
      expect(runbook).toContain(`helm upgrade --install agent-kit ${HELM_CHART}`);
    }
    const why = readFileSync(join(root, "docs/why-a-monorepo.md"), "utf8");
    expect(why).toMatch(/workspace:\*/);
    expect(why).toContain("^build");
    expect(why).toContain("directed acyclic graph");
  });

  it("rejects a missing workspace root and broken package.json files", () => {
    expect(() => findWorkspaceRoot(mkdtempSync(join(tmpdir(), "arch-")))).toThrow(
      /pnpm-workspace.yaml not found/,
    );
    const dir = mkdtempSync(join(tmpdir(), "ws-"));
    mkdirSync(join(dir, "packages", "ghost"), { recursive: true });
    writeFileSync(join(dir, "packages", "ghost", "package.json"), "null");
    expect(() => loadWorkspace(dir)).toThrow(/invalid package.json/);
    writeFileSync(join(dir, "packages", "ghost", "package.json"), '{"version":"1"}');
    expect(() => loadWorkspace(dir)).toThrow(/unnamed package.json/);
  });
});
