import http from "http";
import { TwitterApi } from "twitter-api-v2";
import { analyzeQuestion } from "./analyze.js";
import { withRetry } from "./retry.js";
import { getState, setState, checkRateLimit, logQA } from "./db.js";
import { loadState, saveState } from "./state.js"; // fallback if Supabase not configured

const DRY_RUN = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? String(5 * 60 * 1000));
const BOT_USER_ID = process.env.X_BOT_USER_ID;
const USE_SUPABASE = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);

function buildClient() {
  return new TwitterApi({
    appKey: process.env.X_APP_KEY,
    appSecret: process.env.X_APP_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });
}

function stripHandle(text) {
  return text.replace(/^(@\w+\s*)+/, "").trim();
}

// State helpers that prefer Supabase, fall back to local state.json
async function readSinceId() {
  if (USE_SUPABASE) {
    try { return await getState("since_id"); } catch { /* fall through */ }
  }
  return loadState().sinceId ?? null;
}

async function writeSinceId(id) {
  if (USE_SUPABASE) {
    try { await setState("since_id", id); return; } catch { /* fall through */ }
  }
  saveState({ sinceId: id });
}

async function processMention(rwClient, mention) {
  const question = stripHandle(mention.text);
  if (!question) return;

  const authorId = mention.author_id ?? "unknown";
  console.log(`[mention] ${mention.id} @${authorId}: "${question}"`);

  // Per-user daily rate limit (only enforced when Supabase is configured)
  if (USE_SUPABASE) {
    try {
      const allowed = await checkRateLimit(authorId);
      if (!allowed) {
        console.log(`[rate-limit] @${authorId} hit daily limit — skipping`);
        return;
      }
    } catch (err) {
      console.warn(`[rate-limit] Check failed: ${err.message} — allowing`);
    }
  }

  let reply;
  try {
    reply = await withRetry(() => analyzeQuestion(question));
  } catch (err) {
    console.error(`[error] Analysis failed for ${mention.id}:`, err.message);
    return;
  }

  // Log to Supabase (best-effort)
  if (USE_SUPABASE) {
    logQA(mention.id, authorId, question, reply).catch((err) =>
      console.warn(`[qa-log] ${err.message}`)
    );
  }

  if (DRY_RUN) {
    console.log(`[dry-run] ${mention.id} → (${reply.length} chars): ${reply}`);
  } else {
    try {
      await withRetry(() => rwClient.v2.reply(reply, mention.id));
      console.log(`[posted] Reply to ${mention.id}`);
    } catch (err) {
      console.error(`[error] Post failed for ${mention.id}:`, err.message);
    }
  }
}

async function poll(client, rwClient) {
  const sinceId = await readSinceId();

  const params = {
    "tweet.fields": ["author_id", "text", "created_at"],
    expansions: ["author_id"],
    max_results: 100,
  };
  if (sinceId) params.since_id = sinceId;

  let mentions;
  try {
    const response = await withRetry(() => client.v2.userMentionTimeline(BOT_USER_ID, params));
    mentions = response.data?.data ?? [];
  } catch (err) {
    console.error("[poll] Fetch mentions failed:", err.message);
    return;
  }

  if (mentions.length === 0) {
    console.log("[poll] No new mentions.");
    return;
  }

  console.log(`[poll] ${mentions.length} new mention(s)`);

  // Advance sinceId before processing to avoid re-processing on crash
  const newestId = mentions.reduce((max, m) => (m.id > max ? m.id : max), mentions[0].id);
  await writeSinceId(newestId);

  await Promise.all(mentions.map((m) => processMention(rwClient, m)));
}

function startTestServer() {
  const port = parseInt(process.env.PORT ?? "3000");
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.method === "POST" && req.url === "/ask") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { question } = JSON.parse(body);
          if (!question) throw new Error("Missing 'question' field");
          const reply = await analyzeQuestion(question);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ reply, length: reply.length }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => console.log(`[test-server] listening on port ${port}`));
}

async function main() {
  if (!BOT_USER_ID) throw new Error("X_BOT_USER_ID env var is required");

  const client = buildClient();
  const rwClient = buildClient();

  console.log(`[bot] base-bot v2 starting`);
  console.log(`[bot] DRY_RUN=${DRY_RUN} | poll=${POLL_INTERVAL_MS}ms | supabase=${USE_SUPABASE}`);
  startTestServer();

  await poll(client, rwClient);
  setInterval(() => poll(client, rwClient), POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
