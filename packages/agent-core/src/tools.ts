import { z } from "zod";
import { sleep } from "./utils";

/** JSON Schema fragment the LLM adapter sends as a tool's input schema. */
export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface Tool extends ToolSpec {
  run(args: unknown): Promise<string>;
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `${path}: ${i.message}`;
    })
    .join("; ");
}

// Drop draft meta so providers get a plain object schema.
function toParameters(schema: z.ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema) as JsonSchema;
  const { $schema: _drop, ...rest } = raw;
  return rest;
}

/**
 * Bind a Zod schema to a tool. Validation failures return a string the model
 * can read and retry; they do not abort the agent turn.
 */
export function defineTool<T>(spec: {
  name: string;
  description: string;
  schema: z.ZodType<T>;
  run: (args: T) => Promise<string>;
}): Tool {
  return {
    name: spec.name,
    description: spec.description,
    parameters: toParameters(spec.schema),
    async run(raw: unknown): Promise<string> {
      const parsed = spec.schema.safeParse(raw);
      if (!parsed.success) {
        return `Invalid arguments for ${spec.name}: ${formatZodIssues(parsed.error)}`;
      }
      return spec.run(parsed.data);
    },
  };
}

const bookAppointment = defineTool({
  name: "bookAppointment",
  description: "Book an appointment for a service at a given time",
  schema: z.object({
    service: z.string().min(1),
    time: z.string().min(1),
  }),
  async run({ service, time }) {
    await sleep(120);
    const conf = Math.floor(Math.random() * 9000 + 1000);
    return `Booked ${service} for ${time}. Confirmation #${conf}`;
  },
});

const checkAvailability = defineTool({
  name: "checkAvailability",
  description: "Check open appointment slots for a date",
  schema: z.object({
    date: z.string().min(1),
  }),
  async run({ date }) {
    await sleep(120);
    return `Open slots ${date}: 9:00am, 11:30am, 2:00pm`;
  },
});

// Pure arithmetic so tests can hit validation, success, and runtime-error paths
// without timers or nondeterminism.
const calculate = defineTool({
  name: "calculate",
  description: "Evaluate a basic arithmetic expression with two numbers",
  schema: z.object({
    a: z.number().finite(),
    b: z.number().finite(),
    op: z.enum(["+", "-", "*", "/"]),
  }),
  async run({ a, b, op }) {
    if (op === "/" && b === 0) {
      throw new Error("division by zero");
    }
    switch (op) {
      case "+":
        return String(a + b);
      case "-":
        return String(a - b);
      case "*":
        return String(a * b);
      case "/":
        return String(a / b);
    }
  },
});

export const defaultTools: Tool[] = [bookAppointment, checkAvailability, calculate];

export function createToolRegistry(tools: readonly Tool[] = defaultTools): Map<string, Tool> {
  return new Map(tools.map((t) => [t.name, t]));
}

export const toolRegistry = createToolRegistry();

export function toolSpecsFrom(registry: ReadonlyMap<string, Tool> = toolRegistry): ToolSpec[] {
  return [...registry.values()].map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

export const toolSpecs: ToolSpec[] = toolSpecsFrom(toolRegistry);
