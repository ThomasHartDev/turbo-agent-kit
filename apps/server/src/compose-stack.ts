export const REQUIRED_SERVICES = ["server", "console", "redis", "otel-collector"] as const;

export type ReadyCondition = "service_started" | "service_healthy";

export interface ServiceSpec {
  name: string;
  image?: string;
  build?: { context: string; dockerfile: string };
  environment: Record<string, string>;
  dependsOn: Record<string, ReadyCondition>;
  healthcheck?: { test: string[]; intervalMs: number; timeoutMs: number; retries: number };
  privileged: boolean;
  networkMode?: string;
}

export type ComposeProject = { services: Record<string, ServiceSpec> };

export type RuleId =
  | "required-service"
  | "healthcheck"
  | "depends-healthy"
  | "unknown-dep"
  | "cycle"
  | "no-privileged"
  | "no-secret-env"
  | "build-or-image"
  | "no-host-network"
  | "probe-budget";

export type Finding = { rule: RuleId; service?: string; message: string };

const SECRET = /(?:^|_)(SECRET|PASSWORD|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY)$/i;
const INTERP = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/;
const DUR = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

export function parseDuration(raw: string): number {
  const m = DUR.exec(raw.trim());
  if (!m) throw new SyntaxError(`invalid duration: ${raw}`);
  return Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2]!] ?? 1);
}

export function loadComposeFile(source: string): ComposeProject {
  if (source.includes("\t")) throw new SyntaxError("tab indent");
  const services: Record<string, ServiceSpec> = {};
  for (const [name, body] of Object.entries(serviceBlocks(source))) {
    services[name] = readBlock(name, body);
  }
  return { services };
}

export function evaluateStack(project: ComposeProject): { ok: boolean; findings: Finding[] } {
  const findings: Finding[] = [];
  const add = (rule: RuleId, message: string, service?: string) =>
    findings.push({ rule, service, message });
  for (const name of REQUIRED_SERVICES) {
    if (!project.services[name]) add("required-service", `missing service ${name}`);
  }
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (node: string) => {
    color.set(node, 1);
    stack.push(node);
    for (const dep of Object.keys(project.services[node]?.dependsOn ?? {})) {
      const c = color.get(dep) ?? 0;
      if (c === 1)
        add("cycle", `dependency cycle: ${[...stack.slice(stack.indexOf(dep)), dep].join(" -> ")}`);
      else if (c === 0 && project.services[dep]) visit(dep);
    }
    stack.pop();
    color.set(node, 2);
  };
  for (const svc of Object.values(project.services)) {
    if (svc.privileged) add("no-privileged", "privileged containers are forbidden", svc.name);
    if (svc.networkMode === "host")
      add("no-host-network", "host network breaks service DNS", svc.name);
    if (!svc.image && !svc.build)
      add("build-or-image", "service has neither image nor build", svc.name);
    const hc = svc.healthcheck;
    if (!hc?.test.length) add("healthcheck", "service has no healthcheck", svc.name);
    else if (hc.timeoutMs >= hc.intervalMs || hc.retries < 1) {
      add("probe-budget", "healthcheck timeout must be < interval and retries >= 1", svc.name);
    }
    for (const [key, value] of Object.entries(svc.environment)) {
      if (SECRET.test(key) && value !== "" && !INTERP.test(value)) {
        add("no-secret-env", `${key} must be interpolated, not a literal`, svc.name);
      }
    }
    for (const [dep, cond] of Object.entries(svc.dependsOn)) {
      if (!project.services[dep]) add("unknown-dep", `depends on unknown service ${dep}`, svc.name);
      else if (cond !== "service_healthy")
        add("depends-healthy", `${dep} must use condition service_healthy`, svc.name);
    }
    if ((color.get(svc.name) ?? 0) === 0) visit(svc.name);
  }
  return { ok: findings.length === 0, findings };
}

