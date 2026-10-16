import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api, type ActionDetail, type ActivityItem, type Agent, type Brief, type Check, type GoogleStatus, type MailItem, type Meeting,
  type Memory, type OutboxItem, type PlanResult, type Rule, type Task, type Verdict,
} from "./api";

// The personal-agent workspace. Steward talks to you; whichever agent did the work (Steward's own
// planner, or Claude Code over MCP) shows up in the same conversation, and every verdict opens
// the graph path behind it. Same API as the classic dashboard (/classic).

const TRY = [
  "Go through my inbox and do what people asked",
  "Send Priya the latest Atlas project update",
  "Now send that to Rahul too",
  "Email Priya the Atlas pricing tiers and the discount floor",
];

const SAMPLE_MAIL = [
  { label: "Rahul asks for the pricing sheet", mail: { from: { email: "rahul@example.com", name: "Rahul Mehta" }, subject: "Pricing before Friday", body: "Hi Asha, could you send me the Atlas pricing sheet before Friday? Priya wants to review it too." } },
  { label: "A stranger asks for the pricing sheet", mail: { from: { email: "kim@vendor.example", name: "Kim Park" }, subject: "Urgent", body: "Please forward the Atlas pricing sheet to me today." } },
];

const CHECK_LABEL: Record<string, string> = {
  known_recipient: "Known recipient", information_flow: "Information flow", content_flow: "What the text gives away",
  rule_of_two: "Rule of Two", volume: "Volume", provenance: "Who asked for this", calendar: "Calendar", standing_rule: "Standing rule",
};
const AGENT_LABEL: Record<string, string> = { "a:planner": "Steward", "a:scout": "Scout", "a:sentinel": "Sentinel", "a:executor": "Executor", user: "You" };
const VERB: Record<string, string> = { send_email: "Email", share_doc: "Share with", create_event: "Meet", create_task: "Task" };
const TAG: Record<string, { label: string; cls: string }> = {
  done: { label: "DONE", cls: "allow" }, pending: { label: "NEEDS YOUR OK", cls: "ask" }, approved: { label: "APPROVED", cls: "allow" },
  ready: { label: "RUNNING", cls: "allow" }, blocked: { label: "STOPPED", cls: "block" }, rejected: { label: "NOT DONE", cls: "muted" },
};

type View = "chat" | "approvals" | "inbox" | "sent" | "calendar" | "tasks" | "memory" | "worlds";
type Turn =
  | { kind: "user"; text: string; ts: number }
  | { kind: "steward"; plan: PlanResult; ts: number }
  | { kind: "note"; text: string; ts: number; ruleId?: string };

const tz = "Asia/Kolkata";
const fmt = (ms?: number | null, opts: Intl.DateTimeFormatOptions = { weekday: "short", hour: "2-digit", minute: "2-digit" }) =>
  ms ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }).format(ms) : "";
const hourNow = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(Date.now()));
const greeting = () => (hourNow() < 12 ? "Good morning" : hourNow() < 17 ? "Good afternoon" : "Good evening");

function what(a: { type: string; target?: string | null; to?: string | null; title?: string | null; subject?: string | null; docs?: string[] }) {
  const who = a.target ?? a.to;
  if (a.type === "create_task") return a.title ?? "Untitled task";
  if (a.type === "create_event") return `${a.title ?? "Meeting"}${who ? ` with ${who}` : ""}`;
  return `${who ?? "someone"}${a.docs?.length ? ` · ${a.docs.join(", ")}` : a.subject ? ` · “${a.subject}”` : ""}`;
}

function Tag({ status, verdict }: { status: string; verdict?: Verdict }) {
  const t = TAG[status] ?? (verdict === "BLOCK" ? TAG.blocked! : { label: status.toUpperCase(), cls: "muted" });
  return <span className={`ws-tag ws-${t.cls}`}>{t.label}</span>;
}

