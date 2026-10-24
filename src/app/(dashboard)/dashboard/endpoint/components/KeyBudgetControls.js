"use client";

// Per-API-key daily USD budget on the Endpoint page: today's spend vs budget,
// inline budget edit, and a request-history modal backed by /api/keys/[id]/usage.
// Budget days are calendar days in Asia/Ho_Chi_Minh (reset 00:00 Vietnam time).
import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Input, Modal } from "@/shared/components";

const usd = (n) => `$${(Number(n) || 0).toFixed(n >= 100 ? 2 : 4)}`;

export default function KeyBudgetControls({ apiKey, onChange }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState(null);

  const limit = apiKey.dailyBudgetUsd;
  const b = apiKey.budget;
  const used = (b?.spentUsd || 0) + (b?.reservedUsd || 0);
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : (limit === 0 ? 100 : 0);

  const startEdit = () => {
    setValue(limit == null ? "" : String(limit));
    setError("");
    setEditing(true);
  };
  const save = async () => {
    const ok = await onChange(value.trim() === "" ? null : Number(value));
    if (ok === true) setEditing(false);
    else setError(typeof ok === "string" ? ok : "Could not save budget");
  };
  const openHistory = async () => {
    setHistory({ loading: true });
    try {
      const res = await fetch(`/api/keys/${apiKey.id}/usage`);
      const data = await res.json();
      setHistory(res.ok ? data : { error: data.error || "Failed to load" });
    } catch {
      setHistory({ error: "Failed to load" });
    }
  };

  return (
    <div className="mt-2" data-testid="key-budget">
      {limit == null ? (
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span>Daily budget: unlimited</span>
          <button onClick={startEdit} className="text-primary hover:underline">Set budget</button>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-xs flex-wrap">
            <span className="text-text-main">
              Today {usd(used)} / {usd(limit)} ({pct.toFixed(0)}%)
            </span>
            <span className="text-text-muted">· left {usd(b?.remainingUsd ?? limit)}</span>
            {b?.reservedUsd > 0 && <span className="text-text-muted">· {usd(b.reservedUsd)} in flight</span>}
            <button onClick={startEdit} className="text-primary hover:underline">Edit</button>
            <button onClick={openHistory} className="text-primary hover:underline">History</button>
          </div>
          <div
            className="h-1.5 w-full max-w-xs rounded-full bg-black/5 dark:bg-white/10 overflow-hidden"
            role="progressbar"
            aria-label="Daily budget used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct)}
          >
            <div className={`h-full ${pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-orange-500" : "bg-primary"}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {editing && (
        <div className="mt-2 flex items-start gap-2 max-w-sm">
          <Input
            type="number"
            min="0"
            step="0.01"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="USD per day (empty = unlimited)"
            aria-label="Daily budget in USD"
            className="flex-1"
          />
          <Button size="sm" onClick={save}>Save</Button>
          <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setError(""); }}>Cancel</Button>
        </div>
      )}
      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}

      <Modal isOpen={!!history} title={`Usage: ${apiKey.name}`} onClose={() => setHistory(null)}>
        {history?.loading && <p className="text-sm text-text-muted">Loading…</p>}
        {history?.error && <p className="text-sm text-red-500">{history.error}</p>}
        {history?.days && (
          <div className="flex flex-col gap-4 text-xs">
            <p className="text-text-muted">Days reset at 00:00 Asia/Ho_Chi_Minh.</p>
            <section>
              <h3 className="font-medium mb-1">By day</h3>
              <table className="w-full [&_td]:pr-3 [&_th]:pr-3">
                <thead><tr className="text-left text-text-muted"><th>Day</th><th>Spent</th><th>Requests</th></tr></thead>
                <tbody>
                  {history.days.slice(0, 14).map((d) => (
                    <tr key={d.day}><td>{d.day}</td><td>{usd(d.spentUsd)}</td><td>{d.requests}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
            {history.byModel.length > 0 && (
              <section>
                <h3 className="font-medium mb-1">By model ({history.day})</h3>
                <table className="w-full [&_td]:pr-3 [&_th]:pr-3">
                  <thead><tr className="text-left text-text-muted"><th>Provider/model</th><th>Requests</th><th>Cost</th></tr></thead>
                  <tbody>
                    {history.byModel.map((m) => (
                      <tr key={`${m.provider}/${m.model}`}><td className="font-mono">{m.provider}/{m.model}</td><td>{m.requests}</td><td>{usd(m.costUsd)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
            <section>
              <h3 className="font-medium mb-1">Requests ({history.day})</h3>
              <table className="w-full [&_td]:pr-3 [&_th]:pr-3">
                <thead><tr className="text-left text-text-muted"><th>Time</th><th>Model</th><th>Status</th><th>Cost</th></tr></thead>
                <tbody>
                  {history.requests.map((r) => (
                    <tr key={r.id}>
                      <td>{new Date(r.createdAt).toLocaleTimeString()}</td>
                      <td className="font-mono">{r.provider}/{r.model}</td>
                      <td>{r.costSource || r.status}</td>
                      <td>{usd(r.actualUsd ?? r.reservedUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        )}
      </Modal>
    </div>
  );
}

KeyBudgetControls.propTypes = {
  apiKey: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
    dailyBudgetUsd: PropTypes.number,
    budget: PropTypes.object,
  }).isRequired,
  onChange: PropTypes.func.isRequired,
};
