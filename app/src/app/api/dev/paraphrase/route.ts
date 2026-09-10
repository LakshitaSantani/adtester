import { NextResponse } from "next/server";
import { resolveProject } from "@brain/auth";
import { getDb } from "@brain/db";
import { newId } from "@brain/ids";
import { retrieveCandidates } from "@brain/intent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Does a mined name actually make an unfindable document findable?
 *
 * Screening the model's answers proves they aren't invented. It says nothing
 * about whether they are worth having, and that is the claim this whole
 * mechanism rests on: a planning document that never uses a word from the
 * codebase is invisible to a keyword search, and one phrase written into the
 * lexicon should be the difference.
 *
 * So this sets up exactly that document, searches for it twice, and reports
 * the retrieval statistics either side. No model call — the alias is written
 * by hand, standing in for one the miner would have produced.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  const { token } = (await request.json()) as { token?: string };
  if (!token) return NextResponse.json({ error: "missing token" }, { status: 401 });

  const project = await resolveProject(token, "admin");
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const db = await getDb();
  const pid = project.id;
  const file = "src/checkout/PhoneInput.tsx";

  // A clean slate, so a re-run measures the same thing.
  await db.query(
    `DELETE FROM documents WHERE project_id = $1 AND title = 'Paraphrase fixture'`,
    [pid],
  );
  await db.query(
    `DELETE FROM code_entities WHERE project_id = $1 AND path = $2`,
    [pid, file],
  );

  await db.query(
    `INSERT INTO code_entities (id, project_id, path, kind, name, route, aliases)
     VALUES ($1,$2,$3,'component','PhoneInput',NULL,$4)`,
    // What the lexicon can build unaided: the filename, split up.
    [newId("ce"), pid, file, ["phoneinput", "phone input", "phone"]],
  );

  const documentId = newId("doc");
  await db.query(
    `INSERT INTO documents (id, project_id, title, source, url, occurred_at)
     VALUES ($1,$2,'Paraphrase fixture','transcript',NULL,now() - interval '2 days')`,
    [documentId, pid],
  );

  // Not one word here appears in the filename, and every word is ordinary.
  const passage =
    "Priya: people keep failing at the mobile number — it rejects anything " +
    "with a country code in front of it, and they just give up.";

  await db.query(
    `INSERT INTO chunks (id, project_id, document_id, position, text, speaker, occurred_at)
     VALUES ($1,$2,$3,0,$4,'Priya',now() - interval '2 days')`,
    [newId("chunk"), pid, documentId, passage],
  );

  const search = () =>
    retrieveCandidates(pid, [file], "Tighten the input rules", new Date().toISOString());

  const before = await search();

  await db.query(
    `UPDATE code_entities
        SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['mobile number'::text]))
      WHERE project_id = $1 AND path = $2`,
    [pid, file],
  );

  const after = await search();

  const found = (r: Awaited<ReturnType<typeof search>>) =>
    r.candidates.find((c) => c.row.document_id === documentId);

  const beforeHit = found(before);
  const afterHit = found(after);

  return NextResponse.json({
    pass: (beforeHit?.score ?? 0) === 0 && (afterHit?.score ?? 0) > 0,
    passage,
    before: {
      terms: before.stats.terms,
      matched: before.stats.matched,
      score: beforeHit?.score ?? null,
      reachedTheModel: Boolean(beforeHit),
      note:
        "The document still reaches the model, through the blind-coverage " +
        "slots that exist for exactly this. It arrives unranked, competing " +
        "with every other unmatched document for six places.",
    },
    after: {
      terms: after.stats.terms,
      matched: after.stats.matched,
      score: afterHit?.score ?? null,
      matchedOn: afterHit?.terms ?? [],
      note: "Now it is a scored match, and ranks on its own evidence.",
    },
  });
}
