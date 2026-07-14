import { createClient } from "@supabase/supabase-js";

const DAILY_RATE_LIMIT = parseInt(process.env.DAILY_RATE_LIMIT ?? "20");
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS ?? "300");

let _client = null;
function supabase() {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
    _client = createClient(url, key);
  }
  return _client;
}

export async function getState(key) {
  const { data } = await supabase()
    .from("bot_state")
    .select("value")
    .eq("key", key)
    .single();
  return data?.value ?? null;
}

export async function setState(key, value) {
  await supabase().from("bot_state").upsert({ key, value, updated_at: new Date().toISOString() });
}

export async function checkRateLimit(authorId) {
  const today = new Date().toISOString().slice(0, 10);
  const db = supabase();

  const { data } = await db
    .from("rate_limits")
    .select("count")
    .eq("author_id", authorId)
    .eq("date", today)
    .single();

  const count = data?.count ?? 0;
  if (count >= DAILY_RATE_LIMIT) return false;

  await db.from("rate_limits").upsert(
    { author_id: authorId, date: today, count: count + 1 },
    { onConflict: "author_id,date" }
  );
  return true;
}

export async function logQA(mentionId, authorId, question, answer) {
  await supabase().from("qa_log").upsert(
    { mention_id: mentionId, author_id: authorId, question, answer, created_at: new Date().toISOString() },
    { onConflict: "mention_id" }
  );
}

export async function getCached(key) {
  const { data } = await supabase()
    .from("cache")
    .select("value, expires_at")
    .eq("key", key)
    .single();

  if (!data) return null;
  if (new Date(data.expires_at) < new Date()) return null;
  return data.value;
}

export async function setCached(key, value, ttlSeconds = CACHE_TTL_SECONDS) {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await supabase().from("cache").upsert({ key, value, expires_at: expiresAt });
}
