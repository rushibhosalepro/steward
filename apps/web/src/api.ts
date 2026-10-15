// Thin client for the Steward API. In dev, Vite proxies /api to the Bun server.

export const USER = "demo";
const base = `/api/users/${USER}`;

export type Verdict = "ALLOW" | "ASK" | "BLOCK";
export type Status = "pass" | "ask" | "block" | "skip";

export type Check = {
  check: string;
  status: Status;
  reason: string;
  evidence: string[];
  cypher: string[];
  refs?: string[];
};

export type ActivityItem = {
  id: string; type: string; status: string; verdict: Verdict; reason: string; created_at: number;
  to: string | null; target: string | null; docs: string[]; subject: string | null; title: string | null;
  rationale: string | null; source: string | null;
};

export type ActionDetail = {
  id: string; type: string; status: string; verdict: Verdict; reason: string; created_at: number;
  to?: string; subject?: string; body?: string; title?: string; docs?: string[];
  target: string | null; docTitles: string[];
  checks: Check[];
  derivedFrom: { label: string; text: string } | null;
  justifiedBy: { check: string; status: Status; label: string; name: string }[];
  decisions: { decision: string; note: string | null; ts: number }[];
};

export type PlanStep = {
  order: number; rationale: string; verdict: Verdict; reason: string; status: string;
  action: {
    id: string; type: string; to: string | null; docs: string[]; title: string | null; subject: string | null;
    target: string | null; docTitles: string[];
  };
};

export type PlanResult = {
  requestId: string; planId: string; planner: string; note: string | null; summary: string;
  context: { entryPoints: string[]; nodes: number; edges: number };
  steps: PlanStep[];
};

export type Rule = { id: string; status: string; description: string; action_type: string; person: string; learnedFrom: number; created_at: number };
export type OutboxItem = { id: string; subject: string; body: string; to: string; email: string; attachments: string[]; ts: number };
export type Meeting = { id: string; title: string; start: number; end: number; status: string; with: string[]; project: string | null };
export type IngestResult = {
  messageId: string;
  sender: { id: string; name: string; known: boolean; new: boolean };
  mentions: { id: string; label: string; name: string }[];
  ask: string | null; flagged: boolean;
  commitment: { id: string; what: string; about: string[] } | null;
};
export type MailItem = {
  id: string; subject: string; body: string; ts: number; flagged: boolean | null;
  from: string; email: string; known: boolean; mentions: string[]; asks: string[];
};
export type Suggestion = { id: string; kind: string; text: string; request: string | null; score: number; why: string; refs: string[] };
export type Task = { id: string; title: string; due: number | null; status: string; blockedBy: string[]; project: string | null };

// The approver code proves a human is acting. Agents never have it; the server rejects
// approvals, rule changes, pause/resume, reset and simulated mail without it.
const APPROVER_KEY = "steward-approver";
const readCode = () => {
  try { return localStorage.getItem(APPROVER_KEY) ?? ""; } catch { return ""; }
};
const saveCode = (code: string) => {
  try { localStorage.setItem(APPROVER_KEY, code); } catch { /* private mode: ask again next time */ }
};

async function call<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-steward-approver": readCode(), ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 403 && (body as { humanOnly?: boolean }).humanOnly && !retried) {
    const code = window.prompt("This needs a human. Enter the approver code (shown in the server log, or given to judges):");
    if (code) {
      saveCode(code.trim());
      return call<T>(path, init, true);
    }
  }
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

const post = <T>(path: string, body?: unknown) => call<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export const api = {
  seed: () => post<{ nodes: number; edges: number }>("/seed"),
  request: (request: string, planner?: string) => post<PlanResult>("/requests", { request, planner }),
  actions: () => call<ActivityItem[]>("/actions"),
  inbox: () => call<ActivityItem[]>("/inbox"),
  action: (id: string) => call<ActionDetail>(`/actions/${id}`),
  approve: (id: string) => post<{ ok: boolean; proposedRule?: { id: string; description: string } }>(`/actions/${id}/approve`),
  reject: (id: string) => post(`/actions/${id}/reject`),
  rules: () => call<Rule[]>("/rules"),
  decideRule: (id: string, decision: "accept" | "decline" | "revoke") => post(`/rules/${id}/${decision}`),
  outbox: () => call<OutboxItem[]>("/outbox"),
  calendar: () => call<Meeting[]>("/calendar"),
  tasks: () => call<Task[]>("/tasks"),
  receive: (mail: { from: { email: string; name?: string }; subject: string; body: string }) => post<IngestResult>("/mail", mail),
  mail: () => call<MailItem[]>("/mail"),
  planners: () => fetch("/api/planners").then((r) => r.json() as Promise<{ available: string[]; default: string }>),
  suggestions: () => call<Suggestion[]>("/suggestions"),
  decideSuggestion: (id: string, decision: "dismiss" | "accept" | "decline") => post(`/suggestions/${id}/${decision}`),
};
