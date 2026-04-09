"use client";

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { PipelineInfo } from "@/lib/pipeline/types";

type AnalyzeResult = {
  hallucination_score: number;
  confidence_score: number;
  risk_level: "low" | "medium" | "high";
  flags: string[];
  explanation: string;
  pipeline?: PipelineInfo;
};

type RiskLevel = AnalyzeResult["risk_level"];

type HistoryEntry = {
  id: string;
  text: string;
  result: AnalyzeResult;
  timestamp: number;
};

const STORAGE_KEY = "eva-analysis-history-v1";
const MAX_HISTORY = 10;
const PREVIEW_LEN = 56;

const SAMPLE_TEXT =
  "The API guarantees 100% uptime worldwide and was certified by NASA in 2025, so this deployment is risk-free.";

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "her",
  "was",
  "one",
  "our",
  "has",
  "his",
  "how",
  "its",
  "may",
  "new",
  "now",
  "old",
  "see",
  "two",
  "who",
  "way",
]);

function humanizeFlag(flag: string): string {
  if (flag.startsWith("error:")) {
    const detail = flag.slice(6).replace(/_/g, " ");
    const human =
      detail.length > 0
        ? detail.replace(/\b\w/g, (c) => c.toUpperCase())
        : "Unknown";
    return `Assessment error: ${human}`;
  }
  return flag
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function verdictForRisk(level: RiskLevel): string {
  switch (level) {
    case "low":
      return "Safe to use";
    case "medium":
      return "Requires review";
    case "high":
      return "Do not use without verification";
    default:
      return "Requires review";
  }
}

function truncatePreview(s: string, max = PREVIEW_LEN): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function formatHistoryTime(ts: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ts));
  } catch {
    return "";
  }
}

function persistHistory(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* ignore quota / private mode */
  }
}

function loadHistoryFromStorage(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is HistoryEntry =>
          e != null &&
          typeof e === "object" &&
          typeof (e as HistoryEntry).id === "string" &&
          typeof (e as HistoryEntry).text === "string" &&
          typeof (e as HistoryEntry).timestamp === "number" &&
          (e as HistoryEntry).result != null &&
          typeof (e as HistoryEntry).result === "object"
      )
      .slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

function formatSignedDelta(n: number, digits = 2): string {
  const s = n >= 0 ? "+" : "−";
  const v = Math.abs(n).toFixed(digits);
  return `${s}${v}`;
}

function flagSetsDiff(
  prevFlags: string[],
  curFlags: string[]
): { added: string[]; removed: string[] } {
  const a = new Set(prevFlags);
  const b = new Set(curFlags);
  const added = [...b].filter((f) => !a.has(f));
  const removed = [...a].filter((f) => !b.has(f));
  return { added, removed };
}

const RISK_THEME: Record<
  RiskLevel,
  { label: string; border: string; accent: string; muted: string }
> = {
  low: {
    label: "#0f3d2c",
    border: "rgba(15, 61, 44, 0.35)",
    accent: "#0f3d2c",
    muted: "rgba(15, 61, 44, 0.08)",
  },
  medium: {
    label: "#6b4423",
    border: "rgba(107, 68, 35, 0.4)",
    accent: "#6b4423",
    muted: "rgba(107, 68, 35, 0.1)",
  },
  high: {
    label: "#5c1a1a",
    border: "rgba(92, 26, 26, 0.45)",
    accent: "#5c1a1a",
    muted: "rgba(92, 26, 26, 0.1)",
  },
};

