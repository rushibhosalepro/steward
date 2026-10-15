import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Graph } from "falkordb";
import { z } from "zod";
import { getAction, listInbox, proposeAction } from "../actions/actions";
import { graphFor } from "../db";
import { executeAction, performUnguarded } from "../executor/executor";
import { choosePlanner, planRequest } from "../planner/plan";
import { renderContext, retrieve, searchTerms } from "../retrieval/retrieve";
import { computeContexts } from "../contexts/contexts";
import { runScout } from "../scout/scout";
import { check, type ProposedAction } from "../sentinel/sentinel";

// Steward's graph, as tools any MCP client (Claude Desktop, Claude Code, another agent) can
// select. Read tools expose graph queries and algorithms; write tools go through the Sentinel.
// There is deliberately NO approve / reject / accept-rule tool: an agent over MCP can propose,
// but only a human in Steward's UI can approve an ASK, and nothing can approve a BLOCK.

const BOOKKEEPING = ["User", "Agent", "Action", "Approval", "Rule", "Suggestion", "Request", "Plan", "Step", "AuditEvent", "Context"];

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const READ = { readOnlyHint: true, openWorldHint: false } as const;

const actionShape = {
  type: z.enum(["send_email", "share_doc", "create_event", "create_task"]),
  to: z.string().optional().describe("recipient or invitee email"),
  docs: z.array(z.string()).optional().describe("Document ids, e.g. d:atlas-update-v2 (use steward_search to find them)"),
  subject: z.string().optional(),
  body: z.string().optional(),
  title: z.string().optional().describe("event or task title"),
  start: z.string().optional().describe("event start, ISO 8601"),
  end: z.string().optional().describe("event end, ISO 8601"),
  due: z.string().optional().describe("task due, ISO 8601"),
  derived_from: z
    .string()
    .describe('"request" if the user asked for this (put their words in `request`), or the id of the inbound Message it responds to'),
  request: z.string().optional().describe("the user's own words, when derived_from is \"request\""),
};

type ActionArgs = { [K in keyof typeof actionShape]: z.infer<(typeof actionShape)[K]> };

const ms = (iso?: string) => (iso && !Number.isNaN(Date.parse(iso)) ? Date.parse(iso) : undefined);

async function toProposed(g: Graph, a: ActionArgs): Promise<ProposedAction> {
  let derivedFrom = a.derived_from;
  if (derivedFrom === "request") {
    // The user's words become a Request node, so provenance is a graph edge like everywhere else.
    derivedFrom = `req:${crypto.randomUUID()}`;
    await g.query("CREATE (:Entity:Request {id: $id, text: $text, ts: $ts, via: 'mcp'})", {
      params: { id: derivedFrom, text: a.request ?? "", ts: Date.now() },
    });
  }
  return {
    type: a.type, to: a.to, docs: a.docs, subject: a.subject, body: a.body, title: a.title,
    start: ms(a.start), end: ms(a.end), due: ms(a.due), derivedFrom,
  };
}

