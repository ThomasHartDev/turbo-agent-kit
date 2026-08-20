export type Yaml = null | boolean | number | string | Yaml[] | { [k: string]: Yaml };
export type RuleId =
  | "required-kind"
  | "namespace"
  | "selector"
  | "service-selector"
  | "headless"
  | "stateful-identity"
  | "pvc"
  | "non-root"
  | "probes"
  | "config-string"
  | "config-vs-secret"
  | "secret-ref";
export type Finding = { rule: RuleId; object?: string; message: string };
type Doc = Record<string, Yaml>;
type Line = { indent: number; text: string; n: number };
type Add = (rule: RuleId, message: string, object?: string) => void;

export const REQUIRED = [
  { kind: "Namespace", name: "agent" },
  { kind: "ConfigMap", name: "agent-server" },
  { kind: "Secret", name: "agent-server" },
  { kind: "Deployment", name: "server" },
  { kind: "Service", name: "server" },
  { kind: "StatefulSet", name: "redis" },
  { kind: "Service", name: "redis" },
] as const;

const SECRET = /(?:^|_)(SECRET|PASSWORD|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY)$/i;

export function rec(v: Yaml | undefined): Doc | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}

export function parseYamlDocuments(source: string): Doc[] {
  if (source.includes("\t")) throw new SyntaxError("tab indent");
  const chunks: string[][] = [[]];
  for (const raw of source.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*---\s*$/.test(raw)) chunks.push([]);
    else chunks.at(-1)!.push(raw);
  }
  return chunks.flatMap((c) => {
    const v = rec(parseDoc(c.join("\n")));
    return v && typeof v.kind === "string" ? [v] : [];
  });
}

function parseDoc(source: string): Yaml {
  const ls: Line[] = source.split("\n").flatMap((raw, i) => {
    const cut = raw.trimEnd();
    if (!cut.trim() || cut.trimStart().startsWith("#")) return [];
    return [{ indent: cut.search(/\S/), text: cut.trim(), n: i + 1 }];
  });
  return ls.length === 0 ? null : block(ls, 0, ls[0]!.indent).value;
}

function block(ls: Line[], i: number, min: number): { value: Yaml; next: number } {
  const line = ls[i];
  if (!line || line.indent < min) return { value: null, next: i };
  return line.text === "-" || line.text.startsWith("- ")
    ? seq(ls, i, line.indent)
    : map(ls, i, line.indent);
}

function map(ls: Line[], i: number, indent: number): { value: Doc; next: number } {
  const out: Doc = {};
  while (i < ls.length) {
    const line = ls[i]!;
    if (line.indent < indent || line.text === "-" || line.text.startsWith("- ")) break;
    if (line.indent > indent) throw new SyntaxError(`bad indent at line ${line.n}`);
    const e = split(line.text);
    if (!e) throw new SyntaxError(`expected key at line ${line.n}`);
    i += 1;
    if (e.rest) out[e.key] = scalar(e.rest);
    else {
      const child = block(ls, i, indent + 1);
      out[e.key] = child.value;
      i = child.next;
    }
  }
  return { value: out, next: i };
}

function seq(ls: Line[], i: number, indent: number): { value: Yaml[]; next: number } {
  const out: Yaml[] = [];
  while (i < ls.length) {
    const line = ls[i]!;
    if (line.indent !== indent || (line.text !== "-" && !line.text.startsWith("- "))) break;
    const rest = line.text === "-" ? "" : line.text.slice(2);
    i += 1;
    if (!rest) {
      const child = block(ls, i, indent + 1);
      out.push(child.value);
      i = child.next;
    } else if (split(rest)) {
      const child = map(
        [{ indent: indent + 2, text: rest, n: line.n }, ...ls.slice(i)],
        0,
        indent + 2,
      );
      out.push(child.value);
      i += child.next - 1;
    } else out.push(scalar(rest));
  }
  return { value: out, next: i };
}

function split(text: string): { key: string; rest: string } | undefined {
  const sp = text.indexOf(": ");
  if (sp !== -1) return { key: text.slice(0, sp).trim(), rest: text.slice(sp + 2) };
  return text.endsWith(":") ? { key: text.slice(0, -1).trim(), rest: "" } : undefined;
}

function scalar(raw: string): Yaml {
  const s = raw.trim();
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(",").map((p) => scalar(p.trim())) : [];
  }
  if (s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return s.slice(1, -1);
  }
  return /^[+-]?\d+$/.test(s) ? Number(s) : s;
}

function walk(obj: Yaml | undefined, ...keys: string[]): Yaml | undefined {
  let cur = obj;
  for (const k of keys) {
    const r = rec(cur);
    if (!r) return undefined;
    cur = r[k];
  }
  return cur;
}

function str(v: Yaml | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function id(d: Doc): string {
  return `${str(d.kind) ?? "?"}/${str(walk(d, "metadata", "name")) || "?"}`;
}

function labs(v: Yaml | undefined): Record<string, string> {
  const r = rec(v);
  if (!r) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(r)) {
    if (typeof val === "string" || typeof val === "number") out[k] = String(val);
  }
  return out;
}

function subset(need: Record<string, string>, have: Record<string, string>): boolean {
  return Object.entries(need).every(([k, v]) => have[k] === v) && Object.keys(need).length > 0;
}

