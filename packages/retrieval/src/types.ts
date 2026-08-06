export interface Document {
  id: string;
  text: string;
  metadata?: Record<string, string>;
}

export interface Chunk {
  id: string;
  documentId: string;
  text: string;
  index: number;
  start: number;
  end: number;
  metadata?: Record<string, string>;
}

export interface EmbeddedChunk extends Chunk {
  vector: number[];
}

export interface SearchHit {
  chunk: EmbeddedChunk;
  score: number;
}

export interface Embedder {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface ChunkOptions {
  size: number;
  overlap: number;
  separators?: string[];
}

export interface SearchOptions {
  topK?: number;
  minScore?: number;
}

export function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}
