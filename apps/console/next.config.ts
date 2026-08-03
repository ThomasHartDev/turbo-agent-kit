import type { NextConfig } from "next";

// Browser hits same-origin /api/*; Next rewrites to the Hono server so we never
// need CORS on the agent process during local console work.
const agentOrigin = process.env.AGENT_URL ?? "http://localhost:8787";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/agent/turn", destination: `${agentOrigin}/agent/turn` },
      { source: "/api/agent/telemetry", destination: `${agentOrigin}/telemetry` },
      { source: "/api/agent/healthz", destination: `${agentOrigin}/healthz` },
    ];
  },
};

export default nextConfig;
