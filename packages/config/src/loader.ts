import { z } from "zod";

export interface ConfigIssue {
  path: string;
  message: string;
  received?: string;
}

const REDACTED = "[redacted]";

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(format(issues));
    this.name = "ConfigError";
    this.issues = issues;
  }
}

function format(issues: ConfigIssue[]): string {
  const lines = issues.map((i) => {
    if (i.received === undefined) return `  ${i.path}: ${i.message}`;
    return `  ${i.path}: ${i.message} (received ${i.received})`;
  });
  return `Invalid configuration:\n${lines.join("\n")}`;
}

export type Source = Record<string, string | undefined>;

export interface ConfigOptions<Shape extends z.ZodRawShape> {
  source?: Source;
  secrets?: readonly (keyof Shape & string)[];
}

export interface Config<T> {
  readonly values: T;
  redacted(): Record<string, unknown>;
}

export function loadConfig<Shape extends z.ZodRawShape>(
  shape: Shape,
  options: ConfigOptions<Shape> = {},
): Config<z.infer<z.ZodObject<Shape>>> {
  const source = options.source ?? (process.env as Source);
  const secrets = new Set<string>(options.secrets ?? []);

  const result = z.object(shape).safeParse(source);
  if (!result.success) {
    throw new ConfigError(toIssues(result.error, source, secrets));
  }

  const values = Object.freeze(result.data) as z.infer<z.ZodObject<Shape>>;
  return {
    values,
    redacted: () => redact(values, secrets),
  };
}

// The root key drives both secret redaction and the "what did you actually set"
// lookup. Env is flat, so path[0] is always the offending variable name.
function toIssues(error: z.ZodError, source: Source, secrets: Set<string>): ConfigIssue[] {
  return error.issues.map((issue) => {
    const key = String(issue.path[0] ?? "");
    const path = issue.path.map(String).join(".") || "(root)";
    const raw = source[key];
    if (raw === undefined) {
      return { path, message: "required but not set" };
    }
    return {
      path,
      message: issue.message,
      received: secrets.has(key) ? REDACTED : JSON.stringify(raw),
    };
  });
}

function redact(values: Record<string, unknown>, secrets: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = secrets.has(key) ? REDACTED : value;
  }
  return out;
}
