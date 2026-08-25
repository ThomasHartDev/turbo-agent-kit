import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type Yaml = null | boolean | number | string | Yaml[] | { [k: string]: Yaml };
export type Doc = Record<string, Yaml>;
export type RuleId =
  | "required-kind"
  | "gated-kind"
  | "config-secret"
  | "hpa-bounds"
  | "cpu-request"
  | "dns-name"
  | "replicas-vs-hpa";
export type Finding = { rule: RuleId; message: string };
export type Release = { Name: string; Namespace: string; Service: string };
export type HelmContext = {
  Values: Yaml;
  Release: Release;
  Chart: { Name: string; Version: string; AppVersion: string };
};
type Action = { src: string; tl: boolean; tr: boolean; i: number; j: number };
type Defined = { body: string; tr: boolean; endTl: boolean; endTr: boolean };

const SECRET = /(?:^|_)(SECRET|PASSWORD|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY)$/i;
const DNS = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const ALWAYS = ["ConfigMap", "Deployment", "Service"] as const;

export const rec = (v: Yaml | undefined): Doc | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined;
export const isEmpty = (v: unknown) =>
  v == null ||
  v === false ||
  v === 0 ||
  v === "" ||
  (typeof v === "object" && Object.keys(v as object).length === 0);
export function mergeValues(base: Yaml, overlay: Yaml): Yaml {
  const a = rec(base);
  const b = rec(overlay);
  if (!a || !b) return overlay === undefined ? base : overlay;
  const out: Doc = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in a ? mergeValues(a[k]!, v) : v;
  return out;
}

const q = (s: string) =>
  s.length >= 2 &&
  ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")));
const uq = (s: string) => (q(s) ? s.slice(1, -1) : s);
const hd = (s: string) => s.split(/\s/, 1)[0]!;
const str = (v: Yaml | undefined) => (typeof v === "string" ? v : undefined);
const truthy = (v: unknown) => !isEmpty(v) && v !== "false";

