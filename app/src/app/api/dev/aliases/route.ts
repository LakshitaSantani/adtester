import { NextResponse } from "next/server";
import { screenForTesting } from "@/lib/aliases";

export const runtime = "nodejs";

/**
 * Check the alias screening without spending a model call.
 *
 * The screening is the only thing standing between "the model noticed that
 * this team says mobile number" and "the model made up a phrase that now
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
Priya: people keep failing at the mobile number, it rejects anything with a
country code.
Sam: that is the validator in PhoneInput, we tightened it last week.
Priya: the service is slow too, but that is a separate thing.`;

  const entities = [
    { path: "src/billing/org_quotas.ts", name: "org_quotas" },
    { path: "src/checkout/PhoneInput.tsx", name: "PhoneInput" },
    { path: "src/checkout/validation.ts", name: "validation" },
  ];

  const cases: Array<{ proposal: Record<string, unknown>; expect: "keep" | "drop"; why: string }> = [
    // --- codenames, the case this already handled -------------------------
    {
      proposal: { path: "src/billing/org_quotas.ts", alias: "Project Falcon" },
      expect: "keep",
      why: "a codename, in the documents, not derivable from the filename",
    },
    {
      proposal: { path: "src/billing/org_quotas.ts", alias: "the meter" },
      expect: "keep",
      why: "an internal nickname nobody could guess from the code",
    },
    // --- paraphrase, the case this is being extended for ------------------
    {
      proposal: { path: "src/checkout/PhoneInput.tsx", alias: "mobile number" },
      expect: "keep",
      why: "ordinary English for the same thing, sharing no words with the filename",
    },
    {
      proposal: { path: "src/checkout/PhoneInput.tsx", alias: "country code" },
      expect: "keep",
      why: "a second way in — one thing has several ordinary names",
    },
    // --- and the ways paraphrase goes wrong -------------------------------
    {
      proposal: { path: "src/checkout/PhoneInput.tsx", alias: "the service" },
      expect: "drop",
      why: "too general to identify anything — the guard against ordinary English",
    },
    {
      proposal: { path: "src/checkout/PhoneInput.tsx", alias: "mobile phone number" },
      expect: "drop",
      why: "a plausible paraphrase that nobody in these documents actually said",
    },
    {
      proposal: { path: "src/checkout/validation.ts", alias: "the validator" },
      expect: "drop",
      why: "offered for two files at once, so it identifies neither",
    },
    {
      proposal: { path: "src/checkout/PhoneInput.tsx", alias: "the validator" },
      expect: "drop",
      why: "the other half of the same ambiguity",
    },
    // --- the original guards, still holding -------------------------------
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
      proposal: { path: "src/checkout/PhoneInput.tsx", alias: "is" },
      expect: "drop",
      why: "too short to mean anything",
    },
  ];

  const result = screenForTesting(
    cases.map((c) => c.proposal),
    entities,
    corpus,
  );

  const kept = new Set(result.accepted.map((a) => `${a.path} ${a.alias}`));
  const checked = cases.map((c) => {
    const alias = String(c.proposal.alias ?? "").toLowerCase();
    const actual = kept.has(`${c.proposal.path} ${alias}`) ? "keep" : "drop";
    return {
      alias: c.proposal.alias,
      path: c.proposal.path,
      expected: c.expect,
      actual,
      correct: actual === c.expect,
      why: c.why,
      reason:
        result.rejected.find(
          (r) => r.alias.toLowerCase() === alias && r.path === c.proposal.path,
        )?.reason ?? null,
    };
  });

  const failures = checked.filter((c) => !c.correct);

  return NextResponse.json({
    pass: failures.length === 0,
    proposed: result.proposed,
    accepted: result.accepted.map((a) => `${a.alias} -> ${a.path}`),
    checked,
    note:
      "Two rules need real data and are not exercised here: the corpus-share " +
      "cap, which drops a phrase appearing in more than a quarter of all " +
      "passages, and the per-file limit of five names.",
  });
}
