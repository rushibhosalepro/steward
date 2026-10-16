import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { APPROVER_TOKEN } from "./approver";

// A private sandbox per visitor: their own graph (user id `sbx_<hex>`), seeded with the demo or
// built from their own profile. The browser holds two httpOnly cookies: the sandbox id and a
// token = HMAC(secret, id). Human-only routes (approve, rules, memories, pause, reset) accept that
// token for that sandbox only, so a visitor can approve their own actions without the approver
// code, while an agent over MCP (no cookie) still can't, and no cookie works on another user.

const SECRET = process.env.STEWARD_SANDBOX_SECRET?.trim() || APPROVER_TOKEN;
const ID = "steward_sbx";
const TOKEN = "steward_tok";
const ID_PATTERN = /^sbx_[0-9a-f]{16}$/;

const sign = (id: string) => createHmac("sha256", SECRET).update(id).digest("hex");

export const newSandboxId = () => `sbx_${randomBytes(8).toString("hex")}`;

// The sandbox this browser owns, if its cookies are genuine.
export function sandboxOf(c: Context): string | null {
  const id = getCookie(c, ID);
  const token = getCookie(c, TOKEN);
  if (!id || !token || !ID_PATTERN.test(id)) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(sign(id));
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}

// True when the request comes from the human who owns this user id's sandbox.
export function ownsSandbox(c: Context, userId: string | undefined) {
  return !!userId && sandboxOf(c) === userId;
}

// Behind a proxy (Railway ends TLS before the app), the request the app sees is http; the
// visitor's was https. Trust the proxy's header for that.
export const isHttps = (c: Context) => (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")).split(",")[0]!.trim() === "https";

export function setSandboxCookies(c: Context, id: string) {
  const opts = { path: "/", httpOnly: true, sameSite: "Lax" as const, secure: isHttps(c), maxAge: 7 * 24 * 3600 };
  setCookie(c, ID, id, opts);
  setCookie(c, TOKEN, sign(id), opts);
}
