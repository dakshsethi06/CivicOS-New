import "server-only";

/**
 * Optional language model, through any OpenAI-compatible chat API (Groq, OpenAI, Gemini's compatible endpoint, a local server).
 * Set LLM_API_KEY and LLM_MODEL; LLM_BASE_URL defaults to Groq's. Without them the assistant shows retrieved sources directly.
 */
export function llmConfigured(): boolean {
  return Boolean(process.env.LLM_API_KEY && process.env.LLM_MODEL);
}

export async function chat(system: string, user: string): Promise<string> {
  const base = (process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.LLM_API_KEY}` },
    body: JSON.stringify({
      model: process.env.LLM_MODEL,
      temperature: 0.1,
      max_tokens: 700,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Language model request failed (${res.status})`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Language model returned no text");
  return text;
}
