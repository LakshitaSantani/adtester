/**
 * The investigator.
 *
 * Runs the pipeline from the design doc: symptom, time window, code path,
 * counterfactual, claim. Every step before the counterfactual is a database
 * query over exact edges — no model is involved anywhere in phase 4, which
 * is deliberate. If the causal core is wrong, richer storytelling on top of
 * it only makes it wrong more convincingly.
 *
 * It has three ways to refuse, and using them is the point. A product that
 * always answers is a product that is often wrong, and with engineers as the
 * audience one confidently wrong root cause ends the relationship.
 */

import { analyse, fetchFileContents, type Analysis } from "./analyst";
import { candidatesForSession, type Candidate } from "./candidates";
import { score, type Scored } from "./confidence";
import { testCounterfactual, type Counterfactual } from "./counterfactual";
import { decrypt } from "./crypto";
import { getDb } from "./db";
import { getCommitDiff, type RepoRef } from "./github";
import { findIntent, type IntentMatch } from "./intent";
import { eventsAround } from "./market";
import { buildTimeline, formatTimeline } from "./session-timeline";
import { newId } from "./ids";
import { resolveAnthropicKey } from "./secrets";
import { describeSymptom, isDiffuse, type Symptom } from "./symptoms";

/**
 * Two candidates whose confidence differs by less than this are not
 * distinguishable, and saying otherwise would be a coin toss dressed up as
 * an answer.
 */
const TIE_THRESHOLD = 0.1;

/** Below this, nothing is worth asserting. */
const MIN_CLAIM_CONFIDENCE = 0.35;

export type DeclineReason =
  | "diffuse"
  /** The page's code was never found, so nothing could be ruled in or out. */
  | "no_route"
  /** The code WAS found, and nothing that shipped touches it. */
  | "no_candidates"
  | "tied_candidates"
  | "low_confidence";

export type Investigation = {
  id: string;
  status: "claimed" | "declined";
  symptom: string;
  claim: string | null;
  commitSha: string | null;
  confidence: number | null;
  declinedReason: DeclineReason | null;
  ranked: Array<{ candidate: Candidate; scored: Scored; counterfactual: Counterfactual }>;
};

/**
 * Investigate one symptom.
 *
 * The candidate set comes from an affected session rather than being
 * recomputed: the session already knows its URL and its build, which is
 * exactly what the code-path filter needs.
 */
