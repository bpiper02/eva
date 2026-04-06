import { analyzeText } from "@/lib/ai";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const text = body.text;
    if (typeof text !== "string") {
      return Response.json({ result: "Error processing request" });
    }
    const result = await analyzeText(text);
    return Response.json({ result });
  } catch {
    return Response.json({ result: "Error processing request" });
  }
}
