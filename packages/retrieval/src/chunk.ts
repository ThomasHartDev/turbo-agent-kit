import { assertPositiveInt, type Chunk, type ChunkOptions, type Document } from "./types";

const DEFAULT_SEPARATORS = ["\n\n", "\n", ". ", " ", ""];

export function chunkText(
  text: string,
  options: ChunkOptions,
): Omit<Chunk, "id" | "documentId" | "metadata">[] {
  assertPositiveInt("size", options.size);
  if (!Number.isInteger(options.overlap) || options.overlap < 0) {
    throw new RangeError(`overlap must be a non-negative integer, got ${options.overlap}`);
  }
  if (options.overlap >= options.size) {
    throw new RangeError(`overlap ${options.overlap} must be less than size ${options.size}`);
  }

  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.trim().length === 0) return [];

  const seps = options.separators ?? DEFAULT_SEPARATORS;
  if (seps.length === 1 && seps[0] === "") {
    return slidingWindow(normalized, options.size, options.overlap);
  }
  return packWithOverlap(
    splitRecursive(normalized, options.size, seps),
    options.size,
    options.overlap,
  );
}

export function chunkDocument(doc: Document, options: ChunkOptions): Chunk[] {
  return chunkText(doc.text, options).map((piece, i) => ({
    id: `${doc.id}#${i}`,
    documentId: doc.id,
    text: piece.text,
    index: i,
    start: piece.start,
    end: piece.end,
    metadata: doc.metadata,
  }));
}

function slidingWindow(
  text: string,
  size: number,
  overlap: number,
): Omit<Chunk, "id" | "documentId" | "metadata">[] {
  const step = size - overlap;
  const out: Omit<Chunk, "id" | "documentId" | "metadata">[] = [];
  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(start + size, text.length);
    out.push({ text: text.slice(start, end), index: out.length, start, end });
    if (end === text.length) break;
  }
  return out;
}

function splitRecursive(text: string, size: number, separators: string[]): string[] {
  if (text.length <= size) return text.length === 0 ? [] : [text];

  let separator = "";
  let next: string[] = [];
  for (let i = 0; i < separators.length; i++) {
    const sep = separators[i]!;
    if (sep === "") break;
    if (text.includes(sep)) {
      separator = sep;
      next = separators.slice(i + 1);
      break;
    }
  }

  if (separator === "") return slidingWindow(text, size, 0).map((c) => c.text);

  const out: string[] = [];
  for (const part of text.split(separator)) {
    if (part.length === 0) continue;
    if (part.length <= size) out.push(part);
    else out.push(...splitRecursive(part, size, next));
  }
  return out;
}

function packWithOverlap(
  splits: string[],
  size: number,
  overlap: number,
): Omit<Chunk, "id" | "documentId" | "metadata">[] {
  const chunks: Omit<Chunk, "id" | "documentId" | "metadata">[] = [];
  let current: string[] = [];
  let len = 0;
  let offset = 0;
  const total = (parts: string[]) => parts.reduce((n, p, i) => n + p.length + (i > 0 ? 1 : 0), 0);

  const flush = () => {
    if (current.length === 0) return;
    const text = current.join(" ");
    chunks.push({ text, index: chunks.length, start: offset, end: offset + text.length });
    offset += text.length;
    if (overlap === 0) {
      current = [];
      len = 0;
      return;
    }
    while (current.length > 1 && total(current) > overlap) current.shift();
    if (current.length === 1 && current[0]!.length > overlap) {
      current = [current[0]!.slice(-overlap)];
    }
    len = total(current);
  };

  for (const split of splits) {
    const add = split.length + (current.length > 0 ? 1 : 0);
    if (len + add > size && current.length > 0) flush();
    if (len + split.length + (current.length > 0 ? 1 : 0) > size) {
      current = [];
      len = 0;
    }
    current.push(split);
    len = total(current);
  }
  flush();
  return chunks;
}
