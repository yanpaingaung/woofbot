import { createClient } from "@supabase/supabase-js";
import { embed } from "./embeddings.js";
import { getCached, setCached } from "./db.js";

let _client = null;
function supabase() {
  if (!_client) {
    _client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return _client;
}

export async function searchDocs(query, limit = 5) {
  const cacheKey = `docs:${query.slice(0, 120)}`;

  const cached = await getCached(cacheKey).catch(() => null);
  if (cached) return cached;

  const embedding = await embed(query);

  const { data, error } = await supabase().rpc("match_doc_chunks", {
    query_embedding: embedding,
    match_count: limit,
  });

  if (error) throw new Error(`pgvector search: ${error.message}`);

  const results = (data ?? []).map((row) => ({
    url: row.url,
    title: row.title,
    content: row.content,
    similarity: row.similarity,
  }));

  await setCached(cacheKey, results, 300).catch(() => {});
  return results;
}

export function formatDocContext(chunks) {
  if (!chunks?.length) return "";
  return chunks
    .map((c, i) => `[Doc ${i + 1}: ${c.title ?? c.url}]\n${c.content}`)
    .join("\n\n")
    .slice(0, 3000); // cap injected context at ~750 tokens
}
