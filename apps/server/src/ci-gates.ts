import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { splitInstructions } from "./image-policy";

export type SmokeFinding = { rule: string; path: string; message: string };
export type HelmSmokeResult = {
  ok: boolean;
  findings: SmokeFinding[];
  kinds: string[];
  documents: number;
};
export type WorkspacePackage = { name: string; dir: string };

const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const REQUIRED_KINDS = ["Deployment", "Service"] as const;

export function smokeHelmTemplate(source: string): HelmSmokeResult {
  const findings: SmokeFinding[] = [];
  const add = (rule: string, path: string, message: string) =>
    findings.push({ rule, path, message });
  if (!source.replace(/\r\n/g, "\n").trim()) {
    add("empty-render", "$", "helm template produced no YAML");
    return { ok: false, findings, kinds: [], documents: 0 };
  }
  const kinds: string[] = [];
  let documents = 0;
  parseAllDocuments(source, { prettyErrors: true }).forEach((doc, i) => {
    const path = `doc[${i}]`;
    for (const err of doc.errors) add("yaml", path, err.message);
    if (doc.errors.length) return;
    const json: unknown = doc.toJSON();
    if (json == null) return;
    documents += 1;
    const rec = asRecord(json);
    if (!rec) {
      add("mapping", path, "document must be a mapping with apiVersion and kind");
      return;
    }
    smokeDocument(rec, path, kinds, add);
  });
  for (const kind of REQUIRED_KINDS) {
    if (!kinds.includes(kind)) add("missing-kind", "$", `rendered output is missing kind ${kind}`);
  }
  return { ok: findings.length === 0, findings, kinds, documents };
}

export function dockerfileCopySources(dockerfile: string): string[] {
  return splitInstructions(dockerfile).flatMap((inst) => {
    if (inst.name !== "COPY") return [];
    return inst.args
      .split(/\s+/)
      .filter((t) => t.length > 0 && !t.startsWith("--"))
      .slice(0, -1);
  });
}

export function workspaceDirsFor(
  deps: Record<string, string | undefined>,
  packages: readonly WorkspacePackage[],
): string[] {
  const byName = new Map(packages.map((p) => [p.name, p.dir]));
  return Object.entries(deps)
    .filter(([, spec]) => spec === "workspace:*")
    .flatMap(([name]) => {
      const dir = byName.get(name);
      return dir ? [dir] : [];
    })
    .sort();
}

export function missingWorkspaceCopies(
  dockerfile: string,
  requiredDirs: readonly string[],
): string[] {
  const sources = dockerfileCopySources(dockerfile);
  return requiredDirs.filter(
    (dir) => !sources.some((src) => src === dir || src.startsWith(`${dir}/`)),
  );
}

export function imageRefTag(image: string): { kind: "digest" | "tag" | "none"; value: string } {
  const trimmed = image.trim();
  const at = trimmed.lastIndexOf("@");
  if (at !== -1) return { kind: "digest", value: trimmed.slice(at + 1) };
  const slash = trimmed.lastIndexOf("/");
  const rest = slash === -1 ? trimmed : trimmed.slice(slash + 1);
  const colon = rest.lastIndexOf(":");
  if (colon === -1) return { kind: "none", value: "" };
  return { kind: "tag", value: rest.slice(colon + 1) };
}

function smokeDocument(
  rec: Record<string, unknown>,
  path: string,
  kinds: string[],
  add: (rule: string, path: string, message: string) => void,
): void {
  const kind = str(rec.kind);
  if (!str(rec.apiVersion)) add("apiVersion", path, "apiVersion is missing");
  if (!kind) add("kind", path, "kind is missing");
  else kinds.push(kind);
  const name = str(asRecord(rec.metadata)?.name);
  if (!name) add("name", `${path}.metadata`, "metadata.name is missing");
  else if (name.length > 63 || !DNS1123.test(name)) {
    add("dns-1123", `${path}.metadata.name`, `${name} is not a DNS-1123 label`);
  }
  if (kind !== "Deployment") return;

  const match = stringMap(get(rec, "spec.selector.matchLabels"));
  const labels = stringMap(get(rec, "spec.template.metadata.labels"));
  if (!match || Object.keys(match).length === 0) {
    add("selector", `${path}.spec.selector`, "matchLabels is missing");
  } else if (!labels) {
    add("selector", `${path}.spec.selector`, "pod template labels are missing");
  } else {
    for (const [key, value] of Object.entries(match)) {
      if (labels[key] !== value) {
        add(
          "selector",
          `${path}.spec.selector`,
          `selector ${key}=${value} is not on the pod template`,
        );
      }
    }
  }

  const sc = asRecord(get(rec, "spec.template.spec.securityContext"));
  if (sc && sc.runAsNonRoot === true && (sc.runAsUser === 0 || sc.runAsUser === "0")) {
    add(
      "run-as-root",
      `${path}.spec.template.spec.securityContext`,
      "runAsNonRoot is set with uid 0",
    );
  }

  const list = get(rec, "spec.template.spec.containers");
  const boxes = Array.isArray(list)
    ? list.flatMap((item) => {
        const box = asRecord(item);
        return box ? [box] : [];
      })
    : [];
  if (boxes.length === 0)
    add("containers", `${path}.spec.template.spec`, "Deployment has no containers");
  boxes.forEach((box, j) => {
    const cpath = `${path}.spec.template.spec.containers[${j}]`;
    const image = str(box.image);
    if (!image) add("image-tag", `${cpath}.image`, "container image is missing");
    else {
      const pin = imageRefTag(image);
      if (pin.kind === "none" || (pin.kind === "tag" && pin.value === "latest")) {
        add("image-tag", `${cpath}.image`, `${image} is not pinned`);
      }
    }
    if (
      !str(get(box.livenessProbe, "httpGet.path")) &&
      !str(get(box.readinessProbe, "httpGet.path"))
    ) {
      add("probe", cpath, "container has neither livenessProbe nor readinessProbe");
    }
  });
}

function get(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    const rec = asRecord(cur);
    if (!rec) return undefined;
    cur = rec[key];
  }
  return cur;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function stringMap(v: unknown): Record<string, string> | undefined {
  const rec = asRecord(v);
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(rec)) {
    if (typeof value !== "string") return undefined;
    out[key] = value;
  }
  return out;
}

if (typeof process.argv[1] === "string" && process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: ci-gates <rendered.yaml>...");
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    const result = smokeHelmTemplate(readFileSync(file, "utf8"));
    if (result.ok) console.log(`ok ${file} (${result.documents} docs)`);
    else {
      failed = true;
      for (const f of result.findings) console.error(`${file}: ${f.rule}: ${f.path}: ${f.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
