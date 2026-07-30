import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { createMembership, createOrg, createUser, getUserByEmail, hashPassword } from "@agentfactory/db";
import { createSession } from "@/server/auth";

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export async function POST(request: Request) {
  const body = await request.json();
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!email || !email.includes("@")) return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  if (!name) return NextResponse.json({ error: "Enter your name" }, { status: 400 });
  if (password.length < 8) return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });

  if (await getUserByEmail(email)) {
    return NextResponse.json({ error: "An account with that email already exists" }, { status: 409 });
  }

  // Every new user gets their own org for now — no invite flow yet, so there's no other org to join.
  const org = await createOrg(`${name}'s workspace`, `${slugify(email.split("@")[0])}-${randomBytes(3).toString("hex")}`);
  const user = await createUser({ email, name, passwordHash: await hashPassword(password) });
  await createMembership({ userId: user.id, orgId: org.id, role: "owner" });
  await createSession(user.id);

  return NextResponse.json(user, { status: 201 });
}
