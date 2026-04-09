export type LayerDetermination = "rule" | "embedding" | "llm" | "hybrid";

export type ClaimBreakdown = {
  index: number;
  text: string;
  ruleRisk: number;
  ruleFlags: string[];
  embeddingRisk?: number;
  embeddingConfidence?: number;
  /** True when the overall assessment used the LLM path (same for all claims). */
  llmReviewed: boolean;
};

export type PipelineInfo = {
  determiningLayer: LayerDetermination;
  llmInvoked: boolean;
  /** Combined rule+embedding confidence before any LLM (0–1). */
  confidenceBeforeLLM: number;
  ruleConfidence: number;
  embeddingConfidence: number;
  claims: ClaimBreakdown[];
};
