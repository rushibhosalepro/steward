import { useState } from "react";
import { api, type Profile } from "./api";
import { Onboarding } from "./Onboarding";

// First visit: your own private Steward, either Asha's demo world or one you build by talking to
// your new agent. Either way it's a sandbox only this browser can approve in.

export function Welcome({ onReady }: { onReady: (userId: string, intro?: string) => void }) {
  const [mode, setMode] = useState<"choose" | "onboard">("choose");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (m: "demo" | "profile", profile?: Profile, intro?: string) => {
    setBusy(true); setError(null);
    try {
      const r = await api.createSandbox(m, profile);
      onReady(r.userId, intro);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wl">
      <div className="wl-inner">
        <div className="wl-brand"><div className="ws-avatar">S</div><div><b>Steward</b><small>A personal agent whose limits come from your graph</small></div></div>
        {mode === "choose" && <>
          <h1>Other agents ask the model if an action is safe. Steward asks the graph.</h1>
          <p className="ws-muted">You get your own private Steward: your own graph in FalkorDB, and you're the only one who can approve what it asks. Connect Claude Code or any MCP agent to it and that agent becomes your personal agent too.</p>
          {error && <div className="ws-banner bad" role="alert">{error}</div>}
          <div className="wl-choices">
            <button className="wl-choice" disabled={busy} onClick={() => setMode("onboard")}>
              <b>Meet your agent</b>
              <span>Tell it your name, the people and projects in your life, and what's coming up. A couple of minutes, every step skippable, and it starts on something useful straight away.</span>
              <span className="ws-link">Start →</span>
            </button>
            <button className="wl-choice" disabled={busy} onClick={() => start("demo")}>
              <b>Try the demo</b>
              <span>Asha's world: colleagues, projects, a restricted pricing sheet, and an inbox with an injected email from a stranger. The 3-minute security tour, no personal details needed.</span>
              <span className="ws-link">{busy ? "Setting up…" : "Open →"}</span>
            </button>
          </div>
        </>}
        {mode === "onboard" && (
          <Onboarding busy={busy} error={error} onBack={() => setMode("choose")} onDone={(profile, intro) => void start("profile", profile, intro)} />
        )}
      </div>
    </div>
  );
}
