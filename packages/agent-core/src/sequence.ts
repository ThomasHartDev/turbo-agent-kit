export type ArrowKind = "sync" | "async" | "return" | "note";

export type SequenceMessage = {
  kind: ArrowKind;
  from: string;
  to: string;
  label: string;
  activate?: "from" | "to";
  deactivate?: "from" | "to";
};

export type SequenceStep =
  | SequenceMessage
  | { kind: "loop"; label: string; body: SequenceStep[] }
  | { kind: "alt"; branches: { label: string; body: SequenceStep[] }[] }
  | { kind: "opt"; label: string; body: SequenceStep[] }
  | { kind: "break"; label?: string };

export type SequenceDiagram = {
  participants: readonly { id: string; label: string }[];
  steps: readonly SequenceStep[];
};

const ID = /^[A-Za-z][A-Za-z0-9_]*$/;

function msg(
  kind: ArrowKind,
  from: string,
  to: string,
  label: string,
  extra: Pick<SequenceMessage, "activate" | "deactivate"> = {},
): SequenceMessage {
  return { kind, from, to, label, ...extra };
}

function bump(counts: Map<string, number>, id: string, delta: number, where: string): void {
  const next = (counts.get(id) ?? 0) + delta;
  if (next < 0) throw new Error(`deactivate of idle ${id} (${where})`);
  counts.set(id, next);
}

function snapshot(ids: Set<string>, counts: Map<string, number>): string {
  return [...ids]
    .sort()
    .map((id) => `${id}:${counts.get(id) ?? 0}`)
    .join(",");
}

function walk(
  steps: readonly SequenceStep[],
  ids: Set<string>,
  counts: Map<string, number>,
  where: string,
  inLoop = false,
): void {
  if (steps.length === 0) throw new Error(`empty fragment (${where})`);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const here = `${where}[${i}]`;

    if (step.kind === "loop") {
      const before = snapshot(ids, counts);
      walk(step.body, ids, counts, `${here}.loop`, true);
      if (snapshot(ids, counts) !== before) {
        throw new Error(`loop leaks activation (${here})`);
      }
      continue;
    }

    if (step.kind === "alt") {
      if (step.branches.length < 2) {
        throw new Error(`alt needs at least two branches (${here})`);
      }
      const ends = new Set<string>();
      let last: Map<string, number> | undefined;
      for (const branch of step.branches) {
        const copy = new Map(counts);
        walk(branch.body, ids, copy, `${here}.${branch.label}`, inLoop);
        ends.add(snapshot(ids, copy));
        last = copy;
      }
      if (ends.size !== 1) {
        throw new Error(`alt branches leave different activations (${here})`);
      }
      for (const id of ids) counts.set(id, last!.get(id) ?? 0);
      continue;
    }

    if (step.kind === "opt") {
      const before = snapshot(ids, counts);
      walk(step.body, ids, counts, `${here}.opt`, inLoop);
      if (snapshot(ids, counts) !== before) {
        throw new Error(`opt leaks activation (${here})`);
      }
      continue;
    }

    if (step.kind === "break") {
      if (!inLoop) throw new Error(`break outside loop (${here})`);
      continue;
    }

    if (!ids.has(step.from)) throw new Error(`unknown from ${step.from} (${here})`);
    if (!ids.has(step.to)) throw new Error(`unknown to ${step.to} (${here})`);
    if (step.kind !== "note" && step.label.trim().length === 0) {
      throw new Error(`empty message label (${here})`);
    }
    if (step.activate) bump(counts, step[step.activate], 1, here);
    if (step.deactivate) bump(counts, step[step.deactivate], -1, here);
  }
}

export function assertWellFormed(diagram: SequenceDiagram): void {
  if (diagram.participants.length === 0) throw new Error("diagram has no participants");
  const ids = new Set<string>();
  for (const p of diagram.participants) {
    if (!ID.test(p.id)) throw new Error(`invalid participant id: ${p.id}`);
    if (ids.has(p.id)) throw new Error(`duplicate participant: ${p.id}`);
    ids.add(p.id);
  }
  const counts = new Map<string, number>();
  walk(diagram.steps, ids, counts, "root");
  for (const [id, n] of counts) {
    if (n !== 0) throw new Error(`participant ${id} still activated (${n})`);
  }
}

function escapeLabel(label: string): string {
  return label.replace(/\r?\n/g, " ").replace(/:/g, ";");
}

