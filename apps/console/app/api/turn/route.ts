const AGENT_URL = process.env.AGENT_URL ?? "http://127.0.0.1:8787";

export async function POST(req: Request) {
  const body = await req.text();
  const upstream = await fetch(`${AGENT_URL.replace(/\/$/, "")}/agent/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
    },
  });
}
