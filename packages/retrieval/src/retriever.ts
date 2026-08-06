import { chunkDocument } from "./chunk";
import type {
  ChunkOptions,
  Document,
  EmbeddedChunk,
  Embedder,
  SearchHit,
  SearchOptions,
} from "./types";
import { InMemoryVectorStore } from "./vector-store";

const DEFAULT_CHUNK: ChunkOptions = { size: 400, overlap: 60 };

export interface RetrieverOptions {
  embedder: Embedder;
  chunk?: ChunkOptions;
}

// Ingest → chunk → embed → index. Query embeds the same way and returns top-k cosine hits.
export class Retriever {
  private readonly embedder: Embedder;
  private readonly chunkOptions: ChunkOptions;
  private readonly store: InMemoryVectorStore;

  constructor(options: RetrieverOptions) {
    this.embedder = options.embedder;
    this.chunkOptions = options.chunk ?? DEFAULT_CHUNK;
    this.store = new InMemoryVectorStore(options.embedder.dimensions);
  }

  get size(): number {
    return this.store.size;
  }

  async ingest(docs: Document[]): Promise<number> {
    if (docs.length === 0) return 0;
    const chunks = docs.flatMap((doc) => chunkDocument(doc, this.chunkOptions));
    if (chunks.length === 0) return 0;

    const vectors = await this.embedder.embed(chunks.map((c) => c.text));
    if (vectors.length !== chunks.length) {
      throw new Error(`embedder returned ${vectors.length} vectors for ${chunks.length} chunks`);
    }

    const embedded: EmbeddedChunk[] = chunks.map((chunk, i) => ({
      ...chunk,
      vector: vectors[i]!,
    }));
    this.store.add(embedded);
    return embedded.length;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    if (query.trim().length === 0) return [];
    const [qvec] = await this.embedder.embed([query]);
    return this.store.search(qvec!, { topK: options.topK, minScore: options.minScore });
  }

  clear(): void {
    this.store.clear();
  }
}

export function formatContext(hits: SearchHit[], maxChars = 2000): string {
  if (hits.length === 0) return "";
  const parts: string[] = [];
  let used = 0;
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const block = `[${i + 1}] (score=${hit.score.toFixed(3)}, doc=${hit.chunk.documentId})\n${hit.chunk.text}`;
    if (used + block.length > maxChars && parts.length > 0) break;
    parts.push(block);
    used += block.length + 2;
  }
  return parts.join("\n\n");
}
