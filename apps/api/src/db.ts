import { FalkorDB } from "falkordb";

const url = process.env.FALKORDB_URL ?? "falkor://localhost:6379";

export const db = await FalkorDB.connect({ url });

// One isolated graph per user: memory, rules and actions never cross users.
export function graphFor(userId: string) {
  if (!/^[a-z0-9_-]+$/i.test(userId)) throw new Error(`invalid user id: ${userId}`);
  return db.selectGraph(`user_${userId}`);
}
