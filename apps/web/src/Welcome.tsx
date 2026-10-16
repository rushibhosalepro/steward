import { useState } from "react";
import { api, type Profile } from "./api";

// First visit: your own private Steward, either Asha's demo world or one built from you.
// Either way it's a sandbox only this browser can approve in.

type Person = Profile["people"][number];
type Doc = Profile["documents"][number];

const tzGuess = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
};
const splitList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function Welcome({ onReady }: { onReady: (userId: string) => void }) {
  const [mode, setMode] = useState<"choose" | "form">("choose");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(tzGuess());
  const [early, setEarly] = useState("");
  const [people, setPeople] = useState<(Person & { projectsText: string })[]>([{ name: "", email: "", closeness: "work", projects: [], projectsText: "" }]);
  const [docs, setDocs] = useState<(Doc & { sharedText: string })[]>([{ title: "", project: "", sensitivity: "internal", sharedWith: [], sharedText: "" }]);

  const start = async (m: "demo" | "profile") => {
    setBusy(true); setError(null);
    try {
      const profile: Profile | undefined = m === "profile" ? {
        name: name.trim(), timezone, ...(early ? { noMeetingsBefore: early } : {}),
        people: people.filter((p) => p.name.trim() && p.email.trim()).map(({ projectsText, ...p }) => ({ ...p, projects: splitList(projectsText) })),
        projects: [],
        documents: docs.filter((d) => d.title.trim()).map(({ sharedText, ...d }) => ({ ...d, project: d.project?.trim() || undefined, sharedWith: splitList(sharedText) })),
      } : undefined;
      const r = await api.createSandbox(m, profile);
      onReady(r.userId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setP = (i: number, patch: Partial<Person & { projectsText: string }>) => setPeople((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const setD = (i: number, patch: Partial<Doc & { sharedText: string }>) => setDocs((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  return (
    <div className="wl">
      <div className="wl-inner">
        <div className="wl-brand"><div className="ws-avatar">S</div><div><b>Steward</b><small>A personal agent whose limits come from your graph</small></div></div>
        <h1>Other agents ask the model if an action is safe. Steward asks the graph.</h1>
        <p className="ws-muted">You get your own private Steward: your own graph in FalkorDB, and you're the only one who can approve what it asks. Connect Claude Code or any MCP agent to it and that agent becomes your personal agent too.</p>
        {error && <div className="ws-banner bad" role="alert">{error}</div>}

        {mode === "choose" && (
          <div className="wl-choices">
            <button className="wl-choice" disabled={busy} onClick={() => start("demo")}>
              <b>Try the demo</b>
              <span>Asha's world: colleagues, projects, a restricted pricing sheet, and an inbox with an injected email from a stranger. The 3-minute tour.</span>
              <span className="ws-link">{busy ? "Setting up…" : "Start →"}</span>
            </button>
            <button className="wl-choice" disabled={busy} onClick={() => setMode("form")}>
              <b>Make it yours</b>
              <span>Your name, the people you work with, your projects and documents. A minute's typing, and Steward works on your world instead.</span>
              <span className="ws-link">Set up →</span>
            </button>
          </div>
        )}

        {mode === "form" && (
          <form className="wl-form" onSubmit={(e) => { e.preventDefault(); void start("profile"); }}>
            <div className="wl-row">
              <label>Your name<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" /></label>
              <label>Timezone<input value={timezone} onChange={(e) => setTimezone(e.target.value)} /></label>
              <label>No meetings before<input type="time" value={early} onChange={(e) => setEarly(e.target.value)} /></label>
            </div>

            <h4>People <span className="ws-muted">who you know is who Steward will let you send to</span></h4>
            {people.map((p, i) => (
              <div key={i} className="wl-row">
                <input aria-label="Name" value={p.name} onChange={(e) => setP(i, { name: e.target.value })} placeholder="Name" />
                <input aria-label="Email" type="email" value={p.email} onChange={(e) => setP(i, { email: e.target.value })} placeholder="email@example.com" />
                <select aria-label="How close" value={p.closeness} onChange={(e) => setP(i, { closeness: e.target.value as Person["closeness"] })}>
                  <option value="close">close</option><option value="work">work</option><option value="occasional">occasional</option>
                </select>
                <input aria-label="Projects" value={p.projectsText} onChange={(e) => setP(i, { projectsText: e.target.value })} placeholder="projects, comma-separated" />
              </div>
            ))}
            <button type="button" className="ws-link" onClick={() => setPeople((ps) => [...ps, { name: "", email: "", closeness: "work", projects: [], projectsText: "" }])}>+ person</button>

            <h4>Documents <span className="ws-muted">a document reaches people on its project, or people it's shared with</span></h4>
            {docs.map((d, i) => (
              <div key={i} className="wl-row">
                <input aria-label="Title" value={d.title} onChange={(e) => setD(i, { title: e.target.value })} placeholder="Title" />
                <input aria-label="Project" value={d.project ?? ""} onChange={(e) => setD(i, { project: e.target.value })} placeholder="Project" />
                <select aria-label="Sensitivity" value={d.sensitivity} onChange={(e) => setD(i, { sensitivity: e.target.value as Doc["sensitivity"] })}>
                  <option value="public">public</option><option value="internal">internal</option><option value="restricted">restricted</option>
                </select>
                <input aria-label="Shared with" value={d.sharedText} onChange={(e) => setD(i, { sharedText: e.target.value })} placeholder="shared with (emails)" />
              </div>
            ))}
            <button type="button" className="ws-link" onClick={() => setDocs((ds) => [...ds, { title: "", project: "", sensitivity: "internal", sharedWith: [], sharedText: "" }])}>+ document</button>

            <p className="ws-muted">Stays in your private sandbox. Use made-up names if you prefer; nothing is sent anywhere.</p>
            <div className="ws-btns">
              <button className="ws-primary" disabled={busy || !name.trim()}>{busy ? "Building your graph…" : "Build my Steward"}</button>
              <button type="button" className="ws-ghost" onClick={() => setMode("choose")}>Back</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
