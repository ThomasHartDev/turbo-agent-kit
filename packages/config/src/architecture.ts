import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type NodeKind = "package" | "app" | "infra";
export type EdgeVia = "workspace" | "runtime";

export interface ArchNode {
  id: string;
  kind: NodeKind;
}
export interface ArchEdge {
  from: string;
  to: string;
  via: EdgeVia;
}

export class ArchGraph {
  readonly nodes = new Map<string, ArchNode>();
  private readonly outs = new Map<string, Map<string, EdgeVia>>();

  addNode(node: ArchNode): this {
    if (this.nodes.has(node.id)) throw new Error(`duplicate node: ${node.id}`);
    this.nodes.set(node.id, node);
    this.outs.set(node.id, new Map());
    return this;
  }

  addEdge(from: string, to: string, via: EdgeVia): this {
    const adj = this.outs.get(from);
    if (!adj) throw new Error(`unknown node: ${from}`);
    if (!this.nodes.has(to)) throw new Error(`unknown node: ${to}`);
    adj.set(to, via);
    return this;
  }

  ids(): string[] {
    return [...this.nodes.keys()].sort();
  }

  edges(): ArchEdge[] {
    const all: ArchEdge[] = [];
    for (const from of this.ids()) {
      const adj = this.outs.get(from);
      if (!adj) continue;
      for (const to of [...adj.keys()].sort()) {
        all.push({ from, to, via: adj.get(to) ?? "workspace" });
      }
    }
    return all;
  }

  dependencies(id: string): string[] {
    return [...(this.outs.get(id)?.keys() ?? [])].sort();
  }
}

export function findCycle(graph: ArchGraph): string[] | null {
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let found: string[] | null = null;
  const visit = (id: string) => {
    if (found) return;
    color.set(id, 1);
    stack.push(id);
    for (const next of graph.dependencies(id)) {
      const state = color.get(next) ?? 0;
      if (state === 1) {
        found = [...stack.slice(stack.indexOf(next)), next];
        return;
      }
      if (state === 0) visit(next);
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const id of graph.ids()) {
    if ((color.get(id) ?? 0) === 0) visit(id);
    if (found) return found;
  }
  return null;
}

export function topoSort(graph: ArchGraph): string[] {
  const cycle = findCycle(graph);
  if (cycle) throw new Error(`cycle: ${cycle.join(" -> ")}`);
  const layers = layerViolations(graph);
  if (layers.length > 0) {
    throw new Error(layers.map((edge) => layerLine(graph, edge)).join("; "));
  }
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of graph.ids()) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const edge of graph.edges()) {
    indegree.set(edge.from, (indegree.get(edge.from) ?? 0) + 1);
    dependents.get(edge.to)?.push(edge.from);
  }
  const ready = graph.ids().filter((id) => (indegree.get(id) ?? 0) === 0);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(id);
    for (const from of dependents.get(id) ?? []) {
      const next = (indegree.get(from) ?? 0) - 1;
      indegree.set(from, next);
      if (next === 0) {
        ready.push(from);
        ready.sort();
      }
    }
  }
  if (ordered.length !== graph.ids().length) {
    throw new Error(`incomplete sort: ${ordered.length}/${graph.ids().length}`);
  }
  return ordered;
}

export function layerViolations(graph: ArchGraph): ArchEdge[] {
  return graph.edges().filter((edge) => {
    const from = graph.nodes.get(edge.from);
    const to = graph.nodes.get(edge.to);
    if (!from || !to) return false;
    return from.kind === "package" ? to.kind !== "package" : from.kind === "infra";
  });
}

function mermaidId(id: string): string {
  return `n_${id.replace(/[^A-Za-z0-9]/g, "_")}`;
}

export function renderMermaid(graph: ArchGraph): string {
  const groups: Record<NodeKind, ArchNode[]> = { package: [], app: [], infra: [] };
  for (const id of graph.ids()) {
    const node = graph.nodes.get(id);
    if (node) groups[node.kind].push(node);
  }
  const titles: Record<NodeKind, string> = { package: "packages", app: "apps", infra: "infra" };
  const lines = ["flowchart TB"];
  for (const kind of ["package", "app", "infra"] as const) {
    if (groups[kind].length === 0) continue;
    const title = titles[kind];
    lines.push(`  subgraph ${title}["${title}"]`);
    for (const node of groups[kind]) lines.push(`    ${mermaidId(node.id)}["${node.id}"]`);
    lines.push("  end");
  }
  for (const edge of graph.edges()) {
    const arrow = edge.via === "runtime" ? "-.->" : "-->";
    lines.push(`  ${mermaidId(edge.from)} ${arrow} ${mermaidId(edge.to)}`);
  }
  return lines.join("\n");
}

