import { describe, expect, it } from "vitest";
import { chunkDocument, chunkText } from "./chunk";
import { cosineSimilarity, HashingEmbedder } from "./embed";
import { formatContext, Retriever } from "./retriever";
import type { EmbeddedChunk } from "./types";
import { InMemoryVectorStore } from "./vector-store";

describe("chunkText", () => {
  it("returns empty for blank input and one chunk for short text", () => {
    expect(chunkText("", { size: 50, overlap: 10 })).toEqual([]);
    expect(chunkText("   \n  ", { size: 50, overlap: 10 })).toEqual([]);
    expect(chunkText("hello world", { size: 50, overlap: 5 })).toHaveLength(1);
  });

  it("rejects invalid overlap", () => {
    expect(() => chunkText("hi", { size: 10, overlap: 10 })).toThrow(RangeError);
    expect(() => chunkText("hi", { size: 10, overlap: -1 })).toThrow(RangeError);
  });

  it("default separators + long unbreakable run: size cap, overlap, no injected spaces", () => {
    const size = 20;
    const overlap = 5;
    const original = "x".repeat(100);
    const chunks = chunkText(original, { size, overlap });
    const sliding = chunkText(original, { size, overlap, separators: [""] });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => [c.start, c.end])).toEqual(sliding.map((c) => [c.start, c.end]));
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(size);
      expect(c.text.includes(" ")).toBe(false);
      expect(c.text).toBe("x".repeat(c.text.length));
      expect(original.slice(c.start, c.end)).toBe(c.text);
    }
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const cur = chunks[i]!;
      if (prev.text.length === size && cur.text.length === size) {
        expect(cur.start).toBe(prev.end - overlap);
      }
      const shared = Math.min(overlap, prev.text.length, cur.text.length);
      if (shared > 0 && cur.start < prev.end) {
        const suffix = prev.text.slice(-shared);
        const prefix = cur.text.slice(0, shared);
        expect(prefix).toBe(suffix);
        expect(cur.start).toBe(prev.end - shared);
      }
    }
  });

  it("size-length tokens separated by spaces keep configured overlap", () => {
    const size = 20;
    const overlap = 5;
    const token = "a".repeat(size);
    const original = Array.from({ length: 5 }, () => token).join(" ");
    const chunks = chunkText(original, { size, overlap });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(size);
      expect(original.slice(c.start, c.end)).toBe(c.text);
    }
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const cur = chunks[i]!;
      if (prev.text.length === size && cur.text.length === size) {
        expect(cur.start).toBe(prev.end - overlap);
        expect(cur.text.slice(0, overlap)).toBe(prev.text.slice(-overlap));
      }
    }
    expect(chunks.some((c) => c.start > 0 && c.start < size)).toBe(true);
  });

  it("short soft lead-in before long unbreakable token keeps overlap", () => {
    const cases: { original: string; size: number; overlap: number }[] = [
      {
        original: "See docs at https://" + "a".repeat(80) + ".example.com/path",
        size: 100,
        overlap: 20,
      },
      {
        original: "Hi " + "x".repeat(500),
        size: 400,
        overlap: 60,
      },
    ];

    for (const { original, size, overlap } of cases) {
      const chunks = chunkText(original, { size, overlap });
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0]!.text.length).toBeLessThanOrEqual(overlap);

      for (const c of chunks) {
        expect(c.text.length).toBeLessThanOrEqual(size);
        expect(original.slice(c.start, c.end)).toBe(c.text);
      }

      for (let i = 1; i < chunks.length; i++) {
        const prev = chunks[i - 1]!;
        const cur = chunks[i]!;
        expect(cur.start).toBeLessThan(prev.end);
        const shared = prev.end - cur.start;
        const expected = Math.min(overlap, prev.text.length - 1);
        expect(shared).toBe(expected);
        expect(cur.text.slice(0, shared)).toBe(prev.text.slice(-shared));
      }
    }
  });

  it("maps start/end into source for multi-paragraph multi-word docs", () => {
    const a = "Alpha paragraph about cats and dogs. ".repeat(8).trim();
    const b = "Beta paragraph about birds and fish. ".repeat(8).trim();
    const original = `${a}\n\n${b}`;
    const chunks = chunkText(original, { size: 200, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(original.slice(c.start, c.end)).toBe(c.text);
      expect(c.text.length).toBeLessThanOrEqual(200);
    }
  });

  it("sliding window with separators:[''] keeps source ranges", () => {
    const original = "x".repeat(50);
    const hard = chunkText(original, { size: 20, overlap: 5, separators: [""] });
    expect(hard.every((c) => c.text.length <= 20)).toBe(true);
    expect(hard[0]).toMatchObject({ start: 0, end: 20, text: "x".repeat(20) });
    expect(hard[1]).toMatchObject({ start: 15, end: 35 });
    for (const c of hard) {
      expect(original.slice(c.start, c.end)).toBe(c.text);
    }
  });

  it("chunkDocument assigns ids and maps offsets after CRLF normalize", () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const docs = chunkDocument({ id: "d1", text: words }, { size: 40, overlap: 8 });
    expect(docs[0]).toMatchObject({ documentId: "d1", id: "d1#0" });
    for (const c of docs) {
      expect(words.slice(c.start, c.end)).toBe(c.text);
    }

    const crlf = "line one\r\n\r\nline two has several words here";
    const normalized = crlf.replace(/\r\n/g, "\n");
    const pieces = chunkText(crlf, { size: 20, overlap: 4 });
    for (const c of pieces) {
      expect(normalized.slice(c.start, c.end)).toBe(c.text);
    }
  });
});

