import { afterAll, beforeAll, expect, test } from "bun:test";
import { graphFor } from "../db";
import { brief, renderBrief } from "../personal/personal";
import { check } from "../sentinel/sentinel";
import { ProfileSchema } from "./profile";
import { seedProfile } from "./seed";

const graph = graphFor("test_profile");

beforeAll(async () => {
  await seedProfile(graph, ProfileSchema.parse({
    name: "Rushi B", timezone: "Asia/Kolkata", noMeetingsBefore: "10:00", agentName: "Juno", focus: "work", wantsConnections: ["gmail"],
    meeting: { title: "Launch review", start: Date.now() + 26 * 3_600_000, with: "sam@acme.example", project: "Launch" },
    promise: { what: "Send Sam the launch plan", to: "sam@acme.example", document: "Launch plan", by: Date.now() + 20 * 3_600_000 },
    people: [
      { name: "Sam Ortiz", email: "Sam@Acme.example", closeness: "work", projects: ["Launch"] },
      { name: "Mum", email: "mum@family.example", closeness: "close" },
    ],
    documents: [
      { title: "Launch plan", project: "Launch", sensitivity: "internal" },
      { title: "Salary review", sensitivity: "restricted", sharedWith: [] },
    ],
  }));
});

afterAll(async () => {
  await graph.delete();
});

test("the brief is about the visitor, not Asha", async () => {
  const text = renderBrief(await brief(graph));
  expect(text).toContain("You are Rushi B's personal agent");
  expect(text).not.toContain("demo world");
  expect(text).toContain("no_meetings_before = 10:00");
});

test("the agent's name, the meeting and the promise give the first brief something to do", async () => {
  const b = await brief(graph);
  expect(b.user).toMatchObject({ agentName: "Juno", focus: "work", wantsConnections: ["gmail"] });
  expect(renderBrief(b)).toContain("they call you Juno");
  expect(b.meetings.map((m) => m.title)).toContain("Launch review");
  const kinds = b.needs.map((n) => n.kind);
  expect(kinds).toContain("commitment_due");
  expect(kinds).toContain("meeting_prep");
  expect(b.needs.find((n) => n.kind === "commitment_due")?.request).toBe("Send Sam the launch plan");
});

test("the Sentinel works on their own world", async () => {
  // A project document to a project member: fine to ask (no standing rule yet).
  expect((await check(graph, { type: "send_email", to: "sam@acme.example", docs: ["d:launch-plan"], derivedFrom: "user" })).verdict).toBe("ASK");
  // The same document to family: no path, so it's blocked.
  expect((await check(graph, { type: "send_email", to: "mum@family.example", docs: ["d:launch-plan"], derivedFrom: "user" })).verdict).toBe("BLOCK");
  // A restricted document shared with nobody: blocked even for a colleague.
  expect((await check(graph, { type: "share_doc", to: "sam@acme.example", docs: ["d:salary-review"], derivedFrom: "user" })).verdict).toBe("BLOCK");
});

test("bad input is rejected, not stored", () => {
  expect(ProfileSchema.safeParse({ name: "", people: [] }).success).toBe(false);
  expect(ProfileSchema.safeParse({ name: "x", people: [{ name: "a", email: "not-an-email" }] }).success).toBe(false);
});
