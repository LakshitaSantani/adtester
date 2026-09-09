import { NextResponse } from "next/server";
import { resolveProject } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { newId, newSessionId } from "@/lib/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Seeds the worked example from the design docs.
 *
 * Worth having beyond testing: it's a reproducible demo, it costs no GitHub
 * quota, and — the real reason — it gives a *known correct answer* to check
 * the investigator against. A live repository can't do that, because nobody
 * knows which commit was actually to blame.
 *
 * Development only.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  const { token, scenario = "split" } = (await request.json()) as {
    token?: string;
    scenario?: "split" | "no-split" | "diffuse" | "no-release" | "spa";
  };
  if (!token) return NextResponse.json({ error: "missing token" }, { status: 401 });

  const db = await getDb();
  const project = await resolveProject(token, "admin");
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const pid = project.id;
  for (const table of ["evidence", "investigations", "sessions", "code_edges", "code_entities", "commits"]) {
    await db.query(
      table === "evidence"
        ? `DELETE FROM evidence WHERE investigation_id IN (SELECT id FROM investigations WHERE project_id = $1)`
        : `DELETE FROM ${table} WHERE project_id = $1`,
      [pid],
    );
  }

  // A small but realistic slice of a checkout flow. The route imports a form,
  // which imports validation — so validation sits two hops from the page, and
  // a change to it is a legitimate suspect for a problem seen on /checkout.
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

  // Five commits across two deploys, which is what makes this a fair test.
  //
  // Deploy times line up with when each build actually appeared: the old
  // build went out a week ago carrying b7d2e10, and everything since shipped
  // together in the new build a day ago. That matters, because it means the
  // form restyle is present in BOTH builds — so there is no comparison to
  // make for it, and the investigator should notice that and cap its
  // confidence rather than treating it as a rival explanation.
  const OLD_BUILD_AT = 168;
  const NEW_BUILD_AT = 21;

  const commits: Array<[string, number, string, string[]]> = [
    ["a3f91c2", NEW_BUILD_AT, "Tighten phone validation", ["src/checkout/validation.ts"]],
    ["c1a5f83", NEW_BUILD_AT, "Add avatar upload to profiles", ["src/account/ProfileForm.tsx"]],
    ["d4b8e29", NEW_BUILD_AT, "Bump analytics sampling", ["src/analytics/tracker.ts"]],
    ["e9c3a71", NEW_BUILD_AT, "Update the README", ["README.md"]],
    ["b7d2e10", OLD_BUILD_AT, "Restyle the checkout form", ["src/checkout/CheckoutForm.tsx"]],
  ];

  for (const [sha, hoursAgo, message, touched] of commits) {
    await db.query(
      `INSERT INTO commits
         (project_id, sha, authored_at, deployed_at, author, message, files_touched)
       VALUES ($1,$2,$3,$3,$4,$5,$6)`,
      [pid, sha, at(hoursAgo), "seed", message, touched],
    );
  }

  // Sessions, arranged so a real counterfactual exists.
  //
  // Two builds are live at the same time, which is the situation the whole
  // test depends on: most users are on the new build, a slice are still being
  // served the old one from cache. Were everyone on the same build there
  // would be nothing to compare, and the investigator would have to cap its
  // confidence and say why.
  const make = async (
    release: string,
    startHoursAgo: number,
    spreadHours: number,
    count: number,
    affected: number,
    path: string,
    /**
     * Where the session STARTED, when that differs from where it broke.
     * A single-page app lands people on the homepage and they click through,
     * so this is the normal case rather than an edge one.
     */
    entryPath?: string,
  ) => {
    for (let i = 0; i < count; i++) {
      const offset = (i / Math.max(1, count)) * spreadHours;
      await db.query(
        `INSERT INTO sessions
           (id, project_id, release, started_at, last_event_at, entry_url,
            user_agent, event_count, signatures, error_count, signature_paths, paths)
         VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,0,$9::jsonb,$10::text[])`,
        [
          newSessionId(),
          pid,
          release,
          at(startHoursAgo - offset),
          `https://shop.example.com${entryPath ?? path}`,
          "Mozilla/5.0 (Macintosh) Chrome/140",
          120 + i,
          i < affected ? ["field_retry"] : [],
          // Where the signature actually fired, which is the point.
          i < affected ? JSON.stringify({ field_retry: [path] }) : "{}",
          // Everyone visited the page, whether or not it broke for them —
          // that is the denominator the rate is measured against.
          entryPath && entryPath !== path ? [entryPath, path] : [path],
        ],
      );
    }
  };

  // Last week: the phone field almost never troubled anyone.
  await make(scenario === "no-release" ? "" : "b7d2e10", OLD_BUILD_AT, 140, 60, 1, "/checkout");

  if (scenario === "diffuse") {
    // The same signature all over the site. Nothing about one page's code can
    // explain that, so the investigator should refuse rather than blame a
    // commit that happens to have shipped nearby.
    for (const path of ["/checkout", "/account", "/search", "/cart", "/help"]) {
      await make("a3f91c2", NEW_BUILD_AT, 20, 12, 7, path);
    }
  } else if (scenario === "spa") {
    // Every session enters at "/" and the failure happens on /checkout after
    // the user clicks through. Reasoning from the entry URL would look at the
    // homepage's code and find nothing.
    await make("a3f91c2", NEW_BUILD_AT, 20, 40, 22, "/checkout", "/");
    await make("b7d2e10", NEW_BUILD_AT, 20, 15, 1, "/checkout", "/");
  } else if (scenario === "no-release") {
    // What imported PostHog data actually looks like: real sessions, no build
    // stamps anywhere. The investigator has to fall back to comparing the
    // same page before and after the deploy.
    await make("", NEW_BUILD_AT, 20, 55, 23, "/checkout");
  } else if (scenario === "no-split") {
    // Everyone moved to the new build at once — the common case for teams
    // that don't do gradual rollouts. There is no control group, so the
    // strongest signal is unavailable and confidence must be capped.
    await make("a3f91c2", NEW_BUILD_AT, 20, 55, 23, "/checkout");
  } else {
    // Since the validation change went out, on the new build: it does.
    await make("a3f91c2", NEW_BUILD_AT, 20, 40, 22, "/checkout");
    // Still on the old build over the same hours — the control group.
    await make("b7d2e10", NEW_BUILD_AT, 20, 15, 1, "/checkout");
  }

  const probe = await db.one<{ id: string }>(
    `SELECT id FROM sessions
      WHERE project_id = $1 AND release = 'a3f91c2' AND 'field_retry' = ANY(signatures)
      ORDER BY started_at DESC LIMIT 1`,
    [pid],
  );

  const expectations: Record<string, string> = {
    "no-split":
      "Everyone is on the new build, so there is no control group. a3f91c2 should " +
      "still lead, but confidence must be capped at 0.70 and the report must say why.",
    spa:
      "Every session entered at / and broke on /checkout, as a single-page app " +
      "behaves. Reasoning from the entry URL would examine the homepage and find " +
      "nothing; it should still name a3f91c2.",
    diffuse:
      "The signature is on five different pages. The investigator should decline " +
      "rather than blame a commit behind any one of them.",
    "no-release":
      "No build stamps anywhere, which is what imported PostHog data looks like. " +
      "The investigator should fall back to comparing the page before and after " +
      "the deploy, still name a3f91c2, and cap confidence at 0.85.",
  };

  return NextResponse.json({
    scenario,
    sessionId: probe?.id ?? null,
    commitsSeeded: commits.length,
    expectation: expectations[scenario] ??
      "Two of five commits touch code /checkout reaches: a3f91c2 (validation) and " +
      "b7d2e10 (the form). The counterfactual should separate them — 55% of sessions " +
      "on the new build hit the field-retry signature against ~7% of those still on " +
      "the old one — so a3f91c2 should win with high confidence. b7d2e10 is in " +
      "both builds, so it has no version split at all and should be capped at 0.70.",
  });
}
