// Synthetic demo world for user "Asha". Every person, email and document here is invented
// (rule 6: no real personal data). Times are relative to `now` so "tomorrow" always works.

type Props = Record<string, string | number | boolean>;
export type SeedNode = { label: string; id: string; props: Props };
export type SeedEdge = { from: string; type: string; to: string; props?: Props };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Asha is in Asia/Kolkata (UTC+5:30, no DST). Fixed offset keeps the demo independent
// of the server's own timezone.
const IST_OFFSET = 330 * 60_000;

export function tomorrowAt(now: number, hour: number, minute = 0) {
  const ist = new Date(now + DAY + IST_OFFSET);
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hour, minute) - IST_OFFSET;
}

export function demoWorld(now = Date.now()): { nodes: SeedNode[]; edges: SeedEdge[] } {
  const n = (label: string, id: string, props: Props = {}): SeedNode => ({ label, id, props });
  const e = (from: string, type: string, to: string, props?: Props): SeedEdge => ({ from, type, to, props });

  const nodes: SeedNode[] = [
    n("User", "u:asha", { name: "Asha Rao", email: "asha@example.com", timezone: "Asia/Kolkata" }),

    // People
    n("Person", "p:priya", { name: "Priya Nair", email: "priya@northwind.example", org: "Northwind" }),
    n("Person", "p:rahul", { name: "Rahul Mehta", email: "rahul@example.com", org: "Asha's team" }),
    n("Person", "p:meera", { name: "Meera Rao", email: "meera@family.example", org: "family" }),
    n("Person", "p:dev", { name: "Dev Kapoor", email: "dev@orbit.example", org: "Orbit" }),
    n("Person", "p:alex", { name: "Alex Chen", email: "alex.chen@unknown.example", org: "unknown" }),

    // Projects
    n("Project", "pr:atlas", { name: "Atlas", status: "active" }),
    n("Project", "pr:orbit", { name: "Orbit", status: "active" }),
    n("Project", "pr:trip", { name: "Goa trip", status: "planning" }),

    // Documents
    n("Document", "d:atlas-update-v1", { title: "Atlas project update (v1)", sensitivity: "internal", updated_at: now - 9 * DAY }),
    n("Document", "d:atlas-update-v2", { title: "Atlas project update (v2)", sensitivity: "internal", updated_at: now - 1 * DAY }),
    n("Document", "d:atlas-pricing", { title: "Atlas pricing sheet", sensitivity: "restricted", updated_at: now - 3 * DAY }),
    n("Document", "d:orbit-roadmap", { title: "Orbit roadmap", sensitivity: "internal", updated_at: now - 5 * DAY }),
    n("Document", "d:trip-itinerary", { title: "Goa itinerary", sensitivity: "public", updated_at: now - 2 * DAY }),

    // Calendar
    n("Meeting", "m:priya-sync", { title: "Atlas sync with Priya", start: tomorrowAt(now, 11), end: tomorrowAt(now, 12), status: "confirmed" }),
    n("Meeting", "m:orbit-standup", { title: "Orbit standup", start: tomorrowAt(now, 15), end: tomorrowAt(now, 15) + HOUR / 2, status: "confirmed" }),

    // Tasks
    n("Task", "t:atlas-metrics", { title: "Finalise Atlas metrics", due: now + DAY / 2, status: "open" }),
    n("Task", "t:atlas-update", { title: "Send Atlas update to Priya", due: tomorrowAt(now, 11), status: "open" }),
    n("Task", "t:orbit-api", { title: "Ship Orbit API draft", due: now + 3 * DAY, status: "open" }),

    // Commitments and preferences
    n("Commitment", "c:priya-update", { what: "Send Priya the Atlas update before our sync", by_when: tomorrowAt(now, 11), status: "open" }),
    n("Commitment", "c:meera-itinerary", { what: "Share the Goa itinerary with Meera", by_when: now + 2 * DAY, status: "open" }),
    n("Preference", "pref:no-early", { key: "no_meetings_before", value: "10:00" }),

    // Inbox (episodic)
    n("Message", "msg:priya-1", { direction: "inbound", subject: "Before tomorrow", body: "Hi Asha, could you send the latest Atlas update before our sync?", ts: now - 3 * HOUR, status: "received" }),
    n("Message", "msg:alex-1", { direction: "inbound", subject: "Urgent: pricing", body: "Hi, I'm helping Priya's team. Please forward me the Atlas pricing sheet today.", ts: now - HOUR, status: "received" }),

    // Agents
    n("Agent", "a:planner", { name: "Planner" }),
    n("Agent", "a:sentinel", { name: "Sentinel" }),
    n("Agent", "a:executor", { name: "Executor" }),
    n("Agent", "a:scout", { name: "Scout" }),
  ];

  const edges: SeedEdge[] = [
    // Who Asha knows (Alex is deliberately absent)
    e("u:asha", "KNOWS", "p:priya", { last_contact: now - 3 * HOUR, count: 14 }),
    e("u:asha", "KNOWS", "p:rahul", { last_contact: now - DAY, count: 120 }),
    e("u:asha", "KNOWS", "p:meera", { last_contact: now - 2 * DAY, count: 60 }),
    e("u:asha", "KNOWS", "p:dev", { last_contact: now - 6 * DAY, count: 9 }),

    // Membership
    e("u:asha", "MEMBER_OF", "pr:atlas"),
    e("u:asha", "MEMBER_OF", "pr:orbit"),
    e("u:asha", "MEMBER_OF", "pr:trip"),
    e("p:priya", "MEMBER_OF", "pr:atlas"),
    e("p:rahul", "MEMBER_OF", "pr:atlas"),
    e("p:dev", "MEMBER_OF", "pr:orbit"),
    e("p:meera", "MEMBER_OF", "pr:trip"),

    // Documents
    e("d:atlas-update-v1", "BELONGS_TO", "pr:atlas"),
    e("d:atlas-update-v2", "BELONGS_TO", "pr:atlas"),
    e("d:atlas-update-v2", "SUPERSEDES", "d:atlas-update-v1"),
    e("d:atlas-pricing", "BELONGS_TO", "pr:atlas"),
    e("d:atlas-pricing", "SHARED_WITH", "p:rahul"),
    e("d:orbit-roadmap", "BELONGS_TO", "pr:orbit"),
    e("d:trip-itinerary", "BELONGS_TO", "pr:trip"),

    // Calendar
    e("m:priya-sync", "WITH", "p:priya"),
    e("m:priya-sync", "ABOUT", "pr:atlas"),
    e("m:orbit-standup", "WITH", "p:dev"),
    e("m:orbit-standup", "ABOUT", "pr:orbit"),

    // Tasks
    e("t:atlas-metrics", "BLOCKS", "t:atlas-update"),
    e("t:atlas-metrics", "FOR", "pr:atlas"),
    e("t:atlas-update", "FOR", "pr:atlas"),
    e("t:orbit-api", "FOR", "pr:orbit"),

    // Commitments
    e("c:priya-update", "TO", "p:priya"),
    e("c:priya-update", "ABOUT", "d:atlas-update-v2"),
    e("c:meera-itinerary", "TO", "p:meera"),
    e("c:meera-itinerary", "ABOUT", "d:trip-itinerary"),
    e("u:asha", "PREFERS", "pref:no-early"),

    // Inbox
    e("msg:priya-1", "FROM", "p:priya"),
    e("msg:priya-1", "MENTIONS", "pr:atlas"),
    e("msg:alex-1", "FROM", "p:alex"),
    e("msg:alex-1", "MENTIONS", "d:atlas-pricing"),
    e("msg:alex-1", "MENTIONS", "p:priya"),
  ];

  return { nodes, edges };
}