export interface WorkspacePackage {
  name: string;
  kind: "package" | "app";
  workspaceDeps: string[];
}

export interface DeployService {
  name: string;
  kind: "stateless" | "stateful" | "collector";
  compose: boolean;
  helm: boolean;
  helmWorkload: "Deployment" | "StatefulSet" | null;
  composeReplicas: number;
  helmMin: number;
  helmMax: number;
}

function readPackageJson(file: string): { name: string; dependencies: Record<string, string> } {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof raw !== "object" || raw === null) throw new Error(`invalid package.json: ${file}`);
  const name = "name" in raw ? raw.name : undefined;
  if (typeof name !== "string" || !name) throw new Error(`unnamed package.json: ${file}`);
  const bag =
    "dependencies" in raw && typeof raw.dependencies === "object" && raw.dependencies !== null
      ? raw.dependencies
      : {};
  const dependencies: Record<string, string> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (typeof value === "string") dependencies[key] = value;
  }
  return { name, dependencies };
}

export function loadWorkspace(root: string): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  for (const bucket of ["packages", "apps"] as const) {
    const base = join(root, bucket);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base).sort()) {
      const pkgFile = join(base, entry, "package.json");
      if (!existsSync(pkgFile)) continue;
      const json = readPackageJson(pkgFile);
      out.push({
        name: json.name,
        kind: bucket === "apps" ? "app" : "package",
        workspaceDeps: Object.entries(json.dependencies)
          .filter(([, spec]) => spec.startsWith("workspace:"))
          .map(([dep]) => dep)
          .sort(),
      });
    }
  }
  return out;
}

export function findWorkspaceRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("pnpm-workspace.yaml not found");
    dir = parent;
  }
}

export const RUNTIME_EDGES: readonly ArchEdge[] = [
  { from: "@agent/console", to: "@agent/server", via: "runtime" },
];

export function kitGraph(root: string): ArchGraph {
  const graph = new ArchGraph();
  const packages = loadWorkspace(root);
  for (const pkg of packages) graph.addNode({ id: pkg.name, kind: pkg.kind });
  for (const pkg of packages) {
    for (const dep of pkg.workspaceDeps) graph.addEdge(pkg.name, dep, "workspace");
  }
  for (const edge of RUNTIME_EDGES) graph.addEdge(edge.from, edge.to, edge.via);
  return graph;
}

function layerLine(graph: ArchGraph, edge: ArchEdge): string {
  const from = graph.nodes.get(edge.from)?.kind;
  const to = graph.nodes.get(edge.to)?.kind;
  return `layer: ${edge.from} (${from}) -> ${edge.to} (${to})`;
}

export function invariants(graph: ArchGraph): string[] {
  const problems: string[] = [];
  const cycle = findCycle(graph);
  if (cycle) problems.push(`cycle: ${cycle.join(" -> ")}`);
  for (const edge of layerViolations(graph)) problems.push(layerLine(graph, edge));
  return problems;
}

function unit(
  name: string,
  kind: DeployService["kind"],
  helmWorkload: DeployService["helmWorkload"],
  helmMin: number,
  helmMax: number,
): DeployService {
  return {
    name,
    kind,
    compose: true,
    helm: helmWorkload !== null,
    helmWorkload,
    composeReplicas: 1,
    helmMin,
    helmMax,
  };
}

export const DEPLOY_SERVICES: readonly DeployService[] = [
  unit("redis", "stateful", "StatefulSet", 1, 1),
  unit("otel-collector", "collector", null, 0, 0),
  unit("server", "stateless", "Deployment", 2, 8),
  unit("console", "stateless", "Deployment", 1, 1),
];

export function hpaEnabled(service: DeployService): boolean {
  return service.helm && service.helmMax > service.helmMin;
}

export const LOCAL_COMMANDS = {
  server: "pnpm --filter @agent/server dev",
  console: "pnpm --filter @agent/console dev",
  healthz: "curl -sf http://127.0.0.1:8787/healthz",
  consoleUrl: "http://127.0.0.1:3001",
} as const;

export const PROD_TOPOLOGY = {
  redis: "StatefulSet, 1",
  server: "Deployment 2–8, HPA, Ingress",
  collector: "not in the chart",
} as const;

export const COMPOSE_FILES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yml",
  "docker-compose.yaml",
] as const;

export const HELM_CHART = "deploy/helm/agent-kit";
