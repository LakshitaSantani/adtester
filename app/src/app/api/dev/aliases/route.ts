import { NextResponse } from "next/server";
import { screenForTesting } from "@/lib/aliases";

export const runtime = "nodejs";

/**
 * Check the alias screening without spending a model call.
 *
 * The screening is the only thing standing between "the model noticed what
 * this team calls its quota service" and "the model made up a phrase that now
 * matches half the corpus". A live call is slow, costs money and answers
 * differently every time, so a regression here would never show up in a run
 * anyone would think to do.
 */
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  const corpus = `### Project Falcon — PRD
Falcon is the internal name for the org quota system. The meter decides
whether an account may create another workspace.

### Checkout planning call
Priya: the phone field keeps rejecting international numbers.
Sam: that is the validator in PhoneInput, we tightened it last week.`;

  const entities = [
    { path: "src/billing/org_quotas.ts", name: "org_quotas" },
    { path: "src/checkout/PhoneInput.tsx", name: "PhoneInput" },
  ];

  const cases: Array<{ proposal: Record<string, unknown>; expect: "keep" | "drop"; why: string }> = [
    {
      proposal: { path: "src/billing/org_quotas.ts", alias: "Project Falcon" },
      expect: "keep",
      why: "a real codename, in the documents, not derivable from the filename",
    },
    {
      proposal: { path: "src/billing/org_quotas.ts", alias: "the meter" },
      expect: "keep",
      why: "an internal nickname nobody could guess from the code",
    },
    {
      proposal: { path: "src/billing/org_quotas.ts", alias: "Project Condor" },
      expect: "drop",
      why: "invented — reads exactly like the real one and appears nowhere",
    },
    {
      proposal: { path: "src/secret/hidden.ts", alias: "Falcon" },
      expect: "drop",
      why: "attaches a name to a file that was never offered",
    },
    {
      proposal: { path: "src/checkout/PhoneInput.tsx", alias: "PhoneInput" },
      expect: "drop",
      why: "restates the filename, which the lexicon already covers",
    },
    {
      proposal: {
        path: "src/checkout/PhoneInput.tsx",
        alias: "the phone field keeps rejecting international numbers",
      },
      expect: "drop",
      why: "a sentence, not a name",
    },
    {
      proposal: { path: "src/checkout/PhoneInput.tsx", alias: "is" },
      expect: "drop",
      why: "too short to mean anything",
    },
    {
      proposal: { path: "src/billing/org_quotas.ts", alias: "org quota system" },
      expect: "keep",
      why: "third name for this file — the last one under the cap",
    },
    {
      proposal: { path: "src/billing/org_quotas.ts", alias: "another workspace" },
      expect: "drop",
      why: "fourth name for one file, past the point where a search narrows",
    },
  ];

  const result = screenForTesting(
    cases.map((c) => c.proposal),
    entities,
    corpus,
  );

  const kept = new Set(result.accepted.map((a) => a.alias));
  const checked = cases.map((c) => {
    const alias = String(c.proposal.alias ?? "").toLowerCase();
    const actual = kept.has(alias) ? "keep" : "drop";
    return {
      alias: c.proposal.alias,
      expected: c.expect,
      actual,
      correct: actual === c.expect,
      why: c.why,
      reason:
        result.rejected.find((r) => r.alias.toLowerCase() === alias)?.reason ?? null,
    };
  });

  const failures = checked.filter((c) => !c.correct);

  return NextResponse.json({
    pass: failures.length === 0,
    proposed: result.proposed,
    accepted: result.accepted.map((a) => `${a.alias} -> ${a.path}`),
    checked,
    note:
      "The corpus-share rule — an alias matching more than a quarter of all " +
      "passages is a word rather than a name — needs real chunks in the " +
      "database and is not exercised here.",
  });
}
