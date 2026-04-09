/**
 * Rule-based risk signals: keywords, regex patterns, light contradiction checks.
 */

const KEYWORD_WEIGHTS: Array<{ re: RegExp; weight: number; flag: string }> = [
  { re: /\b100\s*%/i, weight: 0.85, flag: "absolute_percentage" },
  { re: /\bguaranteed\b/i, weight: 0.8, flag: "guarantee_language" },
  { re: /\brisk[- ]free\b/i, weight: 0.82, flag: "risk_free_claim" },
  { re: /\balways\b/i, weight: 0.55, flag: "universal_always" },
  { re: /\bnever\b/i, weight: 0.55, flag: "universal_never" },
  { re: /\bverified\b.*\b(nasa|cdc|who)\b/i, weight: 0.7, flag: "authority_name_drop" },
  { re: /\bcertified\s+by\b/i, weight: 0.65, flag: "certification_claim" },
  { re: /\bno\s+risk\b/i, weight: 0.75, flag: "zero_risk_language" },
  { re: /\bproven\b.*\b(beyond|without)\b/i, weight: 0.6, flag: "proof_language" },
  { re: /\bimpossible\b|\bdefinitely\b|\bcertainly\b/i, weight: 0.5, flag: "certainty_language" },
];

const PATTERN_WEIGHTS: Array<{ re: RegExp; weight: number; flag: string }> = [
  { re: /\b\d{1,3}\s*%\s*(uptime|accuracy|success)\b/i, weight: 0.85, flag: "numeric_sla_claim" },
  { re: /\b(lawsuit|litigation)\s+(proof|proven)\b/i, weight: 0.55, flag: "legal_assertion" },
];

export type RuleOutcome = {
  perClaim: { risk: number; flags: string[] }[];
  aggregateRisk: number;
  /** How decisive rules are in isolation (0–1). */
  confidence: number;
  globalFlags: string[];
  /** Strong signal to skip LLM (e.g. clear contradiction). */
  forceHigh: boolean;
};

function scoreClaim(text: string): { risk: number; flags: string[] } {
  const t = text;
  let risk = 0;
  const flags = new Set<string>();

  for (const { re, weight, flag } of KEYWORD_WEIGHTS) {
    if (re.test(t)) {
      risk = Math.max(risk, weight);
      flags.add(flag);
    }
  }
  for (const { re, weight, flag } of PATTERN_WEIGHTS) {
    if (re.test(t)) {
      risk = Math.max(risk, weight);
      flags.add(flag);
    }
  }

  return { risk, flags: [...flags] };
}

/**
 * Very light contradiction: negated safety vs affirmative safety in the same document.
 */
function detectGlobalContradiction(fullText: string): boolean {
  const lower = fullText.toLowerCase();
  const neg = /\bnot\s+(verified|proven|safe|true)\b|\bunverified\b|\bfalse\b/i.test(
    lower
  );
  const pos =
    /\b(100\s*%|guaranteed|risk[- ]free|no doubt|always works)\b/i.test(lower);
  return neg && pos;
}

function ruleConfidenceFromClaims(
  perClaim: { risk: number; flags: string[] }[],
  forceHigh: boolean
): number {
  if (forceHigh) return 0.95;
  if (perClaim.length === 0) return 0.2;

  const risks = perClaim.map((p) => p.risk);
  const mean = risks.reduce((a, b) => a + b, 0) / risks.length;
  const spread = risks.map((r) => Math.abs(r - mean));
  const avgDistFromMid = spread.reduce((a, b) => a + b, 0) / spread.length;

  // Decisive when most claims are near 0 or near 1, or max is extreme.
  const mx = Math.max(...risks);
  const mn = Math.min(...risks);
  let c = 0.35 + avgDistFromMid * 0.9;
  if (mx >= 0.82) c += 0.25;
  if (mn <= 0.08 && mx <= 0.25) c += 0.2;
  c = Math.min(1, c);
  return c;
}

export function scoreRules(claims: string[], fullText: string): RuleOutcome {
  const forceHigh = detectGlobalContradiction(fullText);
  const perClaim = claims.map((c) => scoreClaim(c));

  if (forceHigh) {
    perClaim.forEach((p) => {
      p.risk = Math.max(p.risk, 0.95);
      if (!p.flags.includes("contradiction_signal")) {
        p.flags.push("contradiction_signal");
      }
    });
  }

  const aggregateRisk =
    perClaim.length === 0
      ? 0
      : Math.max(...perClaim.map((p) => p.risk), 0);

  const globalFlags = new Set<string>();
  perClaim.forEach((p) => p.flags.forEach((f) => globalFlags.add(f)));

  const confidence = ruleConfidenceFromClaims(perClaim, forceHigh);

  return {
    perClaim,
    aggregateRisk,
    confidence,
    globalFlags: [...globalFlags],
    forceHigh,
  };
}