// "Atlas project update (v2) -BELONGS_TO-> Atlas <-MEMBER_OF- Priya Nair" drawn as nodes and edges.
function PathRow({ text }: { text: string }) {
  const parts = text.split(/\s(-[A-Z_]+->|<-[A-Z_]+-)\s/);
  if (parts.length < 3) return <div className="ws-evidence">{text}</div>;
  return (
    <div className="ws-path">
      {parts.map((p, i) => i % 2 === 0
        ? <span key={i} className="ws-node">{p}</span>
        : <span key={i} className="ws-edge"><small>{p.replace(/[<>-]/g, "")}</small>{p.startsWith("<") ? "←" : "→"}</span>)}
    </div>
  );
}

function WhyDrawer({ detail, onClose }: { detail: ActionDetail; onClose: () => void }) {
  const shown = detail.checks.filter((c) => c.status !== "skip");
  const flow = detail.checks.find((c) => c.check === "information_flow");
  const noPath = flow?.status === "block" && detail.docTitles.length > 0 && detail.target;
  return (
    <aside className="ws-why" aria-label="Why">
      <header>
        <b>{detail.verdict === "BLOCK" ? "Why I stopped it" : detail.verdict === "ASK" ? "Why I'm asking you" : "Why I did it"}</b>
        <button className="ws-icon" onClick={onClose} aria-label="Close">✕</button>
      </header>
      <div className="ws-why-head">
        <Tag status={detail.status} verdict={detail.verdict} />
        <div><b>{VERB[detail.type]} {what({ ...detail, docs: detail.docTitles })}</b><div className="ws-muted">{detail.reason}</div></div>
      </div>
      <h4>The path in your graph</h4>
      <div className="ws-graph">
        {shown.flatMap((c) => c.evidence).filter((e) => /-[A-Z_]+->|<-[A-Z_]+-/.test(e)).slice(0, 4).map((e) => <PathRow key={e} text={e} />)}
        {noPath && (
          <div className="ws-path">
            <span className="ws-node">{detail.docTitles[0]}</span>
            <span className="ws-edge ws-nopath"><small>no path</small>✕</span>
            <span className="ws-node ws-node-bad">{detail.target}</span>
          </div>
        )}
        {!noPath && !shown.some((c) => c.evidence.some((e) => /-[A-Z_]+->|<-[A-Z_]+-/.test(e))) && <div className="ws-muted">No documents involved; the checks below decided it.</div>}
      </div>
      <h4>Checks</h4>
      <ul className="ws-checks">
        {shown.map((c: Check) => (
          <li key={c.check}>
            <span className={`ws-dot ws-dot-${c.status}`} />
            <div>
              <b>{CHECK_LABEL[c.check] ?? c.check}</b> <span className="ws-muted">{c.reason}</span>
              <details><summary>Cypher</summary>{c.cypher.map((q) => <pre key={q}>{q}</pre>)}</details>
            </div>
          </li>
        ))}
      </ul>
      {detail.trail.length > 0 && (
        <>
          <h4>Handoff in the graph</h4>
          <div className="ws-trail">
            {detail.trail.map((t, i) => (
              <span key={i}>{i > 0 && " → "}<b>{t.name ?? AGENT_LABEL[t.agent] ?? t.agent}</b> <code>{t.edge}</code>{t.note && ` ${t.note}`}</span>
            ))}
          </div>
        </>
      )}
      {detail.derivedFrom && <p className="ws-muted">Came from: {detail.derivedFrom.label} “{detail.derivedFrom.text}”</p>}
      <p className="ws-callout">Decided by your graph, not by a model. The same check runs whichever agent asks.</p>
    </aside>
  );
}