function collectHighlightTerms(flags: string[]): string[] {
  const terms = new Set<string>();
  for (const flag of flags) {
    if (flag.startsWith("error:")) continue;
    for (const part of flag.split("_")) {
      const p = part.toLowerCase();
      if (p.length >= 4 && !STOPWORDS.has(p)) terms.add(part);
    }
  }
  terms.add("100%");
  terms.add("NASA");
  return [...terms];
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const [start, end] = sorted[i];
    const last = out[out.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

function findHighlightRanges(source: string, terms: string[]): [number, number][] {
  if (!source || terms.length === 0) return [];
  const lower = source.toLowerCase();
  const ranges: [number, number][] = [];
  for (const raw of terms) {
    const q = raw.toLowerCase();
    if (q.length < 2) continue;
    let i = 0;
    while (i < lower.length) {
      const idx = lower.indexOf(q, i);
      if (idx === -1) break;
      const before = idx > 0 ? source[idx - 1] : " ";
      const after =
        idx + q.length < source.length ? source[idx + q.length] : " ";
      const alphaNum = /[a-z0-9%]/i;
      const startWord = !alphaNum.test(before);
      const endWord = !alphaNum.test(after);
      if (startWord && endWord) ranges.push([idx, idx + q.length]);
      i = idx + 1;
    }
  }
  return mergeRanges(ranges);
}

function HighlightedSource({
  text,
  flags,
}: {
  text: string;
  flags: string[];
}) {
  const ranges = findHighlightRanges(text, collectHighlightTerms(flags));
  if (ranges.length === 0) {
    return (
      <p
        style={{
          margin: 0,
          fontSize: "0.9375rem",
          lineHeight: 1.65,
          color: "#2d2d2d",
          whiteSpace: "pre-wrap",
        }}
      >
        {text}
      </p>
    );
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], idx) => {
    if (start > cursor) {
      nodes.push(
        <span key={`t-${idx}-b`}>{text.slice(cursor, start)}</span>
      );
    }
    nodes.push(
      <mark
        key={`t-${idx}-h`}
        style={{
          backgroundColor: "rgba(107, 68, 35, 0.12)",
          color: "inherit",
          padding: "0 0.02em",
        }}
      >
        {text.slice(start, end)}
      </mark>
    );
    cursor = end;
  });
  if (cursor < text.length) {
    nodes.push(<span key="t-tail">{text.slice(cursor)}</span>);
  }

  return (
    <p
      style={{
        margin: 0,
        fontSize: "0.9375rem",
        lineHeight: 1.65,
        color: "#2d2d2d",
        whiteSpace: "pre-wrap",
      }}
    >
      {nodes}
    </p>
  );
}

