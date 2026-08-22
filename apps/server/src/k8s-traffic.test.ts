import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HEALTHZ,
  INGRESS_CLASS,
  REQUIRED,
  cpuMillis,
  evaluateTraffic,
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

function probe(delay: number, period: number, timeout: number, fail: number): Doc {
  return {
    httpGet: { path: HEALTHZ, port: "http" },
    initialDelaySeconds: delay,
    periodSeconds: period,
    timeoutSeconds: timeout,
    failureThreshold: fail,
  };
}

const meta = { name: "server", namespace: "agent" };
const labels = { [APP]: "server" };
const backend = { service: { name: "server", port: { name: "http" } } };

function traffic(): Doc[] {
  return [
    {
      kind: "Deployment",
      metadata: { ...meta },
      spec: {
        replicas: 2,
        selector: { matchLabels: { ...labels } },
        template: {
          metadata: { labels: { ...labels } },
          spec: {
            terminationGracePeriodSeconds: 30,
            containers: [
              {
                name: "server",
                image: "agent-server:local",
                ports: [{ name: "http", containerPort: 8787 }],
                resources: { requests: { cpu: "100m" } },
                livenessProbe: probe(15, 20, 3, 3),
                readinessProbe: probe(3, 5, 2, 2),
              },
            ],
          },
        },
      },
    },
    {
      kind: "Service",
      metadata: { ...meta },
      spec: { selector: labels, ports: [{ name: "http", port: 8787, targetPort: "http" }] },
    },
    {
      kind: "Ingress",
      metadata: { ...meta },
      spec: {
        ingressClassName: INGRESS_CLASS,
        rules: [
          { host: "agent.local", http: { paths: [{ path: "/", pathType: "Prefix", backend }] } },
        ],
      },
    },
    {
      kind: "HorizontalPodAutoscaler",
      metadata: { ...meta },
      spec: {
        scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "server" },
        minReplicas: 2,
        maxReplicas: 8,
        metrics: [
          {
            type: "Resource",
            resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } },
          },
        ],
      },
    },
  ];
}

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

describe("k8s traffic", () => {
  it("locks committed YAML, probe windows, and cpu millicores", () => {
    expect(evaluateTraffic(traffic()).findings).toEqual([]);
    for (const req of REQUIRED) expect(yamlSrc).toContain(`kind: ${req.kind}`);
    expect(yamlSrc).toContain(`path: ${HEALTHZ}`);
    expect(yamlSrc).toContain("cpu: 100m");
    expect(yamlSrc).toContain("averageUtilization: 70");
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
    expect(probeTiming(undefined)).toBeUndefined();
  });

  it("fails closed on missing kinds and drifted invariants", () => {
    expect(evaluateTraffic([]).findings.every((f) => f.rule === "required-kind")).toBe(true);
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
      const d = structuredClone(traffic());
      fn(d);
      expect(
        evaluateTraffic(d).findings.some((f) => f.rule === rule),
        rule,
      ).toBe(true);
    }
  });
});