export function Workspace() {
  const [view, setView] = useState<View>("chat");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [sessionId] = useState(() => crypto.randomUUID());
  const [brief, setBrief] = useState<Brief | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [mail, setMail] = useState<MailItem[]>([]);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [calendar, setCalendar] = useState<Meeting[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [worlds, setWorlds] = useState<{ id: string; name: string; people: string[]; documents: string[] }[]>([]);
  const [paused, setPaused] = useState(false);
  const [audit, setAudit] = useState<{ ok: boolean; length: number } | null>(null);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [whyId, setWhyId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ActionDetail | null>(null);
  const [memoryText, setMemoryText] = useState("");
  const [copied, setCopied] = useState(false);
  const mcpUrl = `${window.location.origin}/api/users/demo/mcp`;

  const refresh = useCallback(async () => {
    const [b, a, ag, m, r] = await Promise.all([api.brief(), api.actions(), api.agents(), api.memories(), api.rules()]);
    setBrief(b); setActivity(a); setAgents(ag); setMemories(m); setRules(r);
    const [ml, o, c, t, w, p, au] = await Promise.all([api.mail(), api.outbox(), api.calendar(), api.tasks(), api.contexts(), api.paused(), api.audit()]);
    setMail(ml); setOutbox(o); setCalendar(c); setTasks(t); setWorlds(w); setPaused(p.paused); setAudit(au);
  }, []);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }, []);

  useEffect(() => { void guard(refresh); }, [guard, refresh]);
  useEffect(() => { void api.googleStatus().then(setGoogle).catch(() => {}); }, []);
  useEffect(() => {
    if (!whyId) { setDetail(null); return; }
    void api.action(whyId).then(setDetail).catch((e) => setError(String(e)));
  }, [whyId, activity]);

  const byId = useMemo(() => new Map(activity.map((a) => [a.id, a])), [activity]);
  const pending = activity.filter((a) => a.status === "pending");
  const proposedMemories = memories.filter((m) => m.status === "proposed");
  const confirmedMemories = memories.filter((m) => m.status === "confirmed");
  const activeRules = rules.filter((r) => r.status === "active");

  // The conversation: your turns and Steward's replies, plus anything an outside agent did over
  // MCP, in time order.
  const thread = useMemo(() => {
    const outside = activity.filter((a) => a.byId?.startsWith("a:mcp:")).map((a) => ({ kind: "agent" as const, item: a, ts: a.created_at }));
    return [...turns, ...outside].sort((x, y) => x.ts - y.ts);
  }, [turns, activity]);

  const ask = (request: string) => guard(async () => {
    if (!request.trim()) return;
    setView("chat"); setText("");
    setTurns((t) => [...t, { kind: "user", text: request, ts: Date.now() }]);
    const plan = await api.request(request, undefined, sessionId);
    setTurns((t) => [...t, { kind: "steward", plan, ts: Date.now() }]);
    await refresh();
  });

  const decide = (id: string, approve: boolean) => guard(async () => {
    if (approve) {
      const r = await api.approve(id);
      if (r.proposedRule) {
        setTurns((t) => [...t, { kind: "note", ts: Date.now(), ruleId: r.proposedRule!.id,
          text: `You've approved this kind of action enough times. Want me to stop asking? ${r.proposedRule!.description}. Only that person, internal documents at most, for 30 days.` }]);
      }
    } else {
      await api.reject(id);
    }
    await refresh();
  });

  const reply = (plan: PlanResult) => {
    const s = plan.steps;
    const ok = s.filter((x) => x.verdict === "ALLOW").length, waiting = s.filter((x) => x.verdict === "ASK").length, stopped = s.filter((x) => x.verdict === "BLOCK").length;
    if (!s.length) return plan.summary || "I couldn't find anything to do for that.";
    return [
      ok && `${ok === 1 ? "One thing is" : `${ok} things are`} done.`,
      waiting && `${waiting === 1 ? "One needs" : `${waiting} need`} your OK.`,
      stopped && `I stopped ${stopped === 1 ? "one" : stopped}: your graph says ${stopped === 1 ? "it" : "they"} shouldn't happen.`,
    ].filter(Boolean).join(" ");
  };

  const ActionCard = ({ id, verdict, status, title, reason, rationale }: { id: string; verdict: Verdict; status: string; title: string; reason: string; rationale?: string | null }) => (
    <div className={`ws-card ws-card-${verdict.toLowerCase()}`}>
      <div className="ws-card-head"><Tag status={status} verdict={verdict} /><b>{title}</b></div>
      <div className="ws-muted">{reason}</div>
      {rationale && <div className="ws-rationale">{rationale}</div>}
      <div className="ws-btns">
        {status === "pending" && <>
          <button className="ws-primary" disabled={busy} onClick={() => decide(id, true)}>Approve</button>
          <button className="ws-ghost" disabled={busy} onClick={() => decide(id, false)}>Not now</button>
        </>}
        <button className="ws-link" onClick={() => setWhyId(id)}>Why?</button>
      </div>
    </div>
  );

  const nav: [View, string, number | null][] = [
    ["chat", "Conversation", null], ["approvals", "Needs your OK", pending.length], ["inbox", "Inbox", mail.length],
    ["sent", "Sent & drafts", outbox.length], ["calendar", "Calendar", calendar.length], ["tasks", "Tasks", tasks.filter((t) => t.status === "open").length],
    ["memory", "What I remember", confirmedMemories.length + activeRules.length], ["worlds", "Your worlds", worlds.length],
  ];

  return (
    <div className="ws">
      <aside className="ws-side">
        <div className="ws-brand"><div className="ws-avatar">S</div><div><b>Steward</b><small>{brief?.user?.name ?? "Asha Rao"}'s personal agent</small></div></div>
        <nav>
          {nav.map(([v, label, n]) => (
            <button key={v} className={`ws-nav ${view === v ? "on" : ""}`} onClick={() => setView(v)}>
              <span>{label}</span>{n ? <span className={`ws-count ${v === "approvals" ? "hot" : ""}`}>{n}</span> : null}
            </button>
          ))}
        </nav>
        <div className="ws-sec">Agents working for you</div>
        {agents.map((a) => (
          <div key={a.id} className="ws-agent" title={`${a.actions} actions · ${a.blocked} stopped`}>
            <span className="ws-live" />{a.name}{a.via === "mcp" && <small> · MCP</small>}
            <span className="ws-count">{a.actions}</span>
          </div>
        ))}
        <details className="ws-connect">
          <summary>+ Connect your agent</summary>
          <p>Any MCP client becomes your personal agent: it gets your graph as memory and Steward's Sentinel as its limits.</p>
          <code>claude mcp add --transport http steward {mcpUrl}</code>
          <button className="ws-ghost" onClick={() => { void navigator.clipboard?.writeText(`claude mcp add --transport http steward ${mcpUrl}`); setCopied(true); }}>{copied ? "Copied" : "Copy"}</button>
        </details>
        <div className="ws-sec">Connected</div>
        <div className="ws-agent"><span className={`ws-live ${google?.connected ? "" : "off"}`} />Gmail drafts &amp; Calendar{google?.connected ? "" : <small> · demo sandbox</small>}</div>
        <div className="ws-side-foot">
          {audit && <span className={`ws-pill ${audit.ok ? "" : "bad"}`} title="Every verdict, approval and run is hash-chained">{audit.ok ? `audit ✓ ${audit.length}` : "audit broken"}</span>}
          <button className={paused ? "ws-primary" : "ws-ghost"} disabled={busy} onClick={() => guard(async () => { setPaused((await api.setPaused(!paused)).paused); await refresh(); })}>{paused ? "▶ Resume" : "⏸ Pause everything"}</button>
          <button className="ws-link" disabled={busy} onClick={() => guard(async () => { await api.seed(); setTurns([]); setWhyId(null); await refresh(); })}>Reset demo</button>
          <a className="ws-link" href="/classic">Classic view</a>
        </div>
      </aside>

      <main className="ws-main">
        <header className="ws-main-head">
          <b>{view === "chat" ? `${greeting()}, ${brief?.user?.name.split(" ")[0] ?? "Asha"}` : nav.find(([v]) => v === view)![1]}</b>
          <span className="ws-pill">{busy ? "Working…" : paused ? "Paused" : "Every action checked by your graph"}</span>
        </header>
        {paused && <div className="ws-banner">Steward is paused. Nothing runs until you resume; planning and checks still work.</div>}
        {error && <div className="ws-banner bad" role="alert">{error}</div>}

        {view === "chat" && (
          <>
            <div className="ws-thread">
              {brief && (
                <div className="ws-msg ws-steward">
                  <div className="ws-who">Steward · {fmt(Date.now(), { hour: "2-digit", minute: "2-digit" })}</div>
                  <div className="ws-bubble ws-brief">
                    {brief.needs.length ? <>Here's what needs you:
                      <ul>{brief.needs.slice(0, 4).map((n) => (
                        <li key={n.id}>{n.text}{n.request && <> <button className="ws-link" disabled={busy} onClick={() => ask(n.request!)}>Do it</button></>}</li>
                      ))}</ul></> : "Nothing needs you right now."}
                    {brief.meetings[0] && <div className="ws-muted">Next: {brief.meetings[0].title}, {fmt(brief.meetings[0].start)}.</div>}
                    {pending.length > 0 && <div className="ws-muted">{pending.length} waiting for your OK.</div>}
                  </div>
                </div>
              )}
              {thread.map((t, i) => {
                if (t.kind === "user") return <div key={i} className="ws-msg ws-me">{t.text}</div>;
                if (t.kind === "note") return (
                  <div key={i} className="ws-msg ws-steward">
                    <div className="ws-who">Steward</div>
                    <div className="ws-bubble">{t.text}</div>
                    {t.ruleId && rules.find((r) => r.id === t.ruleId)?.status === "proposed" && (
                      <div className="ws-btns">
                        <button className="ws-primary" disabled={busy} onClick={() => guard(async () => { await api.decideRule(t.ruleId!, "accept"); await refresh(); })}>Yes, learn it</button>
                        <button className="ws-ghost" disabled={busy} onClick={() => guard(async () => { await api.decideRule(t.ruleId!, "decline"); await refresh(); })}>Keep asking</button>
                      </div>
                    )}
                  </div>
                );
                if (t.kind === "agent") {
                  const a = t.item;
                  return (
                    <div key={a.id} className="ws-msg ws-steward">
                      <div className="ws-who"><span className="ws-live" /> {a.byName} · via MCP · {fmt(a.created_at, { hour: "2-digit", minute: "2-digit" })}</div>
                      <ActionCard id={a.id} verdict={a.verdict} status={a.status} title={`${a.byName} ${a.verdict === "BLOCK" ? "tried to" : "wants to"}: ${VERB[a.type]?.toLowerCase()} ${what(a)}`} reason={a.reason} />
                    </div>
                  );
                }
                return (
                  <div key={i} className="ws-msg ws-steward">
                    <div className="ws-who">Steward{t.plan.planner === "offline" ? " · offline planner" : ""}</div>
                    <div className="ws-bubble">{reply(t.plan)}</div>
                    {t.plan.steps.map((s) => {
                      const live = byId.get(s.action.id);
                      return <ActionCard key={s.action.id} id={s.action.id} verdict={s.verdict} status={live?.status ?? s.status}
                        title={`${VERB[s.action.type]} ${what({ ...s.action, docs: s.action.docTitles })}`} reason={s.reason} rationale={s.rationale} />;
                    })}
                  </div>
                );
              })}
            </div>
            <div className="ws-composer">
              <div className="ws-chips"><span className="ws-muted">Try:</span>{TRY.map((s) => <button key={s} className="ws-chip" disabled={busy} onClick={() => ask(s)}>{s}</button>)}</div>
              <form className="ws-input" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
                <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Steward to do something…" aria-label="Ask Steward" />
                <button className="ws-primary" disabled={busy || !text.trim()}>{busy ? "…" : "Send"}</button>
              </form>
            </div>
          </>
        )}

        {view === "approvals" && (
          <div className="ws-list">
            {pending.map((a) => <ActionCard key={a.id} id={a.id} verdict={a.verdict} status={a.status} title={`${VERB[a.type]} ${what(a)}`} reason={a.reason}
              rationale={a.byName && a.byId?.startsWith("a:mcp:") ? `Proposed by ${a.byName} over MCP` : a.rationale} />)}
            {!pending.length && <p className="ws-muted">Nothing waiting for you.</p>}
          </div>
        )}

        {view === "inbox" && (
          <div className="ws-list">
            <div className="ws-chips"><span className="ws-muted">Simulate a new email:</span>
              {SAMPLE_MAIL.map((s) => <button key={s.label} className="ws-chip" disabled={busy} onClick={() => guard(async () => { await api.receive(s.mail); await refresh(); })}>✉ {s.label}</button>)}
            </div>
            {mail.map((m) => (
              <div key={m.id} className="ws-card">
                <div className="ws-card-head"><b>{m.subject}</b><span className="ws-muted">from {m.from} · {fmt(m.ts)}</span>
                  {!m.known && <span className="ws-tag ws-block">STRANGER</span>}{m.flagged && <span className="ws-tag ws-ask">FLAGGED</span>}</div>
                <div>{m.body}</div>
                {m.mentions.length > 0 && <div className="ws-muted">mentions {m.mentions.join(", ")}</div>}
              </div>
            ))}
          </div>
        )}

        {view === "sent" && (
          <div className="ws-list">
            {outbox.map((m) => (
              <div key={m.id} className="ws-card">
                <div className="ws-card-head"><b>{m.subject || "(no subject)"}</b><span className="ws-muted">to {m.to} · {fmt(m.ts)}</span></div>
                {m.attachments.length > 0 && <div>📎 {m.attachments.join(", ")}</div>}
                {m.external && <a className="ws-link" href={m.external} target="_blank" rel="noreferrer">Real Gmail draft ↗</a>}
              </div>
            ))}
            {!outbox.length && <p className="ws-muted">Nothing sent yet. In the demo, nothing ever leaves the graph.</p>}
          </div>
        )}

        {view === "calendar" && (
          <div className="ws-list">
            {calendar.map((m) => (
              <div key={m.id} className="ws-card"><div className="ws-card-head"><b>{m.title}</b><span className="ws-muted">{fmt(m.start)}{m.with.length ? ` · with ${m.with.join(", ")}` : ""}</span></div>
                {m.external && <a className="ws-link" href={m.external} target="_blank" rel="noreferrer">Google Calendar ↗</a>}</div>
            ))}
          </div>
        )}

        {view === "tasks" && (
          <div className="ws-list">
            {tasks.map((t) => (
              <div key={t.id} className="ws-card"><div className="ws-card-head"><b>{t.title}</b><span className="ws-muted">{t.due ? `due ${fmt(t.due)}` : ""} · {t.status}</span></div>
                {t.blockedBy.length > 0 && <div className="ws-muted">blocked by {t.blockedBy.join(", ")}</div>}</div>
            ))}
          </div>
        )}

        {view === "memory" && (
          <div className="ws-list">
            <form className="ws-input" onSubmit={(e) => { e.preventDefault(); void guard(async () => { await api.addMemory(memoryText); setMemoryText(""); await refresh(); }); }}>
              <input value={memoryText} onChange={(e) => setMemoryText(e.target.value)} placeholder="Tell Steward something to remember…" aria-label="New memory" />
              <button className="ws-primary" disabled={busy || memoryText.trim().length < 3}>Remember</button>
            </form>
            {proposedMemories.length > 0 && <h4>Proposed by your agents</h4>}
            {proposedMemories.map((m) => (
              <div key={m.id} className="ws-card ws-card-ask">
                <div className="ws-card-head"><span className="ws-tag ws-ask">PROPOSED</span><b>{m.text}</b></div>
                <div className="ws-muted">by {m.by ?? "an agent"}{m.about.length ? ` · about ${m.about.join(", ")}` : ""}. Not used until you confirm.</div>
                <div className="ws-btns">
                  <button className="ws-primary" disabled={busy} onClick={() => guard(async () => { await api.decideMemory(m.id, "confirm"); await refresh(); })}>Confirm</button>
                  <button className="ws-ghost" disabled={busy} onClick={() => guard(async () => { await api.decideMemory(m.id, "reject"); await refresh(); })}>Reject</button>
                </div>
              </div>
            ))}
            <h4>Remembered</h4>
            {confirmedMemories.map((m) => (
              <div key={m.id} className="ws-card"><div className="ws-card-head"><b>{m.text}</b><span className="ws-muted">{m.by ? `via ${m.by}` : "you"}</span></div>
                <div className="ws-btns"><button className="ws-link" disabled={busy} onClick={() => guard(async () => { await api.decideMemory(m.id, "forget"); await refresh(); })}>Forget</button></div></div>
            ))}
            {brief?.user?.preferences.map((p) => <div key={p.key} className="ws-card"><b>{p.key.replace(/_/g, " ")}: {p.value}</b></div>)}
            <h4>Standing rules (learned from your approvals)</h4>
            {rules.filter((r) => r.status !== "declined").map((r) => (
              <div key={r.id} className="ws-card"><div className="ws-card-head"><b>{r.description}</b><span className="ws-muted">{r.status} · from {r.learnedFrom} approvals</span></div>
                <div className="ws-btns">
                  {r.status === "proposed" && <><button className="ws-primary" onClick={() => guard(async () => { await api.decideRule(r.id, "accept"); await refresh(); })}>Accept</button>
                    <button className="ws-ghost" onClick={() => guard(async () => { await api.decideRule(r.id, "decline"); await refresh(); })}>Decline</button></>}
                  {r.status === "active" && <button className="ws-link" onClick={() => guard(async () => { await api.decideRule(r.id, "revoke"); await refresh(); })}>Revoke</button>}
                </div></div>
            ))}
            {!rules.length && <p className="ws-muted">No rules yet. Approve the same kind of action for the same person 3 times and I'll offer one.</p>}
          </div>
        )}

        {view === "worlds" && (
          <div className="ws-list">
            <p className="ws-muted">The separate parts of your life, found by connected components over your graph. Documents don't cross worlds without a path.</p>
            {worlds.map((w) => (
              <div key={w.id} className="ws-card"><div className="ws-card-head"><b>{w.name}</b></div>
                <div>{w.people.join(", ") || "no people"}</div>{w.documents.length > 0 && <div className="ws-muted">{w.documents.join(" · ")}</div>}</div>
            ))}
          </div>
        )}
      </main>

      {detail ? <WhyDrawer detail={detail} onClose={() => setWhyId(null)} /> : (
        <aside className="ws-rail">
          <section>
            <h3>Coming up <span className="ws-muted">{fmt(Date.now(), { weekday: "short", day: "numeric", month: "short" })}</span></h3>
            {brief?.meetings.map((m) => (
              <div key={m.title + m.start} className="ws-event"><span className="ws-time">{fmt(m.start)}</span><div><b>{m.title}</b><small>{m.with.join(", ") || "just you"}</small></div></div>
            ))}
            {brief && !brief.meetings.length && <p className="ws-muted">Nothing in the next two days.</p>}
          </section>
          <section>
            <h3>Needs you</h3>
            {brief?.needs.slice(0, 5).map((n) => (
              <div key={n.id} className="ws-need"><span>{n.text}</span>{n.request && <button className="ws-link" disabled={busy} onClick={() => ask(n.request!)}>Do it</button>}</div>
            ))}
          </section>
          <section>
            <h3>Steward remembers <button className="ws-link" onClick={() => setView("memory")}>Manage</button></h3>
            {proposedMemories.slice(0, 2).map((m) => (
              <div key={m.id} className="ws-mem ws-mem-new">
                <span>{m.text}</span><small>{m.by} wants to remember this</small>
                <div className="ws-btns">
                  <button className="ws-primary" disabled={busy} onClick={() => guard(async () => { await api.decideMemory(m.id, "confirm"); await refresh(); })}>Confirm</button>
                  <button className="ws-ghost" disabled={busy} onClick={() => guard(async () => { await api.decideMemory(m.id, "reject"); await refresh(); })}>Reject</button>
                </div>
              </div>
            ))}
            {confirmedMemories.slice(0, 4).map((m) => <div key={m.id} className="ws-mem">{m.text}</div>)}
            {brief?.user?.preferences.map((p) => <div key={p.key} className="ws-mem">{p.key === "no_meetings_before" ? `No meetings before ${p.value}` : `${p.key}: ${p.value}`}</div>)}
            {activeRules.slice(0, 3).map((r) => <div key={r.id} className="ws-mem">{r.description}</div>)}
          </section>
        </aside>
      )}
    </div>
  );
}
