import { z } from "zod";
import { sleep } from "./utils";

// These types not shared so keep them local
export interface ToolSpec {
  name: string;
  description: string;
}

export interface Tool extends ToolSpec {
  run(args: unknown): Promise<string>;
}

function defineTool<T>(spec: { name: string; description: string; schema: z.ZodType<T>; run: (args: T) => Promise<string> }): Tool {
  return {
    name: spec.name,
    description: spec.description,
    run: (raw: unknown) => spec.run(spec.schema.parse(raw)),
  };
}

const bookAppointment = defineTool({
  name: "bookAppointment",
  description: "Book an appointment for a service at a given time",
  schema: z.object({ service: z.string(), time: z.string() }),
  async run({ service, time }) {
    await sleep(120);
    const conf = Math.floor(Math.random() * 9000 + 1000); // Fake demo data for now
    return `Booked ${service} for ${time}. Confirmation #${conf}`;
  },
});

const checkAvailability = defineTool({
  name: "checkAvailability",
  description: "Check open appointment slots for a date",
  schema: z.object({ date: z.string() }),
  async run({ date }) {
    await sleep(120);
    return `Open slots ${date}: 9:00am, 11:30am, 2:00pm`;
  },
});

export const toolRegistry = new Map<string, Tool>(
  [bookAppointment, checkAvailability].map((t): [string, Tool] => [t.name, t]), // O(1) lookups by name
);

export const toolSpecs: ToolSpec[] = [...toolRegistry.values()].map((t) => ({
  name: t.name,
  description: t.description,
}));
