import { cosineSimilarity } from "./embed";
import { assertPositiveInt, type EmbeddedChunk, type SearchHit } from "./types";

export interface VectorSearchOptions {
  topK?: number;
  minScore?: number;
}

export class InMemoryVectorStore {
  private readonly items: EmbeddedChunk[] = [];
  private readonly dimensions: number;

  constructor(dimensions: number) {
    assertPositiveInt("dimensions", dimensions);
    this.dimensions = dimensions;
  }

  get size(): number {
    return this.items.length;
  }

  add(chunks: EmbeddedChunk[]): void {
    for (const chunk of chunks) {
      if (chunk.vector.length !== this.dimensions) {
        throw new RangeError(
          `chunk ${chunk.id} has dim ${chunk.vector.length}, store expects ${this.dimensions}`,
        );
      }
      this.items.push(chunk);
    }
  }

  search(query: number[], options: VectorSearchOptions = {}): SearchHit[] {
    const topK = options.topK ?? 5;
    assertPositiveInt("topK", topK);
    const minScore = options.minScore ?? Number.NEGATIVE_INFINITY;
    if (query.length !== this.dimensions) {
      throw new RangeError(`query dim ${query.length} does not match store dim ${this.dimensions}`);
    }
    if (this.items.length === 0) return [];

    const hits: SearchHit[] = [];
    for (const chunk of this.items) {
      const score = cosineSimilarity(query, chunk.vector);
      if (score >= minScore) hits.push({ chunk, score });
    }
    hits.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
    return hits.slice(0, topK);
  }

  clear(): void {
    this.items.length = 0;
  }
}
