import { NextResponse } from "next/server";
import { resolveProject } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { newId, newSessionId } from "@/lib/ids";
import { ingestDocument } from "@/lib/ingest-docs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A fully populated dashboard, for looking at.
 *
 * Distinct from /api/dev/seed on purpose. Seed builds a scenario with a known
 * correct answer and then makes the real investigator work it out — that is
 * how the brain gets tested. This writes the finished output directly,
 * including the parts that need an Anthropic key, so the interface can be
 * judged without one.
 *
 * Nothing here was worked out by the product. Every claim, score and quote is
 * written by hand, which is why each finding is tagged as a demo in the
 * database rather than trusting anyone to remember.
 *
 * Development only.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  const { token } = (await request.json()) as { token?: string };
  const project = await resolveProject(token, "admin");
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const db = await getDb();
  const pid = project.id;

  for (const table of ["evidence", "feedback", "investigations", "sessions", "code_edges", "code_entities", "commits", "chunks", "documents"]) {
    await db.query(
      ["evidence", "feedback"].includes(table)
        ? `DELETE FROM ${table} WHERE investigation_id IN (SELECT id FROM investigations WHERE project_id = $1)`
        : `DELETE FROM ${table} WHERE project_id = $1`,
      [pid],
    );
  }

  const now = Date.now();
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString();

  // --- the codebase --------------------------------------------------------

  const files: Array<[string, string, string | null]> = [
    ["app/checkout/page.tsx", "route", "/checkout"],
    ["app/account/page.tsx", "route", "/account"],
    ["app/pricing/page.tsx", "route", "/pricing"],
    ["src/checkout/CheckoutForm.tsx", "component", null],
    ["src/checkout/validation.ts", "module", null],
    ["src/account/AvatarUpload.tsx", "component", null],
    ["src/pricing/PlanPicker.tsx", "component", null],
  ];
  for (const [path, kind, route] of files) {
    const name = path.split("/").pop()!.replace(/\.\w+$/, "");
    await db.query(
      `INSERT INTO code_entities (id, project_id, path, kind, name, route, aliases)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [newId("ce"), pid, path, kind, name, route, [name.toLowerCase()]],
    );
  }
  for (const [from, to] of [
    ["app/checkout/page.tsx", "src/checkout/CheckoutForm.tsx"],
    ["src/checkout/CheckoutForm.tsx", "src/checkout/validation.ts"],
    ["app/account/page.tsx", "src/account/AvatarUpload.tsx"],
    ["app/pricing/page.tsx", "src/pricing/PlanPicker.tsx"],
  ]) {
    await db.query(
      `INSERT INTO code_edges (project_id, from_path, to_path) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [pid, from, to],
    );
  }

  const commits: Array<[string, number, string, string, string[]]> = [
    ["a3f91c2", 21, "Tighten phone validation", "priya", ["src/checkout/validation.ts"]],
    ["c1a5f83", 44, "Add avatar upload to profiles", "devon", ["src/account/AvatarUpload.tsx"]],
    ["e2d70b4", 70, "Rework the plan picker layout", "sam", ["src/pricing/PlanPicker.tsx"]],
    ["b7d2e10", 168, "Restyle the checkout form", "priya", ["src/checkout/CheckoutForm.tsx"]],
  ];
  for (const [sha, hoursAgo, message, author, touched] of commits) {
    await db.query(
      `INSERT INTO commits (project_id, sha, authored_at, deployed_at, author, message, files_touched)
       VALUES ($1,$2,$3,$3,$4,$5,$6)`,
      [pid, sha, at(hoursAgo), author, message, touched],
    );
  }

  // --- sessions ------------------------------------------------------------

  const makeSessions = async (
    count: number,
    affected: number,
    path: string,
    signature: string,
    release: string,
    hoursAgo: number,
  ): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = newSessionId();
      ids.push(id);
      await db.query(
        `INSERT INTO sessions
           (id, project_id, release, started_at, last_event_at, entry_url, user_agent,
            event_count, signatures, error_count, source)
         VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,'posthog')`,
        [
          id,
          pid,
          release,
          at(hoursAgo - (i / count) * 18),
          `https://shop.example.com${path}`,
          i % 3 === 0
            ? "Mozilla/5.0 (iPhone) Safari/17"
            : "Mozilla/5.0 (Macintosh) Chrome/140",
          80 + i * 3,
          i < affected ? [signature] : [],
          i < affected && signature === "js_error" ? 1 : 0,
        ],
      );
    }
    return ids;
  };

  const checkoutSessions = await makeSessions(40, 22, "/checkout", "field_retry", "a3f91c2", 20);
  await makeSessions(15, 1, "/checkout", "field_retry", "b7d2e10", 20);
  await makeSessions(60, 1, "/checkout", "field_retry", "b7d2e10", 168);
  const accountSessions = await makeSessions(34, 12, "/account", "js_error", "c1a5f83", 40);
  const pricingSessions = await makeSessions(28, 6, "/pricing", "dead_click", "e2d70b4", 66);
  for (const p of ["/search", "/cart", "/help", "/settings", "/inbox"]) {
    await makeSessions(11, 5, p, "rage_click", "a3f91c2", 16);
  }

  // --- the documents behind the first finding ------------------------------

  await ingestDocument(pid, {
    filename: "checkout-v2-prd.md",
    text: `# Checkout v2\n\n## 2.2 Phone number validation\n\nThe phone field must accept E.164 international format. Roughly a fifth of orders come from outside the US, and rejecting a valid international number is the worst failure mode here because the customer has no way to tell what we wanted.\n`,
    occurredAt: at(30 * 24),
  });
  await ingestDocument(pid, {
    filename: "sprint-planning-2026-09-04.md",
    text: `# Sprint planning\n\nPriya: The PRD says we need E.164, so international numbers. Do we actually need international for launch?\n\nMarco: US-only is fine for now, we'll add it back after launch. Ship the simple version.\n\nPriya: Fine, but if someone types a plus sign we're going to reject them outright with no explanation. That's going to look broken rather than restricted.\n`,
    occurredAt: at(5 * 24),
  });

  const chunks = await db.query<{ id: string; text: string; speaker: string | null }>(
    `SELECT id, text, speaker FROM chunks WHERE project_id = $1`,
    [pid],
  );
  const chunkFor = (needle: string) => chunks.find((c) => c.text.includes(needle))?.id ?? null;

  // --- findings ------------------------------------------------------------

  type Signal = [string, string, string, number];

  const addInvestigation = async (opts: {
    symptom: string;
    startedHoursAgo: number;
    status: "claimed" | "declined";
    claim: string;
    sha?: string;
    confidence?: number;
    declinedReason?: string;
    sessions?: string[];
    candidates?: Array<{
      sha: string;
      message: string;
      author: string;
      matched: string[];
      touched: number;
      score: number;
      capped: boolean;
      signals: Signal[];
    }>;
    intent?: Array<{
      kind: "prd" | "transcript";
      chunkId: string | null;
      quote: string;
      title: string;
      speaker: string | null;
      relevance: string;
      occurredAt: string;
    }>;
    analysis?: Record<string, unknown>;
    verdict?: { correct: boolean; note: string };
  }) => {
    const id = newId("inv");
    await db.query(
      `INSERT INTO investigations
         (id, project_id, symptom, symptom_started, status, claim, commit_sha,
          confidence, declined_reason, created_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [
        id,
        pid,
        opts.symptom,
        at(opts.startedHoursAgo),
        opts.status,
        opts.claim,
        opts.sha ?? null,
        opts.confidence ?? null,
        opts.declinedReason ?? null,
        at(opts.startedHoursAgo - 1),
      ],
    );

    for (const sessionId of (opts.sessions ?? []).slice(0, 8)) {
      await db.query(
        `INSERT INTO evidence (id, investigation_id, kind, ref, detail)
         VALUES ($1,$2,'session',$3,'{}'::jsonb)`,
        [newId("ev"), id, sessionId],
      );
    }

    for (const [rank, c] of (opts.candidates ?? []).entries()) {
      await db.query(
        `INSERT INTO evidence (id, investigation_id, kind, ref, quote, detail, contribution)
         VALUES ($1,$2,'commit',$3,$4,$5,$6)`,
        [
          newId("ev"),
          id,
          c.sha,
          c.message,
          JSON.stringify({
            rank,
            matchedFiles: c.matched,
            filesTouched: c.touched,
            author: c.author,
            capped: c.capped,
          }),
          c.score,
        ],
      );
      for (const [name, label, detail, contribution] of c.signals) {
        await db.query(
          `INSERT INTO evidence (id, investigation_id, kind, ref, quote, detail, contribution)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            newId("ev"),
            id,
            name === "counterfactual" ? "counterfactual" : "signal",
            c.sha,
            detail,
            JSON.stringify({ signal: name, label, score: contribution }),
            contribution,
          ],
        );
      }
    }

    for (const m of opts.intent ?? []) {
      await db.query(
        `INSERT INTO evidence (id, investigation_id, kind, ref, quote, detail, contribution)
         VALUES ($1,$2,$3,$4,$5,$6,0)`,
        [
          newId("ev"),
          id,
          m.kind,
          m.chunkId,
          m.quote,
          JSON.stringify({
            title: m.title,
            speaker: m.speaker,
            occurredAt: m.occurredAt,
            kind: m.kind === "transcript" ? "decision" : "requirement",
            relevance: m.relevance,
          }),
        ],
      );
    }

    if (opts.analysis) {
      await db.query(
        `INSERT INTO evidence (id, investigation_id, kind, ref, quote, detail, contribution)
         VALUES ($1,$2,'analysis',$3,$4,$5,0)`,
        [
          newId("ev"),
          id,
          opts.sha ?? null,
          String(opts.analysis.howItBroke ?? ""),
          JSON.stringify(opts.analysis),
        ],
      );
    }

    if (opts.verdict) {
      await db.query(
        `INSERT INTO feedback (investigation_id, was_correct, note) VALUES ($1,$2,$3)`,
        [id, opts.verdict.correct, opts.verdict.note],
      );
    }
  };

  // 1. The full worked example: high confidence, intent, analysis, a fix.
  await addInvestigation({
    symptom: "field retry on /checkout",
    startedHoursAgo: 20,
    status: "claimed",
    claim: "Tighten phone validation (a3f91c2) introduced field retry on /checkout.",
    sha: "a3f91c2",
    confidence: 0.89,
    sessions: checkoutSessions,
    candidates: [
      {
        sha: "a3f91c2",
        message: "Tighten phone validation",
        author: "priya",
        matched: ["src/checkout/validation.ts"],
        touched: 1,
        score: 0.89,
        capped: false,
        signals: [
          ["counterfactual", "Counterfactual", "55% of 40 sessions on builds with the change hit this, against 7% of 15 on builds without it.", 0.45],
          ["codePath", "Code path", "1 of 1 changed files are on this page's path.", 0.2],
          ["onset", "Onset", "The symptom started 1.2 hours after this deployed.", 0.2],
          ["volume", "Volume", "22 sessions affected.", 0.12],
          ["dilution", "Other candidates", "1 other change could explain this equally well.", -0.08],
        ],
      },
      {
        sha: "b7d2e10",
        message: "Restyle the checkout form",
        author: "priya",
        matched: ["src/checkout/CheckoutForm.tsx"],
        touched: 1,
        score: 0.35,
        capped: false,
        signals: [
          ["counterfactual", "Counterfactual", "Every session in this window was on the same side of this change, so there is no comparison to make.", 0],
          ["codePath", "Code path", "1 of 1 changed files are on this page's path.", 0.2],
          ["onset", "Onset", "The symptom started 147.0 hours after this deployed.", 0.02],
          ["volume", "Volume", "22 sessions affected.", 0.12],
          ["dilution", "Other candidates", "1 other change could explain this equally well.", -0.08],
        ],
      },
    ],
    intent: [
      {
        kind: "prd",
        chunkId: chunkFor("E.164"),
        quote: "The phone field must accept E.164 international format.",
        title: "Checkout v2",
        speaker: null,
        relevance: "The shipped validation rejects exactly the format this requires.",
        occurredAt: at(30 * 24),
      },
      {
        kind: "transcript",
        chunkId: chunkFor("US-only"),
        quote: "US-only is fine for now, we'll add it back after launch. Ship the simple version.",
        title: "Sprint planning",
        speaker: "Marco",
        relevance: "The decision that narrowed the change, taken verbally and never written down anywhere else.",
        occurredAt: at(5 * 24),
      },
      {
        kind: "transcript",
        chunkId: chunkFor("plus sign"),
        quote: "if someone types a plus sign we're going to reject them outright with no explanation",
        title: "Sprint planning",
        speaker: "Priya",
        relevance: "The exact failure users then hit, raised before it shipped.",
        occurredAt: at(5 * 24),
      },
    ],
    analysis: {
      whatChanged:
        "validatePhone() was replaced with a strict ten-digit check, /^\\d{10}$/, dropping the permissive parser that previously accepted country codes and separators.",
      howItBroke:
        "Any number containing a plus sign, spaces or more than ten digits now fails validation, and the form shows a generic error rather than saying what format it wants. International customers cannot get past the field at all.",
      whatUsersHit:
        "In the recordings, people type a number, tab away, get an error, retype it a slightly different way, and after the third attempt abandon checkout.",
      fix: {
        path: "src/checkout/validation.ts",
        rationale:
          "Restore E.164 parsing, keeping US numbers working by defaulting the country when none is given.",
        patch: `--- a/src/checkout/validation.ts\n+++ b/src/checkout/validation.ts\n@@ -12,7 +12,8 @@\n export function validatePhone(input: string): boolean {\n-  return /^\\d{10}$/.test(input);\n+  const parsed = parsePhoneNumber(input, { defaultCountry: "US" });\n+  return parsed.isValid();\n }`,
        caveat: null,
      },
    },
    verdict: {
      correct: true,
      note: "Right commit and the right reason. Priya's line is the bit that made it obvious.",
    },
  });

  // 2. Capped: nobody stamped a build, so it's a before/after comparison.
  await addInvestigation({
    symptom: "js error on /account",
    startedHoursAgo: 40,
    status: "claimed",
    claim: "Add avatar upload to profiles (c1a5f83) introduced js error on /account.",
    sha: "c1a5f83",
    confidence: 0.72,
    sessions: accountSessions,
    candidates: [
      {
        sha: "c1a5f83",
        message: "Add avatar upload to profiles",
        author: "devon",
        matched: ["src/account/AvatarUpload.tsx"],
        touched: 3,
        score: 0.72,
        capped: true,
        signals: [
          ["counterfactual", "Before / after", "No build stamps, so this compares the same page either side of the deploy: 35% of 34 sessions after against 2% of 51 before. Nothing else deployed at that moment.", 0.45],
          ["codePath", "Code path", "1 of 3 changed files are on this page's path.", 0.07],
          ["onset", "Onset", "The symptom started 0.4 hours after this deployed.", 0.2],
          ["volume", "Volume", "12 sessions affected.", 0.09],
          ["dilution", "Other candidates", "No other change survived the same filters.", 0],
        ],
      },
    ],
    verdict: {
      correct: true,
      note: "Correct, though we'd already found this one ourselves from Sentry.",
    },
  });

  // 3. Low confidence, and a fix it declines to write.
  await addInvestigation({
    symptom: "dead click on /pricing",
    startedHoursAgo: 66,
    status: "claimed",
    claim: "Rework the plan picker layout (e2d70b4) introduced dead click on /pricing.",
    sha: "e2d70b4",
    confidence: 0.44,
    sessions: pricingSessions,
    candidates: [
      {
        sha: "e2d70b4",
        message: "Rework the plan picker layout",
        author: "sam",
        matched: ["src/pricing/PlanPicker.tsx"],
        touched: 9,
        score: 0.44,
        capped: true,
        signals: [
          ["counterfactual", "Before / after", "No build stamps, so this compares the same page either side of the deploy: 21% of 28 sessions after against 11% of 40 before. 2 other changes went out in the same deploy, so timing alone cannot separate them.", 0.22],
          ["codePath", "Code path", "1 of 9 changed files are on this page's path.", 0.06],
          ["onset", "Onset", "The symptom started 5.1 hours after this deployed.", 0.14],
          ["volume", "Volume", "6 sessions affected.", 0.07],
          ["dilution", "Other candidates", "No other change survived the same filters.", 0],
        ],
      },
    ],
    analysis: {
      whatChanged:
        "The plan cards were changed from buttons to divs with a click handler, and the outer card now has a larger padded area than the handler covers.",
      howItBroke:
        "Clicks that land on the padding hit the card but not the handler, so nothing happens. It is not consistent, which matches the low session count.",
      whatUsersHit:
        "People click a plan, nothing changes, and they click again slightly lower before it works.",
      fix: {
        path: "src/pricing/PlanPicker.tsx",
        rationale:
          "The handler should sit on the same element as the padding, but this touches the keyboard behaviour too.",
        patch: null,
        caveat:
          "Fixing this properly means going back to a real button element, which changes focus and keyboard handling across the whole card. That is a decision about the component's API rather than a small edit.",
      },
    },
    verdict: {
      correct: false,
      note: "Wrong. The dead clicks are on the FAQ accordion further down, not the plan cards.",
    },
  });

  // 4-6. The refusals, so all three are visible.
  await addInvestigation({
    symptom: "rage click across 5 pages",
    startedHoursAgo: 16,
    status: "declined",
    claim:
      "This is happening across 5 different pages, so it can't be pinned to the code behind any one of them. Worth looking at infrastructure, a shared dependency, or a browser release.",
    declinedReason: "diffuse",
  });

  await addInvestigation({
    symptom: "network error on /search",
    startedHoursAgo: 30,
    status: "declined",
    claim:
      "3 changes fit equally well and the evidence doesn't separate them. The likeliest are e2d70b4 and c1a5f83. A gradual rollout would separate them — with some users on each build, the difference shows up directly.",
    declinedReason: "tied_candidates",
  });

  await addInvestigation({
    symptom: "field retry on /settings",
    startedHoursAgo: 12,
    status: "declined",
    claim: "No indexed route matches /settings, so the code path can't be narrowed.",
    declinedReason: "no_route",
  });

  const [totals] = await db.query<{ sessions: number; investigations: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM sessions WHERE project_id = $1) AS sessions,
       (SELECT COUNT(*)::int FROM investigations WHERE project_id = $1) AS investigations`,
    [pid],
  );

  return NextResponse.json({
    ...totals,
    note:
      "Demo data. Every claim, score and quote here was written by hand, not worked out by " +
      "the product. Use /api/dev/seed to test whether the analysis is actually correct.",
  });
}
