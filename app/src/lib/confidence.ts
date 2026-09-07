/**
 * Where the confidence number comes from.
 *
 * If this were a model's self-report the product would be a toy. It's
 * computed from named signals, each independently checkable, each stored as
 * its own row — so a user can open the breakdown and argue with it, and so
 * an old investigation can be re-scored when the weights improve.
 *
 * The structural rule that keeps it honest: only the counterfactual can
 * license high confidence. Everything else is circumstantial. A change that
 * went to everyone at once leaves before-and-after rather than a comparison,
 * and anything else that shipped that afternoon explains it equally well —
 * so confidence is capped, and the report says why in plain words.
 */

import type { Counterfactual } from "./counterfactual";

/**
 * Confidence with no counterfactual can never exceed this, however neatly
 * everything else lines up.
 */
export const NO_COUNTERFACTUAL_CAP = 0.7;

/** A separation of this many percentage points earns full marks. */
const FULL_SEPARATION = 0.2;

const WEIGHTS = {
  counterfactual: 0.45,
  codePath: 0.2,
  onset: 0.2,
  volume: 0.15,
} as const;

export type SignalName = keyof typeof WEIGHTS | "dilution";

export type Signal = {
  name: SignalName;
  label: string;
  /** 0..1 for positive signals; negative for dilution. */
  score: number;
  /** How much this moved the final number. */
  contribution: number;
  detail: string;
};

export type Scored = {
  confidence: number;
  capped: boolean;
  signals: Signal[];
};

export type ScoreInput = {
  counterfactual: Counterfactual;
  /** Changed files that the page's code actually reaches. */
  matchedFiles: number;
  /** Everything the commit touched. */
  filesTouched: number;
  /** Hours between the deploy and the symptom starting. */
  onsetGapHours: number | null;
  /** Sessions showing the symptom. */
  affectedSessions: number;
  /** How many candidates survived the same filters, this one included. */
  candidateCount: number;
};

function counterfactualSignal(cf: Counterfactual): Signal {
  if (!cf.available) {
    return {
      name: "counterfactual",
      label: "Counterfactual",
      score: 0,
      contribution: 0,
      detail: cf.detail,
    };
  }

  // Negative separation means the symptom was *less* common with the change,
  // which is evidence against this commit rather than weak evidence for it.
  const score = Math.max(0, Math.min(1, cf.separation / FULL_SEPARATION));
  const withPct = (cf.withChange.rate * 100).toFixed(0);
  const withoutPct = (cf.withoutChange.rate * 100).toFixed(0);

  return {
    name: "counterfactual",
    label: "Counterfactual",
    score,
    contribution: score * WEIGHTS.counterfactual,
    detail:
      `${withPct}% of ${cf.withChange.sessions} sessions with the change hit this, ` +
      `against ${withoutPct}% of ${cf.withoutChange.sessions} without it` +
      (cf.separation <= 0
        ? " — no worse with the change, which argues against this commit."
        : "."),
  };
}

function codePathSignal(matched: number, total: number): Signal {
  // Touching one of two files is a sharper signal than one of two hundred:
  // a sprawling commit intersects the page's code by coincidence.
  const specificity = total > 0 ? matched / total : 0;
  const score = matched === 0 ? 0 : Math.max(0.3, Math.min(1, specificity));

  return {
    name: "codePath",
    label: "Code path",
    score,
    contribution: score * WEIGHTS.codePath,
    detail:
      matched === 0
        ? "Touches nothing this page reaches."
        : `${matched} of ${total} changed files are on this page's path.`,
  };
}

function onsetSignal(gapHours: number | null): Signal {
  if (gapHours === null) {
    return {
      name: "onset",
      label: "Onset",
      score: 0,
      contribution: 0,
      detail: "No deploy time, so the symptom can't be lined up against it.",
    };
  }

  const gap = Math.abs(gapHours);
  const score = gap <= 1 ? 1 : gap <= 6 ? 0.7 : gap <= 24 ? 0.4 : 0.1;
  const rounded = gap < 1 ? `${Math.round(gap * 60)} minutes` : `${gap.toFixed(1)} hours`;

  return {
    name: "onset",
    label: "Onset",
    score,
    contribution: score * WEIGHTS.onset,
    detail:
      gapHours < 0
        ? `The symptom started ${rounded} BEFORE this deployed, which argues against it.`
        : `The symptom started ${rounded} after this deployed.`,
  };
}

function volumeSignal(sessions: number): Signal {
  const score = sessions >= 50 ? 1 : sessions >= 20 ? 0.8 : sessions >= 5 ? 0.5 : 0.2;
  return {
    name: "volume",
    label: "Volume",
    score,
    contribution: score * WEIGHTS.volume,
    detail:
      sessions < 5
        ? `Only ${sessions} sessions affected — closer to an anecdote than a pattern.`
        : `${sessions} sessions affected.`,
  };
}

/**
 * Other survivors of the same filters make any single one less likely to be
 * the culprit. This signal can only ever subtract.
 */
function dilutionSignal(candidates: number): Signal {
  const others = Math.max(0, candidates - 1);
  const penalty = Math.min(0.3, others * 0.08);
  return {
    name: "dilution",
    label: "Other candidates",
    score: -penalty,
    contribution: -penalty,
    detail:
      others === 0
        ? "No other change survived the same filters."
        : `${others} other change${others > 1 ? "s" : ""} could explain this equally well.`,
  };
}

export function score(input: ScoreInput): Scored {
  const signals: Signal[] = [
    counterfactualSignal(input.counterfactual),
    codePathSignal(input.matchedFiles, input.filesTouched),
    onsetSignal(input.onsetGapHours),
    volumeSignal(input.affectedSessions),
    dilutionSignal(input.candidateCount),
  ];

  const positive = signals
    .filter((s) => s.name !== "dilution")
    .reduce((sum, s) => sum + s.contribution, 0);

  const dilution = signals.find((s) => s.name === "dilution")?.contribution ?? 0;

  let confidence: number;
  let capped = false;

  if (input.counterfactual.available) {
    confidence = positive + dilution;
  } else {
    // Without the counterfactual, the remaining weights only add to 0.55.
    // Rescaling them to fill the cap would quietly pretend the missing
    // evidence didn't matter, so instead the ceiling is real: a perfect
    // score on everything else reaches the cap and no further.
    const available = WEIGHTS.codePath + WEIGHTS.onset + WEIGHTS.volume;
    confidence = (positive / available) * NO_COUNTERFACTUAL_CAP + dilution;
    capped = true;
  }

  return {
    confidence: Math.max(0, Math.min(1, confidence)),
    capped,
    signals,
  };
}
