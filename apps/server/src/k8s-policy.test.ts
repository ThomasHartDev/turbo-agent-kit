import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REDIS_FS_GROUP,
  REQUIRED,
  SERVER_IMAGE,
  SERVER_IMAGE_PULL_POLICY,
  evaluateCluster,
  parseYamlDocuments,
  rec,
  type Yaml,
} from "./k8s-policy";

type Doc = Record<string, Yaml>;
const APP = "app.kubernetes.io/name";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const file = resolve(root, "deploy/k8s/base.yaml");
const readme = readFileSync(resolve(root, "README.md"), "utf8");
const load = () => parseYamlDocuments(readFileSync(file, "utf8"));

function find(docs: Doc[], kind: string, name?: string): Doc {
  return docs.find(
    (d) => d.kind === kind && (name === undefined || rec(d.metadata)?.name === name),
  )!;
}
function spec(d: Doc) {
  return rec(rec(d.spec)?.template)?.spec as Doc;
}
function ctr(d: Doc) {
  return rec((spec(d).containers as Yaml[])[0])!;
}

describe("k8s base", () => {
  const base = load();

  it("parses YAML edge cases and the committed manifests", () => {
    expect(parseYamlDocuments("")).toEqual([]);
    expect(parseYamlDocuments("# x\n---\n")).toEqual([]);
    expect(() => parseYamlDocuments("kind:\tPod")).toThrow(/tab/);
    expect(() => parseYamlDocuments("kind: X\n   extra: 1\n")).toThrow(/indent/);
    const [doc] = parseYamlDocuments(
      'kind: X\nmetadata:\n  labels:\n    app.kubernetes.io/name: s\nargs: ["--appendonly", "yes"]\nmodes: [ReadWriteOnce]\nPORT: "8787"\n',
    );
    expect(rec(rec(doc?.metadata)?.labels)?.[APP]).toBe("s");
    expect(doc?.args).toEqual(["--appendonly", "yes"]);
    expect(doc?.modes).toEqual(["ReadWriteOnce"]);
    expect(doc?.PORT).toBe("8787");
    expect(evaluateCluster(base).findings).toEqual([]);
    for (const req of REQUIRED) expect(find(base, req.kind, req.name).kind).toBe(req.kind);
    expect(rec(find(base, "Service", "redis").spec)?.clusterIP).toBe("None");
    expect(rec(find(base, "StatefulSet").spec)?.serviceName).toBe("redis");
    expect(rec(spec(find(base, "StatefulSet")).securityContext)?.fsGroup).toBe(REDIS_FS_GROUP);
    expect(ctr(find(base, "Deployment")).image).toBe(SERVER_IMAGE);
    expect(ctr(find(base, "Deployment")).imagePullPolicy).toBe(SERVER_IMAGE_PULL_POLICY);
    expect(readme).toContain(`-t ${SERVER_IMAGE}`);
    expect(readme).toContain(`kind load docker-image ${SERVER_IMAGE}`);
    expect(readme).toContain(`minikube image load ${SERVER_IMAGE}`);
    expect(readme).toContain(`imagePullPolicy: ${SERVER_IMAGE_PULL_POLICY}`);
  });

  it("fails closed on missing kinds and drifted invariants", () => {
    expect(evaluateCluster([]).findings.every((f) => f.rule === "required-kind")).toBe(true);
    const dep = (d: Doc[]) => find(d, "Deployment");
    const cases: [string, (d: Doc[]) => void][] = [
      ["selector", (d) => ((rec(rec(dep(d).spec)?.selector)?.matchLabels as Doc)[APP] = "x")],
      [
        "service-selector",
        (d) => ((rec(find(d, "Service", "server").spec)?.selector as Doc)[APP] = "x"),
      ],
      ["headless", (d) => (rec(find(d, "Service", "redis").spec)!.clusterIP = "10.0.0.1")],
      ["stateful-identity", (d) => (rec(find(d, "StatefulSet").spec)!.serviceName = "ghost")],
      ["pvc", (d) => (rec(find(d, "StatefulSet").spec)!.volumeClaimTemplates = [])],
      ["fs-group", (d) => delete rec(spec(find(d, "StatefulSet")).securityContext)!.fsGroup],
      ["fs-group", (d) => (rec(spec(find(d, "StatefulSet")).securityContext)!.fsGroup = 0)],
      ["image", (d) => (ctr(dep(d)).image = "agent-server:latest")],
      ["image", (d) => delete ctr(dep(d)).imagePullPolicy],
      ["non-root", (d) => (rec(spec(dep(d)).securityContext)!.runAsUser = 0)],
      ["probes", (d) => delete ctr(dep(d)).livenessProbe],
      ["namespace", (d) => (rec(dep(d).metadata)!.namespace = "default")],
      ["config-vs-secret", (d) => (rec(find(d, "ConfigMap").data)!.OPENAI_API_KEY = "sk")],
      ["config-string", (d) => (rec(find(d, "ConfigMap").data)!.PORT = 8787)],
      ["secret-ref", (d) => (ctr(dep(d)).env = [{ name: "OPENAI_API_KEY", value: "sk" }])],
    ];
    for (const [rule, fn] of cases) {
      const d = structuredClone(base);
      fn(d);
      expect(
        evaluateCluster(d).findings.some((f) => f.rule === rule),
        rule,
      ).toBe(true);
    }
    const docs = structuredClone(base);
    rec(ctr(dep(docs)).livenessProbe)!.httpGet = { path: "/ready", port: "http" };
    expect(evaluateCluster(docs).findings.some((f) => f.rule === "probes")).toBe(true);
  });
});
