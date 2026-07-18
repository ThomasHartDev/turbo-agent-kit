import { z } from "zod";

// Env values arrive as strings, so every coercion below starts from a string and
// narrows into the real type. Kept explicit rather than leaning on z.coerce so the
// accepted spellings (and the rejections) are visible and testable.

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

export function bool() {
  return z
    .string()
    .trim()
    .toLowerCase()
    .refine((v) => TRUTHY.has(v) || FALSY.has(v), {
      message: "expected a boolean (true/false/1/0/yes/no/on/off)",
    })
    .transform((v) => TRUTHY.has(v));
}

export function integer() {
  return z
    .string()
    .trim()
    .regex(/^[+-]?\d+$/, "expected an integer")
    .transform(Number)
    .pipe(z.number().int());
}

export function port() {
  return integer().pipe(z.number().int().min(1).max(65535));
}

export function url() {
  return z.url();
}

export function nonEmpty() {
  return z.string().trim().min(1, "must not be empty");
}

export function oneOf<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values);
}
