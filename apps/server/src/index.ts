import { serve } from "@hono/node-server";
import { createLLMProvider } from "@agent/llm";
import { createApp } from "./create-app";

export { createApp } from "./create-app";
export type { AppDeps } from "./create-app";
export { rateLimitMiddleware } from "./rate-limit";

const port = Number(process.env.PORT ?? 8787);

// Only start a listener when this file is the process entrypoint.
const isMain =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("/src/index.ts") || process.argv[1].endsWith("/dist/index.js"));

if (isMain) {
  const app = createApp({ llm: createLLMProvider() });
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`@agent/server listening on http://localhost:${info.port}`);
  });
}
