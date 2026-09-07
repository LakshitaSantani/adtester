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

import { candidatesForSession, type Candidate } from "./candidates";
import { score, type Scored } from "./confidence";
import { testCounterfactual, type Counterfactual } from "./counterfactual";
import { getDb } from "./db";
import { newId } from "./ids";
import { describeSymptom, isDiffuse, type Symptom } from "./symptoms";

/**
 * Two candidates whose confidence differs by less than this are not
 * distinguishable, and saying otherwise would be a coin toss dressed up as
 * an answer.
 */
const TIE_THRESHOLD = 0.1;

/** Below this, nothing is worth asserting. */
const MIN_CLAIM_CONFIDENCE = 0.35;

export type DeclineReason = "diffuse" | "no_candidates" | "tied_candidates" | "low_confidence";

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

  const narrowed = await candidatesForSession(probeSessionId);
  if (!narrowed || narrowed.candidates.length === 0) {
    return decline(
      "no_candidates",
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

  const claim = buildClaim(best.candidate, symptom);

  await db.query(
    `UPDATE investigations
        SET status = 'claimed', claim = $2, commit_sha = $3, confidence = $4,
            completed_at = now()
      WHERE id = $1`,
    [id, claim, best.candidate.sha, best.scored.confidence],
  );

  await saveEvidence(id, ranked, symptom);

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
