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
  requestId: string; planId: string; planner: string; summary: string;
  context: { entryPoints: string[]; nodes: number; edges: number };
  steps: PlanStep[];
};

export type Rule = { id: string; status: string; description: string; action_type: string; person: string; learnedFrom: number; created_at: number };
export type OutboxItem = { id: string; subject: string; body: string; to: string; email: string; attachments: string[]; ts: number };
export type Meeting = { id: string; title: string; start: number; end: number; status: string; with: string[]; project: string | null };
export type Task = { id: string; title: string; due: number | null; status: string; blockedBy: string[]; project: string | null };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
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
};
