export type Yaml = null | boolean | number | string | Yaml[] | { [k: string]: Yaml };
export type Doc = Record<string, Yaml>;
export type RuleId =
  | "required-kind"
  | "namespace"
  | "selector"
  | "service-selector"
  | "probes"
  | "probe-window"
  | "cpu-request"
  | "hpa-target"
  | "hpa-bounds"
  | "hpa-metric"
  | "ingress-class"
  | "ingress-path"
  | "ingress-backend";
export type Finding = { rule: RuleId; object?: string; message: string };
type Add = (rule: RuleId, message: string, object?: string) => void;

export const REQUIRED = [
  { kind: "Deployment", name: "server" },
  { kind: "Service", name: "server" },
  { kind: "Ingress", name: "server" },
  { kind: "HorizontalPodAutoscaler", name: "server" },
] as const;
export const HEALTHZ = "/healthz";
export const INGRESS_CLASS = "nginx";

export type ProbeTiming = {
  initialDelaySeconds: number;
  periodSeconds: number;
  timeoutSeconds: number;
  failureThreshold: number;
  successThreshold: number;
};

export function rec(v: Yaml | undefined): Doc | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}

export function cpuMillis(raw: Yaml | undefined): number {
  if (typeof raw === "number") return raw * 1000;
  if (typeof raw !== "string" || raw === "") return Number.NaN;
  return raw.endsWith("m") ? Number(raw.slice(0, -1)) : Number(raw) * 1000;
}

export function probeDetectionSeconds(p: ProbeTiming): number {
  return p.failureThreshold * p.periodSeconds;
}

export function probeTiming(raw: Doc | undefined): ProbeTiming | undefined {
  if (!raw) return undefined;
  return {
    initialDelaySeconds: num(raw.initialDelaySeconds, 0),
    periodSeconds: num(raw.periodSeconds, 10),
    timeoutSeconds: num(raw.timeoutSeconds, 1),
    failureThreshold: num(raw.failureThreshold, 3),
    successThreshold: num(raw.successThreshold, 1),
  };
}

export function evaluateTraffic(docs: readonly Doc[]): { ok: boolean; findings: Finding[] } {
  const findings: Finding[] = [];
  const add: Add = (rule, message, object) => findings.push({ rule, object, message });
  for (const req of REQUIRED) {
    if (!docs.some((d) => d.kind === req.kind && nameOf(d) === req.name)) {
      add("required-kind", `missing ${req.kind}/${req.name}`);
    }
  }
  const deployments = docs.filter((d) => d.kind === "Deployment");
  const services = docs.filter((d) => d.kind === "Service");
  for (const d of docs) {
    const kind = str(d.kind) ?? "";
    const object = id(d);
    if (kind !== "Namespace" && str(walk(d, "metadata", "namespace")) !== "agent") {
      add("namespace", "must live in namespace agent", object);
    }
    if (kind === "Deployment") checkDeployment(d, add);
    if (kind === "Service") {
      const sel = labs(walk(d, "spec", "selector"));
      if (
        !deployments.some((w) =>
          subset(sel, labs(walk(w, "spec", "template", "metadata", "labels"))),
        )
      ) {
        add("service-selector", "selector matches no Deployment pods", object);
      }
    }
    if (kind === "Ingress") checkIngress(d, services, add);
    if (kind === "HorizontalPodAutoscaler") checkHpa(d, deployments, add);
  }
  return { ok: findings.length === 0, findings };
}

function checkDeployment(d: Doc, add: Add) {
  const object = id(d);
  const sel = labs(walk(d, "spec", "selector", "matchLabels"));
  if (!subset(sel, labs(walk(d, "spec", "template", "metadata", "labels")))) {
    add("selector", "matchLabels must be a subset of pod labels", object);
  }
  const pod = rec(walk(d, "spec", "template", "spec")) ?? {};
  const list = objs(walk(d, "spec", "template", "spec", "containers"));
  if (!list.length) add("probes", "workload has no containers", object);
  for (const c of list) {
    const ports = objs(c.ports);
    const live = rec(c.livenessProbe);
    const ready = rec(c.readinessProbe);
    if (!live || !ready) {
      add("probes", "container needs liveness and readiness probes", object);
      continue;
    }
    for (const [label, probe] of [
      ["liveness", live],
      ["readiness", ready],
    ] as const) {
      if (str(walk(probe, "httpGet", "path")) !== HEALTHZ) {
        add("probes", `${label} httpGet path must be ${HEALTHZ}`, object);
      }
      const port = walk(probe, "httpGet", "port");
      if (
        port !== undefined &&
        !ports.some((p) => str(p.name) === port || p.containerPort === port)
      ) {
        add("probes", `${label} httpGet port must match a container port`, object);
      }
    }
    const lt = probeTiming(live)!;
    const rt = probeTiming(ready)!;
    for (const [label, t] of [
      ["liveness", lt],
      ["readiness", rt],
    ] as const) {
      if (t.periodSeconds < 1 || t.timeoutSeconds < 1 || t.failureThreshold < 1) {
        add("probes", `${label} period, timeout, and failureThreshold must be >= 1`, object);
      }
      if (t.timeoutSeconds >= t.periodSeconds) {
        add("probes", `${label} timeoutSeconds must be less than periodSeconds`, object);
      }
    }
    const readyWin = probeDetectionSeconds(rt);
    if (readyWin >= probeDetectionSeconds(lt)) {
      add("probe-window", "readiness must fail closed faster than liveness restarts", object);
    }
    if (rt.initialDelaySeconds > lt.initialDelaySeconds) {
      add("probe-window", "readiness initialDelay must not exceed liveness", object);
    }
    if (num(pod.terminationGracePeriodSeconds, 30) < readyWin) {
      add("probe-window", "terminationGracePeriodSeconds must cover the readiness window", object);
    }
    if (!(cpuMillis(walk(c, "resources", "requests", "cpu")) > 0)) {
      add("cpu-request", "HPA CPU metric needs a positive cpu request", object);
    }
  }
}

