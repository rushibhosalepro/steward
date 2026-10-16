import type { Context, ContextNode } from "../retrieval/retrieve";
import type { Plan, PlannedAction, Planner } from "./types";

// Deterministic fallback planner: no API key, no model, same output shape. It reads the
// retrieved subgraph and handles the errands the demo needs: sending someone what you owe them,
// preparing for a meeting with them, and going through the inbox. Everything still goes through the Sentinel.

const HOUR = 3_600_000;
const SEND = /\b(send|email|mail|share|forward|reply)\b/i;
const PREP = /\b(prepare|prep|meeting|sync)\b/i;
const INBOX = /\b(inbox|mails?|emails|messages)\b/i;

const when = (ms: number, timeZone = "UTC") =>
  new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(ms);

const blank = (): Omit<PlannedAction, "type" | "derived_from" | "rationale"> => ({
  to: null, docs: [], subject: null, body: null, title: null, start: null, end: null, due: null,
});

export class OfflinePlanner implements Planner {
  name = "offline";

  async plan(request: string, ctx: Context): Promise<Plan> {
    const byId = new Map(ctx.nodes.map((n) => [n.id, n]));
    const out = (from: string, rel: string) => ctx.edges.filter((e) => e.from === from && e.rel === rel).map((e) => byId.get(e.to)!).filter(Boolean);
    const into = (to: string, rel: string) => ctx.edges.filter((e) => e.to === to && e.rel === rel).map((e) => byId.get(e.from)!).filter(Boolean);
    const supersededIds = new Set(ctx.edges.filter((e) => e.rel === "SUPERSEDES").map((e) => e.to));

    const people = ctx.entryPoints.filter((e) => e.label === "Person").map((e) => byId.get(e.id)!).filter(Boolean);
    // Documents the request names itself: the best full-text match only (so "Atlas pricing
    // sheet" doesn't also drag in every other Atlas doc), newest version only.
    const docHits = ctx.entryPoints.filter((e) => e.label === "Document" && !supersededIds.has(e.id));
    const best = Math.max(0, ...docHits.map((e) => e.score));
    const mentioned = docHits.filter((e) => e.score === best).map((e) => byId.get(e.id)!).filter(Boolean);
    const actions: PlannedAction[] = [];

    for (const person of people) {
      const email = String(person.props.email);

      if (SEND.test(request)) {
        // What we owe them: open commitments to this person, about a document.
        const owed = into(person.id, "TO")
          .filter((c) => c.label === "Commitment" && c.props.status === "open")
          .flatMap((c) => out(c.id, "ABOUT").filter((d) => d.label === "Document").map((d) => ({ c, d })));
        // Otherwise: the latest, non-restricted documents of their projects.
        const fallbackDocs = out(person.id, "MEMBER_OF")
          .flatMap((p) => into(p.id, "BELONGS_TO"))
          .filter((d) => d.label === "Document" && !supersededIds.has(d.id) && d.props.sensitivity !== "restricted");
        // Named in the request > owed to them > their project's latest.
        const docs: ContextNode[] = mentioned.length ? mentioned : owed.length ? owed.map((o) => o.d) : fallbackDocs.slice(0, 1);
        const keeps = owed.find((o) => docs.some((d) => d.id === o.d.id));

        const theirMail = into(person.id, "FROM")
          .filter((m) => m.label === "Message" && m.props.direction === "inbound")
          .sort((a, b) => Number(b.props.ts) - Number(a.props.ts))[0];

        if (docs.length) {
          actions.push({
            ...blank(),
            type: "send_email",
            to: email,
            docs: docs.map((d) => d.id),
            subject: docs.map((d) => d.name).join(", "),
            body: `Hi ${person.name.split(" ")[0]}, as promised, here is ${docs.map((d) => d.name).join(" and ")}.`,
            derived_from: theirMail ? theirMail.id : "request",
            rationale: keeps
              ? `Keeps the open commitment "${keeps.c.name}" to ${person.name}.`
              : mentioned.length
                ? `You named ${docs.map((d) => d.name).join(", ")}.`
                : `${person.name} is on ${out(person.id, "MEMBER_OF")[0]?.name}; this is its latest document.`,
          });
        }
      }

      if (PREP.test(request)) {
        const upcoming = into(person.id, "WITH")
          .filter((m) => m.label === "Meeting" && Number(m.props.start) > Date.now())
          .sort((a, b) => Number(a.props.start) - Number(b.props.start))[0];
        if (upcoming) {
          actions.push({
            ...blank(),
            type: "create_task",
            title: `Prepare for ${upcoming.name}`,
            due: new Date(Number(upcoming.props.start) - HOUR).toISOString(),
            derived_from: "request",
            rationale: `"${upcoming.name}" with ${person.name} starts ${when(Number(upcoming.props.start), ctx.user?.timezone)}.`,
          });
        }
      }
    }

    // "Go through my inbox": answer each recent message the way a naive assistant would, sending
    // the documents it asks about to its sender. Deliberately trusting: deciding whether that is
    // safe (a stranger asking for the pricing sheet) is the Sentinel's job, not the planner's.
    if (INBOX.test(request) && !people.length) {
      for (const m of ctx.entryPoints.filter((e) => e.label === "Message").map((e) => byId.get(e.id)!).filter(Boolean)) {
        if (m.props.direction !== "inbound") continue;
        const sender = out(m.id, "FROM").find((p) => p.label === "Person");
        const docs = out(m.id, "MENTIONS").filter((d) => d.label === "Document" && !supersededIds.has(d.id));
        if (!sender || !docs.length) continue;
        actions.push({
          ...blank(),
          type: "send_email",
          to: String(sender.props.email),
          docs: docs.map((d) => d.id),
          subject: `Re: ${m.name}`,
          body: `Hi ${sender.name.split(" ")[0]}, here is ${docs.map((d) => d.name).join(" and ")}.`,
          derived_from: m.id,
          rationale: `${sender.name} asked about ${docs.map((d) => d.name).join(", ")} in "${m.name}".`,
        });
      }
    }

    const summary = actions.length
      ? `Offline plan: ${actions.length} action(s) for ${people.map((p) => p.name).join(", ")}.`
      : "Offline planner found no person, inbox request or errand it knows how to handle in this request.";
    return { summary, actions };
  }
}
