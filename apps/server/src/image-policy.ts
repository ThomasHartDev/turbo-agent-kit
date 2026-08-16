export type RuleId =
  "multi-stage" | "non-root" | "healthcheck" | "no-add" | "no-secret-env" | "has-cmd";

export interface Instruction {
  name: string;
  args: string;
  line: number;
}

export interface Stage {
  name: string | undefined;
  image: string;
  from: Instruction;
  instructions: Instruction[];
}

export interface Finding {
  rule: RuleId;
  line: number;
  message: string;
}

export interface PolicyResult {
  ok: boolean;
  findings: Finding[];
}

export interface IgnorePattern {
  pattern: string;
  negated: boolean;
  anchored: boolean;
  line: number;
}

const SECRET_NAME = /(?:^|_)(SECRET|PASSWORD|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY)$/i;

export function splitInstructions(source: string): Instruction[] {
  const physical = source.replace(/\r\n/g, "\n").split("\n");
  const out: Instruction[] = [];
  let buf = "";
  let startLine = 1;
  let pending = false;

  const flush = () => {
    const text = buf.trim();
    buf = "";
    pending = false;
    if (!text || text.startsWith("#")) return;
    const sp = text.search(/\s/);
    out.push({
      name: (sp === -1 ? text : text.slice(0, sp)).toUpperCase(),
      args: sp === -1 ? "" : text.slice(sp + 1).trim(),
      line: startLine,
    });
  };

  for (let i = 0; i < physical.length; i++) {
    const raw = physical[i] ?? "";
    if (!pending) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      startLine = i + 1;
      if (trimmed.endsWith("\\")) {
        buf = trimmed.slice(0, -1);
        pending = true;
      } else {
        buf = trimmed;
        flush();
      }
      continue;
    }
    const trimmedEnd = raw.trimEnd();
    const cont = trimmedEnd.endsWith("\\");
    buf = `${buf.trimEnd()} ${(cont ? trimmedEnd.slice(0, -1) : raw).trim()}`;
    if (!cont) flush();
  }
  if (pending) flush();
  return out;
}

export function parseFrom(args: string): {
  image: string;
  name: string | undefined;
  platform?: string;
} {
  const tokens = tokenize(args);
  let platform: string | undefined;
  let i = 0;
  while (i < tokens.length && tokens[i]!.startsWith("--")) {
    const token = tokens[i]!;
    const eq = token.indexOf("=");
    if (eq !== -1 && token.slice(2, eq) === "platform") platform = token.slice(eq + 1);
    i += 1;
  }
  const asWord = tokens[i + 1];
  const name = asWord?.toUpperCase() === "AS" ? tokens[i + 2] : undefined;
  return { image: tokens[i] ?? "", name, platform };
}

export function groupStages(instructions: Instruction[]): {
  prelude: Instruction[];
  stages: Stage[];
} {
  const prelude: Instruction[] = [];
  const stages: Stage[] = [];
  for (const inst of instructions) {
    if (inst.name === "FROM") {
      const parsed = parseFrom(inst.args);
      stages.push({ name: parsed.name, image: parsed.image, from: inst, instructions: [] });
    } else if (stages.length === 0) {
      prelude.push(inst);
    } else {
      stages.at(-1)!.instructions.push(inst);
    }
  }
  return { prelude, stages };
}

export function isRootUser(args: string): boolean {
  const user = (tokenize(args)[0] ?? "").split(":")[0]?.trim() ?? "";
  return user === "" || user === "0" || user.toLowerCase() === "root";
}

