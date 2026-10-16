import { useMemo, useState } from "react";
import type { Profile } from "./api";

// "Make it yours", as a conversation: one question at a time, each skippable, ending with what
// the agent learned. The answers become the visitor's own graph (seed/profile.ts); the first task
// then runs in the workspace. Choosing tools to connect records a preference only.

type Person = { name: string; email: string; closeness: "close" | "work" | "occasional"; project: string };
type Doc = { title: string; project: string; sensitivity: "public" | "internal" | "restricted" };
type Step = "name" | "agent" | "focus" | "people" | "docs" | "upcoming" | "prefs" | "connect" | "summary";
const STEPS: Step[] = ["name", "agent", "focus", "people", "docs", "upcoming", "prefs", "connect", "summary"];

const FOCUS = [
  { id: "work", label: "Work, projects and commitments" },
  { id: "email_calendar", label: "Email and calendar" },
  { id: "personal", label: "Personal tasks and planning" },
  { id: "everything", label: "A bit of everything" },
] as const;

const CONNECT = [
  { id: "gmail", label: "Gmail", what: "Drafts only. Steward writes drafts for you to send; it never sends. Google's drafts permission technically also allows sending, so Steward's code only ever creates drafts, and each one is checked by the Sentinel first." },
  { id: "calendar", label: "Google Calendar", what: "Only a calendar Steward creates for itself. It can't read or change your other calendars, and it never invites anyone." },
  { id: "drive", label: "Google Drive", what: "Not available yet. Documents you tell Steward about stay in your graph, with the sensitivity you choose." },
] as const;

const tzGuess = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
// Local "YYYY-MM-DDTHH:mm" for <input type="datetime-local">, `days` from today at `hour`.
const localAt = (days: number, hour: number) => {
  const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
};

