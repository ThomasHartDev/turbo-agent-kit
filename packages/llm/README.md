# @agent/llm

Key-gated Vercel AI SDK adapter. `createLLMProvider` returns `AiSdkLLMProvider` when `OPENAI_API_KEY` (or `apiKey`) is set, otherwise `MockLLMProvider` so CI never needs credentials.

```ts
import { createLLMProvider } from "@agent/llm";
const llm = createLLMProvider();
```

## Tests

```
pnpm --filter @agent/llm test
```
