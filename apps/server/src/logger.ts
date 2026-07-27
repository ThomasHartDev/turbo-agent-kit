export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  service?: string;
  level?: LogLevel;
  /** Capture sink for tests; defaults to process.stdout.write. */
  write?: (line: string) => void;
  clock?: () => number;
  base?: Record<string, unknown>;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const service = options.service ?? "agent-server";
  const minLevel = options.level ?? "info";
  const write =
    options.write ??
    ((line: string) => {
      process.stdout.write(line);
    });
  const clock = options.clock ?? Date.now;
  const base = options.base ?? {};

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const entry: Record<string, unknown> = {
      ts: new Date(clock()).toISOString(),
      level,
      service,
      msg,
      ...base,
      ...fields,
    };
    // One object per line so container log collectors can parse without multi-line join.
    write(`${JSON.stringify(entry)}\n`);
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) =>
      createLogger({
        service,
        level: minLevel,
        write,
        clock,
        base: { ...base, ...fields },
      }),
  };
}

export function parseLogLevel(raw: string | undefined): LogLevel {
  switch (raw?.toLowerCase()) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return raw.toLowerCase() as LogLevel;
    default:
      return "info";
  }
}
