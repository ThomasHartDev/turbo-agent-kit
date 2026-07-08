import { MockLLMProvider } from "./llm-provider";
import { runAgentTurn } from "./orchestrator";
import { InMemoryConversationStore } from "./store";
import { Telemetry } from "./telemetry";

const llm = new MockLLMProvider();
const telemetry = new Telemetry();
const store = new InMemoryConversationStore();
const convo = store.create("sms");

const prompts = ["what are your hours?", "ok, book an appointment"];

for (const prompt of prompts) {
  console.log(`\n=== USER (${convo.channel}): ${prompt} ===`);
  await runAgentTurn(convo, prompt, llm, telemetry, {
    onMessage: (m) => {
      if (m.role === "user") return;
      console.log(`  [${m.role}] ${m.content}`);
    },
  });
}

console.log("\n--- telemetry ---");
console.log(`LLM  p50/p95/p99: ${telemetry.percentile(50, "llm")}/${telemetry.percentile(95, "llm")}/${telemetry.percentile(99, "llm")}ms`);
console.log(`Tool p50/p95/p99: ${telemetry.percentile(50, "tool")}/${telemetry.percentile(95, "tool")}/${telemetry.percentile(99, "tool")}ms`);
console.log(`events:   ${telemetry.all().length}`);
for (const e of telemetry.all()) {
  console.log(`  [${e.type}] ${e.detail} - ${Math.round(e.ms)}ms`);
}
