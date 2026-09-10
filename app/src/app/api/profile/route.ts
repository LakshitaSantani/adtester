import { NextResponse } from "next/server";
import { resolveProject } from "@brain/auth";
import { enqueue } from "@brain/jobs";
import { draftProfile, loadProfile, saveProfile, type Profile } from "@brain/profile";
import { ensureWorker } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: Partial<Profile> & { token?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const project = await resolveProject(body.token, "admin");
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Keep what we guessed alongside what they said, so a bad guess stays
  // visible rather than being quietly replaced by the correction.
  const draft = await draftProfile(project.id);
  const before = await loadProfile(project.id);

  await saveProfile(
    project.id,
    {
      whatWeDo: body.whatWeDo?.slice(0, 500) ?? null,
      customers: body.customers ?? null,
      revenueModel: body.revenueModel ?? null,
      criticalPaths: (body.criticalPaths ?? []).slice(0, 40),
      rollout: body.rollout ?? null,
      competitors: (body.competitors ?? []).slice(0, 20),
      seasonality: body.seasonality?.slice(0, 500) ?? null,
    },
    draft,
  );

  // Naming a competitor is the act of asking about them. Waiting for someone
  // to also press "run the analysis" on a different page meant the answer
  // never arrived and nothing said why.
  const saved = await loadProfile(project.id);
  const changed =
    JSON.stringify((before?.competitors ?? []).slice().sort()) !==
    JSON.stringify((saved?.competitors ?? []).slice().sort());

  if (changed && (saved?.competitors ?? []).length > 0) {
    await enqueue(project.id, "research_market");
    ensureWorker();
  }

  return NextResponse.json({ saved: true, researching: changed });
}