export function evaluateImagePolicy(source: string): PolicyResult & { stages: Stage[] } {
  const instructions = splitInstructions(source);
  const { stages } = groupStages(instructions);
  const findings: Finding[] = [];
  const add = (rule: RuleId, line: number, message: string) =>
    findings.push({ rule, line, message });

  if (stages.length < 2) {
    add(
      "multi-stage",
      stages[0]?.from.line ?? 1,
      "runtime image must discard the compile toolchain in a later stage",
    );
  }

  const runtime = stages.at(-1);
  if (runtime) {
    const user = last(runtime.instructions, (i) => i.name === "USER");
    if (!user || isRootUser(user.args)) {
      add(
        "non-root",
        user?.line ?? runtime.from.line,
        user ? `USER ${user.args} still has uid 0` : "final stage has no USER",
      );
    }
    const hc = last(runtime.instructions, (i) => i.name === "HEALTHCHECK");
    if (!hc || /^NONE\b/i.test(hc.args)) {
      add(
        "healthcheck",
        hc?.line ?? runtime.from.line,
        hc ? "HEALTHCHECK NONE disables the liveness probe" : "final stage has no HEALTHCHECK",
      );
    }
    if (!runtime.instructions.some((i) => i.name === "CMD" || i.name === "ENTRYPOINT")) {
      add("has-cmd", runtime.from.line, "final stage has no CMD or ENTRYPOINT");
    }
  }

  for (const inst of instructions) {
    if (inst.name === "ADD")
      add("no-add", inst.line, "ADD fetches URLs and unpacks archives; use COPY");
    if (inst.name === "ENV" || inst.name === "ARG") {
      for (const key of namesFromEnvOrArg(inst)) {
        if (key && SECRET_NAME.test(key)) {
          add(
            "no-secret-env",
            inst.line,
            `${inst.name} ${key} bakes a secret into the image config`,
          );
        }
      }
    }
  }
  return { ok: findings.length === 0, findings, stages };
}

export function parseDockerignore(source: string): IgnorePattern[] {
  return source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((raw, i) => {
      const trimmed = raw.trim();
      if (!trimmed || trimmed === "." || trimmed.startsWith("#")) return [];
      const negated = trimmed.startsWith("!");
      let pattern = (negated ? trimmed.slice(1) : trimmed).replace(/^\.\//, "").replace(/\/+$/, "");
      const anchored = pattern.startsWith("/");
      if (anchored) pattern = pattern.slice(1);
      return [{ pattern, negated, anchored, line: i + 1 }];
    });
}

export function isIgnored(relPath: string, patterns: readonly IgnorePattern[]): boolean {
  const path = relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!path) return false;
  const chain = pathPrefixes(path);
  let ignored = false;
  for (const p of patterns) {
    if (chain.some((candidate) => matchOne(p, candidate))) ignored = !p.negated;
  }
  return ignored;
}

export function parseEnvArgs(args: string): Record<string, string> {
  const tokens = tokenize(args);
  const out: Record<string, string> = {};
  if (tokens.some((t) => t.includes("="))) {
    for (const token of tokens) {
      const eq = token.indexOf("=");
      if (eq !== -1) out[token.slice(0, eq)] = token.slice(eq + 1);
    }
    return out;
  }
  if (tokens[0]) out[tokens[0]] = tokens.slice(1).join(" ");
  return out;
}

function namesFromEnvOrArg(inst: Instruction): string[] {
  if (inst.name !== "ARG") return Object.keys(parseEnvArgs(inst.args));
  return [(tokenize(inst.args)[0] ?? "").split("=")[0] ?? ""];
}

function matchOne(p: IgnorePattern, path: string): boolean {
  if (p.anchored) return globMatch(p.pattern, path);
  if (!p.pattern.includes("/")) {
    return globMatch(p.pattern, path.split("/").at(-1) ?? path);
  }
  return globMatch(p.pattern, path) || globMatch(`**/${p.pattern}`, path);
}

function pathPrefixes(path: string): string[] {
  const segs = path.split("/");
  return segs.map((_, i) => segs.slice(0, i + 1).join("/"));
}

function globMatch(pattern: string, value: string): boolean {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      out += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += pattern[i + 2] === "/" ? 2 : 1;
    } else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += "+^$()[]{}|\\.".includes(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`${out}$`).test(value);
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function last<T>(xs: readonly T[], pred: (x: T) => boolean): T | undefined {
  for (let i = xs.length - 1; i >= 0; i--) if (pred(xs[i]!)) return xs[i];
  return undefined;
}