export async function investigate(
  projectId: string,
  symptom: Symptom,
  /** A key supplied for this run only, when the project stored none. */
  suppliedKey?: string | null,
): Promise<Investigation> {
  const db = await getDb();
  const id = newId("inv");
  const description = describeSymptom(symptom);

  await db.query(
    `INSERT INTO investigations (id, project_id, symptom, symptom_started, status)
     VALUES ($1,$2,$3,$4,'running')`,
    [id, projectId, description, symptom.startedAt],
  );

  const decline = async (reason: DeclineReason, note: string): Promise<Investigation> => {
    await db.query(
      `UPDATE investigations
          SET status = 'declined', declined_reason = $2, claim = $3, completed_at = now()
        WHERE id = $1`,
      [id, reason, note],
    );
    // A refusal is exactly where what happened outside the code matters most.
    // "Nothing you shipped explains this" is more useful with "and here is
    // what changed in the market that week" beside it.
    await attachMarketContext(id, projectId, symptom.startedAt);
    return {
      id,
      status: "declined",
      symptom: description,
      claim: note,
      commitSha: null,
      confidence: null,
      declinedReason: reason,
      ranked: [],
    };
  };

  // Refusal 1: a symptom spread across many pages isn't traceable to the
  // code behind any one of them. Usually infrastructure, a dependency, or a
  // browser update — and blaming a commit would be a guess.
  if (isDiffuse(symptom)) {
    return decline(
      "diffuse",
      `This is happening across ${symptom.pathCount} different pages, so it can't be ` +
        `pinned to the code behind any one of them. Worth looking at infrastructure, ` +
        `a shared dependency, or a browser release.`,
    );
  }

  // Use an affected session as the probe into the code path.
  const probeSessionId = symptom.sessionIds[0];
  if (!probeSessionId) {
    return decline("no_candidates", "No affected sessions to work from.");
  }

  const narrowed = await candidatesForSession(probeSessionId, { path: symptom.path });
  if (!narrowed || narrowed.candidates.length === 0) {
    // Two very different failures used to share one label. "Nothing shipped
    // that touches this page" means there is nothing to do. "We couldn't
    // find this page's code at all" means the setup is incomplete — an
    // unrecognised framework, or the wrong repository — and is fixable.
    const routeUnknown =
      narrowed !== null && narrowed.matchedRoutes.length === 0 && narrowed.path !== null;
    return decline(
      routeUnknown ? "no_route" : "no_candidates",
      narrowed?.note ??
        "Nothing that shipped recently touches code this page reaches, so no change here explains it.",
    );
  }

  // Score every survivor. The counterfactual runs per candidate because each
  // one splits the population at a different moment.
  const ranked: Investigation["ranked"] = [];

  for (const candidate of narrowed.candidates) {
    const counterfactual = await testCounterfactual(
      projectId,
      candidate.sha,
      symptom.signature,
      symptom.path,
      symptom.startedAt,
    );

    const deployedAt = candidate.deployedAt ?? candidate.authoredAt;
    const onsetGapHours = deployedAt
      ? (new Date(symptom.startedAt).getTime() - new Date(deployedAt).getTime()) / 3_600_000
      : null;

    const scored = score({
      counterfactual,
      matchedFiles: candidate.matchedFiles.length,
      filesTouched: candidate.filesTouchedCount,
      onsetGapHours,
      affectedSessions: symptom.affectedSessions,
      candidateCount: narrowed.candidates.length,
    });

    ranked.push({ candidate, scored, counterfactual });
  }

  ranked.sort((a, b) => b.scored.confidence - a.scored.confidence);
  const best = ranked[0];
  const runnerUp = ranked[1];

  // Refusal 2: if the top two can't be separated, rank them and claim
  // nothing. Two plausible suspects presented honestly is more useful than
  // one presented falsely.
  if (runnerUp && best.scored.confidence - runnerUp.scored.confidence < TIE_THRESHOLD) {
    const note =
      `${ranked.length} changes fit equally well and the evidence doesn't separate them. ` +
      `The likeliest are ${best.candidate.sha.slice(0, 8)} and ` +
      `${runnerUp.candidate.sha.slice(0, 8)}.` +
      (best.counterfactual.available
        ? ""
        : " A gradual rollout would separate them — with some users on each build, " +
          "the difference shows up directly.");
    await saveEvidence(id, ranked);
    return { ...(await decline("tied_candidates", note)), ranked };
  }

  // Refusal 3: a leader that still isn't convincing.
  if (best.scored.confidence < MIN_CLAIM_CONFIDENCE) {
    await saveEvidence(id, ranked);
    return {
      ...(await decline(
        "low_confidence",
        `The strongest candidate is ${best.candidate.sha.slice(0, 8)}, but the evidence ` +
          `is too thin to call it. ${weakestLink(best.scored)}`,
      )),
      ranked,
    };
  }

  // Only now, on the one commit we're actually going to name, do we go
  // looking for what the team said they were building. Running this over
  // every candidate would cost a model call each to explain changes we are
  // about to discard.
  const apiKey = suppliedKey ?? (await resolveAnthropicKey(projectId));

  let intent: IntentMatch[] = [];
  try {
    intent = await findIntent(
      projectId,
      {
        sha: best.candidate.sha,
        message: best.candidate.message,
        files: best.candidate.matchedFiles,
        deployedAt: best.candidate.deployedAt,
      },
      description,
      apiKey,
    );
  } catch (error) {
    // An enrichment must never take down a finding that stands on its own.
    console.log("investigate: intent lookup failed", error);
  }

  // The analyst runs last and knows the verdict. It is never asked which
  // commit is responsible — only to explain one it was handed.
  let analysis: Analysis | null = null;
  try {
    analysis = await runAnalyst(projectId, best.candidate, symptom, description, intent, apiKey);
  } catch (error) {
    console.log("investigate: analysis failed", error);
  }

  const claim = buildClaim(best.candidate, symptom);

  await db.query(
    `UPDATE investigations
        SET status = 'claimed', claim = $2, commit_sha = $3, confidence = $4,
            completed_at = now()
      WHERE id = $1`,
    [id, claim, best.candidate.sha, best.scored.confidence],
  );

  await saveEvidence(id, ranked, symptom, intent, analysis);
  await attachMarketContext(id, projectId, symptom.startedAt);

  return {
    id,
    status: "claimed",
    symptom: description,
    claim,
    commitSha: best.candidate.sha,
    confidence: best.scored.confidence,
    declinedReason: null,
    ranked,
  };
}