export function Onboarding({ onDone, onBack, busy, error }: {
  onDone: (profile: Profile, intro: string) => void; onBack: () => void; busy: boolean; error: string | null;
}) {
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [agentName, setAgentName] = useState("");
  const [focus, setFocus] = useState<Profile["focus"]>();
  const [people, setPeople] = useState<Person[]>([{ name: "", email: "", closeness: "work", project: "" }]);
  const [docs, setDocs] = useState<Doc[]>([{ title: "", project: "", sensitivity: "internal" }]);
  const [meeting, setMeeting] = useState({ title: "", with: "", when: localAt(1, 11) });
  const [promise, setPromise] = useState({ what: "", to: "", document: "", by: localAt(1, 18) });
  const [timezone, setTimezone] = useState(tzGuess());
  const [early, setEarly] = useState("");
  const [wants, setWants] = useState<("gmail" | "calendar" | "drive")[]>([]);

  const me = name.trim() || "there";
  const agent = agentName.trim() || "Steward";
  const okPeople = people.filter((p) => p.name.trim() && /\S+@\S+\.\S+/.test(p.email));
  const okDocs = docs.filter((d) => d.title.trim());
  const projects = [...new Set([...okPeople.map((p) => p.project.trim()), ...okDocs.map((d) => d.project.trim())].filter(Boolean))];
  const next = () => setStep(STEPS[STEPS.indexOf(step) + 1]!);
  const back = () => (step === "name" ? onBack() : setStep(STEPS[STEPS.indexOf(step) - 1]!));

  const profile = useMemo<Profile>(() => ({
    name: name.trim(), timezone, ...(agentName.trim() ? { agentName: agentName.trim() } : {}), ...(focus ? { focus } : {}),
    ...(early ? { noMeetingsBefore: early } : {}), wantsConnections: wants,
    people: okPeople.map((p) => ({ name: p.name.trim(), email: p.email.trim(), closeness: p.closeness, projects: p.project.trim() ? [p.project.trim()] : [] })),
    projects: [],
    documents: okDocs.map((d) => ({ title: d.title.trim(), project: d.project.trim() || undefined, sensitivity: d.sensitivity, sharedWith: [] })),
    ...(meeting.title.trim() ? { meeting: { title: meeting.title.trim(), start: new Date(meeting.when).getTime(), minutes: 30, ...(meeting.with ? { with: meeting.with } : {}) } } : {}),
    ...(promise.what.trim() && promise.to ? { promise: { what: promise.what.trim(), to: promise.to, ...(promise.document ? { document: promise.document } : {}), by: new Date(promise.by).getTime() } } : {}),
  }), [name, timezone, agentName, focus, early, wants, okPeople, okDocs, meeting, promise]);

  const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
  const learned = [
    okPeople.length ? `you work with ${list(okPeople.map((p) => p.name.trim().split(" ")[0]!))}${projects.length ? ` on ${list(projects)}` : ""}` : projects.length ? `you're working on ${list(projects)}` : null,
    early ? `you'd rather not have meetings before ${early}` : null,
    meeting.title.trim() ? `"${meeting.title.trim()}" is coming up` : null,
    promise.what.trim() && promise.to ? `you promised ${okPeople.find((p) => p.email.trim().toLowerCase() === promise.to)?.name.split(" ")[0] ?? promise.to}: "${promise.what.trim()}"` : null,
  ].filter(Boolean) as string[];
  const intro = learned.length
    ? `I've learned that ${list(learned)}. Let me start with the most useful thing.`
    : "I don't know much about your world yet. Tell me what you need, and I'll learn as we go.";

  const ask: Record<Step, string> = {
    name: "Hi, I'm your new personal agent. What should I call you?",
    agent: `Nice to meet you, ${me}. What would you like to call me?`,
    focus: `What should ${agent === "Steward" ? "I" : `${agent}`} help you with first?`,
    people: "Who do you work with most? A few people is plenty. Who you know is who I'll let you send things to.",
    docs: "Any documents I should know about? A document can only go to people on its project, or people you share it with.",
    upcoming: "What's coming up? One meeting in the next couple of days, and one thing you've promised someone. That's what I'll start on.",
    prefs: "Any working preferences?",
    connect: "Which tools would you like me to work with later? Choosing here just records it; nothing gets connected or authorised.",
    summary: `Here's what I've got, ${me}.`,
  };

  const setP = (i: number, patch: Partial<Person>) => setPeople((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const setD = (i: number, patch: Partial<Doc>) => setDocs((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const answered: Partial<Record<Step, string>> = {
    name: name.trim(), agent: agentName.trim() || "Steward is fine",
    focus: FOCUS.find((f) => f.id === focus)?.label ?? "skipped",
    people: okPeople.length ? okPeople.map((p) => p.name.trim()).join(", ") : "skipped",
    docs: okDocs.length ? okDocs.map((d) => d.title.trim()).join(", ") : "skipped",
    upcoming: [meeting.title.trim(), promise.what.trim()].filter(Boolean).join(" · ") || "skipped",
    prefs: [timezone, early && `no meetings before ${early}`].filter(Boolean).join(", "),
    connect: wants.length ? wants.join(", ") : "none for now",
  };
  const done = STEPS.slice(0, STEPS.indexOf(step));

  return (
    <div className="ob">
      <div className="ob-thread">
        {done.map((s) => (
          <div key={s}>
            <div className="ws-msg ws-steward"><div className="ws-bubble">{ask[s]}</div></div>
            <div className="ws-msg ws-me ob-answer">{answered[s]}</div>
          </div>
        ))}
        <div className="ws-msg ws-steward"><div className="ws-who">{agent}</div><div className="ws-bubble">{ask[step]}</div></div>
      </div>

      <form className="ob-controls" onSubmit={(e) => { e.preventDefault(); if (step === "summary") onDone(profile, intro); else if (step !== "name" || name.trim()) next(); }}>
        {step === "name" && <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" aria-label="Your name" />}
        {step === "agent" && <input autoFocus value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Steward, Juno, Friday…" aria-label="Agent name" />}
        {step === "focus" && (
          <div className="ws-chips">{FOCUS.map((f) => (
            <button type="button" key={f.id} className={`ws-chip ${focus === f.id ? "on" : ""}`} onClick={() => setFocus(f.id)}>{f.label}</button>
          ))}</div>
        )}
        {step === "people" && <>
          {people.map((p, i) => (
            <div key={i} className="ob-row">
              <input aria-label="Name" value={p.name} onChange={(e) => setP(i, { name: e.target.value })} placeholder="Name" />
              <input aria-label="Email" type="email" value={p.email} onChange={(e) => setP(i, { email: e.target.value })} placeholder="email@example.com" />
              <select aria-label="How close" value={p.closeness} onChange={(e) => setP(i, { closeness: e.target.value as Person["closeness"] })}>
                <option value="close">close</option><option value="work">work</option><option value="occasional">occasional</option>
              </select>
              <input aria-label="Shared project" value={p.project} onChange={(e) => setP(i, { project: e.target.value })} placeholder="Project you share (optional)" />
            </div>
          ))}
          <button type="button" className="ws-link" onClick={() => setPeople((ps) => [...ps, { name: "", email: "", closeness: "work", project: "" }])}>+ person</button>
        </>}
        {step === "docs" && <>
          {docs.map((d, i) => (
            <div key={i} className="ob-row">
              <input aria-label="Title" value={d.title} onChange={(e) => setD(i, { title: e.target.value })} placeholder="Document title" />
              <input aria-label="Project" list="ob-projects" value={d.project} onChange={(e) => setD(i, { project: e.target.value })} placeholder="Project" />
              <select aria-label="Sensitivity" value={d.sensitivity} onChange={(e) => setD(i, { sensitivity: e.target.value as Doc["sensitivity"] })}>
                <option value="public">public</option><option value="internal">internal</option><option value="restricted">restricted (only people you share it with)</option>
              </select>
            </div>
          ))}
          <datalist id="ob-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
          <button type="button" className="ws-link" onClick={() => setDocs((ds) => [...ds, { title: "", project: "", sensitivity: "internal" }])}>+ document</button>
        </>}
        {step === "upcoming" && <>
          <div className="ob-row">
            <input aria-label="Meeting" value={meeting.title} onChange={(e) => setMeeting({ ...meeting, title: e.target.value })} placeholder="A meeting, e.g. Launch review" />
            <select aria-label="With" value={meeting.with} onChange={(e) => setMeeting({ ...meeting, with: e.target.value })}>
              <option value="">with…</option>{okPeople.map((p) => <option key={p.email} value={p.email.trim().toLowerCase()}>{p.name}</option>)}
            </select>
            <input aria-label="When" type="datetime-local" value={meeting.when} onChange={(e) => setMeeting({ ...meeting, when: e.target.value })} />
          </div>
          <div className="ob-row">
            <input aria-label="Promise" value={promise.what} onChange={(e) => setPromise({ ...promise, what: e.target.value })} placeholder="A promise, e.g. Send Sam the launch plan" />
            <select aria-label="To" value={promise.to} onChange={(e) => setPromise({ ...promise, to: e.target.value })}>
              <option value="">to…</option>{okPeople.map((p) => <option key={p.email} value={p.email.trim().toLowerCase()}>{p.name}</option>)}
            </select>
            <select aria-label="About document" value={promise.document} onChange={(e) => setPromise({ ...promise, document: e.target.value })}>
              <option value="">about…</option>{okDocs.map((d) => <option key={d.title} value={d.title.trim()}>{d.title}</option>)}
            </select>
            <input aria-label="By" type="datetime-local" value={promise.by} onChange={(e) => setPromise({ ...promise, by: e.target.value })} />
          </div>
        </>}
        {step === "prefs" && (
          <div className="ob-row">
            <label>Timezone<input value={timezone} onChange={(e) => setTimezone(e.target.value)} /></label>
            <label>No meetings before<input type="time" value={early} onChange={(e) => setEarly(e.target.value)} /></label>
          </div>
        )}
        {step === "connect" && (
          <div className="ob-connect">
            {CONNECT.map((c) => (
              <label key={c.id} className={`ob-tool ${wants.includes(c.id) ? "on" : ""}`}>
                <input type="checkbox" checked={wants.includes(c.id)} onChange={(e) => setWants((w) => (e.target.checked ? [...w, c.id] : w.filter((x) => x !== c.id)))} />
                <span><b>{c.label}</b><small>{c.what}</small></span>
              </label>
            ))}
            <p className="ws-muted">Connecting a tool never approves an action: every email, share or invite still goes through the Sentinel, and anything it asks about waits for you. Nothing shows as connected until Google confirms it. On this public demo, your workspace runs on what you tell it; your own MCP agent (Claude Code or any other) can bring its own tools.</p>
          </div>
        )}
        {step === "summary" && (
          <div className="ob-summary">
            <p>{intro}</p>
            <p className="ws-muted">This becomes your own private graph. Only this browser can approve what {agent} asks. Use made-up names if you prefer; nothing is sent anywhere.</p>
          </div>
        )}
        {error && <div className="ws-banner bad" role="alert">{error}</div>}
        <div className="ws-btns">
          <button className="ws-primary" disabled={busy || (step === "name" && !name.trim())}>
            {step === "summary" ? (busy ? "Building your graph…" : `Start working with ${agent}`) : "Next"}
          </button>
          {!["name", "summary"].includes(step) && <button type="button" className="ws-ghost" onClick={next}>Skip</button>}
          <button type="button" className="ws-link" onClick={back}>Back</button>
        </div>
      </form>
    </div>
  );
}
