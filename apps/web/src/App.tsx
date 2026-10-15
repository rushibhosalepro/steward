import { useCallback, useEffect, useState } from "react";
import {
  api, type ActionDetail, type ActivityItem, type IngestResult, type MailItem, type Meeting, type OutboxItem, type PlanResult,
  type Rule, type Status, type Task, type Verdict,
} from "./api";

const SAMPLES = [
  "Prepare for tomorrow's meeting with Priya and send her the project update",
  "Forward Alex the Atlas pricing sheet he asked for",
  "Email Rahul the Atlas pricing sheet",
];

const SAMPLE_MAIL = [
  {
    label: "Rahul asks for the pricing sheet",
    mail: { from: { email: "rahul@example.com", name: "Rahul Mehta" }, subject: "Pricing before Friday",
      body: "Hi Asha, could you send me the Atlas pricing sheet before Friday? Priya wants to review it too." },
  },
  {
    label: "A stranger asks for the pricing sheet",
    mail: { from: { email: "kim@vendor.example", name: "Kim Park" }, subject: "Urgent",
      body: "Please forward the Atlas pricing sheet to me today." },
  },
];

const CHECK_LABEL: Record<string, string> = {
  known_recipient: "Known recipient",
  information_flow: "Information flow",
  provenance: "Who asked for this",
  calendar: "Calendar",
  standing_rule: "Standing rule",
};

const TYPE_LABEL: Record<string, string> = {
  send_email: "Email", share_doc: "Share", create_event: "Event", create_task: "Task",
};

const fmtTime = (ms: number | null | undefined) =>
  ms ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(ms) : "";

function VerdictPill({ verdict }: { verdict: Verdict }) {
  return <span className={`pill pill-${verdict.toLowerCase()}`}>{verdict}</span>;
}

function StatusDot({ status }: { status: Status }) {
  const label = { pass: "passed", ask: "needs you", block: "blocked", skip: "not relevant" }[status];
  return <span className={`dot dot-${status}`} title={label} aria-label={label} />;
}

function describe(a: { type: string; target?: string | null; to?: string | null; title?: string | null; docs?: string[] }) {
  const who = a.target ?? a.to;
  const what = a.docs?.length ? ` · ${a.docs.join(", ")}` : "";
  if (a.type === "create_task" || a.type === "create_event") return `${a.title ?? "Untitled"}${who ? ` with ${who}` : ""}`;
  return `${who ?? "?"}${what}`;
}