export function parseValues(source: string): Yaml {
  type L = { n: number; t: string };
  const ls: L[] = source.split("\n").flatMap((raw) => {
    const cut = raw.replace(/\s+#.*$/, "").trimEnd();
    return !cut.trim() || cut.trim().startsWith("#")
      ? []
      : [{ n: cut.search(/\S/), t: cut.trim() }];
  });
  const parse = (i: number, n: number): { v: Doc; i: number } => {
    const out: Doc = {};
    while (i < ls.length) {
      const line = ls[i]!;
      if (line.n < n) break;
      if (line.n > n) throw new SyntaxError("bad indent");
      const m = line.t.match(/^([^:]+):(.*)$/);
      if (!m) throw new SyntaxError(line.t);
      const rest = m[2]!.trim();
      const key = m[1]!.trim();
      i += 1;
      if (rest) {
        out[key] =
          rest === "true" || rest === "false"
            ? rest === "true"
            : q(rest)
              ? rest.slice(1, -1)
              : /^-?\d+(?:\.\d+)?$/.test(rest)
                ? Number(rest)
                : rest;
      } else if (ls[i] && ls[i]!.n > n) {
        const ch = parse(i, ls[i]!.n);
        out[key] = ch.v;
        i = ch.i;
      } else out[key] = null;
    }
    return { v: out, i };
  };
  return ls.length ? parse(0, ls[0]!.n).v : {};
}

export const kindsIn = (yaml: string) => [...yaml.matchAll(/^kind:\s+(\S+)/gm)].map((m) => m[1]!);

export function evaluateChart(yaml: string, values: Yaml): { ok: boolean; findings: Finding[] } {
  const findings: Finding[] = [];
  const add = (rule: RuleId, message: string) => findings.push({ rule, message });
  const kinds = kindsIn(yaml);
  for (const k of ALWAYS) if (!kinds.includes(k)) add("required-kind", `missing ${k}`);
  const v = rec(values) ?? {};
  const ing = rec(v.ingress)?.enabled === true;
  const hpa = rec(v.autoscaling)?.enabled === true;
  if (ing !== kinds.includes("Ingress")) add("gated-kind", "Ingress must follow ingress.enabled");
  if (hpa !== kinds.includes("HorizontalPodAutoscaler"))
    add("gated-kind", "HPA must follow autoscaling.enabled");
  for (const k of Object.keys(rec(v.config) ?? {}))
    if (SECRET.test(k)) add("config-secret", `${k} belongs in a Secret`);
  if (/^\s+OPENAI_API_KEY:/m.test(yaml)) add("config-secret", "OPENAI_API_KEY must not render");
  const reps = /^\s+replicas:\s+\d+/m.test(yaml);
  if (hpa && reps) add("replicas-vs-hpa", "omit spec.replicas when an HPA owns the Deployment");
  if (!hpa && !reps) add("replicas-vs-hpa", "Deployment needs replicas when HPA is off");
  if (hpa) {
    const min = Number(yaml.match(/minReplicas:\s+(\d+)/)?.[1]);
    const max = Number(yaml.match(/maxReplicas:\s+(\d+)/)?.[1]);
    if (!(min >= 1 && max > min && max <= 32))
      add("hpa-bounds", "minReplicas >= 1 and maxReplicas in (min, 32]");
    const cpu = rec(rec(v.resources)?.requests)?.cpu;
    const ms = typeof cpu === "string" && cpu.endsWith("m") ? Number(cpu.slice(0, -1)) : NaN;
    if (!(ms > 0)) add("cpu-request", "HPA CPU metric needs a positive cpu request");
  }
  for (const m of yaml.matchAll(/^\s+name:\s+(\S+)/gm)) {
    const nm = uq(m[1]!);
    if (nm.length > 63 || !DNS.test(nm)) add("dns-name", `${nm} is not DNS-1123`);
  }
  return { ok: findings.length === 0, findings };
}

function actions(src: string): Action[] {
  const out: Action[] = [];
  let i = 0;
  while (i < src.length) {
    const a = src.indexOf("{{", i);
    if (a === -1) break;
    const b = src.indexOf("}}", a + 2);
    if (b === -1) throw new SyntaxError("unclosed action");
    let inner = src.slice(a + 2, b);
    const tl = inner.startsWith("-");
    const tr = inner.endsWith("-");
    if (tl) inner = inner.slice(1);
    if (tr) inner = inner.slice(0, -1);
    out.push({ src: inner.trim(), tl, tr, i: a, j: b + 2 });
    i = b + 2;
  }
  return out;
}

function matchEnd(all: Action[], start: number): { elseAt?: number; endAt: number } {
  let d = 0;
  let elseAt: number | undefined;
  for (let i = start; i < all.length; i++) {
    const h = hd(all[i]!.src);
    if (h === "if" || h === "define") d += 1;
    else if (h === "else" && d === 1 && elseAt === undefined) elseAt = i;
    else if (h === "end") {
      d -= 1;
      if (d === 0) return { elseAt, endAt: i };
    }
  }
  throw new SyntaxError("unclosed block");
}

function lookup(ctx: HelmContext, path: string): unknown {
  let cur: Yaml | undefined = ctx as unknown as Yaml;
  for (const p of path.replace(/^\./, "").split(".")) {
    if (!p) continue;
    const r = rec(cur);
    if (!r) return undefined;
    cur = r[p];
  }
  return cur;
}

function splitTokens(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i += 1;
    if (i >= s.length) break;
    if (s[i] === '"' || s[i] === "'") {
      const qch = s[i]!;
      let j = i + 1;
      while (j < s.length && s[j] !== qch) j += 1;
      out.push(s.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (s[i] === "(") {
      let d = 1;
      let j = i + 1;
      while (j < s.length && d > 0) {
        if (s[j] === '"' || s[j] === "'") {
          const qch = s[j]!;
          j += 1;
          while (j < s.length && s[j] !== qch) j += 1;
        } else if (s[j] === "(") d += 1;
        else if (s[j] === ")") d -= 1;
        j += 1;
      }
      out.push(s.slice(i, j));
      i = j;
      continue;
    }
    let j = i;
    while (j < s.length && !/\s/.test(s[j]!) && s[j] !== "(") j += 1;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

function atom(
  tok: string,
  ctx: HelmContext,
  include: (name: string, c: HelmContext) => string,
): unknown {
  if (tok.startsWith("(") && tok.endsWith(")"))
    return evalExpr(tok.slice(1, -1).trim(), ctx, include);
  if (q(tok)) return tok.slice(1, -1);
  if (tok === "true" || tok === "false") return tok === "true";
  if (tok === "null") return null;
  if (/^-?\d+$/.test(tok)) return Number(tok);
  if (tok === ".") return ctx;
  if (tok.startsWith(".")) return lookup(ctx, tok);
  return tok;
}

function evalExpr(
  src: string,
  ctx: HelmContext,
  include: (name: string, c: HelmContext) => string,
): unknown {
  const stages = src.split("|").map((s) => s.trim());
  let acc: unknown;
  for (let s = 0; s < stages.length; s++) {
    const parts = splitTokens(stages[s]!);
    const args = parts.slice(1).map((p) => atom(p, ctx, include));
    if (s === 0) {
      const h = parts[0]!;
      acc =
        h.startsWith(".") || q(h) || /^-?\d/.test(h)
          ? atom(h, ctx, include)
          : call(h, args, ctx, include);
    } else acc = call(parts[0]!, [...args, acc], ctx, include);
  }
  return acc;
}

function call(
  name: string,
  args: unknown[],
  ctx: HelmContext,
  include: (name: string, c: HelmContext) => string,
): unknown {
  if (name === "include")
    return include(String(args[0]), (args[1] as HelmContext | undefined) ?? ctx);
  if (name === "default") return isEmpty(args[1]) ? args[0] : args[1];
  if (name === "quote") return JSON.stringify(String(args[0] ?? ""));
  if (name === "lower") return String(args[0] ?? "").toLowerCase();
  if (name === "trunc") return String(args[1] ?? "").slice(0, Number(args[0]));
  if (name === "trimSuffix") {
    const s = String(args[1] ?? "");
    const suf = String(args[0] ?? "");
    return suf && s.endsWith(suf) ? s.slice(0, -suf.length) : s;
  }
  if (name === "printf") {
    let i = 0;
    const rest = args.slice(1);
    return String(args[0] ?? "").replace(/%s/g, () => String(rest[i++] ?? ""));
  }
  if (name === "not") return !truthy(args[0]);
  throw new SyntaxError(`unknown function ${name}`);
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export function evalTemplate(
  src: string,
  ctx: HelmContext,
  inherited?: Map<string, Defined>,
): string {
  const all = actions(src);
  const defs = new Map<string, Defined>(inherited);
  for (let i = 0; i < all.length; i++) {
    if (hd(all[i]!.src) !== "define") continue;
    const { endAt } = matchEnd(all, i);
    const start = all[i]!;
    const end = all[endAt]!;
    defs.set(uq(start.src.slice(6).trim()), {
      body: src.slice(start.j, end.i),
      tr: start.tr,
      endTl: end.tl,
      endTr: end.tr,
    });
    i = endAt;
  }
  const include = (name: string, c: HelmContext): string => {
    const def = defs.get(name);
    if (def === undefined) throw new SyntaxError(`unknown template ${name}`);
    let text = evalTemplate(def.body, c, defs);
    if (def.tr) text = text.replace(/^\s+/, "");
    if (def.endTl) text = text.replace(/\s+$/, "");
    return text;
  };
  let out = "";
  let pos = 0;
  let trim = false;
  const emit = (chunk: string, tl: boolean, tr: boolean) => {
    if (tl) out = out.replace(/\s+$/, "");
    out += trim ? chunk.replace(/^\s+/, "") : chunk;
    trim = tr;
  };
  for (let i = 0; i < all.length; i++) {
    const a = all[i]!;
    emit(src.slice(pos, a.i), false, false);
    pos = a.j;
    if (a.tl) out = out.replace(/\s+$/, "");
    const h = hd(a.src);
    if (h === "define") {
      i = matchEnd(all, i).endAt;
      pos = all[i]!.j;
      trim = all[i]!.tr;
      continue;
    }
    if (h === "end" || h === "else") break;
    if (h === "if") {
      const { elseAt, endAt } = matchEnd(all, i);
      const cond = truthy(evalExpr(a.src.slice(2).trim(), ctx, include));
      const from = cond ? a.j : elseAt !== undefined ? all[elseAt]!.j : all[endAt]!.j;
      const to = cond ? (elseAt !== undefined ? all[elseAt]!.i : all[endAt]!.i) : all[endAt]!.i;
      const inner = cond || elseAt !== undefined ? src.slice(from, to) : "";
      out += evalTemplate(inner, ctx, defs);
      const end = all[endAt]!;
      if (end.tl) out = out.replace(/\s+$/, "");
      trim = end.tr;
      pos = end.j;
      i = endAt;
      continue;
    }
    out += stringify(evalExpr(a.src, ctx, include));
    trim = a.tr;
  }
  emit(src.slice(pos), false, false);
  return out;
}

export const DEFAULT_RELEASE: Release = { Name: "agent", Namespace: "agent", Service: "Helm" };

export function renderChart(
  dir: string,
  overlay: Yaml = {},
  release: Release = DEFAULT_RELEASE,
): { yaml: string; values: Yaml } {
  const chart = rec(parseValues(readFileSync(join(dir, "Chart.yaml"), "utf8"))) ?? {};
  const values = mergeValues(parseValues(readFileSync(join(dir, "values.yaml"), "utf8")), overlay);
  const ctx: HelmContext = {
    Values: values,
    Release: release,
    Chart: {
      Name: str(chart.name) ?? "",
      Version: str(chart.version) ?? "",
      AppVersion: str(chart.appVersion) ?? "",
    },
  };
  const parts: string[] = [];
  let helpers = "";
  for (const name of readdirSync(join(dir, "templates")).sort()) {
    const src = readFileSync(join(dir, "templates", name), "utf8");
    if (basename(name).startsWith("_")) helpers += src;
    else {
      const rendered = evalTemplate(helpers + src, ctx).trim();
      if (rendered) parts.push(rendered);
    }
  }
  return { yaml: `${parts.join("\n---\n")}\n`, values };
}
