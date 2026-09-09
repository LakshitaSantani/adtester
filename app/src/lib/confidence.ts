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
 * How good the comparison was decides one thing: how high this can go.
 *
 *   version split — some users on the new build, others still on the old, at
 *   the same time. Time is held constant and only the code differs. No cap.
 *
 *   before / after — nobody stamped a build, so we compare the same page
 *   either side of the deploy. Which code each session ran is still certain;
 *   what can't be ruled out is everything else that moved that afternoon.
 *
 *   nothing — everything left is circumstantial.
 *
 * One number per mode, and it is a ceiling rather than a discount. An earlier
 * version did both — shrank the score AND capped it — which penalised the
 * same weakness twice and made the arithmetic impossible to reason about.
 */
const CAP = { version_split: 1, temporal: 0.85, none: 0.7 } as const;

export const NO_COUNTERFACTUAL_CAP = CAP.none;

/** A separation of this many percentage points earns full marks. */
const FULL_SEPARATION = 0.2;

/**
 * How far "before the deploy" is still consistent with "after it".
 *
 * Deploy timestamps come from CI and session timestamps from browsers, and
 * neither agrees with the other to the minute.
 */
const CLOCK_SKEW_HOURS = 0.25;

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
  /**
    * -1..1. Negative means this signal argues AGAINST the candidate.
    *
    * Three can go negative: the counterfactual when the change made things
    * better, onset when the symptom predates the deploy, and dilution always.
    */
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
  /**
    * Candidates the evidence could NOT clear, this one included.
    *
    * Not the raw survivor count: a commit whose counterfactual showed the
    * symptom was no worse with it is not competing for the blame.
    */
  rivalCount: number;
  /** Which evidence chain connects this change to the symptom. */
  reachedVia: "route" | "api" | "both";
  /** True when the symptom is a rejected request rather than a client error. */
  symptomIsRequestFailure: boolean;
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

  // Negative separation means the symptom was *less* common with the change.
  //
  // This used to clamp to zero, which sounds conservative and is not: a
  // commit that measurably FIXED the symptom scored 0 here and then collected
  // full marks from code path, onset and volume — enough to clear the claim
  // threshold and be named as the cause of the bug it repaired. Silence from
  // the one signal that can exonerate is not neutrality. Evidence against has
  // to be able to push the number down, so the scale runs to -1.
  const score = Math.max(-1, Math.min(1, cf.separation / FULL_SEPARATION));
  const withPct = (cf.withChange.rate * 100).toFixed(0);
  const withoutPct = (cf.withoutChange.rate * 100).toFixed(0);

  const worseOrNot =
    cf.separation <= 0
      ? " — no worse with the change, which argues against this commit."
      : ".";

  if (cf.mode === "version_split") {
    return {
      name: "counterfactual",
      label: "Counterfactual",
      score,
      contribution: score * WEIGHTS.counterfactual,
      detail:
        `${withPct}% of ${cf.withChange.sessions} sessions on builds with the change hit ` +
        `this, against ${withoutPct}% of ${cf.withoutChange.sessions} on builds without it, ` +
        `over the ${cf.overlap.hours.toFixed(1)} hours both were serving traffic` +
        worseOrNot,
    };
  }

  // Temporal. Say plainly what was compared and what it can't rule out —
  // a reader who knows a campaign launched that afternoon should be able to
  // discount this themselves.
  const shared =
    cf.coDeployed > 0
      ? ` ${cf.coDeployed} other change${cf.coDeployed > 1 ? "s" : ""} went out in the same ` +
        `deploy, so timing alone cannot separate them.`
      : " Nothing else deployed at that moment.";

  return {
    name: "counterfactual",
    label: "Before / after",
    score,
    contribution: score * WEIGHTS.counterfactual,
    detail:
      `No build stamps, so this compares the same page either side of the deploy: ` +
      `${withPct}% of ${cf.withChange.sessions} sessions after against ` +
      `${withoutPct}% of ${cf.withoutChange.sessions} before${worseOrNot}` +
      shared,
  };
}