function emit(steps: readonly SequenceStep[], lines: string[], depth: number): void {
  const pad = "  ".repeat(depth);
  for (const step of steps) {
    if (step.kind === "loop") {
      lines.push(`${pad}loop ${escapeLabel(step.label)}`);
      emit(step.body, lines, depth + 1);
      lines.push(`${pad}end`);
      continue;
    }
    if (step.kind === "alt") {
      step.branches.forEach((branch, i) => {
        lines.push(`${pad}${i === 0 ? "alt" : "else"} ${escapeLabel(branch.label)}`);
        emit(branch.body, lines, depth + 1);
      });
      lines.push(`${pad}end`);
      continue;
    }
    if (step.kind === "opt") {
      lines.push(`${pad}opt ${escapeLabel(step.label)}`);
      emit(step.body, lines, depth + 1);
      lines.push(`${pad}end`);
      continue;
    }
    if (step.kind === "break") {
      const suffix = step.label?.trim() ? ` ${escapeLabel(step.label)}` : "";
      lines.push(`${pad}break${suffix}`);
      lines.push(`${pad}end`);
      continue;
    }
    if (step.kind === "note") {
      const span = step.from === step.to ? step.from : `${step.from},${step.to}`;
      lines.push(`${pad}Note over ${span}: ${escapeLabel(step.label)}`);
    } else {
      const arrow = step.kind === "return" ? "-->>" : step.kind === "async" ? "-)" : "->>";
      lines.push(`${pad}${step.from}${arrow}${step.to}: ${escapeLabel(step.label)}`);
    }
    if (step.activate) lines.push(`${pad}activate ${step[step.activate]}`);
    if (step.deactivate) lines.push(`${pad}deactivate ${step[step.deactivate]}`);
  }
}

export function toMermaid(diagram: SequenceDiagram): string {
  assertWellFormed(diagram);
  const lines = ["sequenceDiagram"];
  for (const p of diagram.participants) {
    lines.push(`  participant ${p.id} as ${escapeLabel(p.label)}`);
  }
  emit(diagram.steps, lines, 1);
  return `${lines.join("\n")}\n`;
}

export type LoopEvent = "user" | "llm" | "tool_call" | "tool_result" | "final" | "give_up";

export function acceptsTrace(events: readonly LoopEvent[], maxSteps: number): boolean {
  if (maxSteps < 1 || events[0] !== "user") return false;
  let i = 1;
  let steps = 0;
  while (i < events.length) {
    if (events[i] === "give_up") return steps === maxSteps && i === events.length - 1;
    if (events[i] !== "llm") return false;
    i += 1;
    const next = events[i];
    if (next === "final") return i === events.length - 1 && steps < maxSteps;
    if (next === "tool_call" && events[i + 1] === "tool_result") {
      steps += 1;
      if (steps > maxSteps) return false;
      i += 2;
      continue;
    }
    return false;
  }
  return false;
}

export const AGENT_LOOP_DIAGRAM: SequenceDiagram = {
  participants: [
    { id: "User", label: "User" },
    { id: "Agent", label: "runAgentTurn" },
    { id: "LLM", label: "LLMProvider" },
    { id: "Tools", label: "Tool registry" },
    { id: "Tel", label: "Telemetry" },
  ],
  steps: [
    msg("sync", "User", "Agent", "user text"),
    {
      kind: "loop",
      label: "step < maxSteps",
      body: [
        msg("sync", "Agent", "LLM", "complete(history, specs)", { activate: "to" }),
        msg("return", "LLM", "Agent", "final or tool_call", { deactivate: "from" }),
        msg("async", "Agent", "Tel", "record llm span"),
        {
          kind: "alt",
          branches: [
            {
              label: "final",
              body: [msg("sync", "Agent", "User", "assistant answer"), { kind: "break" }],
            },
            {
              label: "tool_call",
              body: [
                msg("sync", "Agent", "Tools", "run(name, args)", { activate: "to" }),
                msg("return", "Tools", "Agent", "output / unknown / error", {
                  deactivate: "from",
                }),
                msg("async", "Agent", "Tel", "record tool span"),
                msg("note", "Agent", "Agent", "append tool message; next step"),
              ],
            },
          ],
        },
      ],
    },
    {
      kind: "opt",
      label: "no final",
      body: [msg("sync", "Agent", "User", "give-up if no final")],
    },
  ],
};
