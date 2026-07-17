import { createOpenAI } from "@ai-sdk/openai";
import { MockLLMProvider, type LLMProvider } from "@agent/core";
import { AiSdkLLMProvider } from "./ai-sdk-provider";

export interface LLMConfig {
  apiKey?: string;
  model?: string;
  system?: string;
}

const DEFAULT_MODEL = "gpt-4o-mini";

// Key-gated: a real key wires up the AI SDK, otherwise fall back to the mock so
// tests and local dev run without credentials.
export function createLLMProvider(config: LLMConfig = {}): LLMProvider {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return new MockLLMProvider();

  const openai = createOpenAI({ apiKey });
  return new AiSdkLLMProvider({
    model: openai(config.model ?? DEFAULT_MODEL),
    system: config.system,
  });
}