export function inspectDockerfile(source: string): {
  stages: number;
  finalUser: string | undefined;
  hasHealthcheck: boolean;
  usesAdd: boolean;
} {
  let stages = 0;
  let finalUser: string | undefined;
  let hasHealthcheck = false;
  let usesAdd = false;
  let buf = "";
  const take = (text: string) => {
    const sp = text.search(/\s/);
    const name = (sp === -1 ? text : text.slice(0, sp)).toUpperCase();
    const args = sp === -1 ? "" : text.slice(sp + 1).trim();
    if (name === "FROM") {
      stages += 1;
      finalUser = undefined;
      hasHealthcheck = false;
    } else if (name === "USER") finalUser = args.split(/\s+/)[0];
    else if (name === "HEALTHCHECK" && !/^NONE\b/i.test(args)) hasHealthcheck = true;
    else if (name === "ADD") usesAdd = true;
  };
  for (const raw of source.replace(/\r\n/g, "\n").split("\n")) {
    const t = raw.trim();
    if (!buf && (!t || t.startsWith("#"))) continue;
    const cont = t.endsWith("\\");
    buf = buf ? `${buf} ${cont ? t.slice(0, -1) : t}`.trim() : cont ? t.slice(0, -1) : t;
    if (!cont) {
      take(buf);
      buf = "";
    }
  }
  if (buf) take(buf);
  return { stages, finalUser, hasHealthcheck, usesAdd };
}

function serviceBlocks(source: string): Record<string, string> {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.trim() === "services:");
  if (start === -1) throw new SyntaxError("compose file has no services:");
  const out: Record<string, string> = {};
  let current: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    if (current) out[current] = buf.join("\n");
    buf = [];
  };
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("  ") && !line.startsWith("    ") && /^  [A-Za-z0-9_-]+:\s*$/.test(line)) {
      flush();
      current = line.trim().slice(0, -1);
      continue;
    }
    if (current && (line.startsWith("    ") || line.trim() === "")) buf.push(line);
    else if (line.trim() && !line.startsWith(" ")) break;
  }
  flush();
  return out;
}

function readBlock(name: string, body: string): ServiceSpec {
  const field = (key: string) => body.match(new RegExp(`^ {4,}${key}:\\s*(.*)$`, "m"))?.[1];
  const testLine = field("test");
  const interval = field("interval");
  const timeout = field("timeout");
  const retries = field("retries");
  const environment: Record<string, string> = {};
  const envBody = body.split("    environment:\n")[1]?.split(/\n    [a-z_]+:/)[0] ?? "";
  for (const line of envBody.split("\n")) {
    const m = line.match(/^      ([A-Z0-9_]+):\s*(.*)$/);
    if (m) environment[m[1]!] = unquote(m[2]!);
  }
  const dependsOn: Record<string, ReadyCondition> = {};
  const depBody = body.split("    depends_on:\n")[1]?.split(/\n    [a-z_]+:/)[0] ?? "";
  if (/^      - /.test(depBody)) {
    for (const line of depBody.split("\n")) {
      const m = line.match(/^      - (\S+)/);
      if (m) dependsOn[m[1]!] = "service_started";
    }
  } else {
    let dep: string | undefined;
    for (const line of depBody.split("\n")) {
      const nameLine = line.match(/^      ([A-Za-z0-9_-]+):\s*$/);
      if (nameLine) dep = nameLine[1];
      const cond = line.match(/^        condition:\s*(\S+)/);
      if (dep && cond) dependsOn[dep] = cond[1] as ReadyCondition;
    }
  }
  const dockerfile = field("dockerfile");
  const context = field("context");
  return {
    name,
    image: field("image") ? unquote(field("image")!) : undefined,
    build:
      dockerfile || context
        ? { context: unquote(context ?? "."), dockerfile: unquote(dockerfile ?? "Dockerfile") }
        : undefined,
    environment,
    dependsOn,
    healthcheck:
      testLine || interval
        ? {
            test: testLine
              ? /^CMD(?:-SHELL)?\b/.test(unquote(testLine))
                ? unquote(testLine).split(/\s+/)
                : ["CMD-SHELL", unquote(testLine)]
              : [],
            intervalMs: interval ? parseDuration(unquote(interval)) : 30_000,
            timeoutMs: timeout ? parseDuration(unquote(timeout)) : 30_000,
            retries: retries ? Number(retries) : 3,
          }
        : undefined,
    privileged: field("privileged") === "true",
    networkMode: field("network_mode") ? unquote(field("network_mode")!) : undefined,
  };
}

function unquote(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}
