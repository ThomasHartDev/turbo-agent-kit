import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Browser hits same-origin /api/agent/*; Next rewrites to the Hono server so we
// never need CORS on the agent process during local console work.
const agentOrigin = process.env.AGENT_URL ?? "http://localhost:8787";
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  outputFileTracingRoot: repoRoot,
  async rewrites() {
    return [
      { source: "/api/agent/turn", destination: `${agentOrigin}/agent/turn` },
      { source: "/api/agent/telemetry", destination: `${agentOrigin}/telemetry` },
      { source: "/api/agent/healthz", destination: `${agentOrigin}/healthz` },
    ];
  },
};

export default nextConfig;
