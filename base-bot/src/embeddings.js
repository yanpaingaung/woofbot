// Voyage AI voyage-3: 1024-dim, 200M tokens/month free tier
// Get a free key at: https://dash.voyageai.com
const MODEL = "voyage-3";
const API_URL = "https://api.voyageai.com/v1/embeddings";

function apiKey() {
  const key = process.env.VOYAGE_API_KEY ?? process.env.EMBEDDING_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY env var is required (free at dash.voyageai.com)");
  return key;
}

async function post(input, retries = 8) {
  // Voyage free tier = 3 RPM → wait 22s between retries (just above the 20s window)
  const RETRY_DELAY = 22_000;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({ model: MODEL, input }),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.status === 429) {
      if (attempt === retries) throw new Error("Voyage AI rate limit exceeded after retries — add a payment method at dashboard.voyageai.com to unlock 300 RPM (free tokens still apply)");
      console.warn(`[embeddings] Rate limited — waiting ${RETRY_DELAY / 1000}s (attempt ${attempt + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY));
      continue;
    }

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`Voyage AI embeddings HTTP ${res.status}: ${err}`);
    }

    return res.json();
  }
}

export async function embed(text) {
  const data = await post(text);
  return data.data[0].embedding;
}

export async function embedBatch(texts) {
  if (texts.length === 0) return [];
  const data = await post(texts);
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}