export function createMcpServer(userId: string, { guarded = true }: { guarded?: boolean } = {}) {
  const g = graphFor(userId);
  const server = new McpServer({ name: "steward", version: "0.1.0" });

  server.registerTool("steward_search", {
    title: "Search the user's graph",
    description: "Full-text search over people, projects, documents, meetings, tasks and commitments. Use it to find ids for other tools.",
    inputSchema: { query: z.string() },
    annotations: READ,
  }, async ({ query }) => {
    const terms = searchTerms(query);
    if (!terms.length) return json([]);
    const res = await g.roQuery(
      `CALL db.idx.fulltext.queryNodes('Entity', $q) YIELD node, score
       WITH node, score WHERE none(l IN labels(node) WHERE l IN $hide)
       RETURN node.id AS id, [l IN labels(node) WHERE l <> 'Entity'][0] AS label,
              coalesce(node.name, node.title, node.subject, node.what) AS name, node.email AS email, score
       ORDER BY score DESC LIMIT 10`,
      { params: { q: terms.map((t) => `${t}|${t}*`).join("|"), hide: BOOKKEEPING } },
    );
    return json(res.data ?? []);
  });

  server.registerTool("steward_get_context", {
    title: "Graph context for a request",
    description: "The part of the user's graph a request is about: full-text entry points expanded 1-2 hops in one Cypher query. This is exactly what Steward's planner sees.",
    inputSchema: { request: z.string() },
    annotations: READ,
  }, async ({ request }) => {
    const ctx = await retrieve(g, request);
    return { content: [{ type: "text" as const, text: renderContext(ctx) }] };
  });

  server.registerTool("steward_find_connection", {
    title: "How are two things connected?",
    description: "Shortest path between two entities (ids from steward_search), not routed through the user or Steward's bookkeeping. 'No path' is meaningful: e.g. a document with no path to a person cannot be shared with them.",
    inputSchema: { from_id: z.string(), to_id: z.string(), max_hops: z.number().int().min(1).max(5).default(4) },
    annotations: READ,
  }, async ({ from_id, to_id, max_hops }) => {
    const res = await g.roQuery<{ names: string[]; rels: string[]; len: number }>(
      `MATCH (a:Entity {id: $from}), (b:Entity {id: $to})
       MATCH p = (a)-[*1..${max_hops}]-(b)
       WHERE none(n IN nodes(p) WHERE any(l IN labels(n) WHERE l IN $hide))
       RETURN [n IN nodes(p) | coalesce(n.name, n.title, n.subject, n.id)] AS names, [r IN relationships(p) | type(r)] AS rels, length(p) AS len
       ORDER BY len LIMIT 1`,
      { params: { from: from_id, to: to_id, hide: BOOKKEEPING } },
    );
    const p = res.data?.[0];
    if (!p) return json({ connected: false, note: `no path within ${max_hops} hops that doesn't go through the user` });
    const path = p.names.map((n, i) => (i < p.rels.length ? `${n} -${p.rels[i]}-` : n)).join(" ");
    return json({ connected: true, hops: p.len, path });
  });

  server.registerTool("steward_who_matters", {
    title: "Who and what is central",
    description: "PageRank over the user's graph: the most central people and projects. Use it to prioritise.",
    inputSchema: { limit: z.number().int().min(1).max(20).default(5) },
    annotations: READ,
  }, async ({ limit }) => {
    const res = await g.roQuery<{ label: string; name: string; id: string; score: number }>(
      `CALL algo.pageRank('Entity', null) YIELD node, score
       WITH node, score WHERE node:Person OR node:Project
       RETURN [l IN labels(node) WHERE l <> 'Entity'][0] AS label, coalesce(node.name, node.title) AS name, node.id AS id, score
       ORDER BY score DESC LIMIT $limit`,
      { params: { limit } },
    );
    return json(res.data ?? []);
  });

  server.registerTool("steward_contexts", {
    title: "The user's worlds",
    description: "The separate parts of the user's life (work projects, family, side projects), found by FalkorDB's connected-components algorithm over people, projects and documents. Data rarely should cross between worlds.",
    inputSchema: {},
    annotations: READ,
  }, async () => json(await computeContexts(g)));

  server.registerTool("steward_check_action", {
    title: "Dry-run the Sentinel",
    description: "Dry run only: whether an action would be ALLOWed, need the user's approval (ASK) or be BLOCKed, with each graph check, its path and its Cypher. Stores and queues nothing; to do the errand, call steward_propose_action.",
    inputSchema: actionShape,
    annotations: READ,
  }, async (args) => {
    // Agents read "ASK" as "I can't" and stopped without queueing anything (gpt-5.4-mini in the
    // multi-model benchmark), so the result says what happens next.
    const result = await check(g, await toProposed(g, args as ActionArgs));
    const next = result.verdict === "BLOCK"
      ? "This was only a dry run. It would be blocked: don't propose it."
      : result.verdict === "ASK"
        ? "This was only a dry run; nothing is queued. To do the errand, call steward_propose_action with the same arguments: it goes into the user's approval inbox."
        : "This was only a dry run. To do the errand, call steward_propose_action with the same arguments.";
    return json({ ...result, next });
  });

  server.registerTool("steward_propose_action", {
    title: guarded ? "Propose an action" : "Do an action",
    description: guarded
      ? "Propose one errand. The Sentinel decides: ALLOW runs it now (sandboxed: nothing leaves the user's graph), ASK puts it in the user's approval inbox, BLOCK records it and it can never run. You cannot approve anything over MCP."
      : "Do one errand now: send an email, share a document, create an event or a task.",
    inputSchema: actionShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => {
    if (!guarded) {
      // Evaluation baseline: the same tool with no Sentinel. Never reachable in production.
      const done = await performUnguarded(g, await toProposed(g, args as ActionArgs));
      return json({ id: done.id, status: "done" });
    }
    const proposed = await proposeAction(g, await toProposed(g, args as ActionArgs), "a:mcp");
    const execution = proposed.status === "ready" ? await executeAction(g, proposed.id) : null;
    return json({
      id: proposed.id, verdict: proposed.verdict, reason: proposed.reason,
      status: execution?.ok ? "done" : execution ? execution.status : proposed.status,
      next: proposed.verdict === "ASK" ? "waiting for the user to approve in Steward" : proposed.verdict === "BLOCK" ? "blocked; it will not run" : "ran",
    });
  });

  server.registerTool("steward_run_request", {
    title: "Run a request through Steward",
    description: "Give Steward a sentence. It retrieves the graph context, plans the errands, checks each with the Sentinel, runs what's allowed and queues the rest for the user.",
    inputSchema: { request: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ request }) => json(await planRequest(g, request, choosePlanner())));

  server.registerTool("steward_list_inbox", {
    title: "Actions waiting for the user",
    description: "Actions the Sentinel answered with ASK. Only the user can approve them, in Steward's UI.",
    inputSchema: {},
    annotations: READ,
  }, async () => json(await listInbox(g)));

  server.registerTool("steward_explain_action", {
    title: "Why did Steward decide that?",
    description: "For one action: the verdict, where it came from, every check with its graph path and Cypher, and the graph facts it rests on.",
    inputSchema: { action_id: z.string() },
    annotations: READ,
  }, async ({ action_id }) => {
    const a = await getAction(g, action_id);
    return a ? json(a) : { content: [{ type: "text" as const, text: `no action ${action_id}` }], isError: true };
  });

  server.registerTool("steward_get_suggestions", {
    title: "What needs attention",
    description: "Scout's suggestions: promises due, requests to take on, people waiting for a reply, blocked tasks, meetings without prep, flagged mail. Ranked by urgency and PageRank.",
    inputSchema: {},
    annotations: READ,
  }, async () => json(await runScout(g)));

  return server;
}