function ctrs(w: Doc): Doc[] {
  const list = walk(w, "spec", "template", "spec", "containers");
  return Array.isArray(list) ? list.flatMap((c) => (rec(c) ? [rec(c)!] : [])) : [];
}

export function evaluateCluster(docs: readonly Doc[]): { ok: boolean; findings: Finding[] } {
  const findings: Finding[] = [];
  const add: Add = (rule, message, object) => findings.push({ rule, object, message });
  for (const req of REQUIRED) {
    if (!docs.some((d) => d.kind === req.kind && str(walk(d, "metadata", "name")) === req.name)) {
      add("required-kind", `missing ${req.kind}/${req.name}`);
    }
  }
  const workloads = docs.filter((d) => d.kind === "Deployment" || d.kind === "StatefulSet");
  const services = docs.filter((d) => d.kind === "Service");
  for (const d of docs) {
    const kind = str(d.kind) ?? "";
    const object = id(d);
    if (kind === "Namespace") {
      if (str(walk(d, "metadata", "name")) !== "agent")
        add("namespace", "namespace must be named agent", object);
      continue;
    }
    if (str(walk(d, "metadata", "namespace")) !== "agent")
      add("namespace", "must live in namespace agent", object);
    if (kind === "ConfigMap") {
      const data = rec(d.data) ?? {};
      for (const [k, v] of Object.entries(data)) {
        if (typeof v !== "string") add("config-string", `${k} must be a string`, object);
        if (SECRET.test(k)) add("config-vs-secret", `${k} belongs in a Secret`, object);
      }
      if (!str(data.REDIS_URL)?.includes("redis.agent.svc")) {
        add("config-string", "REDIS_URL must target redis.agent.svc", object);
      }
    }
    if (kind === "Secret") {
      const data = rec(d.stringData) ?? rec(d.data) ?? {};
      if (!("OPENAI_API_KEY" in data))
        add("secret-ref", "Secret must define OPENAI_API_KEY", object);
    }
    if (kind === "Deployment" || kind === "StatefulSet") {
      const sel = labs(walk(d, "spec", "selector", "matchLabels"));
      if (!subset(sel, labs(walk(d, "spec", "template", "metadata", "labels"))))
        add("selector", "matchLabels must be a subset of pod labels", object);
      const sc = rec(walk(d, "spec", "template", "spec", "securityContext")) ?? {};
      if (sc.runAsNonRoot !== true || sc.runAsUser === 0 || typeof sc.runAsUser !== "number") {
        add("non-root", "pod must set runAsNonRoot and a non-zero runAsUser", object);
      }
      const list = ctrs(d);
      if (!list.length) add("probes", "workload has no containers", object);
      for (const c of list) {
        const live = rec(c.livenessProbe);
        const ready = rec(c.readinessProbe);
        if (!live || !ready) add("probes", "container needs liveness and readiness probes", object);
        const path = str(walk(live, "httpGet", "path")) ?? str(walk(ready, "httpGet", "path"));
        if (path && path !== "/healthz")
          add("probes", `httpGet path must be /healthz (got ${path})`, object);
        let secretRef = false;
        for (const item of Array.isArray(c.env) ? c.env : []) {
          const e = rec(item);
          if (!e || !SECRET.test(str(e.name) ?? "")) continue;
          if (e.value)
            add("secret-ref", `${str(e.name)} must not be a plaintext env value`, object);
          if (rec(walk(e, "valueFrom", "secretKeyRef"))) secretRef = true;
          else add("secret-ref", `${str(e.name)} must use secretKeyRef`, object);
        }
        if (kind === "Deployment" && !secretRef) {
          add("secret-ref", "server must inject OPENAI_API_KEY from secretKeyRef", object);
        }
        if (kind === "Deployment") {
          const from = Array.isArray(c.envFrom) ? c.envFrom : [];
          const ok = from.some(
            (item) => str(walk(rec(item), "configMapRef", "name")) === "agent-server",
          );
          if (!ok) add("config-vs-secret", "server must envFrom ConfigMap agent-server", object);
        }
      }
    }
    if (kind === "StatefulSet") {
      const serviceName = str(walk(d, "spec", "serviceName"));
      const svc = services.find((s) => str(walk(s, "metadata", "name")) === serviceName);
      if (!serviceName || !svc)
        add("stateful-identity", "serviceName must name a Service in this set", object);
      else if (str(walk(svc, "spec", "clusterIP")) !== "None") {
        add("headless", `Service/${serviceName} must be headless (clusterIP: None)`, object);
      }
      const tpls = walk(d, "spec", "volumeClaimTemplates");
      if (!Array.isArray(tpls) || !tpls.length)
        add("pvc", "StatefulSet needs volumeClaimTemplates", object);
      else {
        for (const t of tpls) {
          const modes = walk(rec(t), "spec", "accessModes");
          if (!(Array.isArray(modes) && modes.includes("ReadWriteOnce"))) {
            add("pvc", "volumeClaimTemplate must include ReadWriteOnce", object);
          }
        }
      }
    }
    if (kind === "Service") {
      const sel = labs(walk(d, "spec", "selector"));
      if (
        !workloads.some((w) => subset(sel, labs(walk(w, "spec", "template", "metadata", "labels"))))
      ) {
        add("service-selector", "selector matches no Deployment or StatefulSet pods", object);
      }
    }
  }
  return { ok: findings.length === 0, findings };
}
