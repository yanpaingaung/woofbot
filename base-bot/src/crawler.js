/**
 * Crawls docs.base.org, chunks content, embeds with Voyage AI, and upserts to Supabase.
 *
 * Usage:
 *   node --env-file=.env src/crawler.js           # incremental (skip unchanged pages)
 *   node --env-file=.env src/crawler.js --full    # full crawl, auto-resumes if interrupted
 *   node --env-file=.env src/crawler.js --reset   # wipe all chunks and start completely fresh
 */

import { createClient } from "@supabase/supabase-js";
import { load } from "cheerio";
import { createHash } from "crypto";
import { embedBatch } from "./embeddings.js";

const ROOT_URL = "https://docs.base.org";
const MAX_PAGES = 600;
const CHUNK_CHARS = 2800;
const EMBED_BATCH_SIZE = 10;
const FETCH_CONCURRENCY = 4;
const CHECKPOINT_KEY = "crawl_checkpoint";
const CHECKPOINT_TTL_HOURS = 72; // auto-expire stale checkpoints after 3 days

let _client = null;
function supabase() {
  if (!_client) {
    _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  }
  return _client;
}

// ── Checkpoint helpers ────────────────────────────────────────────────────────

async function loadCheckpoint() {
  const { data } = await supabase()
    .from("bot_state")
    .select("value")
    .eq("key", CHECKPOINT_KEY)
    .single();
  if (!data) return null;
  try {
    const cp = JSON.parse(data.value);
    const ageHours = (Date.now() - cp.startedAt) / 3_600_000;
    if (ageHours > CHECKPOINT_TTL_HOURS) return null;
    if (cp.completedAt) return null; // previous run finished cleanly
    return cp;
  } catch { return null; }
}