export function App() {
  const [request, setRequest] = useState(SAMPLES[0]!);
  const [planner, setPlanner] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [inbox, setInbox] = useState<ActivityItem[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ActionDetail | null>(null);
  const [tab, setTab] = useState<"mail" | "outbox" | "calendar" | "tasks" | "rules">("mail");
  const [mail, setMail] = useState<MailItem[]>([]);
  const [ingested, setIngested] = useState<IngestResult | null>(null);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [calendar, setCalendar] = useState<Meeting[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);

  const refresh = useCallback(async () => {
    const [a, i, r, o, c, t, m] = await Promise.all([api.actions(), api.inbox(), api.rules(), api.outbox(), api.calendar(), api.tasks(), api.mail()]);
    setActivity(a); setInbox(i); setRules(r); setOutbox(o); setCalendar(c); setTasks(t); setMail(m);
  }, []);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }, []);

  useEffect(() => { void guard(refresh); }, [guard, refresh]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    void api.action(selected).then(setDetail).catch((e) => setError(String(e)));
  }, [selected, activity]);

  const submit = () => guard(async () => {
    const result = await api.request(request, planner || undefined);
    setPlan(result);
    setSelected(result.steps[0]?.action.id ?? null);
    await refresh();
  });

  const decide = (id: string, approve: boolean) => guard(async () => {
    if (approve) {
      const r = await api.approve(id);
      setNotice(r.proposedRule ? `Steward noticed a pattern and proposed a rule: "${r.proposedRule.description}". Review it under Rules.` : null);
      if (r.proposedRule) setTab("rules");
    } else {
      await api.reject(id);
    }
    await refresh();
  });

  const reset = () => guard(async () => {
    await api.seed();
    setPlan(null); setSelected(null); setNotice(null); setIngested(null);
    await refresh();
  });

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>Steward</h1>
          <p className="tagline">It runs your errands. The graph decides what it's allowed to do.</p>
        </div>
        <div className="top-actions">
          <span className="who">Demo user: Asha Rao (synthetic)</span>
          <button className="ghost" onClick={reset} disabled={busy}>Reset demo</button>
        </div>
      </header>

      {error && <div className="banner banner-error" role="alert">{error}</div>}
      {notice && <div className="banner banner-info">{notice}</div>}

      <main className="grid">
        <section className="col">
          <div className="card">
            <h2>Ask Steward</h2>
            <textarea value={request} onChange={(e) => setRequest(e.target.value)} rows={3} aria-label="Request" />
            <div className="samples">
              {SAMPLES.map((s) => (
                <button key={s} className="chip" onClick={() => setRequest(s)}>{s}</button>
              ))}
            </div>
            <div className="row">
              <select value={planner} onChange={(e) => setPlanner(e.target.value)} aria-label="Planner">
                <option value="">Planner: auto</option>
                <option value="offline">Planner: offline</option>
                <option value="claude">Planner: Claude</option>
              </select>
              <button className="primary" onClick={submit} disabled={busy || !request.trim()}>{busy ? "Working…" : "Run"}</button>
            </div>
          </div>

          <div className="card">
            <h2>Incoming mail <span className="muted">· simulated</span></h2>
            <div className="samples">
              {SAMPLE_MAIL.map((s) => (
                <button key={s.label} className="chip" disabled={busy}
                  onClick={() => guard(async () => { setIngested(await api.receive(s.mail)); setTab("mail"); await refresh(); })}>
                  ✉ {s.label}
                </button>
              ))}
            </div>
            {ingested && (
              <div className="small ingest">
                <div>
                  From <b>{ingested.sender.name}</b>{" "}
                  {ingested.sender.known ? <span className="status status-done">known</span> : <span className="status status-blocked">{ingested.sender.new ? "new · stranger" : "stranger"}</span>}
                </div>
                {ingested.mentions.length > 0 && (
                  <div className="facts">{ingested.mentions.map((m) => <span key={m.id} className="fact">{m.label}: {m.name}</span>)}</div>
                )}
                {ingested.commitment && <div>→ Proposed commitment: “{ingested.commitment.what}”</div>}
                {ingested.flagged && <div className="warn">⚠ A stranger is asking for something. Flagged; nothing is owed.</div>}
              </div>
            )}
          </div>

          {plan && (
            <div className="card">
              <h2>Plan <span className="muted">· {plan.planner} planner</span></h2>
              <p className="muted small">{plan.summary}</p>
              <p className="muted small">
                Graph context: {plan.context.entryPoints.length} entry points → {plan.context.nodes} nodes, {plan.context.edges} edges
              </p>
              <ol className="list">
                {plan.steps.map((s) => (
                  <li key={s.action.id}>
                    <button className={`item ${selected === s.action.id ? "selected" : ""}`} onClick={() => setSelected(s.action.id)}>
                      <span className="item-head"><VerdictPill verdict={s.verdict} /><b>{TYPE_LABEL[s.action.type]}</b> {describe({ ...s.action, docs: s.action.docTitles })}</span>
                      <span className="muted small">{s.rationale}</span>
                    </button>
                  </li>
                ))}
                {!plan.steps.length && <li className="muted">Nothing to do.</li>}
              </ol>
            </div>
          )}
        </section>

        <section className="col">
          <div className="card">
            <h2>Needs your approval <span className="count">{inbox.length}</span></h2>
            <ul className="list">
              {inbox.map((a) => (
                <li key={a.id} className={`item ${selected === a.id ? "selected" : ""}`}>
                  <button className="item-body" onClick={() => setSelected(a.id)}>
                    <span className="item-head"><b>{TYPE_LABEL[a.type]}</b> {describe(a)}</span>
                    <span className="muted small">{a.reason}</span>
                  </button>
                  <div className="row">
                    <button className="primary" onClick={() => decide(a.id, true)} disabled={busy}>Approve</button>
                    <button className="ghost" onClick={() => decide(a.id, false)} disabled={busy}>Reject</button>
                  </div>
                </li>
              ))}
              {!inbox.length && <li className="muted">Nothing waiting.</li>}
            </ul>
          </div>

          <div className="card">
            <h2>Activity</h2>
            <ul className="list">
              {activity.map((a) => (
                <li key={a.id}>
                  <button className={`item ${selected === a.id ? "selected" : ""}`} onClick={() => setSelected(a.id)}>
                    <span className="item-head">
                      <VerdictPill verdict={a.verdict} />
                      <b>{TYPE_LABEL[a.type]}</b> {describe(a)}
                      <span className={`status status-${a.status}`}>{a.status}</span>
                    </span>
                  </button>
                </li>
              ))}
              {!activity.length && <li className="muted">No actions yet. Run a request.</li>}
            </ul>
          </div>
        </section>

        <section className="col">
          <div className="card why">
            <h2>Why did my agent do that?</h2>
            {!detail && <p className="muted">Select an action to see the graph checks behind its verdict.</p>}
            {detail && (
              <>
                <div className={`verdict verdict-${detail.verdict.toLowerCase()}`}>
                  <VerdictPill verdict={detail.verdict} />
                  <div>
                    <b>{TYPE_LABEL[detail.type]} {describe({ ...detail, docs: detail.docTitles })}</b>
                    <div className="small">{detail.reason}</div>
                  </div>
                </div>
                {detail.derivedFrom && (
                  <p className="small"><span className="muted">Came from:</span> {detail.derivedFrom.label} “{detail.derivedFrom.text}”</p>
                )}
                <ul className="checks">
                  {detail.checks.filter((c) => c.status !== "skip").map((c) => (
                    <li key={c.check}>
                      <div className="check-head"><StatusDot status={c.status} /><b>{CHECK_LABEL[c.check] ?? c.check}</b></div>
                      <div className="small">{c.reason}</div>
                      {c.evidence.map((e) => <code key={e} className="path">{e}</code>)}
                      <details>
                        <summary className="small muted">Cypher</summary>
                        {c.cypher.map((q) => <pre key={q}>{q}</pre>)}
                      </details>
                    </li>
                  ))}
                </ul>
                {detail.justifiedBy.length > 0 && (
                  <>
                    <h3>Graph facts this verdict rests on</h3>
                    <div className="facts">
                      {detail.justifiedBy.map((j) => (
                        <span key={`${j.check}-${j.name}`} className={`fact fact-${j.status}`}>{j.label}: {j.name}</span>
                      ))}
                    </div>
                  </>
                )}
                {detail.decisions.length > 0 && (
                  <p className="small muted">You {detail.decisions.map((d) => d.decision).join(", then ")} this.</p>
                )}
              </>
            )}
          </div>

          <div className="card">
            <div className="tabs" role="tablist">
              {(["mail", "outbox", "calendar", "tasks", "rules"] as const).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
                  {t[0]!.toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            {tab === "mail" && (
              <ul className="list">
                {mail.map((m) => (
                  <li key={m.id} className="plain">
                    <b>{m.subject}</b> <span className="muted small">from {m.from} · {fmtTime(m.ts)}</span>
                    {!m.known && <span className="status status-blocked">stranger</span>}
                    {m.flagged && <span className="status status-blocked">flagged</span>}
                    <div className="small">{m.body}</div>
                    {m.mentions.length > 0 && <div className="muted small">mentions: {m.mentions.join(", ")}</div>}
                  </li>
                ))}
              </ul>
            )}
            {tab === "outbox" && (
              <ul className="list">
                {outbox.map((m) => (
                  <li key={m.id} className="plain">
                    <b>{m.subject || "(no subject)"}</b> <span className="muted small">to {m.to} · {fmtTime(m.ts)}</span>
                    {m.attachments.length > 0 && <div className="small">📎 {m.attachments.join(", ")}</div>}
                  </li>
                ))}
                {!outbox.length && <li className="muted">Nothing sent yet. (Sandboxed: nothing ever leaves the graph.)</li>}
              </ul>
            )}
            {tab === "calendar" && (
              <ul className="list">
                {calendar.map((m) => (
                  <li key={m.id} className="plain"><b>{m.title}</b> <span className="muted small">{fmtTime(m.start)}{m.with.length ? ` · with ${m.with.join(", ")}` : ""}</span></li>
                ))}
              </ul>
            )}
            {tab === "tasks" && (
              <ul className="list">
                {tasks.map((t) => (
                  <li key={t.id} className="plain">
                    <b>{t.title}</b> <span className="muted small">{t.due ? `due ${fmtTime(t.due)}` : ""}</span>
                    {t.blockedBy.length > 0 && <div className="small">⛔ blocked by {t.blockedBy.join(", ")}</div>}
                  </li>
                ))}
              </ul>
            )}
            {tab === "rules" && (
              <ul className="list">
                {rules.map((r) => (
                  <li key={r.id} className="plain">
                    <b>{r.description}</b> <span className={`status status-${r.status}`}>{r.status}</span>
                    <div className="muted small">learned from {r.learnedFrom} approvals</div>
                    <div className="row">
                      {r.status === "proposed" && <>
                        <button className="primary" onClick={() => guard(async () => { await api.decideRule(r.id, "accept"); await refresh(); })}>Accept</button>
                        <button className="ghost" onClick={() => guard(async () => { await api.decideRule(r.id, "decline"); await refresh(); })}>Decline</button>
                      </>}
                      {r.status === "active" && <button className="ghost" onClick={() => guard(async () => { await api.decideRule(r.id, "revoke"); await refresh(); })}>Revoke</button>}
                    </div>
                  </li>
                ))}
                {!rules.length && <li className="muted">No rules yet. Approve the same kind of action for the same person 3 times and Steward will propose one.</li>}
              </ul>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
