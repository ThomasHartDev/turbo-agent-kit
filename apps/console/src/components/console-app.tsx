"use client";

import { useCallback, useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import { fetchTelemetry, streamAgentTurn } from "@/lib/agent-client";
import { canSubmit, chatReducer, initialChatState, isEmpty } from "@/lib/chat-state";
import { createSubmitGuard } from "@/lib/submit-guard";
import type { TelemetrySnapshot } from "@/lib/types";

const emptySnap: TelemetrySnapshot = {
  events: 0,
  all: { count: 0, p50: 0, p95: 0, p99: 0 },
  llm: { count: 0, p50: 0, p95: 0, p99: 0 },
  tool: { count: 0, p50: 0, p95: 0, p99: 0 },
};

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

export function ConsoleApp() {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [busy, setBusy] = useState(false);
  const [snap, setSnap] = useState(emptySnap);
  const [telErr, setTelErr] = useState<string | null>(null);
  const [telLoading, setTelLoading] = useState(true);
  const telLoadedRef = useRef(false);
  const guardRef = useRef(createSubmitGuard());
  const abortRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const refreshTel = useCallback(async (opts?: { showLoading?: boolean }) => {
    const showLoading = opts?.showLoading ?? !telLoadedRef.current;
    if (showLoading) setTelLoading(true);
    try {
      setSnap(await fetchTelemetry());
      setTelErr(null);
      telLoadedRef.current = true;
    } catch (err) {
      setTelErr(err instanceof Error ? err.message : "telemetry fetch failed");
    } finally {
      if (showLoading) setTelLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshTel({ showLoading: true });
    const id = window.setInterval(() => void refreshTel({ showLoading: false }), 5000);
    return () => window.clearInterval(id);
  }, [refreshTel]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      guardRef.current.cancel();
    };
  }, []);

  function cancelInFlight() {
    abortRef.current?.abort();
    abortRef.current = null;
    guardRef.current.cancel();
    setBusy(false);
  }

  function onReset() {
    cancelInFlight();
    dispatch({ type: "reset" });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const current = stateRef.current;
    if (!canSubmit(current)) return;
    const turnId = guardRef.current.tryBegin();
    if (turnId === null) return;

    const message = current.draft.trim();
    const conversationId = current.conversationId ?? undefined;
    const ac = new AbortController();
    abortRef.current = ac;
    dispatch({ type: "submit" });
    setBusy(true);
    let settled = false;

    try {
      for await (const event of streamAgentTurn(
        { message, conversationId },
        { signal: ac.signal },
      )) {
        if (!guardRef.current.isActive(turnId)) return;
        if (event.type === "meta") {
          dispatch({ type: "meta", conversationId: event.conversationId });
        } else if (event.type === "message") {
          dispatch({ type: "message", message: event.message });
        } else if (event.type === "done") {
          settled = true;
          dispatch({ type: "done" });
          void refreshTel({ showLoading: false });
        } else if (event.type === "error") {
          settled = true;
          dispatch({
            type: "fail",
            error: event.detail ? `${event.error}: ${event.detail}` : event.error,
            restoreDraft: message,
          });
        } else {
          settled = true;
          dispatch({ type: "fail", error: event.message, restoreDraft: message });
        }
      }
      if (!settled && guardRef.current.isActive(turnId)) {
        dispatch({ type: "fail", error: "stream closed before done", restoreDraft: message });
      }
    } catch (err) {
      if (!guardRef.current.isActive(turnId) || isAbortError(err)) return;
      dispatch({
        type: "fail",
        error: err instanceof Error ? err.message : "request failed",
        restoreDraft: message,
      });
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      guardRef.current.end(turnId);
      // cancelInFlight bumps turnId; only the live turn clears busy
      if (guardRef.current.isActive(turnId)) setBusy(false);
    }
  }

  return (
    <div className="shell">
      <main className="chat">
        <header className="pad">
          <h1>Agent console</h1>
          <p className="muted">
            Streams <code>POST /agent/turn</code> over SSE
            {state.conversationId ? ` · ${state.conversationId.slice(0, 8)}` : ""}
          </p>
        </header>
        <div className="messages" role="log" aria-live="polite">
          {isEmpty(state) && (
            <div className="state empty" data-testid="empty-state">
              No messages yet. Send a turn to open a conversation.
            </div>
          )}
          {state.messages.map((m, i) => (
            <div key={`${m.role}-${i}`} className={`bubble ${m.role}`}>
              <span className="role">{m.role}</span>
              <p>{m.content}</p>
            </div>
          ))}
          {(state.status === "loading" || state.status === "streaming") && (
            <div className="state loading" data-testid="loading-state" aria-busy="true">
              {state.status === "loading" ? "Waiting for stream…" : "Streaming…"}
            </div>
          )}
          {state.status === "error" && state.error && (
            <div className="state error" data-testid="error-state" role="alert">
              {state.error}
            </div>
          )}
        </div>
        <form className="pad composer" onSubmit={onSubmit}>
          <label className="sr-only" htmlFor="draft">
            Message
          </label>
          <textarea
            id="draft"
            rows={2}
            value={state.draft}
            placeholder="Message the agent…"
            disabled={busy}
            onChange={(e) => dispatch({ type: "set_draft", draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void onSubmit(e);
              }
            }}
          />
          <div className="actions">
            <button type="button" className="ghost" onClick={onReset}>
              Reset
            </button>
            <button type="submit" disabled={!canSubmit(state) || busy}>
              {busy ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      </main>
      <aside className="side pad">
        <div className="row">
          <h2>Telemetry</h2>
          <button
            type="button"
            className="ghost"
            onClick={() => void refreshTel({ showLoading: true })}
            disabled={telLoading}
          >
            {telLoading ? "…" : "Refresh"}
          </button>
        </div>
        <p className="muted">Nearest-rank p50 / p95 / p99 (ms).</p>
        {telErr && (
          <div className="state error" role="alert" data-testid="telemetry-error">
            {telErr}
          </div>
        )}
        <table>
          <thead>
            <tr>
              <th>Series</th>
              <th>n</th>
              <th>p50</th>
              <th>p95</th>
              <th>p99</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["all", snap.all],
                ["llm", snap.llm],
                ["tool", snap.tool],
              ] as const
            ).map(([label, s]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{s.count}</td>
                <td>{s.p50}</td>
                <td>{s.p95}</td>
                <td>{s.p99}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">events: {snap.events}</p>
      </aside>
    </div>
  );
}
