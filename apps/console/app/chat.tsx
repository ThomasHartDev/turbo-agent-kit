"use client";

import { useState, type FormEvent } from "react";

type Row = { who: "you" | "agent"; text: string };

export function Chat() {
  const [input, setInput] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setRows((cur) => [...cur, { who: "you", text: message }]);
    try {
      const res = await fetch("/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const text = await res.text();
      setRows((cur) => [...cur, { who: "agent", text: text || `${res.status} empty` }]);
    } catch (err) {
      setRows((cur) => [...cur, { who: "agent", text: String(err) }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="log">
        {rows.map((row, i) => (
          <div key={`${row.who}-${i}`} className={`row ${row.who}`}>
            {row.who}: {row.text}
          </div>
        ))}
      </div>
      <form onSubmit={onSubmit}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message"
          disabled={busy}
        />
        <button type="submit" disabled={busy}>
          {busy ? "Sending" : "Send"}
        </button>
      </form>
    </>
  );
}