function checkIngress(d: Doc, services: readonly Doc[], add: Add) {
  const object = id(d);
  if (str(walk(d, "spec", "ingressClassName")) !== INGRESS_CLASS) {
    add("ingress-class", `ingressClassName must be ${INGRESS_CLASS}`, object);
  }
  const rules = objs(walk(d, "spec", "rules"));
  if (!rules.length) add("ingress-path", "Ingress has no rules", object);
  for (const rule of rules) {
    const list = objs(walk(rule, "http", "paths"));
    if (!list.length) add("ingress-path", "Ingress rule has no paths", object);
    for (const p of list) {
      const pathType = str(p.pathType);
      if (pathType !== "Prefix" && pathType !== "Exact") {
        add("ingress-path", "pathType must be Prefix or Exact", object);
      }
      const svcName = str(walk(p, "backend", "service", "name"));
      const portName = str(walk(p, "backend", "service", "port", "name"));
      const portNum = walk(p, "backend", "service", "port", "number");
      const svc = services.find((s) => nameOf(s) === svcName);
      if (!svc) {
        add("ingress-backend", `backend Service/${svcName ?? "?"} is missing`, object);
        continue;
      }
      const hit = objs(walk(svc, "spec", "ports")).some(
        (sp) => (portName !== undefined && str(sp.name) === portName) || sp.port === portNum,
      );
      if (!hit) add("ingress-backend", "backend port must match a Service port", object);
    }
  }
}

function checkHpa(d: Doc, deployments: readonly Doc[], add: Add) {
  const object = id(d);
  const ref = rec(walk(d, "spec", "scaleTargetRef")) ?? {};
  const target = deployments.find(
    (w) => nameOf(w) === str(ref.name) && str(ref.kind) === "Deployment",
  );
  if (str(ref.apiVersion) !== "apps/v1" || str(ref.kind) !== "Deployment" || !target) {
    add("hpa-target", "scaleTargetRef must name a Deployment in this set", object);
  }
  const min = num(walk(d, "spec", "minReplicas"), 0);
  const max = num(walk(d, "spec", "maxReplicas"), 0);
  if (!(min >= 1 && max > min && max <= 32)) {
    add("hpa-bounds", "minReplicas >= 1 and maxReplicas in (min, 32]", object);
  }
  const cpu = objs(walk(d, "spec", "metrics")).find(
    (m) => str(m.type) === "Resource" && str(walk(m, "resource", "name")) === "cpu",
  );
  const util = num(walk(cpu, "resource", "target", "averageUtilization"), 0);
  if (
    !cpu ||
    str(walk(cpu, "resource", "target", "type")) !== "Utilization" ||
    util < 1 ||
    util > 100
  ) {
    add("hpa-metric", "HPA needs a CPU Utilization target in 1..100", object);
  }
}

function walk(obj: Yaml | undefined, ...keys: string[]): Yaml | undefined {
  return keys.reduce<Yaml | undefined>((cur, k) => rec(cur)?.[k], obj);
}

const str = (v: Yaml | undefined) => (typeof v === "string" ? v : undefined);
const num = (v: Yaml | undefined, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const nameOf = (d: Doc) => str(walk(d, "metadata", "name"));
const id = (d: Doc) => `${str(d.kind) ?? "?"}/${nameOf(d) || "?"}`;
function labs(v: Yaml | undefined): Record<string, string> {
  const r = rec(v);
  if (!r) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(r)) {
    if (typeof val === "string" || typeof val === "number") out[k] = String(val);
  }
  return out;
}
const subset = (need: Record<string, string>, have: Record<string, string>) =>
  Object.keys(need).length > 0 && Object.entries(need).every(([k, v]) => have[k] === v);
const objs = (list: Yaml | undefined): Doc[] =>
  Array.isArray(list) ? list.flatMap((x) => (rec(x) ? [rec(x)!] : [])) : [];
