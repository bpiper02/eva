import type { AnalyzeResult } from "@/lib/ai";
import { analyzeText } from "@/lib/ai";
import { scoreEmbeddings } from "@/lib/pipeline/embeddings";
import { scoreRules } from "@/lib/pipeline/rules";
import { splitIntoAtomicClaims } from "@/lib/pipeline/splitClaims";
import type { ClaimBreakdown, LayerDetermination, PipelineInfo } from "@/lib/pipeline/types";

function riskLevelFromScore(h: number): AnalyzeResult["risk_level"] {
  if (h < 0.34) return "low";
  if (h < 0.67) return "medium";
  return "high";
}

function combinedRisk(ruleAgg: number, embedAgg: number, embedOk: boolean): number {
  if (!embedOk) return ruleAgg;
  return Math.min(1, Math.max(0, 0.42 * ruleAgg + 0.58 * embedAgg));
}

function confidenceBeforeLLM(
  rc: number,
  ec: number,
  embedOk: boolean
): number {
  if (!embedOk) return Math.min(1, rc * 0.82);
  return Math.min(1, rc * 0.42 + ec * 0.58);
}

function pickDeterminingLayer(
  llmInvoked: boolean,
  rc: number,
  ec: number,
  embedOk: boolean
): LayerDetermination {
  if (llmInvoked) return "llm";
  if (!embedOk) return "rule";
  if (rc >= ec + 0.1) return "rule";
  if (ec > rc + 0.1) return "embedding";
  return "hybrid";
}

function buildClaimRows(
  claims: string[],
  rulePer: { risk: number; flags: string[] }[],
  embedPer: { risk: number; confidence: number }[] | null,
  llmReviewed: boolean
): ClaimBreakdown[] {
  return claims.map((t, i) => ({
    index: i,
    text: t,
    ruleRisk: rulePer[i]?.risk ?? 0,
    ruleFlags: rulePer[i]?.flags ?? [],
    embeddingRisk: embedPer?.[i]?.risk,
    embeddingConfidence: embedPer?.[i]?.confidence,
    llmReviewed,
  }));
}

/**
 * Hybrid pipeline: atomic claims → rules → embeddings → optional single LLM call.
 */
export async function runHybridPipeline(fullText: string): Promise<AnalyzeResult> {
  const claims = splitIntoAtomicClaims(fullText);
  const ruleOutcome = scoreRules(claims, fullText);
  const embedOutcome = await scoreEmbeddings(claims);

  const RC = ruleOutcome.confidence;
  const EC = embedOutcome.ok ? embedOutcome.confidence : 0;
  const confPre = confidenceBeforeLLM(RC, EC, embedOutcome.ok);

  /** LLM only when combined layer confidence is low (and no forced rule crisis). */
  let llmInvoked =
    !ruleOutcome.forceHigh &&
    confPre < 0.54 &&
    !(RC >= 0.86) &&
    !(embedOutcome.ok && RC >= 0.64 && EC >= 0.62);

  if (RC >= 0.88 && ruleOutcome.aggregateRisk >= 0.72) {
    llmInvoked = false;
  }

  const embedPer = embedOutcome.ok ? embedOutcome.perClaim : null;

  if (llmInvoked) {
    const llm = await analyzeText(fullText);
    const determiningLayer: LayerDetermination = "llm";
    const pipeline: PipelineInfo = {
      determiningLayer,
      llmInvoked: true,
      confidenceBeforeLLM: confPre,
      ruleConfidence: RC,
      embeddingConfidence: EC,
      claims: buildClaimRows(
        claims,
        ruleOutcome.perClaim,
        embedPer,
        true
      ),
    };

    const mergedFlags = [
      ...new Set([
        ...llm.flags,
        ...ruleOutcome.globalFlags.slice(0, 6).map((f) => `rule:${f}`),
        embedOutcome.ok ? "layer:embedding_used" : "layer:embedding_skipped",
      ]),
    ];

    return {
      ...llm,
      flags: mergedFlags,
      explanation: `${llm.explanation} (Prior rule/embedding confidence was low; full model assessment was used.)`,
      pipeline,
    };
  }

  const agg = combinedRisk(
    ruleOutcome.aggregateRisk,
    embedOutcome.aggregateRisk,
    embedOutcome.ok
  );
  const hallucination_score = Math.min(1, Math.max(0, agg));
  const confidence_score = Math.min(
    1,
    confPre + (embedOutcome.ok && RC >= 0.55 && EC >= 0.55 ? 0.08 : 0)
  );
  const risk_level = riskLevelFromScore(hallucination_score);

  const determiningLayer = pickDeterminingLayer(false, RC, EC, embedOutcome.ok);

  const pipeline: PipelineInfo = {
    determiningLayer,
    llmInvoked: false,
    confidenceBeforeLLM: confPre,
    ruleConfidence: RC,
    embeddingConfidence: EC,
    claims: buildClaimRows(claims, ruleOutcome.perClaim, embedPer, false),
  };

  const flags = [
    ...ruleOutcome.globalFlags.slice(0, 10),
    ...(embedOutcome.ok ? ["embedding_scored"] : ["embedding_unavailable"]),
    "llm_skipped",
  ];

  const layerLabel =
    determiningLayer === "rule"
      ? "rule-based markers"
      : determiningLayer === "embedding"
        ? "embedding similarity"
        : "combined rule and embedding signals";

  const explanation = `No generative assessment call was required. ${layerLabel.charAt(0).toUpperCase() + layerLabel.slice(1)} cleared the confidence threshold (blended ${(confPre * 100).toFixed(0)}%). Use the pipeline payload for claim-level breakdown.`;

  return {
    hallucination_score,
    confidence_score,
    risk_level,
    flags,
    explanation,
    pipeline,
  };
}
