import type { PipelineInfo } from "@/lib/pipeline/types";

type RiskLevel = "low" | "medium" | "high";

export type AnalyzeResult = {
  hallucination_score: number;
  confidence_score: number;
  risk_level: RiskLevel;
  flags: string[];
  explanation: string;
  /** Optional hybrid pipeline metadata (rules, embeddings, LLM routing). */
  pipeline?: PipelineInfo;
};

const fallbackResult = (reason: string): AnalyzeResult => ({
  hallucination_score: 1,
  confidence_score: 0,
  risk_level: "high",
  flags: [`error:${reason}`],
  explanation:
    "The model response could not be parsed into the required schema. Treat this output as high risk.",
});

const systemPrompt = `You are an AI output risk evaluator for a developer tool.
Return ONLY valid JSON with this exact schema:
{
  "hallucination_score": number, // 0 to 1
  "confidence_score": number, // 0 to 1
  "risk_level": "low" | "medium" | "high",
  "flags": string[],
  "explanation": string // 1-2 sentences
}
Rules:
- Output must be JSON only (no markdown, no code fences, no extra text).
- Scores must be numeric between 0 and 1.
- Keep explanation concise and practical.`;

function clampScore(value: unknown, fallback: number) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function parseModelResult(text: string): AnalyzeResult | null {
  try {
    const parsed = JSON.parse(text) as Partial<AnalyzeResult>;

    if (!parsed || typeof parsed !== "object") return null;
    if (
      parsed.risk_level !== "low" &&
      parsed.risk_level !== "medium" &&
      parsed.risk_level !== "high"
    ) {
      return null;
    }

    const flags = Array.isArray(parsed.flags)
      ? parsed.flags.filter((f): f is string => typeof f === "string")
      : [];

    if (typeof parsed.explanation !== "string" || !parsed.explanation.trim()) {
      return null;
    }

    return {
      hallucination_score: clampScore(parsed.hallucination_score, 1),
      confidence_score: clampScore(parsed.confidence_score, 0),
      risk_level: parsed.risk_level,
      flags,
      explanation: parsed.explanation.trim(),
    };
  } catch {
    return null;
  }
}

async function callGemini(promptText: string): Promise<string | null> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: promptText }],
          },
        ],
      }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("GEMINI API ERROR:", data);
    return null;
  }

  const modelText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return typeof modelText === "string" ? modelText : null;
}

export async function analyzeText(text: string): Promise<AnalyzeResult> {
  try {
    const prompt = `Evaluate this AI output for risk:\n\n${text}`;
    const first = await callGemini(prompt);
    if (!first) return fallbackResult("no_response");

    const parsedFirst = parseModelResult(first);
    if (parsedFirst) return parsedFirst;

    const retryPrompt =
      `Your previous answer was invalid. Return ONLY valid JSON with the required schema.\n` +
      `Input text to evaluate:\n\n${text}`;
    const second = await callGemini(retryPrompt);
    if (!second) return fallbackResult("retry_no_response");

    const parsedSecond = parseModelResult(second);
    if (parsedSecond) return parsedSecond;

    return fallbackResult("invalid_json_after_retry");
  } catch (err) {
    console.error("ANALYZE ERROR:", err);
    return fallbackResult("runtime_exception");
  }
}
