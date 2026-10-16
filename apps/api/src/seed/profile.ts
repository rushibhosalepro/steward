import { z } from "zod";
import type { SeedEdge, SeedNode } from "./demo";

// "Make it yours": a visitor describes their own world in a short form, and it becomes the same
// kind of graph as the demo (User, Person, Project, Document, KNOWS, MEMBER_OF, BELONGS_TO,
// SHARED_WITH, PREFERS). From then on the brief, the Sentinel and any connected agent work on
// their people and projects instead of Asha's.

const name = z.string().trim().min(1).max(80);
export const ProfileSchema = z.object({
  name,
  timezone: z.string().trim().max(60).default("UTC"),
  noMeetingsBefore: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  people: z.array(z.object({
    name,
    email: z.string().trim().toLowerCase().email().max(120),
    // How close: drives the KNOWS edge (a known recipient) and its weight.
    closeness: z.enum(["close", "work", "occasional"]).default("work"),
    projects: z.array(name).max(5).default([]),
  })).max(25).default([]),
  projects: z.array(name).max(10).default([]),
  documents: z.array(z.object({
    title: name,
    project: name.optional(),
    sensitivity: z.enum(["public", "internal", "restricted"]).default("internal"),
    sharedWith: z.array(z.string().trim().toLowerCase().email()).max(10).default([]),
  })).max(25).default([]),
});
export type Profile = z.infer<typeof ProfileSchema>;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "x";
const WEIGHT = { close: 60, work: 15, occasional: 3 } as const;
const DAY = 24 * 3_600_000;

export function profileWorld(p: Profile, now = Date.now()): { nodes: SeedNode[]; edges: SeedEdge[] } {
  const nodes: SeedNode[] = [];
  const edges: SeedEdge[] = [];
  const add = (label: string, id: string, props: Record<string, unknown>) => {
    if (!nodes.some((n) => n.id === id)) nodes.push({ label, id, props: props as SeedNode["props"] });
    return id;
  };
  const projectId = (pname: string) => add("Project", `pr:${slug(pname)}`, { name: pname, status: "active" });

  add("User", "u:me", { name: p.name, timezone: p.timezone, created_at: now });
  for (const [id, n] of [["a:planner", "Planner"], ["a:sentinel", "Sentinel"], ["a:executor", "Executor"], ["a:scout", "Scout"], ["a:mcp", "MCP client"]]) {
    add("Agent", id!, { name: n });
  }
  if (p.noMeetingsBefore) {
    add("Preference", "pref:no-early", { key: "no_meetings_before", value: p.noMeetingsBefore });
    edges.push({ from: "u:me", type: "PREFERS", to: "pref:no-early" });
  }
  for (const pr of p.projects) edges.push({ from: "u:me", type: "MEMBER_OF", to: projectId(pr) });

  const personByEmail = new Map<string, string>();
  for (const person of p.people) {
    const id = add("Person", `p:${slug(person.email)}`, { name: person.name, email: person.email });
    personByEmail.set(person.email, id);
    edges.push({ from: "u:me", type: "KNOWS", to: id, props: { count: WEIGHT[person.closeness], last_contact: now - 2 * DAY } });
    for (const pr of person.projects) {
      const pid = projectId(pr);
      edges.push({ from: id, type: "MEMBER_OF", to: pid });
      if (!edges.some((e) => e.from === "u:me" && e.type === "MEMBER_OF" && e.to === pid)) edges.push({ from: "u:me", type: "MEMBER_OF", to: pid });
    }
  }
  for (const doc of p.documents) {
    const id = add("Document", `d:${slug(doc.title)}`, { title: doc.title, sensitivity: doc.sensitivity, updated_at: now - DAY });
    if (doc.project) edges.push({ from: id, type: "BELONGS_TO", to: projectId(doc.project) });
    for (const email of doc.sharedWith) {
      const pid = personByEmail.get(email);
      if (pid) edges.push({ from: id, type: "SHARED_WITH", to: pid });
    }
  }
  return { nodes, edges };
}