function codePathSignal(
  matched: number,
  total: number,
  reachedVia: "route" | "api" | "both",
  symptomIsRequestFailure: boolean,
): Signal {
  // Touching one of two files is a sharper signal than one of two hundred:
  // a sprawling commit intersects the page's code by coincidence.
  const specificity = total > 0 ? matched / total : 0;
  let score = matched === 0 ? 0 : Math.max(0.3, Math.min(1, specificity));

  // A failed request was answered by the server. A change reached only through
  // the page's imports cannot have produced that response, so it is a weaker
  // explanation for this particular symptom — not an impossible one, since a
  // frontend change can send a malformed request, which is why this discounts
  // rather than excludes.
  const wrongSideOfTheWire = symptomIsRequestFailure && reachedVia === "route";
  if (wrongSideOfTheWire) score *= 0.4;

  const where =
    reachedVia === "api"
      ? "reached from the endpoint that failed"
      : reachedVia === "both"
        ? "on this page's path and behind the endpoint that failed"
        : "on this page's path";

  return {
    name: "codePath",
    label: "Code path",
    score,
    contribution: score * WEIGHTS.codePath,
    detail:
      matched === 0
        ? "Touches nothing this page reaches."
        : `${matched} of ${total} changed files are ${where}.` +
          (wrongSideOfTheWire
            ? " The failure was a rejected request, which the server answered, so client-side code is a weaker explanation."
            : ""),
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
  const rounded = gap < 1 ? `${Math.round(gap * 60)} minutes` : `${gap.toFixed(1)} hours`;

  // Taking the absolute value scored "started six hours BEFORE the deploy"
  // exactly as highly as six hours after, while the sentence underneath said
  // it argued against the commit. Code cannot break something that was
  // already broken, so the sign has to survive into the arithmetic.
  //
  // It doesn't go all the way to -1, because startedAt is the earliest
  // matching session in the window rather than a true onset: one unrelated
  // session of the same shape drags it earlier. Enough to sink a candidate
  // that has nothing else going for it, not enough to override a decisive
  // counterfactual on its own.
  const score =
    gapHours >= -CLOCK_SKEW_HOURS
      ? gap <= 1
        ? 1
        : gap <= 6
          ? 0.7
          : gap <= 24
            ? 0.4
            : 0.1
      : gap <= 6
        ? -0.4
        : -1;

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
 * Other candidates that could still explain this make any single one less
 * likely to be the culprit. This signal can only ever subtract.
 *
 * "Still could" is the whole point, and it used to be missing: the penalty
 * counted every commit that touched a reachable file, so three people
 * pushing comment and styling changes to checkout that week docked the real
 * culprit 0.24 — after the counterfactual had already measured those three at
 * zero correlation with the symptom. Evidence that clears a commit should
 * remove it from the crowd, not leave it there as a shadow of doubt.
 *
 * A rival is one we could not clear: either it has no counterfactual at all,
 * or it has one and the symptom was worse with it.
 */
function dilutionSignal(rivals: number): Signal {
  const others = Math.max(0, rivals - 1);
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
    codePathSignal(
      input.matchedFiles,
      input.filesTouched,
      input.reachedVia,
      input.symptomIsRequestFailure,
    ),
    onsetSignal(input.onsetGapHours),
    volumeSignal(input.affectedSessions),
    dilutionSignal(input.rivalCount),
  ];

  const positive = signals
    .filter((s) => s.name !== "dilution")
    .reduce((sum, s) => sum + s.contribution, 0);

  const dilution = signals.find((s) => s.name === "dilution")?.contribution ?? 0;

  let confidence: number;
  let capped = false;

  if (input.counterfactual.available) {
    const ceiling = CAP[input.counterfactual.mode];
    const raw = positive + dilution;
    confidence = Math.min(raw, ceiling);
    capped = raw > ceiling;
  } else {
    // Without the counterfactual, the remaining weights only add to 0.55.
    // Rescaling them to fill the cap would quietly pretend the missing
    // evidence didn't matter, so instead the ceiling is real: a perfect
    // score on everything else reaches the cap and no further.
    const available = WEIGHTS.codePath + WEIGHTS.onset + WEIGHTS.volume;
    confidence = (positive / available) * CAP.none + dilution;
    capped = true;
  }

  return {
    confidence: Math.max(0, Math.min(1, confidence)),
    capped,
    signals,
  };
}
