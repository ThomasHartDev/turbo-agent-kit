import { assertPositiveInt, type Embedder } from "./types";

export interface HashingEmbedderOptions {
  dimensions?: number;
  includeBigrams?: boolean;
}

// Feature hashing of tokens (+ optional bigrams) into a fixed L2-normalized
// vector. Deterministic and dependency-free; swap for a real model Embedder.
export class HashingEmbedder implements Embedder {
  readonly dimensions: number;
  private readonly includeBigrams: boolean;

  constructor(options: HashingEmbedderOptions = {}) {
    const dims = options.dimensions ?? 256;
    assertPositiveInt("dimensions", dims);
    this.dimensions = dims;
    this.includeBigrams = options.includeBigrams ?? true;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const vec = new Float64Array(this.dimensions);
    const tokens = tokenize(text);
    if (tokens.length === 0) return Array.from(vec);

    for (const token of tokens) this.accumulate(vec, token, 1);
    if (this.includeBigrams) {
      for (let i = 0; i < tokens.length - 1; i++) {
        this.accumulate(vec, `${tokens[i]!}_${tokens[i + 1]!}`, 0.5);
      }
    }
    return l2Normalize(vec);
  }

  private accumulate(vec: Float64Array, feature: string, weight: number): void {
    const h = fnv1a(feature);
    const idx = h % this.dimensions;
    vec[idx]! += ((h & 1) === 0 ? 1 : -1) * weight;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new RangeError(`vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function l2Normalize(vec: Float64Array): number[] {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!;
  if (sum === 0) return Array.from(vec);
  const inv = 1 / Math.sqrt(sum);
  const out = new Array<number>(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! * inv;
  return out;
}
