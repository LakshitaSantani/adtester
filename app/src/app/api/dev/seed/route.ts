import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { newId, newSessionId } from "@/lib/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Seeds the worked example from the design docs, so the candidate filter can
 * be exercised without a GitHub round trip.
 *
 * Worth having beyond testing: it's a reproducible demo, it costs no API
 * quota, and it gives a known-correct answer to check the filter against —
 * which a live repo can't, because nobody knows which commit "should" win.
 *
 * Development only.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  const { token } = (await request.json()) as { token?: string };
  if (!token) return NextResponse.json({ error: "missing token" }, { status: 401 });

  const db = await getDb();
  const project = await db.one<{ id: string }>(
    `SELECT id FROM projects WHERE view_token = $1`,
    [token],
  );
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const pid = project.id;
  for (const table of ["code_edges", "code_entities", "commits"]) {
    await db.query(`DELETE FROM ${table} WHERE project_id = $1`, [pid]);
  }

  // A small but realistic slice of a checkout flow. The route imports a form,
  // which imports validation — so validation is reachable at depth 2, and a
  // change to it is a legitimate suspect for a problem seen on /checkout.
  const files: Array<[string, string, string | null]> = [
    ["app/checkout/page.tsx", "route", "/checkout"],
    ["app/account/page.tsx", "route", "/account"],
    ["src/checkout/CheckoutForm.tsx", "component", null],
    ["src/checkout/validation.ts", "module", null],
    ["src/checkout/PhoneInput.tsx", "component", null],
    ["src/account/ProfileForm.tsx", "component", null],
    ["src/analytics/tracker.ts", "module", null],
  ];

  for (const [path, kind, route] of files) {
    const name = path.split("/").pop()!.replace(/\.\w+$/, "");
    await db.query(
      `INSERT INTO code_entities (id, project_id, path, kind, name, route, aliases)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [newId("ce"), pid, path, kind, name, route, [name.toLowerCase()]],
    );
  }

  const edges: Array<[string, string]> = [
    ["app/checkout/page.tsx", "src/checkout/CheckoutForm.tsx"],
    ["src/checkout/CheckoutForm.tsx", "src/checkout/validation.ts"],
    ["src/checkout/CheckoutForm.tsx", "src/checkout/PhoneInput.tsx"],
    ["app/account/page.tsx", "src/account/ProfileForm.tsx"],
  ];
  for (const [from, to] of edges) {
    await db.query(
      `INSERT INTO code_edges (project_id, from_path, to_path) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [pid, from, to],
    );
  }

  const now = Date.now();
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString();

  // Five commits in the window. Only two touch anything /checkout reaches —
  // the rest are the noise a real week produces, and the filter's whole job
  // is to remove them without a model.
  const commits: Array<[string, number, string, string[]]> = [
    ["a3f91c2", 6, "Tighten phone validation", ["src/checkout/validation.ts"]],
    ["b7d2e10", 9, "Restyle the checkout form", ["src/checkout/CheckoutForm.tsx"]],
    ["c1a5f83", 12, "Add avatar upload to profiles", ["src/account/ProfileForm.tsx"]],
    ["d4b8e29", 20, "Bump analytics sampling", ["src/analytics/tracker.ts"]],
    ["e9c3a71", 30, "Update the README", ["README.md"]],
  ];

  for (const [sha, hoursAgo, message, touched] of commits) {
    await db.query(
      `INSERT INTO commits
         (project_id, sha, authored_at, deployed_at, author, message, files_touched)
       VALUES ($1,$2,$3,$3,$4,$5,$6)
       ON CONFLICT (project_id, sha) DO UPDATE SET
         deployed_at = EXCLUDED.deployed_at,
         files_touched = EXCLUDED.files_touched`,
      [pid, sha, at(hoursAgo), "seed", message, touched],
    );
  }

  // A session on /checkout, on the build that carries the validation change.
  const sessionId = newSessionId();
  await db.query(
    `INSERT INTO sessions
       (id, project_id, release, started_at, last_event_at, entry_url,
        user_agent, event_count, signatures, error_count)
     VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9)`,
    [
      sessionId,
      pid,
      "a3f91c2",
      at(2),
      "https://shop.example.com/checkout",
      "Mozilla/5.0 (Macintosh) Chrome/140",
      142,
      ["field_retry"],
      0,
    ],
  );

  return NextResponse.json({
    sessionId,
    commitsSeeded: commits.length,
    expectation:
      "Two of five commits touch code /checkout reaches: a3f91c2 (validation) " +
      "and b7d2e10 (the form itself).",
  });
}
