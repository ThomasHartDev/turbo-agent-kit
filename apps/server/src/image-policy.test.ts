import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateImagePolicy,
  groupStages,
  isIgnored,
  isRootUser,
  parseDockerignore,
  parseEnvArgs,
  parseFrom,
  splitInstructions,
} from "./image-policy";

const here = dirname(fileURLToPath(import.meta.url));

describe("splitInstructions / stages", () => {
  it("skips empty, comment-only, and CRLF input", () => {
    expect(splitInstructions("")).toEqual([]);
    expect(splitInstructions("\n# only a comment\n\n")).toEqual([]);
    expect(splitInstructions("\r\n# win\r\n")).toEqual([]);
  });

  it("joins backslash continuations and parses FROM flags", () => {
    const [run] = splitInstructions("RUN echo a \\\n    && echo b\nUSER agent\n");
    expect(run).toMatchObject({ name: "RUN", args: "echo a && echo b", line: 1 });
    expect(splitInstructions("user agent")[0]).toMatchObject({ name: "USER", args: "agent" });
    const ast = groupStages(
      splitInstructions(
        "ARG NODE=22\nFROM --platform=linux/amd64 node:22 AS build\nRUN make\nFROM node:22 AS runtime\n",
      ),
    );
    expect(ast.prelude).toHaveLength(1);
    expect(ast.stages.map((s) => s.name)).toEqual(["build", "runtime"]);
    expect(parseFrom(ast.stages[0]!.from.args).platform).toBe("linux/amd64");
    expect(ast.stages[0]!.instructions[0]).toMatchObject({ name: "RUN", args: "make" });
  });
});

describe("evaluateImagePolicy", () => {
  it("fails a single-stage root image with ADD, no probe, and a baked secret", () => {
    const result = evaluateImagePolicy(`
FROM node:22
ADD https://example.com/app.tgz /app
ENV OPENAI_API_KEY=sk-test
ARG REDIS_PASSWORD=secret
USER root
HEALTHCHECK NONE
`);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.rule).sort()).toEqual([
      "has-cmd",
      "healthcheck",
      "multi-stage",
      "no-add",
      "no-secret-env",
      "no-secret-env",
      "non-root",
    ]);
  });

  it("classifies root vs agent and last-wins USER/HEALTHCHECK", () => {
    expect(isRootUser("0")).toBe(true);
    expect(isRootUser("0:0")).toBe(true);
    expect(isRootUser("root:root")).toBe(true);
    expect(isRootUser("")).toBe(true);
    expect(isRootUser("agent")).toBe(false);
    expect(isRootUser("agent:agent")).toBe(false);
    expect(isRootUser("1001")).toBe(false);
    const missing = 'FROM a AS b\nFROM c\nCMD ["node"]\nHEALTHCHECK CMD true\n';
    expect(evaluateImagePolicy(missing).findings.some((f) => f.rule === "non-root")).toBe(true);
    expect(
      evaluateImagePolicy(
        'FROM a AS b\nFROM c\nUSER 0:0\nCMD ["node"]\nHEALTHCHECK CMD true\n',
      ).findings.some((f) => f.rule === "non-root"),
    ).toBe(true);
    const ok = evaluateImagePolicy(`
FROM node:22 AS build
RUN compile
FROM node:22-bookworm-slim AS runtime
USER root
USER agent
HEALTHCHECK NONE
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8787/healthz')"
CMD ["node","dist/index.js"]
`);
    expect(ok.findings).toEqual([]);
    expect(parseEnvArgs("PORT=8787 NODE_ENV=production")).toEqual({
      PORT: "8787",
      NODE_ENV: "production",
    });
    expect(parseEnvArgs("PORT 8787")).toEqual({ PORT: "8787" });
    expect(
      evaluateImagePolicy(
        'FROM a AS b\nFROM c\nUSER agent\nENV PORT=8787\nCMD ["node"]\nHEALTHCHECK CMD true\n',
      ).ok,
    ).toBe(true);
  });
});

describe("dockerignore", () => {
  it("matches globs, negation, and root-anchored paths", () => {
    expect(parseDockerignore("")).toEqual([]);
    expect(isIgnored("src/index.ts", [])).toBe(false);
    expect(isIgnored("", parseDockerignore("node_modules"))).toBe(false);
    const patterns = parseDockerignore("node_modules\n*.md\n!README.md\n");
    expect(isIgnored("node_modules/x", patterns)).toBe(true);
    expect(isIgnored("apps/server/node_modules/x", patterns)).toBe(true);
    expect(isIgnored("docs/guide.md", patterns)).toBe(true);
    expect(isIgnored("README.md", patterns)).toBe(false);
    const env = parseDockerignore("**/.turbo\n.env\n.env.*\n!.env.example\n");
    expect(isIgnored("apps/server/.turbo/cache", env)).toBe(true);
    expect(isIgnored(".env.local", env)).toBe(true);
    expect(isIgnored(".env.example", env)).toBe(false);
    const rootOnly = parseDockerignore("/node_modules\n");
    expect(isIgnored("node_modules/leftpad", rootOnly)).toBe(true);
    expect(isIgnored("apps/server/node_modules/leftpad", rootOnly)).toBe(false);
    expect(isIgnored("apps/server/node_modules/x", parseDockerignore("**/node_modules\n"))).toBe(
      true,
    );
  });
});

describe("apps/server image recipe", () => {
  it("satisfies the production policy and keeps secrets out of the context", () => {
    const dockerfile = readFileSync(resolve(here, "../Dockerfile"), "utf8");
    const dockerignore = readFileSync(resolve(here, "../../../.dockerignore"), "utf8");
    const result = evaluateImagePolicy(dockerfile);
    expect(result.findings).toEqual([]);
    expect(result.stages.map((s) => s.name)).toEqual(["base", "deps", "build", "runtime"]);
    const runtime = result.stages.at(-1)!;
    expect([...runtime.instructions].reverse().find((i) => i.name === "USER")?.args).toBe("agent");
    const hc = [...runtime.instructions].reverse().find((i) => i.name === "HEALTHCHECK");
    expect(hc?.args).toMatch(/\/healthz/);
    expect(hc?.args).toMatch(/127\.0\.0\.1/);
    const patterns = parseDockerignore(dockerignore);
    for (const path of [
      ".git/HEAD",
      "node_modules/x",
      "apps/server/node_modules/x",
      ".env.local",
    ]) {
      expect(isIgnored(path, patterns), path).toBe(true);
    }
    expect(isIgnored("apps/server/src/index.ts", patterns)).toBe(false);
    expect(isIgnored("pnpm-lock.yaml", patterns)).toBe(false);
  });
});
