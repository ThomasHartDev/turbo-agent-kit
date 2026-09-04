import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RELEASE,
  evalTemplate,
  evaluateChart,
  isEmpty,
  kindsIn,
  mergeValues,
  parseValues,
  renderChart,
  type HelmContext,
  type Yaml,
} from "./helm-chart";

const chartDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../deploy/helm/agent-kit");
const readme = readFileSync(resolve(chartDir, "../../../README.md"), "utf8");
const ctx = (values: Yaml = {}): HelmContext => ({
  Values: values,
  Release: DEFAULT_RELEASE,
  Chart: { Name: "agent-kit", Version: "0.1.0", AppVersion: "0.1.0" },
});
const has = (yaml: string, values: Yaml, rule: string) =>
  evaluateChart(yaml, values).findings.some((f) => f.rule === rule);

describe("helm chart", () => {
  it("parses values, pipelines, overlays, and the five Kubernetes kinds", () => {
    expect(parseValues("")).toEqual({});
    expect(parseValues("# x\na: 1\nb:\n  c: x\n")).toEqual({ a: 1, b: { c: "x" } });
    expect(
      mergeValues({ ingress: { enabled: true, host: "h" } }, { ingress: { enabled: false } }),
    ).toEqual({
      ingress: { enabled: false, host: "h" },
    });
    expect(isEmpty(0)).toBe(true);
    expect(isEmpty("x")).toBe(false);
    expect(evalTemplate("{{ .Release.Name }}", ctx())).toBe("agent");
    expect(evalTemplate('{{ .Values.missing | default "n" }}', ctx())).toBe("n");
    expect(evalTemplate("{{ if .Values.on }}Y{{ else }}N{{ end }}", ctx({ on: false }))).toBe("N");
    expect(evalTemplate('{{ printf "%s:%s" "agent-server" "local" }}', ctx())).toBe(
      "agent-server:local",
    );
    expect(
      evalTemplate(`{{ "${"x".repeat(62)}-zzzz" | trunc 63 | trimSuffix "-" }}`, ctx()).length,
    ).toBe(62);
    expect(() => evalTemplate("{{ .Values.x", ctx())).toThrow(/unclosed/);
    expect(() => evalTemplate('{{ include "nope" . }}', ctx())).toThrow(/unknown template/);
    const { yaml, values } = renderChart(chartDir);
    expect(kindsIn(yaml)).toEqual([
      "ConfigMap",
      "Service",
      "Deployment",
      "Ingress",
      "HorizontalPodAutoscaler",
    ]);
    expect(evaluateChart(yaml, values).findings).toEqual([]);
    expect(yaml).not.toMatch(/^\s+replicas:/m);
    expect(yaml).toContain("agent-agent-kit");
    expect(yaml).toContain("path: /healthz");
    expect(readme).toContain("helm template agent deploy/helm/agent-kit");
    const off = renderChart(chartDir, {
      ingress: { enabled: false },
      autoscaling: { enabled: false },
    });
    expect(kindsIn(off.yaml)).toEqual(["ConfigMap", "Service", "Deployment"]);
    expect(off.yaml).toMatch(/^\s+replicas: 2/m);
    expect(renderChart(chartDir, { ingress: { host: "api.example.com" } }).yaml).toContain(
      "api.example.com",
    );
    expect(renderChart(chartDir, { nameOverride: "server" }).yaml).toContain("name: agent-server");
  });

  it("truncates concatenated fullname to a DNS-1123 metadata.name", () => {
    const dns = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
    const { yaml, values } = renderChart(
      chartDir,
      { nameOverride: "a".repeat(60) },
      { Name: "verylongrelease", Namespace: "agent", Service: "Helm" },
    );
    const names = [...yaml.matchAll(/^metadata:\n {2}name:\s+(\S+)/gm)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(63);
      expect(dns.test(name)).toBe(true);
    }
    expect(evaluateChart(yaml, values).findings).toEqual([]);
  });

  it("strips {{- end }} left-trim from included defines", () => {
    expect(
      evalTemplate('{{ define "n" }}{{ .Chart.Name }}\n{{- end }}{{ include "n" . }}', ctx()),
    ).toBe("agent-kit");
  });

  it("fails closed on secrets, HPA bounds, DNS names, and replica ownership", () => {
    const { yaml, values } = renderChart(chartDir);
    expect(has("", values, "required-kind")).toBe(true);
    expect(has(yaml.replace("kind: Ingress", "kind: Foo"), values, "gated-kind")).toBe(true);
    expect(has(yaml.replace("LOG_LEVEL:", "OPENAI_API_KEY:"), values, "config-secret")).toBe(true);
    expect(
      has(yaml, mergeValues(values, { config: { OPENAI_API_KEY: "sk" } }), "config-secret"),
    ).toBe(true);
    expect(has(yaml.replace("maxReplicas: 8", "maxReplicas: 2"), values, "hpa-bounds")).toBe(true);
    expect(
      has(yaml, mergeValues(values, { resources: { requests: { cpu: "0m" } } }), "cpu-request"),
    ).toBe(true);
    expect(has(yaml.replaceAll("agent-agent-kit", "Agent_Server"), values, "dns-name")).toBe(true);
    expect(
      has(
        yaml.replace("spec:\n  selector:", "spec:\n  replicas: 2\n  selector:"),
        values,
        "replicas-vs-hpa",
      ),
    ).toBe(true);
    const off = renderChart(chartDir, { autoscaling: { enabled: false } });
    expect(has(off.yaml.replace(/^\s+replicas: 2\n/m, ""), off.values, "replicas-vs-hpa")).toBe(
      true,
    );
  });
});
