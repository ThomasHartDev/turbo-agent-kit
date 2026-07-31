import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineTool, createToolRegistry, toolSpecsFrom, toolRegistry, toolSpecs } from "./tools";

describe("defineTool", () => {
  it("exposes JSON Schema parameters derived from the Zod schema", () => {
    const tool = defineTool({
      name: "echo",
      description: "echo a string",
      schema: z.object({ text: z.string().min(1) }),
      async run({ text }) {
        return text;
      },
    });

    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: { text: { type: "string", minLength: 1 } },
      required: ["text"],
    });
    expect(tool.parameters).not.toHaveProperty("$schema");
  });

  it("runs with valid args", async () => {
    const tool = defineTool({
      name: "sum",
      description: "add two numbers",
      schema: z.object({ a: z.number(), b: z.number() }),
      async run({ a, b }) {
        return String(a + b);
      },
    });
    await expect(tool.run({ a: 2, b: 3 })).resolves.toBe("5");
  });

  it("returns a structured invalid-args message on empty and wrong types", async () => {
    const tool = defineTool({
      name: "book",
      description: "book",
      schema: z.object({
        service: z.string().min(1),
        time: z.string().min(1),
      }),
      async run() {
        return "ok";
      },
    });

    const empty = await tool.run({ service: "", time: "" });
    expect(empty).toMatch(/^Invalid arguments for book:/);
    expect(empty).toContain("service");
    expect(empty).toContain("time");

    const wrongType = await tool.run({ service: 42, time: null });
    expect(wrongType).toMatch(/^Invalid arguments for book:/);

    const missing = await tool.run({});
    expect(missing).toMatch(/^Invalid arguments for book:/);
  });

  it("does not swallow runtime errors from the handler", async () => {
    const tool = defineTool({
      name: "boom",
      description: "throws",
      schema: z.object({}),
      async run() {
        throw new Error("handler exploded");
      },
    });
    await expect(tool.run({})).rejects.toThrow("handler exploded");
  });
});

describe("default tool registry", () => {
  it("registers bookAppointment, checkAvailability, and calculate", () => {
    expect([...toolRegistry.keys()].sort()).toEqual([
      "bookAppointment",
      "calculate",
      "checkAvailability",
    ]);
    expect(toolSpecs).toHaveLength(3);
    for (const spec of toolSpecs) {
      expect(spec.parameters).toMatchObject({ type: "object" });
    }
  });

  it("calculate multiplies and rejects bad ops at the schema layer", async () => {
    const calc = toolRegistry.get("calculate")!;
    await expect(calc.run({ a: 6, b: 7, op: "*" })).resolves.toBe("42");

    const badOp = await calc.run({ a: 1, b: 2, op: "%" });
    expect(badOp).toMatch(/^Invalid arguments for calculate:/);

    await expect(calc.run({ a: 1, b: 0, op: "/" })).rejects.toThrow("division by zero");
  });

  it("createToolRegistry builds an isolated map", () => {
    const t = defineTool({
      name: "only",
      description: "solo",
      schema: z.object({}),
      async run() {
        return "x";
      },
    });
    const reg = createToolRegistry([t]);
    expect(reg.size).toBe(1);
    expect(toolSpecsFrom(reg)).toEqual([
      { name: "only", description: "solo", parameters: t.parameters },
    ]);
  });
});