async function saveCheckpoint(visited, queue) {
  const value = JSON.stringify({
    startedAt: Date.now(),
    completedAt: null,
    visited: [...visited],
    queue,
  });
  await supabase().from("bot_state").upsert(
    { key: CHECKPOINT_KEY, value, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
}

async function markCheckpointDone() {
  const { data } = await supabase()
    .from("bot_state").select("value").eq("key", CHECKPOINT_KEY).single();
  if (!data) return;
  try {
    const cp = JSON.parse(data.value);
    cp.completedAt = Date.now();
    await supabase().from("bot_state").upsert(
      { key: CHECKPOINT_KEY, value: JSON.stringify(cp), updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
  } catch { /* best-effort */ }
}

// ── Page helpers ──────────────────────────────────────────────────────────────

function normalizeUrl(href, base) {
  try {
    const u = new URL(href, base);
    if (u.hostname !== new URL(ROOT_URL).hostname) return null;
    u.hash = "";
    u.search = "";
    return u.href.replace(/\/$/, "") || ROOT_URL;
  } catch { return null; }
}

function extractText($) {
  $("nav, footer, header, script, style, aside, .sidebar, .toc, [aria-hidden='true'], .breadcrumb").remove();
  const main = $("main, article, .content, .docs-content, [role='main']").first();
  return (main.length ? main : $("body"))
    .text()
    .replace(/\s+/g, " ")
    .trim();
}

function chunkText(text, size = CHUNK_CHARS) {
  const chunks = [];
  const sections = text.split(/(?:\n\n+|(?<=\. )(?=[A-Z]))/);
  let buf = "";
  for (const section of sections) {
    if (!section.trim()) continue;
    if (buf.length + section.length > size && buf.length > 100) {
      chunks.push(buf.trim());
      buf = section;
    } else {
      buf += (buf ? " " : "") + section;
    }
  }
  if (buf.trim().length > 50) chunks.push(buf.trim());
  return chunks;
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "woofbot-docs-crawler/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  const $ = load(html);
  const title = $("h1").first().text().trim() || $("title").text().replace(/[|\-].*$/, "").trim() || url;
  const content = extractText($);
  const links = new Set();
  $("a[href]").each((_, el) => {
    const href = normalizeUrl($(el).attr("href"), url);
    if (href) links.add(href);
  });
  return { title, content, links: [...links] };
}

async function pageChanged(url, pageHash) {
  const { data } = await supabase()
    .from("doc_chunks")
    .select("content_hash")
    .eq("url", url)
    .eq("chunk_index", 0)
    .single();
  return !data || data.content_hash !== pageHash;
}

async function upsertPageChunks(url, title, chunks, embeddings, pageHash) {
  const db = supabase();
  const rows = chunks.map((content, i) => ({
    url, title, chunk_index: i, content,
    embedding: embeddings[i],
    content_hash: pageHash,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await db.from("doc_chunks").upsert(rows, { onConflict: "url,chunk_index" });
  if (error) throw new Error(`Upsert error for ${url}: ${error.message}`);
  await db.from("doc_chunks").delete().eq("url", url).gte("chunk_index", chunks.length);
}

// ── Main crawl ────────────────────────────────────────────────────────────────

export async function runCrawl({ incremental = true, reset = false } = {}) {
  const db = supabase();

  if (reset) {
    console.log("[crawler] --reset: wiping all doc_chunks and checkpoint...");
    await db.from("doc_chunks").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    await db.from("bot_state").delete().eq("key", CHECKPOINT_KEY);
  }

  const visited = new Set();
  let queue = [ROOT_URL];
  let pagesProcessed = 0;
  let chunksTotal = 0;
  let pagesSkipped = 0;

  // ── Restore checkpoint for full crawls ──────────────────────────────────────
  if (!incremental && !reset) {
    const cp = await loadCheckpoint().catch(() => null);
    if (cp) {
      console.log(`[crawler] Resuming from checkpoint: ${cp.visited.length} pages already done, ${cp.queue.length} remaining in queue`);
      cp.visited.forEach((u) => visited.add(u));
      // Merge saved queue with root (in case new pages were added to the site)
      queue = [...new Set([...cp.queue, ROOT_URL])];
    } else {
      console.log("[crawler] Starting full crawl of " + ROOT_URL);
    }
  } else {
    console.log(`[crawler] Starting ${incremental ? "incremental" : reset ? "reset" : "full"} crawl of ${ROOT_URL}`);
  }

  // ── Buffer + flush ──────────────────────────────────────────────────────────
  let pageBuffer = [];

  async function flushBuffer() {
    if (pageBuffer.length === 0) return;
    const flat = pageBuffer.flatMap((p) => p.chunks);
    const allEmbeddings = [];
    for (let i = 0; i < flat.length; i += EMBED_BATCH_SIZE) {
      const embs = await embedBatch(flat.slice(i, i + EMBED_BATCH_SIZE));
      allEmbeddings.push(...embs);
    }
    let offset = 0;
    for (const { url, title, chunks, pageHash } of pageBuffer) {
      await upsertPageChunks(url, title, chunks, allEmbeddings.slice(offset, offset + chunks.length), pageHash);
      chunksTotal += chunks.length;
      offset += chunks.length;
    }
    pageBuffer = [];

    // Save checkpoint after every successful flush (only for full crawls)
    if (!incremental) {
      await saveCheckpoint(visited, queue).catch(() => {});
    }
  }

  // ── BFS crawl loop ──────────────────────────────────────────────────────────
  while (queue.length > 0 && pagesProcessed + pagesSkipped < MAX_PAGES) {
    // Phase 1: fetch in parallel
    const batch = queue.splice(0, FETCH_CONCURRENCY).filter((u) => !visited.has(u));
    if (batch.length === 0) continue;
    batch.forEach((u) => visited.add(u));

    const results = await Promise.allSettled(batch.map(fetchPage));

    // Phase 2: collect into buffer (sequential, no embedding yet)
    for (let i = 0; i < batch.length; i++) {
      const url = batch[i];
      const r = results[i];
      if (r.status !== "fulfilled" || !r.value) continue;

      const { title, content, links } = r.value;
      if (content.length < 80) continue;

      for (const link of links) {
        if (!visited.has(link) && !queue.includes(link)) queue.push(link);
      }

      const chunks = chunkText(content);
      if (chunks.length === 0) continue;

      const pageHash = createHash("md5").update(content).digest("hex");

      if (incremental) {
        const changed = await pageChanged(url, pageHash).catch(() => true);
        if (!changed) { pagesSkipped++; continue; }
      }

      console.log(`[crawler] ${url} → ${chunks.length} chunk(s)`);
      pageBuffer.push({ url, title, chunks, pageHash });
      pagesProcessed++;
    }

    // Phase 3: embed + upsert (one batch at a time — never concurrent)
    const totalBuffered = pageBuffer.reduce((n, p) => n + p.chunks.length, 0);
    if (totalBuffered >= EMBED_BATCH_SIZE) await flushBuffer();
  }

  await flushBuffer();
  await markCheckpointDone().catch(() => {});

  console.log(`[crawler] Done. processed: ${pagesProcessed}, skipped: ${pagesSkipped}, chunks: ${chunksTotal}`);
  return { pagesProcessed, pagesSkipped, chunksTotal };
}

// ── CLI entry point ───────────────────────────────────────────────────────────
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` ||
    process.argv[1]?.endsWith("crawler.js")) {
  const reset = process.argv.includes("--reset");
  const full = process.argv.includes("--full") || reset;
  runCrawl({ incremental: !full, reset })
    .then(({ pagesProcessed, chunksTotal }) => {
      console.log(`Crawl complete — ${pagesProcessed} pages, ${chunksTotal} chunks`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[crawler] Fatal:", err.message);
      process.exit(1);
    });
}
