# @agent/core

Framework-free agent loop: provider interface, Zod tool registry, session store, telemetry. A turn is the regular language `user (llm tool_call tool_result)* llm final`, or budget exhaustion. The mermaid below is `toMermaid(AGENT_LOOP_DIAGRAM)`; tests lock the fence to that string and check activation-stack well-formedness.

## Agent loop

```mermaid
sequenceDiagram
  participant User as User
  participant Agent as runAgentTurn
  participant LLM as LLMProvider
  participant Tools as Tool registry
  participant Tel as Telemetry
  User->>Agent: user text
  loop step < maxSteps
    Agent->>LLM: complete(history, specs)
    activate LLM
    LLM-->>Agent: final or tool_call
    deactivate LLM
    Agent-)Tel: record llm span
    alt final
      Agent->>User: assistant answer
      break
      end
    else tool_call
      Agent->>Tools: run(name, args)
      activate Tools
      Tools-->>Agent: output / unknown / error
      deactivate Tools
      Agent-)Tel: record tool span
      Note over Agent: append tool message; next step
    end
  end
  opt no final
    Agent->>User: give-up if no final
  end
```

`runAgentTurn` appends the user message, then up to `MAX_STEPS` provider calls. Unknown tools and throws become tool text. Exhausting the budget emits `TURN_BUDGET_MESSAGE`.

## Tests

```
pnpm --filter @agent/core test
```
