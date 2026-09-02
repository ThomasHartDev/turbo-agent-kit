# Architecture

The kit is a directed acyclic graph. `workspace:*` edges are solid. HTTP, Redis, and the collector are dashed runtime edges. Packages may depend only on other packages. Apps depend on packages. Infra has no outbound edges.

```mermaid
flowchart TB
  subgraph packages["packages"]
    n__agent_config["@agent/config"]
    n__agent_core["@agent/core"]
    n__agent_llm["@agent/llm"]
    n__agent_rate_limiter["@agent/rate-limiter"]
    n__agent_retrieval["@agent/retrieval"]
    n__agent_store_redis["@agent/store-redis"]
    n__agent_telemetry["@agent/telemetry"]
  end
  subgraph apps["apps"]
    n__agent_console["@agent/console"]
    n__agent_server["@agent/server"]
  end
  subgraph infra["infra"]
    n_otel_collector["otel-collector"]
    n_redis["redis"]
  end
  n__agent_console -.-> n__agent_server
  n__agent_llm --> n__agent_core
  n__agent_server --> n__agent_core
  n__agent_server --> n__agent_llm
  n__agent_server --> n__agent_rate_limiter
  n__agent_server --> n__agent_telemetry
  n__agent_server -.-> n_otel_collector
  n__agent_server -.-> n_redis
  n__agent_store_redis --> n__agent_core
  n__agent_store_redis --> n__agent_rate_limiter
  n__agent_telemetry --> n__agent_core
```

`@agent/config` loads this graph from the workspace package.json files, then overlays the three runtime edges. `topoSort` is Kahn with an alphabetical ready queue. A three-color DFS reports a cycle as a closed path. Compose vs Helm: [runbook.md](./runbook.md). Why one repo: [why-a-monorepo.md](./why-a-monorepo.md).
