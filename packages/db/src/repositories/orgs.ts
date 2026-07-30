import { eq } from "drizzle-orm";
import type { Org } from "@agentfactory/core";
import { db } from "../client";
import { orgs } from "../schema";

function toOrg(row: typeof orgs.$inferSelect): Org {
  return { id: row.id, name: row.name, slug: row.slug, createdAt: row.createdAt.toISOString() };
}

export async function getOrg(id: number): Promise<Org | undefined> {
  const [row] = await db.select().from(orgs).where(eq(orgs.id, id));
  return row ? toOrg(row) : undefined;
}

export async function createOrg(name: string, slug: string): Promise<Org> {
  const [row] = await db.insert(orgs).values({ name, slug }).returning();
  return toOrg(row);
}
