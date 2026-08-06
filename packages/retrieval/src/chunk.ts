import { assertPositiveInt, type Chunk, type ChunkOptions, type Document } from "./types";

const DEFAULT_SEPARATORS = ["\n\n", "\n", ". ", " ", ""];

interface SourceSpan {
  start: number;
  end: number;
}

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
    normalized,
    splitRecursive(normalized, options.size, seps, 0),
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

function splitRecursive(
  text: string,
  size: number,
  separators: string[],
  offset: number,
): SourceSpan[] {
  if (text.length === 0) return [];
  if (text.length <= size) return [{ start: offset, end: offset + text.length }];

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

  if (separator === "") {
    const out: SourceSpan[] = [];
    for (let i = 0; i < text.length; i += size) {
      const end = Math.min(i + size, text.length);
      out.push({ start: offset + i, end: offset + end });
    }
    return out;
  }

  const out: SourceSpan[] = [];
  let cursor = 0;
  while (true) {
    const idx = text.indexOf(separator, cursor);
    const partEnd = idx === -1 ? text.length : idx;
    if (partEnd > cursor) {
      const part = text.slice(cursor, partEnd);
      if (part.length <= size) {
        out.push({ start: offset + cursor, end: offset + partEnd });
      } else {
        out.push(...splitRecursive(part, size, next, offset + cursor));
      }
    }
    if (idx === -1) break;
    cursor = idx + separator.length;
  }
  return out;
}

function packWithOverlap(
  original: string,
  pieces: SourceSpan[],
  size: number,
  overlap: number,
): Omit<Chunk, "id" | "documentId" | "metadata">[] {
  const chunks: Omit<Chunk, "id" | "documentId" | "metadata">[] = [];
  let current: SourceSpan[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const start = current[0]!.start;
    const end = current[current.length - 1]!.end;
    chunks.push({
      text: original.slice(start, end),
      index: chunks.length,
      start,
      end,
    });
    if (overlap === 0) {
      current = [];
      return;
    }
    const overlapStart = Math.max(start, end - overlap);
    while (current.length > 0 && current[0]!.end <= overlapStart) {
      current.shift();
    }
    if (current.length > 0 && current[0]!.start < overlapStart) {
      current[0] = { start: overlapStart, end: current[0]!.end };
    }
  };

  for (const piece of pieces) {
    if (current.length > 0 && piece.end - current[0]!.start > size) {
      flush();
    }
    if (current.length > 0 && piece.end - current[0]!.start > size) {
      current = [];
    }
    current.push(piece);
  }
  flush();
  return chunks;
}
