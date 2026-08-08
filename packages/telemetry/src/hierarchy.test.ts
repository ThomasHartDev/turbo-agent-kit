import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { MockLLMProvider, InMemoryConversationStore, runAgentTurn } from "@agent/core";
import { initTracing, resetTracingForTests } from "./init";
import { SpanTelemetry } from "./span-telemetry";
import { withAgentTurn } from "./with-turn";

let exporter: InMemorySpanExporter;

beforeAll(async () => {
  await resetTracingForTests();
  exporter = new InMemorySpanExporter();
  initTracing({
    serviceName: "hierarchy-test",
    otlpEndpoint: null,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
});

beforeEach(() => exporter.reset());
afterAll(async () => resetTracingForTests());

function byName(spans: ReadableSpan[], name: string) {
  return spans.filter((s) => s.name === name);
}

function childOf(spans: ReadableSpan[], parent: ReadableSpan) {
  const parentId = parent.spanContext().spanId;
  return spans.filter((s) => {
    const viaContext = s.parentSpanContext?.spanId;
    const viaId = (s as ReadableSpan & { parentSpanId?: string }).parentSpanId;
    return viaContext === parentId || viaId === parentId;
  });
}

describe("server → llm → tool span hierarchy", () => {
  it("nests llm and tool under agent.turn for a tool-using prompt", async () => {
    const store = new InMemoryConversationStore();
    const convo = store.create("chat");
    const telemetry = new SpanTelemetry();

    await withAgentTurn(
      {
        conversationId: convo.id,
        channel: "chat",
        requestId: "req-1",
        messageLength: 20,
      },
      () => runAgentTurn(convo, "book an appointment", new MockLLMProvider(), telemetry),
    );

    const spans = exporter.getFinishedSpans();
    const turn = byName(spans, "agent.turn")[0]!;
    expect(turn).toBeDefined();
    expect(turn.attributes["agent.conversation_id"]).toBe(convo.id);
    expect(turn.attributes["agent.request_id"]).toBe("req-1");

    const children = childOf(spans, turn);
    const llmSpans = children.filter((s) => s.name === "agent.llm");
    const toolSpans = children.filter((s) => s.name === "agent.tool");
    expect(llmSpans.length).toBeGreaterThanOrEqual(1);
    expect(toolSpans).toHaveLength(1);
    expect(toolSpans[0]!.attributes["agent.detail"]).toBe("bookAppointment");
    expect(toolSpans[0]!.spanContext().traceId).toBe(turn.spanContext().traceId);
    expect(telemetry.all().some((e) => e.type === "tool")).toBe(true);
  });

  it("emits only llm children when no tool is called", async () => {
    const store = new InMemoryConversationStore();
    const convo = store.create("sms");
    const telemetry = new SpanTelemetry();

    await withAgentTurn({ conversationId: convo.id, channel: "sms" }, () =>
      runAgentTurn(convo, "hello there", new MockLLMProvider(), telemetry),
    );

    const spans = exporter.getFinishedSpans();
    const turn = byName(spans, "agent.turn")[0]!;
    const children = childOf(spans, turn);
    expect(children.every((s) => s.name === "agent.llm")).toBe(true);
    expect(byName(spans, "agent.tool")).toHaveLength(0);
  });

  it("marks error status on failed turns and clamps bad durations", async () => {
    await expect(
      withAgentTurn({ conversationId: "c-fail" }, async () => {
        throw new Error("provider down");
      }),
    ).rejects.toThrow("provider down");

    const turns = byName(exporter.getFinishedSpans(), "agent.turn");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.status.code).toBe(SpanStatusCode.ERROR);

    exporter.reset();
    const telemetry = new SpanTelemetry();
    telemetry.record({ type: "llm", channel: "voice", ms: Number.NaN, detail: "final" });
    telemetry.record({ type: "llm", channel: "voice", ms: -5, detail: "final" });
    expect(telemetry.all().every((e) => e.ms === 0)).toBe(true);
    expect(byName(exporter.getFinishedSpans(), "agent.llm")).toHaveLength(2);
  });
});
