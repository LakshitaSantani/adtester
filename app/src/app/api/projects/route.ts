import { NextResponse } from "next/server";
import { getDb } from "@brain/db";
import { newAdminToken, newInstallKey, newProjectId, newViewToken } from "@brain/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Creates a project and hands back two strings:
 *
 *   install_key  — public, goes in the script tag on the customer's site
 *   view_token   — read the recordings and the reports
 *   admin_token  — that, plus credentials and starting work that costs money
 *
 * The view token is an unguessable URL, not authentication. It's honest for
 * a handful of design partners on staging sites, and it stops being honest
 * the moment somebody points this at real customers — which is the trigger
 * for building real accounts (phase 6).
 */
export async function POST(request: Request) {
  let name = "Untitled";
  try {
    const body = (await request.json()) as { name?: string };
    if (typeof body.name === "string" && body.name.trim()) {
      name = body.name.trim().slice(0, 80);
    }
  } catch {
    /* an empty body is fine */
  }

  const db = await getDb();
  const id = newProjectId();
  const installKey = newInstallKey();
  const viewToken = newViewToken();
  const adminToken = newAdminToken();

  await db.query(
    `INSERT INTO projects (id, name, install_key, view_token, admin_token)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, name, installKey, viewToken, adminToken],
  );

  return NextResponse.json({ id, name, installKey, viewToken, adminToken });
}
