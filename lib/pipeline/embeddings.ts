/**
 * Gemini text embeddings + cosine similarity against small reference anchors.
 * Fails softly if the API key is missing or the request errors.
 */

const EMBED_MODEL = "text-embedding-004";

/** “Soft”, hedged reference lines (lower risk if claim aligns). */
const SAFE_ANCHORS = [
  "This may depend on context and should be verified independently.",
  "Results can vary; this is not a guarantee for every situation.",
  "Consider checking primary sources before relying on this summary.",
];

/** Overclaim / absolutist reference lines (higher risk if claim aligns). */
const RISK_ANCHORS = [
  "This is guaranteed with absolute certainty and no exceptions.",
  "Verified beyond any doubt with one hundred percent accuracy in all cases.",
  "There is zero risk and no possibility of failure under any conditions.",
];

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

async function embedOne(text: string): Promise<number[] | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${key}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text }] },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("EMBED ERROR:", data);
    return null;
  }

  const values = data?.embedding?.values as number[] | undefined;
  return Array.isArray(values) ? values : null;
}

/** Batch embed in one HTTP round-trip when possible. */
async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key || texts.length === 0) return texts.map(() => null);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents?key=${key}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: texts.map((t) => ({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text: t }] },
      })),
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("BATCH EMBED ERROR:", data);
    /* Fallback: per-item */
    const out: (number[] | null)[] = [];
    for (const t of texts) {
      out.push(await embedOne(t));
    }
    return out;
  }

  const embeddings = data?.embeddings as Array<{ values?: number[] }> | undefined;
  if (!Array.isArray(embeddings)) {
    const out: (number[] | null)[] = [];
    for (const t of texts) {
      out.push(await embedOne(t));
    }
    return out;
  }

  return embeddings.map((e) =>
    Array.isArray(e?.values) ? (e.values as number[]) : null
  );
}

export type EmbeddingOutcome = {
  perClaim: { risk: number; confidence: number }[];
  aggregateRisk: number;
  /** Confidence that embedding separation is meaningful (0–1). */
  confidence: number;
  ok: boolean;
};

function riskFromAnchors(
  claimVec: number[],
  safeVecs: number[][],
  riskVecs: number[][]
): { risk: number; confidence: number } {
  const simSafe = Math.max(...safeVecs.map((v) => cosine(claimVec, v)));
  const simRisk = Math.max(...riskVecs.map((v) => cosine(claimVec, v)));
  const gap = Math.abs(simRisk - simSafe);
  // Map similarity toward risk anchors into hallucination-like risk.
  const raw = (simRisk - simSafe + 1) / 2;
  const risk = Math.min(1, Math.max(0, raw));
  const confidence = Math.min(1, 0.35 + gap * 1.25);
  return { risk, confidence };
}

let anchorCache: { safe: number[][]; risk: number[][] } | null = null;

async function getAnchorVectors(): Promise<{ safe: number[][]; risk: number[][] }> {
  if (anchorCache) return anchorCache;
  const [safeEmb, riskEmb] = await Promise.all([
    embedBatch(SAFE_ANCHORS),
    embedBatch(RISK_ANCHORS),
  ]);
  const safe = safeEmb.filter((v): v is number[] => v != null);
  const risk = riskEmb.filter((v): v is number[] => v != null);
  anchorCache = { safe, risk };
  return anchorCache;
}

const MAX_CLAIMS_EMBED = 14;

export async function scoreEmbeddings(
  claims: string[]
): Promise<EmbeddingOutcome> {
  const trimmed = claims.slice(0, MAX_CLAIMS_EMBED);
  if (trimmed.length === 0) {
    return {
      perClaim: [],
      aggregateRisk: 0,
      confidence: 0,
      ok: false,
    };
  }

  const anchors = await getAnchorVectors();
  if (anchors.safe.length === 0 || anchors.risk.length === 0) {
    return {
      perClaim: trimmed.map(() => ({ risk: 0.5, confidence: 0 })),
      aggregateRisk: 0.5,
      confidence: 0,
      ok: false,
    };
  }

  const claimVecs = await embedBatch(trimmed);
  const perClaim: { risk: number; confidence: number }[] = [];

  for (let i = 0; i < trimmed.length; i++) {
    const vec = claimVecs[i];
    if (!vec) {
      perClaim.push({ risk: 0.5, confidence: 0 });
      continue;
    }
    perClaim.push(riskFromAnchors(vec, anchors.safe, anchors.risk));
  }

  const aggregateRisk =
    perClaim.length === 0
      ? 0
      : perClaim.reduce((a, p) => a + p.risk, 0) / perClaim.length;

  const confMean =
    perClaim.length === 0
      ? 0
      : perClaim.reduce((a, p) => a + p.confidence, 0) / perClaim.length;

  return {
    perClaim,
    aggregateRisk,
    confidence: confMean,
    ok: perClaim.some((p) => p.confidence > 0.15),
  };
}
