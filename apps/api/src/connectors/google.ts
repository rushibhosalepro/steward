import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The real connector: Gmail drafts and Google Calendar events, for ONE Steward user (the
// account owner's own data, rule 6). It runs only inside the Executor, after the Sentinel has
// allowed the action (or the human approved it) and the pre-execution re-check passed.
//
// Least privilege, stated:
// - Gmail: scope gmail.compose. Google has no drafts-only scope; this one could also send.
//   Steward's code only ever calls drafts.create. Nothing is sent.
// - Calendar: scope calendar.app.created: only calendars this app created. Events go on a
//   dedicated "Steward" calendar. Invitees are written in the description, not added as
//   attendees, so Google never emails anyone.
// Credential isolation: tokens live in .secrets/google.json (git-ignored), never in the graph,
// so no Cypher query, model context or MCP tool can read them.

const SCOPES = ["https://www.googleapis.com/auth/gmail.compose", "https://www.googleapis.com/auth/calendar.app.created"];
const STORE = fileURLToPath(new URL("../../../../.secrets/google.json", import.meta.url));

type Store = { refresh_token: string; access_token?: string; expires_at?: number; calendar_id?: string; account?: string };

const env = () => ({
  id: process.env.GOOGLE_CLIENT_ID ?? "",
  secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  redirect: process.env.GOOGLE_REDIRECT_URI ?? `http://localhost:${process.env.PORT ?? 8787}/oauth/google/callback`,
  user: process.env.STEWARD_GOOGLE_USER ?? "demo",
});

const load = (): Store | null => (existsSync(STORE) ? (JSON.parse(readFileSync(STORE, "utf8")) as Store) : null);
const save = (s: Store) => {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify(s, null, 2), { mode: 0o600 });
};

export const googleConfigured = () => !!(env().id && env().secret);
export const googleConnected = () => !!load()?.refresh_token;
export const googleUser = () => env().user;

const pendingStates = new Set<string>();

export function authUrl() {
  const state = crypto.randomUUID();
  pendingStates.add(state);
  const p = new URLSearchParams({
    client_id: env().id, redirect_uri: env().redirect, response_type: "code", scope: SCOPES.join(" "),
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function token(body: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env().id, client_secret: env().secret, ...body }),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(`google token: ${json.error ?? res.status} ${json.error_description ?? ""}`.trim());
  return json;
}

export async function handleCallback(code: string, state: string) {
  if (!pendingStates.delete(state)) throw new Error("unknown or reused OAuth state");
  const t = await token({ code, grant_type: "authorization_code", redirect_uri: env().redirect });
  if (!t.refresh_token) throw new Error("Google returned no refresh token; remove Steward's access in your Google account and connect again");
  save({ refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + (t.expires_in ?? 3600) * 1000 });
  const profile = await api<{ emailAddress: string }>("https://gmail.googleapis.com/gmail/v1/users/me/profile");
  save({ ...load()!, account: profile.emailAddress });
  return { account: profile.emailAddress };
}

async function accessToken() {
  const s = load();
  if (!s) throw new Error("Google is not connected");
  if (s.access_token && (s.expires_at ?? 0) > Date.now() + 60_000) return s.access_token;
  const t = await token({ refresh_token: s.refresh_token, grant_type: "refresh_token" });
  save({ ...s, access_token: t.access_token, expires_at: Date.now() + (t.expires_in ?? 3600) * 1000 });
  return t.access_token!;
}

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`google ${res.status}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function createDraft(d: { to: string; subject: string; body: string; attachments: { filename: string; text: string }[] }) {
  const boundary = `steward-${crypto.randomUUID()}`;
  const parts = [
    `To: ${d.to}`, `Subject: ${d.subject}`, "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "", d.body, "",
    ...d.attachments.flatMap((a) => [
      `--${boundary}`, `Content-Type: text/plain; charset=UTF-8; name="${a.filename}"`, `Content-Disposition: attachment; filename="${a.filename}"`, "", a.text, "",
    ]),
    `--${boundary}--`,
  ];
  const draft = await api<{ id: string; message: { id: string } }>("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST", body: JSON.stringify({ message: { raw: b64url(parts.join("\r\n")) } }),
  });
  return { id: draft.id, url: `https://mail.google.com/mail/u/0/#drafts?compose=${draft.message.id}` };
}

async function stewardCalendar() {
  const s = load()!;
  if (s.calendar_id) return s.calendar_id;
  const cal = await api<{ id: string }>("https://www.googleapis.com/calendar/v3/calendars", {
    method: "POST", body: JSON.stringify({ summary: "Steward", description: "Events created by Steward after its Sentinel allowed them." }),
  });
  save({ ...load()!, calendar_id: cal.id });
  return cal.id;
}

export async function createEvent(e: { title: string; start: number; end: number; invitee?: string }) {
  const cal = await stewardCalendar();
  const ev = await api<{ id: string; htmlLink: string }>(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events?sendUpdates=none`, {
    method: "POST",
    body: JSON.stringify({
      summary: e.title,
      description: `Created by Steward.${e.invitee ? ` Invitee (not emailed): ${e.invitee}` : ""}`,
      start: { dateTime: new Date(e.start).toISOString() },
      end: { dateTime: new Date(e.end).toISOString() },
    }),
  });
  return { id: ev.id, url: ev.htmlLink };
}

export function googleStatus() {
  const s = load();
  return { configured: googleConfigured(), connected: !!s?.refresh_token, account: s?.account ?? null, steward_user: env().user, calendar: s?.calendar_id ? "Steward" : null, scopes: SCOPES };
}

export function disconnect() {
  if (existsSync(STORE)) writeFileSync(STORE, "{}");
  return { connected: false };
}
