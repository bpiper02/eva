import type { AnalyzeResult } from "@/lib/ai";

const EXPLANATION_RISK_KEYWORDS = [
  "incorrect",
  "false",
  "inaccurate",
  "hallucination",
  "fabricated",
  "not true",
] as const;

/** Match human phrases on normalized flag text (underscores as spaces). */
const FLAG_RISK_PHRASES = [
  "factual error",
  "false claim",
  "fabrication",
  "incorrect fact",
] as const;

function explanationTriggersOverride(explanation: string): boolean {
  const e = explanation.toLowerCase();
  return EXPLANATION_RISK_KEYWORDS.some((kw) => e.includes(kw));
}

function flagMatchesRiskPhrases(flag: string): boolean {
  const normalized = flag.toLowerCase().replace(/_/g, " ");
  return FLAG_RISK_PHRASES.some((phrase) => normalized.includes(phrase));
}

function hasAbsoluteClaimHeuristic(inputText: string): boolean {
  const t = inputText.toLowerCase();
  if (t.includes("100%")) return true;
  if (t.includes("guaranteed")) return true;
  if (t.includes("risk-free") || t.includes("risk free")) return true;
  if (/\balways\b/.test(t)) return true;
  if (/\bnever\b/.test(t)) return true;
  return false;
}

/**
 * Post-processes LLM output so risk labels stay consistent with content and heuristics.
 * Does not change the API response shape.
 */
export function enforceRiskConsistency(
  result: AnalyzeResult,
  inputText: string
): AnalyzeResult {
  const out: AnalyzeResult = {
    ...result,
    flags: [...result.flags],
  };

  let overrideTriggered = false;

  // A. Explanation-based override
  if (explanationTriggersOverride(out.explanation)) {
    overrideTriggered = true;
    out.risk_level = "high";
    out.hallucination_score = Math.max(out.hallucination_score, 0.8);
  }

  // B. Flag-based override
  if (out.flags.some(flagMatchesRiskPhrases)) {
    overrideTriggered = true;
    out.risk_level = "high";
  }

  // C. Absolute claim heuristic
  if (
    hasAbsoluteClaimHeuristic(inputText) &&
    out.hallucination_score > 0.5 &&
    out.risk_level === "low"
  ) {
    out.risk_level = "medium";
  }

  // D. Sanity floor
  if (out.hallucination_score >= 0.9) {
    out.risk_level = "high";
  }

  // E. Monotonic: LOW only if hallucination < 0.3, no flags, no A/B override
  const lowAllowed =
    out.hallucination_score < 0.3 &&
    out.flags.length === 0 &&
    !overrideTriggered;

  if (out.risk_level === "low" && !lowAllowed) {
    out.risk_level = out.hallucination_score >= 0.5 ? "high" : "medium";
  }

  return out;
}
