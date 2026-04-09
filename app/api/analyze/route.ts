import { NextResponse } from "next/server";
import { enforceRiskConsistency } from "@/lib/enforceRiskConsistency";
import { runHybridPipeline } from "@/lib/pipeline/hybrid";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";

    if (!text) {
      return NextResponse.json(
        { error: "Invalid input. Please provide non-empty text." },
        { status: 400 }
      );
    }

    const raw = await runHybridPipeline(text);
    const result = enforceRiskConsistency(raw, text);

    return NextResponse.json({ result });
  } catch (err) {
    console.error("ROUTE ERROR:", err);
    return NextResponse.json(
      { error: "Error processing request." },
      { status: 500 }
    );
  }
}