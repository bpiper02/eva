type GenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
};

export async function analyzeText(text: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return "Error generating response";
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text }],
          },
        ],
      }),
    });

    if (!response.ok) {
      return "Error generating response";
    }

    const data = (await response.json()) as GenerateContentResponse;
    const generated = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (typeof generated !== "string") {
      return "Error generating response";
    }

    return generated;
  } catch {
    return "Error generating response";
  }
}