/**
 * Gather what the analyst needs: the diff, the current source, and a
 * description of what a real user actually did.
 */
async function runAnalyst(
  projectId: string,
  candidate: Candidate,
  symptom: Symptom,
  description: string,
  intent: IntentMatch[],
  apiKey: string | null,
): Promise<Analysis | null> {
  const db = await getDb();

  const repoRow = await db.one<{
    owner: string;
    name: string;
    default_branch: string;
    access_token: string | null;
  }>(
    `SELECT owner, name, default_branch, access_token FROM repos
      WHERE project_id = $1 ORDER BY created_at LIMIT 1`,
    [projectId],
  );

  const repo: RepoRef | null = repoRow
    ? { owner: repoRow.owner, name: repoRow.name, token: decrypt(repoRow.access_token) }
    : null;

  const [diff, fileContents] = repo
    ? await Promise.all([
        getCommitDiff(repo, candidate.sha),
        fetchFileContents(repo, repoRow!.default_branch, candidate.matchedFiles),
      ])
    : [null, []];

  // One affected recording, read back as what the person did.
  let timeline = "No recording available.";
  const probe = symptom.sessionIds[0];
  if (probe) {
    try {
      timeline = formatTimeline(await buildTimeline(probe)) || timeline;
    } catch {
      // A missing event file costs the timeline, not the analysis.
    }
  }

  return analyse({
    apiKey,
    commit: {
      sha: candidate.sha,
      message: candidate.message,
      files: candidate.matchedFiles,
    },
    diff,
    fileContents,
    timeline,
    symptom: description,
    intent,
  });
}

/**
 * Record what changed outside the code around the same time.
 *
 * Stored with a contribution of null rather than zero, and under its own kind,
 * so it can never be mistaken for a scored signal. There is no counterfactual
 * for the market — no group of users who didn't experience a competitor's
 * price cut — so presenting this on the same scale as a code finding would
 * quietly undo the distinction the whole product rests on.
 *
 * It is context for a person to weigh, and it says so.
 */
async function attachMarketContext(
  investigationId: string,
  projectId: string,
  when: string,
): Promise<void> {
  try {
    const events = await eventsAround(projectId, when);
    if (events.length === 0) return;
    const db = await getDb();

    for (const event of events.slice(0, 6)) {
      await db.query(
        `INSERT INTO evidence (id, investigation_id, kind, ref, quote, detail, contribution)
         VALUES ($1,$2,'market',$3,$4,$5,NULL)`,
        [
          newId("ev"),
          investigationId,
          event.url,
          event.headline,
          JSON.stringify({
            competitor: event.competitor,
            eventKind: event.kind,
            occurredOn: event.occurredOn,
            daysBefore: event.daysBefore,
            detail: event.detail,
            dateExact: event.dateExact,
          }),
        ],
      );
    }
  } catch (error) {
    // Context is a bonus. It must never take down a finding.
    console.log("investigate: could not attach market context", error);
  }
}