function ComparisonPanel({
  current,
  previous,
}: {
  current: HistoryEntry;
  previous: HistoryEntry;
}) {
  const cur = current.result;
  const prev = previous.result;
  const dHall = cur.hallucination_score - prev.hallucination_score;
  const dConf = cur.confidence_score - prev.confidence_score;
  const { added, removed } = flagSetsDiff(prev.flags, cur.flags);

  const cellStyle: CSSProperties = {
    border: "1px solid #e3e0d8",
    background: "#fff",
    padding: "1rem 1.1rem",
  };

  return (
    <section
      style={{
        marginBottom: "1.5rem",
        border: "1px solid #d4cfc4",
        background: "#faf9f6",
      }}
    >
      <div style={{ padding: "1rem 1.15rem 0.85rem", borderBottom: "1px solid #e3e0d8" }}>
        <p
          style={{
            margin: 0,
            fontSize: "0.6875rem",
            fontWeight: 600,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "#5c5c5c",
          }}
        >
          Comparison
        </p>
        <p style={{ margin: "0.65rem 0 0", fontSize: "0.875rem", lineHeight: 1.5, color: "#444" }}>
          Current assessment vs the prior run in your history (older iteration).
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        }}
      >
        <div style={{ ...cellStyle, borderRight: "none" }}>
          <p
            style={{
              margin: 0,
              fontSize: "0.6875rem",
              fontWeight: 600,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "#666",
            }}
          >
            Current
          </p>
          <p
            style={{
              margin: "0.75rem 0 0",
              fontSize: "1.0625rem",
              fontWeight: 700,
              letterSpacing: "0.04em",
              color: RISK_THEME[cur.risk_level].label,
            }}
          >
            {cur.risk_level.toUpperCase()}
          </p>
        </div>
        <div style={{ ...cellStyle, borderLeft: "1px solid #e8e5dd" }}>
          <p
            style={{
              margin: 0,
              fontSize: "0.6875rem",
              fontWeight: 600,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "#666",
            }}
          >
            Previous
          </p>
          <p
            style={{
              margin: "0.75rem 0 0",
              fontSize: "1.0625rem",
              fontWeight: 700,
              letterSpacing: "0.04em",
              color: RISK_THEME[prev.risk_level].label,
            }}
          >
            {prev.risk_level.toUpperCase()}
          </p>
        </div>
      </div>

      <div style={{ padding: "1rem 1.15rem 1.25rem", borderTop: "1px solid #e3e0d8" }}>
        <p style={{ margin: "0 0 0.5rem", fontSize: "0.8125rem", color: "#333" }}>
          <strong style={{ fontWeight: 600 }}>Risk level</strong>{" "}
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {prev.risk_level.toUpperCase()} → {cur.risk_level.toUpperCase()}
          </span>
        </p>
        <p style={{ margin: "0.35rem 0", fontSize: "0.8125rem", color: "#333" }}>
          <strong style={{ fontWeight: 600 }}>Hallucination</strong>{" "}
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {prev.hallucination_score.toFixed(2)} → {cur.hallucination_score.toFixed(2)}{" "}
            <span style={{ color: "#5c5c5c" }}>({formatSignedDelta(dHall)})</span>
          </span>
        </p>
        <p style={{ margin: "0.35rem 0", fontSize: "0.8125rem", color: "#333" }}>
          <strong style={{ fontWeight: 600 }}>Confidence</strong>{" "}
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {prev.confidence_score.toFixed(2)} → {cur.confidence_score.toFixed(2)}{" "}
            <span style={{ color: "#5c5c5c" }}>({formatSignedDelta(dConf)})</span>
          </span>
        </p>
        <div style={{ marginTop: "0.85rem" }}>
          <p style={{ margin: 0, fontSize: "0.6875rem", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "#6b6560" }}>
            Flags
          </p>
          {added.length > 0 && (
            <p style={{ margin: "0.45rem 0 0", fontSize: "0.8125rem", color: "#0f3d2c" }}>
              <strong style={{ fontWeight: 600 }}>Added</strong>{" "}
              {added.map(humanizeFlag).join(" · ") || "—"}
            </p>
          )}
          {removed.length > 0 && (
            <p style={{ margin: "0.35rem 0 0", fontSize: "0.8125rem", color: "#5c1a1a" }}>
              <strong style={{ fontWeight: 600 }}>Removed</strong>{" "}
              {removed.map(humanizeFlag).join(" · ") || "—"}
            </p>
          )}
          {added.length === 0 && removed.length === 0 && (
            <p style={{ margin: "0.45rem 0 0", fontSize: "0.8125rem", color: "#666" }}>
              No flag changes between these two runs.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const [text, setText] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"" | "success" | "error">("");
  const [showCompare, setShowCompare] = useState(false);

  useEffect(() => {
    const loaded = loadHistoryFromStorage();
    setHistory(loaded);
    if (loaded.length > 0) {
      setActiveIndex(0);
      setText(loaded[0].text);
    }
  }, []);

  const activeEntry = useMemo(() => {
    if (history.length === 0) return null;
    const i = Math.max(0, Math.min(activeIndex, history.length - 1));
    return history[i];
  }, [history, activeIndex]);

  const result = activeEntry?.result ?? null;
  const lastAnalyzedText = activeEntry?.text ?? null;

  const canCompareWithPrevious =
    history.length >= 2 && activeIndex < history.length - 1;
  const previousEntry =
    canCompareWithPrevious ? history[activeIndex + 1] : null;

  const analyze = async () => {
    setError("");
    setCopyStatus("");
    setShowCompare(false);
    setLoading(true);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data?.error || "Request failed.");
        return;
      }

      const newResult = data.result as AnalyzeResult;
      const entry: HistoryEntry = {
        id:
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `eva-${Date.now()}`,
        text,
        result: newResult,
        timestamp: Date.now(),
      };

      setHistory((prev) => {
        const next = [entry, ...prev].slice(0, MAX_HISTORY);
        persistHistory(next);
        return next;
      });
      setActiveIndex(0);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const selectHistoryItem = (index: number) => {
    if (index < 0 || index >= history.length) return;
    setActiveIndex(index);
    setText(history[index].text);
    setShowCompare(false);
    setCopyStatus("");
  };

  const clearHistory = () => {
    setHistory([]);
    persistHistory([]);
    setActiveIndex(0);
    setShowCompare(false);
    setCopyStatus("");
  };

  const copyJson = async () => {
    if (!result) return;
    const json = JSON.stringify(result, null, 2);
    setCopyStatus("");

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(json);
        setCopyStatus("success");
        return;
      }
    } catch {
      /* fallback */
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = json;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopyStatus(copied ? "success" : "error");
    } catch {
      setCopyStatus("error");
    }
  };

  const theme = result ? RISK_THEME[result.risk_level] : null;
  const showSystemIssue =
    result?.flags.some((f) => f.startsWith("error:")) ?? false;
  const maxFlagBullets = showSystemIssue ? 2 : 3;
  const keyIssues =
    result?.flags.filter((f) => !f.startsWith("error:")).slice(0, maxFlagBullets) ??
    [];

  return (
    <main
      style={{
        minHeight: "100%",
        background: "#f6f5f2",
        color: "#1a1a1a",
        padding: "clamp(1.5rem, 4vw, 3rem)",
        fontFamily:
          'var(--font-geist-sans), "Helvetica Neue", Helvetica, Arial, sans-serif',
      }}
    >
      <div style={{ maxWidth: 880, margin: "0 auto" }}>
        <header style={{ marginBottom: "2.25rem" }}>
          <p
            style={{
              margin: 0,
              fontSize: "0.6875rem",
              fontWeight: 600,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "#5c5c5c",
            }}
          >
            Agent Output Risk Assessment
          </p>
          <h1
            style={{
              margin: "0.35rem 0 0",
              fontSize: "clamp(1.75rem, 4vw, 2.25rem)",
              fontWeight: 600,
              letterSpacing: "-0.02em",
              fontFamily:
                'Georgia, "Times New Roman", "Times", serif',
              lineHeight: 1.15,
            }}
          >
            Eva
          </h1>
          <p
            style={{
              margin: "0.75rem 0 0",
              maxWidth: 36 * 16,
              fontSize: "1rem",
              lineHeight: 1.55,
              color: "#404040",
            }}
          >
            Evaluate whether an AI output is safe to use in real decisions.
          </p>
        </header>

        <section
          style={{
            background: "#fff",
            border: "1px solid #e3e0d8",
            padding: "1.25rem 1.35rem",
            marginBottom: "1.75rem",
          }}
        >
          <label
            htmlFor="eva-input"
            style={{
              display: "block",
              fontSize: "0.75rem",
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "#666",
              marginBottom: "0.5rem",
            }}
          >
            Text under review
          </label>
          <textarea
            id="eva-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={loading}
            placeholder="Paste the model output you intend to rely on…"
            rows={7}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "0.85rem 0.95rem",
              fontSize: "0.9375rem",
              lineHeight: 1.55,
              border: "1px solid #cfcac0",
              borderRadius: 0,
              resize: "vertical",
              fontFamily: "inherit",
              background: "#fdfcfa",
              color: "#1a1a1a",
              outline: "none",
            }}
          />
          <div
            style={{
              marginTop: "1rem",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "0.65rem",
            }}
          >
            <button
              type="button"
              onClick={analyze}
              disabled={loading || !text.trim()}
              style={{
                padding: "0.55rem 1.15rem",
                fontSize: "0.8125rem",
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                border: "none",
                background: "#1a1a1a",
                color: "#fff",
                cursor:
                  loading || !text.trim() ? "not-allowed" : "pointer",
                opacity: loading || !text.trim() ? 0.45 : 1,
              }}
            >
              {loading ? "Assessing…" : "Analyze"}
            </button>
            <button
              type="button"
              onClick={() => {
                setText(SAMPLE_TEXT);
                setCopyStatus("");
                setShowCompare(false);
              }}
              disabled={loading}
              style={{
                padding: "0.55rem 1rem",
                fontSize: "0.8125rem",
                fontWeight: 500,
                border: "1px solid #c4bfb2",
                background: "#fff",
                color: "#333",
                cursor: loading ? "not-allowed" : "pointer",
                opacity: loading ? 0.5 : 1,
              }}
            >
              Sample
            </button>
            {result && (
              <button
                type="button"
                onClick={copyJson}
                style={{
                  marginLeft: "auto",
                  padding: "0.4rem 0",
                  fontSize: "0.75rem",
                  fontWeight: 500,
                  border: "none",
                  background: "transparent",
                  color: "#555",
                  textDecoration: "underline",
                  textUnderlineOffset: "3px",
                  cursor: "pointer",
                }}
              >
                Copy JSON
              </button>
            )}
          </div>
          {copyStatus === "success" && (
            <p style={{ margin: "0.65rem 0 0", fontSize: "0.8125rem", color: "#0f3d2c" }}>
              Copied assessment JSON.
            </p>
          )}
          {copyStatus === "error" && (
            <p style={{ margin: "0.65rem 0 0", fontSize: "0.8125rem", color: "#5c1a1a" }}>
              Could not copy. Select JSON from your tools or try again.
            </p>
          )}
        </section>

        <section
          style={{
            background: "#fff",
            border: "1px solid #e3e0d8",
            padding: "1rem 1.2rem 1.1rem",
            marginBottom: "1.75rem",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: "0.75rem",
              flexWrap: "wrap",
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: "0.6875rem",
                fontWeight: 600,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "#5c5c5c",
              }}
            >
              Recent assessments
            </h2>
            {history.length > 0 && (
              <button
                type="button"
                onClick={clearHistory}
                aria-label="Clear all saved assessments"
                style={{
                  padding: "0.35rem 0.65rem",
                  fontSize: "0.6875rem",
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  border: "1px solid #c4bfb2",
                  background: "#fff",
                  color: "#5c1a1a",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Clear all
              </button>
            )}
          </div>
          <p style={{ margin: "0.45rem 0 0.85rem", fontSize: "0.75rem", color: "#737373" }}>
            Stored locally in this browser (last {MAX_HISTORY}). Click an entry to reload it.
          </p>
          {history.length === 0 ? (
            <p style={{ margin: 0, fontSize: "0.875rem", color: "#888" }}>
              No saved runs yet. Analyze text to build a history you can revisit.
            </p>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {history.map((entry, index) => {
                const isActive = index === activeIndex;
                const r = entry.result.risk_level;
                const riskDot = RISK_THEME[r].accent;
                return (
                  <li key={entry.id} style={{ marginBottom: index < history.length - 1 ? 6 : 0 }}>
                    <button
                      type="button"
                      onClick={() => selectHistoryItem(index)}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "0.65rem",
                        padding: "0.55rem 0.65rem",
                        border: isActive ? "1px solid #b8b3a8" : "1px solid #ece8e0",
                        background: isActive ? "#f9f8f4" : "#fdfcfa",
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 6,
                          height: 6,
                          marginTop: "0.35rem",
                          borderRadius: "50%",
                          background: riskDot,
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span
                          style={{
                            display: "block",
                            fontSize: "0.8125rem",
                            lineHeight: 1.45,
                            color: "#2d2d2d",
                          }}
                        >
                          {truncatePreview(entry.text)}
                        </span>
                        <span
                          style={{
                            display: "block",
                            marginTop: "0.2rem",
                            fontSize: "0.6875rem",
                            letterSpacing: "0.06em",
                            textTransform: "uppercase",
                            color: RISK_THEME[r].label,
                            fontWeight: 600,
                          }}
                        >
                          {r.toUpperCase()}
                        </span>
                      </span>
                      <span
                        style={{
                          fontSize: "0.6875rem",
                          color: "#8a8580",
                          flexShrink: 0,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {formatHistoryTime(entry.timestamp)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {loading && (
          <div
            style={{
              marginBottom: "1.5rem",
              height: 2,
              background: "#e3e0d8",
              overflow: "hidden",
            }}
            aria-hidden
          >
            <div
              className="h-full w-1/3 bg-neutral-800/70 animate-pulse"
              style={{ animationDuration: "1.2s" }}
            />
          </div>
        )}

        {error && (
          <div
            style={{
              background: "#fff",
              border: "1px solid #d4c4c4",
              padding: "1rem 1.15rem",
              marginBottom: "1.5rem",
            }}
          >
            <p style={{ margin: 0, fontSize: "0.875rem", color: "#5c1a1a" }}>
              <strong style={{ fontWeight: 600 }}>Request could not be completed.</strong>{" "}
              {error}
            </p>
          </div>
        )}

        {result && theme && lastAnalyzedText !== null && (
          <article
            className="transition-opacity duration-300 ease-out"
            style={{
              opacity: loading ? 0.35 : 1,
            }}
          >
            <section
              style={{
                background: "#fff",
                border: `1px solid ${theme.border}`,
                borderLeft: `4px solid ${theme.accent}`,
                padding: "1.5rem 1.6rem 1.65rem",
                marginBottom: "1.5rem",
                boxShadow: "0 1px 0 rgba(0,0,0,0.04)",
              }}
            >
              <p
                style={{
                  margin: 0,
                  fontSize: "0.6875rem",
                  fontWeight: 600,
                  letterSpacing: "0.16em",
                  color: theme.label,
                }}
              >
                Assessment
              </p>
              <p
                style={{
                  margin: "0.65rem 0 0",
                  fontSize: "clamp(1.85rem, 4.5vw, 2.35rem)",
                  fontWeight: 700,
                  letterSpacing: "0.04em",
                  color: theme.label,
                  lineHeight: 1.05,
                  textTransform: "uppercase",
                }}
              >
                {result.risk_level}
              </p>
              <p
                style={{
                  margin: "0.85rem 0 0",
                  fontSize: "1.0625rem",
                  fontWeight: 500,
                  lineHeight: 1.45,
                  color: "#242424",
                  maxWidth: "28rem",
                }}
              >
                {verdictForRisk(result.risk_level)}
              </p>
            </section>

            {canCompareWithPrevious && activeEntry && previousEntry && (
              <div style={{ marginBottom: "1.25rem" }}>
                <button
                  type="button"
                  onClick={() => setShowCompare((v) => !v)}
                  style={{
                    padding: "0.5rem 0.85rem",
                    fontSize: "0.75rem",
                    fontWeight: 600,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    border: "1px solid #c4bfb2",
                    background: showCompare ? "#1a1a1a" : "#fff",
                    color: showCompare ? "#fff" : "#333",
                    cursor: "pointer",
                  }}
                >
                  {showCompare ? "Hide comparison" : "Compare with previous"}
                </button>
              </div>
            )}

            {showCompare && canCompareWithPrevious && activeEntry && previousEntry && (
              <ComparisonPanel current={activeEntry} previous={previousEntry} />
            )}

            <div
              style={{
                display: "grid",
                gap: "1.5rem",
              }}
            >
              <section
                style={{
                  background: "#fff",
                  border: "1px solid #e3e0d8",
                  padding: "1.25rem 1.35rem",
                }}
              >
                <h2
                  style={{
                    margin: 0,
                    fontSize: "0.6875rem",
                    fontWeight: 600,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: "#5c5c5c",
                  }}
                >
                  Key issues
                </h2>
                <ul
                  style={{
                    margin: "0.85rem 0 0",
                    paddingLeft: "1.15rem",
                    fontSize: "0.9375rem",
                    lineHeight: 1.55,
                    color: "#2d2d2d",
                  }}
                >
                  {keyIssues.length === 0 && !showSystemIssue ? (
                    <li style={{ marginBottom: 0, listStyle: "none", marginLeft: "-1.15rem" }}>
                      No discrete issue codes were flagged for this output.
                    </li>
                  ) : (
                    <>
                      {keyIssues.map((f) => (
                        <li key={f} style={{ marginBottom: "0.35rem" }}>
                          {humanizeFlag(f)}
                        </li>
                      ))}
                      {showSystemIssue && (
                        <li style={{ marginBottom: 0 }}>
                          System could not produce a reliable model assessment for this run.
                        </li>
                      )}
                    </>
                  )}
                </ul>
              </section>

              <section
                style={{
                  background: "#fff",
                  border: "1px solid #e3e0d8",
                  padding: "1.25rem 1.35rem",
                }}
              >
                <h2
                  style={{
                    margin: 0,
                    fontSize: "0.6875rem",
                    fontWeight: 600,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: "#5c5c5c",
                  }}
                >
                  Reviewed text
                </h2>
                <p
                  style={{
                    margin: "0.45rem 0 0.85rem",
                    fontSize: "0.75rem",
                    color: "#737373",
                  }}
                >
                  Subtle marking indicates terms tied to reported risk signals.
                </p>
                <HighlightedSource text={lastAnalyzedText} flags={result.flags} />
              </section>

              <section
                style={{
                  background: "#faf9f6",
                  border: "1px solid #e8e5dd",
                  padding: "1.1rem 1.35rem",
                }}
              >
                <h2
                  style={{
                    margin: 0,
                    fontSize: "0.6875rem",
                    fontWeight: 600,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: "#6b6560",
                  }}
                >
                  Model scores
                </h2>
                <div
                  style={{
                    marginTop: "0.75rem",
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "1rem",
                    maxWidth: 320,
                  }}
                >
                  <div>
                    <p
                      style={{
                        margin: 0,
                        fontSize: "0.6875rem",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        color: "#757575",
                      }}
                    >
                      Hallucination
                    </p>
                    <p
                      style={{
                        margin: "0.2rem 0 0",
                        fontSize: "1.125rem",
                        fontWeight: 600,
                        fontVariantNumeric: "tabular-nums",
                        color: "#333",
                      }}
                    >
                      {result.hallucination_score.toFixed(2)}
                    </p>
                  </div>
                  <div>
                    <p
                      style={{
                        margin: 0,
                        fontSize: "0.6875rem",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        color: "#757575",
                      }}
                    >
                      Confidence
                    </p>
                    <p
                      style={{
                        margin: "0.2rem 0 0",
                        fontSize: "1.125rem",
                        fontWeight: 600,
                        fontVariantNumeric: "tabular-nums",
                        color: "#333",
                      }}
                    >
                      {result.confidence_score.toFixed(2)}
                    </p>
                  </div>
                </div>
              </section>

              <section
                style={{
                  background: "#fff",
                  border: "1px solid #e3e0d8",
                  padding: "1.25rem 1.35rem",
                  marginBottom: "2rem",
                }}
              >
                <h2
                  style={{
                    margin: 0,
                    fontSize: "0.6875rem",
                    fontWeight: 600,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: "#5c5c5c",
                  }}
                >
                  Reasoning
                </h2>
                <p
                  style={{
                    margin: "0.85rem 0 0",
                    fontSize: "1rem",
                    lineHeight: 1.65,
                    color: "#2d2d2d",
                    maxWidth: "38rem",
                  }}
                >
                  {result.explanation}
                </p>
              </section>
            </div>
          </article>
        )}

        {!result && !error && !loading && (
          <p
            style={{
              margin: 0,
              fontSize: "0.875rem",
              lineHeight: 1.55,
              color: "#666",
            }}
          >
            Submit text above to generate a structured risk assessment. This tool does not
            replace human judgment for consequential decisions.
          </p>
        )}

        <footer
          style={{
            marginTop: "2.5rem",
            paddingTop: "1.25rem",
            borderTop: "1px solid #e0ddd4",
            fontSize: "0.75rem",
            color: "#7a766f",
            lineHeight: 1.5,
          }}
        >
          Eva supports evaluation workflows only. It is not a conversational assistant and
          does not verify claims against external sources.
        </footer>
      </div>
    </main>
  );
}
