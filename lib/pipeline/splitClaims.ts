/**
 * Splits free text into atomic claims (sentences / clauses) for per-unit scoring.
 */
export function splitIntoAtomicClaims(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const chunks = normalized
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const merged: string[] = [];
  for (const c of chunks) {
    if (merged.length === 0) {
      merged.push(c);
      continue;
    }
    if (c.length < 24 && !/[.!?]$/.test(merged[merged.length - 1])) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${c}`;
    } else if (c.length < 16) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${c}`;
    } else {
      merged.push(c);
    }
  }

  return merged.length > 0 ? merged : [normalized];
}