function weakestLink(scored: Scored): string {
  const weakest = scored.signals
    .filter((s) => s.name !== "dilution")
    .sort((a, b) => a.score - b.score)[0];
  return weakest ? weakest.detail : "";
}

function buildClaim(candidate: Candidate, symptom: Symptom): string {
  const what = symptom.signature.replace(/_/g, " ");
  const where = symptom.path ? ` on ${symptom.path}` : "";
  return `${candidate.message} (${candidate.sha.slice(0, 8)}) introduced ${what}${where}.`;
}

/**
 * Store every signal as its own row.
 *
 * Never as generated prose: rows are what let the UI show a breakdown, and
 * what let an old investigation be re-scored when the weights change.
 */
async function saveEvidence(
  investigationId: string,
  ranked: Investigation["ranked"],
  symptom?: Symptom,
  intent: IntentMatch[] = [],
  analysis: Analysis | null = null,
): Promise<void> {
  const db = await getDb();
  await db.query(`DELETE FROM evidence WHERE investigation_id = $1`, [investigationId]);

  if (symptom) {
    for (const sessionId of symptom.sessionIds.slice(0, 10)) {
      await db.query(
        `INSERT INTO evidence (id, investigation_id, kind, ref, quote, detail)
         VALUES ($1,$2,'session',$3,NULL,$4)`,
        [
          newId("ev"),
          investigationId,
          sessionId,
          JSON.stringify({ signature: symptom.signature, path: symptom.path }),
        ],
      );
    }
  }

  // Intent rows carry a contribution of exactly zero, and that is the point.
  // A PRD saying "must accept international format" next to code that doesn't
  // is enormously persuasive to a human and proves nothing about why a metric
  // moved. It explains; it must never score.
  for (const match of intent) {
    await db.query(
      `INSERT INTO evidence (id, investigation_id, kind, ref, quote, detail, contribution)
       VALUES ($1,$2,$3,$4,$5,$6,0)`,
      [
        newId("ev"),
        investigationId,
        match.source === "transcript" ? "transcript" : "prd",
        match.chunkId,
        match.quote,
        JSON.stringify({
          title: match.documentTitle,
          url: match.documentUrl,
          speaker: match.speaker,
          occurredAt: match.occurredAt,
          offsetMs: match.offsetMs,
          kind: match.kind,
          relevance: match.relevance,
        }),
      ],
    );
  }

  if (analysis) {
    // Stored with contribution zero, like intent. The analyst explains a
    // verdict it played no part in reaching, and must not appear to have
    // strengthened it.
    await db.query(
      `INSERT INTO evidence (id, investigation_id, kind, ref, quote, detail, contribution)
       VALUES ($1,$2,'analysis',$3,$4,$5,0)`,
      [
        newId("ev"),
        investigationId,
        ranked[0]?.candidate.sha ?? null,
        analysis.howItBroke,
        JSON.stringify(analysis),
      ],
    );
  }

  for (const [rank, entry] of ranked.entries()) {
    await db.query(
      `INSERT INTO evidence (id, investigation_id, kind, ref, quote, detail, contribution)
       VALUES ($1,$2,'commit',$3,$4,$5,$6)`,
      [
        newId("ev"),
        investigationId,
        entry.candidate.sha,
        entry.candidate.message,
        JSON.stringify({
          rank,
          matchedFiles: entry.candidate.matchedFiles,
          filesTouched: entry.candidate.filesTouchedCount,
          author: entry.candidate.author,
          deployedAt: entry.candidate.deployedAt,
          capped: entry.scored.capped,
        }),
        entry.scored.confidence,
      ],
    );

    for (const signal of entry.scored.signals) {
      await db.query(
        `INSERT INTO evidence (id, investigation_id, kind, ref, quote, detail, contribution)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          newId("ev"),
          investigationId,
          signal.name === "counterfactual" ? "counterfactual" : "signal",
          entry.candidate.sha,
          signal.detail,
          JSON.stringify({ signal: signal.name, label: signal.label, score: signal.score }),
          signal.contribution,
        ],
      );
    }
  }
}
