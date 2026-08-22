import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HEALTHZ,
  cpuMillis,
  evaluateTraffic,
  parseYamlDocs,
  probeDetectionSeconds,
  probeTiming,
  rec,
  type Doc,
  type Yaml,
} from "./k8s-traffic";

const APP = "app.kubernetes.io/name";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const yamlSrc = readFileSync(resolve(root, "deploy/k8s/traffic.yaml"), "utf8");
const readme = readFileSync(resolve(root, "README.md"), "utf8");
const chart = () => parseYamlDocs(yamlSrc);

function find(docs: Doc[], kind: string): Doc {
  return docs.find((d) => d.kind === kind)!;
}
function ctr(d: Doc) {
  const pod = rec(rec(d.spec)?.template)?.spec as Doc;
  return rec((pod.containers as Yaml[])[0])!;
}
function pathOf(d: Doc[]): Doc {
  const rule = rec((rec(find(d, "Ingress").spec)!.rules as Yaml[])[0])!;
  return rec((rec(rule.http)!.paths as Yaml[])[0])!;
}

describe("parseYamlDocs", () => {
  it("splits documents, nests maps/lists, and types scalars", () => {
    const docs = parseYamlDocs(`
kind: Deployment
spec:
  containers:
    - name: server
      resources:
        requests:
          cpu: 100m
      livenessProbe:
        httpGet:
          path: /healthz
          port: http
        periodSeconds: 20
        timeoutSeconds: 3
        failureThreshold: 3
---
kind: HorizontalPodAutoscaler
spec:
  minReplicas: 2
  maxReplicas: 8
  metrics:
    - type: Resource
      resource:
        target:
          averageUtilization: 70
`);
    expect(docs.map((d) => d.kind)).toEqual(["Deployment", "HorizontalPodAutoscaler"]);
    const c = rec((rec(docs[0]!.spec)!.containers as Yaml[])[0])!;
    const live = rec(c.livenessProbe)!;
    expect(rec(live.httpGet)).toEqual({ path: "/healthz", port: "http" });
    expect(rec(rec(c.resources)?.requests)?.cpu).toBe("100m");
    expect(live.periodSeconds).toBe(20);
    expect(live.timeoutSeconds).toBe(3);
    expect(live.failureThreshold).toBe(3);
    const hpa = rec(docs[1]!.spec)!;
    expect(hpa.minReplicas).toBe(2);
    expect(hpa.maxReplicas).toBe(8);
    const util = rec(rec(rec((hpa.metrics as Yaml[])[0])?.resource)?.target)?.averageUtilization;
    expect(util).toBe(70);
    expect(typeof live.periodSeconds).toBe("number");
    expect(typeof util).toBe("number");
  });
});

describe("k8s traffic", () => {
  it("evaluates the committed chart and probe/cpu helpers", () => {
    const parsed = chart();
    expect(parsed.map((d) => d.kind)).toEqual([
      "Deployment",
      "Service",
      "Ingress",
      "HorizontalPodAutoscaler",
    ]);
    expect(evaluateTraffic(parsed).findings).toEqual([]);
    const live = rec(ctr(find(parsed, "Deployment")).livenessProbe)!;
    expect(rec(live.httpGet)?.path).toBe(HEALTHZ);
    expect(live.periodSeconds).toBe(20);
    expect(typeof live.periodSeconds).toBe("number");
    expect(readme).toContain("kubectl apply -f deploy/k8s/traffic.yaml");
    expect(cpuMillis(undefined)).toBeNaN();
    expect(cpuMillis("")).toBeNaN();
    expect(cpuMillis("0m")).toBe(0);
    expect(cpuMillis("100m")).toBe(100);
    expect(cpuMillis("1")).toBe(1000);
    expect(cpuMillis(0.5)).toBe(500);
    expect(probeDetectionSeconds(probeTiming({ periodSeconds: 5, failureThreshold: 2 })!)).toBe(10);
    expect(probeDetectionSeconds(probeTiming({ periodSeconds: 20, failureThreshold: 3 })!)).toBe(
      60,
    );
    expect(probeDetectionSeconds(probeTiming({ periodSeconds: "5", failureThreshold: "2" })!)).toBe(
      10,
    );
    expect(probeTiming(undefined)).toBeUndefined();
  });

  it("fails closed on missing kinds and drifted invariants", () => {
    expect(evaluateTraffic([]).findings.every((f) => f.rule === "required-kind")).toBe(true);
    expect(
      evaluateTraffic(
        parseYamlDocs(yamlSrc.replaceAll("path: /healthz", "path: /ready")),
      ).findings.some((f) => f.rule === "probes"),
    ).toBe(true);
    const dep = (d: Doc[]) => find(d, "Deployment");
    const hpa = (d: Doc[]) => rec(find(d, "HorizontalPodAutoscaler").spec)!;
    const cases: [string, (d: Doc[]) => void][] = [
      ["selector", (d) => ((rec(rec(dep(d).spec)?.selector)?.matchLabels as Doc)[APP] = "x")],
      ["service-selector", (d) => ((rec(find(d, "Service").spec)?.selector as Doc)[APP] = "x")],
      ["namespace", (d) => (rec(dep(d).metadata)!.namespace = "default")],
      ["probes", (d) => delete ctr(dep(d)).livenessProbe],
      [
        "probes",
        (d) => (rec(ctr(dep(d)).livenessProbe)!.httpGet = { path: "/ready", port: "http" }),
      ],
      ["probes", (d) => (rec(ctr(dep(d)).livenessProbe)!.timeoutSeconds = 20)],
      ["probe-window", (d) => (rec(ctr(dep(d)).readinessProbe)!.periodSeconds = 30)],
      ["cpu-request", (d) => ((rec(rec(ctr(dep(d)).resources)?.requests) as Doc).cpu = "0m")],
      ["ingress-class", (d) => (rec(find(d, "Ingress").spec)!.ingressClassName = "traefik")],
      ["ingress-path", (d) => (pathOf(d).pathType = "ImplementationSpecific")],
      ["ingress-backend", (d) => (rec(rec(pathOf(d).backend)?.service)!.name = "ghost")],
      ["hpa-target", (d) => (rec(hpa(d).scaleTargetRef)!.kind = "Service")],
      ["hpa-bounds", (d) => (hpa(d).maxReplicas = 2)],
      ["hpa-metric", (d) => (hpa(d).metrics = [])],
    ];
    for (const [rule, fn] of cases) {
      const d = structuredClone(chart());
      fn(d);
      expect(
        evaluateTraffic(d).findings.some((f) => f.rule === rule),
        rule,
      ).toBe(true);
    }
  });
});
