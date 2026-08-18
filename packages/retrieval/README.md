# @agent/retrieval

In-process RAG: recursive split with overlap, `Embedder` port, in-memory cosine top-k. `ingest` is chunk → embed → index. Overlap must be less than chunk size; a wrong vector count fails closed.

```ts
import { Retriever, HashingEmbedder } from "@agent/retrieval";
const retriever = new Retriever({ embedder: new HashingEmbedder({ dimensions: 64 }) });
await retriever.ingest([{ id: "doc-1", text: "Hours are 9 to 5." }]);
```

## Tests

```
pnpm --filter @agent/retrieval test
```
