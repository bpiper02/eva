import { NextResponse } from "next/server";
import { analyzeText } from "@/lib/ai";

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

    const result = await analyzeText(text);

    return NextResponse.json({ result });
  } catch (err) {
    console.error("ROUTE ERROR:", err);
    return NextResponse.json(
      { error: "Error processing request." },
      { status: 500 }
    );
  }
}