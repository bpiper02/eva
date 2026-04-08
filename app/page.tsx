"use client";
import { useState } from "react";

type AnalyzeResult = {
  hallucination_score: number;
  confidence_score: number;
  risk_level: "low" | "medium" | "high";
  flags: string[];
  explanation: string;
};

export default function Home() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const sampleText =
    "The API guarantees 100% uptime worldwide and was certified by NASA in 2025, so this deployment is risk-free.";

  const analyze = async () => {
    setError("");
    setResult(null);
    setLoading(true);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data?.error || "Request failed.");
        return;
      }

      setResult(data.result as AnalyzeResult);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const copyJson = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
  };

  const riskColor =
    result?.risk_level === "high"
      ? "#c62828"
      : result?.risk_level === "medium"
      ? "#ef6c00"
      : "#2e7d32";

  return (
    <main style={{ padding: 40, maxWidth: 820, margin: "0 auto" }}>
      <h1>Eva</h1>
      <p>Agent Output Risk Scoring</p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste AI output to evaluate..."
        style={{ width: "100%", height: 150, padding: 10 }}
      />

      <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
        <button onClick={analyze} disabled={loading || !text.trim()}>
          {loading ? "Analyzing..." : "Analyze"}
        </button>
        <button onClick={() => setText(sampleText)} disabled={loading}>
          Use sample
        </button>
        <button onClick={copyJson} disabled={!result}>
          Copy JSON
        </button>
      </div>

      {error && (
        <p style={{ marginTop: 14, color: "#c62828" }}>
          <strong>Error:</strong> {error}
        </p>
      )}

      {result && (
        <section
          style={{
            marginTop: 20,
            border: "1px solid #ddd",
            borderRadius: 8,
            padding: 14,
          }}
        >
          <p>
            <strong>Hallucination score:</strong>{" "}
            {result.hallucination_score.toFixed(2)}
          </p>
          <p>
            <strong>Confidence score:</strong> {result.confidence_score.toFixed(2)}
          </p>
          <p>
            <strong>Risk level:</strong>{" "}
            <span style={{ color: riskColor, textTransform: "uppercase" }}>
              {result.risk_level}
            </span>
          </p>
          <p>
            <strong>Flags:</strong>{" "}
            {result.flags.length > 0 ? result.flags.join(", ") : "None"}
          </p>
          <p>
            <strong>Explanation:</strong> {result.explanation}
          </p>
        </section>
      )}

      {!result && !error && !loading && (
        <p style={{ marginTop: 16, color: "#666" }}>
          Run analysis to see structured risk scores.
        </p>
      )}
      {loading && (
        <p style={{ marginTop: 16, color: "#444" }}>
          Evaluating output risk...
        </p>
      )}
      <p style={{ marginTop: 18, color: "#666", fontSize: 14 }}>
        Eva is a developer tool for evaluating AI outputs, not a chat app.
      </p>
    </main>
  );
}