describe("embed + store + retriever", () => {
  it("embeds, ranks by cosine, and retrieves the right document", async () => {
    const emb = new HashingEmbedder({ dimensions: 128 });
    const [v] = await emb.embed(["retrieval augmented generation"]);
    expect(Math.sqrt(v!.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 5);
    expect(await emb.embed(["same"])).toEqual(await emb.embed(["same"]));

    const [q, near, far] = await emb.embed([
      "token bucket rate limiter refill burst",
      "token bucket rate limiting refills continuously under burst load",
      "banana bread recipe with walnuts and cinnamon",
    ]);
    expect(cosineSimilarity(q!, near!)).toBeGreaterThan(cosineSimilarity(q!, far!));
    expect(() => cosineSimilarity([1], [1, 2])).toThrow(RangeError);

    const store = new InMemoryVectorStore(2);
    const chunk = (id: string, vector: number[]): EmbeddedChunk => ({
      id,
      documentId: "d",
      text: id,
      index: 0,
      start: 0,
      end: 1,
      vector,
    });
    store.add([chunk("a", [1, 0]), chunk("b", [0.7, 0.7]), chunk("c", [0, 1])]);
    expect(store.search([1, 0], { topK: 2 }).map((h) => h.chunk.id)).toEqual(["a", "b"]);
    expect(store.search([1, 0], { topK: 5, minScore: 0.9 })).toHaveLength(1);
    expect(() => store.add([chunk("bad", [1])])).toThrow(RangeError);

    const retriever = new Retriever({
      embedder: new HashingEmbedder({ dimensions: 256 }),
      chunk: { size: 120, overlap: 20 },
    });
    await retriever.ingest([
      {
        id: "k8s",
        text: "A horizontal pod autoscaler watches CPU metrics and scales deployment replicas under load.",
      },
      {
        id: "bake",
        text: "Banana bread needs ripe bananas, flour, eggs, and a 350 degree oven for one hour.",
      },
    ]);
    const hits = await retriever.search("horizontal pod autoscaler scales replicas", { topK: 2 });
    expect(hits[0]!.chunk.documentId).toBe("k8s");
    expect(formatContext(hits)).toContain("[1]");
    expect(formatContext([])).toBe("");
    expect(await retriever.search("   ")).toEqual([]);
  });
});
