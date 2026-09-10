import { NextResponse } from "next/server";
import { resolveProject } from "@/lib/auth";
import { decideSuggestion, pendingSuggestions } from "@/lib/competitors";
import { enqueue } from "@/lib/jobs";
import { ensureWorker } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What discovery has turned up and nobody has ruled on yet. */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("t");
  const project = await resolveProject(token, "view");
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json({ suggestions: await pendingSuggestions(project.id) });
}

/**
 * Accept a suggestion, dismiss it, or ask for another look.
 *
 * Admin only. Accepting adds a name to the list the market research spends
 * its search budget on, and searching is billed per search — so this is a
 * decision that costs money, which puts it on the same side of the line as
 * changing credentials rather than reading a report.
 */
export async function POST(request: Request) {
  let body: { token?: string; name?: string; accept?: boolean; rediscover?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const project = await resolveProject(body.token ?? null, "admin");
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (body.rediscover) {
    await enqueue(project.id, "discover_competitors");
    ensureWorker();
    return NextResponse.json({ queued: true });
  }

  if (!body.name) {
    return NextResponse.json({ error: "missing name" }, { status: 400 });
  }

  await decideSuggestion(project.id, body.name, body.accept === true);
  return NextResponse.json({ suggestions: await pendingSuggestions(project.id) });
}
