# base-bot v2

A Base ecosystem expert X (Twitter) bot that combines:
- **RAG on docs.base.org** — every page crawled, chunked, and embedded in Supabase pgvector for accurate, doc-grounded answers
- **Live on-chain analytics** via two MCP servers: Coinbase's public Base MCP + our custom base-analytics-mcp
- **Supabase backend** — bot state, Q&A log, per-user rate limiting, response cache

Scope: Base chain only. No price predictions, no buy/sell advice, never fabricates numbers.

---

## Prerequisites

- Node.js 20+
- Anthropic API key
- OpenAI API key (for `text-embedding-3-small` embeddings, ~$0.02/1M tokens)
- Supabase project (free tier works — pgvector is built in)
- X Developer App with OAuth 1.0a credentials
- `base-analytics-mcp` running locally or deployed

---

## Quick start

### 1. Install dependencies

```bash
cd base-bot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in all values
```

Key values to fill:
- `ANTHROPIC_API_KEY` — from [console.anthropic.com](https://console.anthropic.com)
- `OPENAI_API_KEY` — from [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` — from Supabase dashboard → Project Settings → API → **service_role** (not anon)
- X credentials — see step 4 below

### 3. Supabase pgvector setup

The schema (tables + HNSW index + `match_doc_chunks` RPC function) is already applied via migration.
If you're starting from a fresh Supabase project, apply the migration manually:

```bash
# Run the SQL in: supabase/migrations/base_bot_rag_schema.sql
# via Supabase dashboard → SQL Editor, or via Supabase CLI
```

### 4. X Developer App

1. [developer.twitter.com](https://developer.twitter.com) → Create Project → Create App
2. App Permissions → **Read and Write**
3. User Authentication Settings → enable OAuth 1.0a
4. Keys and Tokens → generate API Key, API Secret, Access Token, Access Token Secret
5. Find your bot's numeric user ID at [tweeterid.com](https://tweeterid.com)

### 5. Start base-analytics-mcp

```bash
cd ../base-analytics-mcp
npm install
npm start   # listens on http://localhost:8788
```

### 6. Run the initial full crawl

This downloads every page on docs.base.org, chunks them, embeds with OpenAI, and stores in Supabase. Takes ~5–10 minutes and costs roughly $0.05–$0.15 in OpenAI embedding tokens.

```bash
npm run crawl:full
```

For daily incremental updates (only re-embed changed pages):

```bash
npm run crawl
```

Schedule this as a cron job (see Deployment below).

### 7. Test without posting to X

```bash
npm run test-mock
```

This runs hardcoded questions through the full Claude + MCP + RAG pipeline. X credentials not needed.

### 8. Start the bot

```bash
DRY_RUN=true npm start    # logs replies without posting
# then:
DRY_RUN=false npm start   # live
```

---

## Architecture

```
X mentions (poll every 5 min)
       │
       ▼
  stripHandle()
       │
       ├── searchDocs(question)          ← pgvector similarity search on doc_chunks
       ├── connectMcp(analytics)         ← base-analytics-mcp (localhost:8788)
       └── connectMcp(base) [optional]   ← mcp.base.org (Coinbase public MCP)
       │
       ▼
  Claude claude-sonnet-4-6
    system: Base expert + doc-grounded + on-chain tool user
    user:   [doc context] + [question]
    tools:  all MCP tools from both servers
       │
       ▼  (agentic tool loop)
  reply text ≤ 275 chars
       │
       ├── logQA() → Supabase qa_log
       ├── checkRateLimit() → Supabase rate_limits
       └── rwClient.v2.reply() (if DRY_RUN=false)
```

---

## Deployment

### Railway (recommended)

1. Push to GitHub
2. New project → Deploy from GitHub repo → select this repo
3. Add environment variables from `.env`
4. Add a cron service for daily re-crawl:
   - Command: `npm run crawl`
   - Schedule: `0 4 * * *` (4am UTC daily)

### Render

- Web Service for the bot (command: `npm start`)
- Cron Job for the crawler (command: `npm run crawl`, schedule: `0 4 * * *`)

### Fly.io

```bash
fly launch
fly secrets set ANTHROPIC_API_KEY=... OPENAI_API_KEY=... SUPABASE_URL=... # etc.
fly deploy
```

For the cron, add a `[processes]` section to `fly.toml` or use a separate app.

---

## Cost estimates

| Item | Free tier | Cost at ~100 mentions/day |
|------|-----------|--------------------------|
| Anthropic (Claude Sonnet) | pay-per-use | ~$0.30–$1.00/day |
| OpenAI (embeddings) | $5 credit/new account | ~$0.01/day (incremental crawl) |
| Initial full crawl | — | ~$0.05–$0.15 one-time |
| Supabase | free up to 500MB + 5GB bandwidth | free for this use case |
| X API Free tier | 1,500 posts/month | free if ≤ 50 replies/day |
| Base RPC (public) | free | free; use Alchemy/QuickNode for high volume |

At 100 mentions/day: roughly **$10–$30/month** total, dominated by Claude API calls.

---

## Environment variables

See `.env.example` for full list. Required:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key |
| `OPENAI_API_KEY` | OpenAI embeddings key |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `BASE_ANALYTICS_MCP_URL` | URL of base-analytics-mcp (e.g. `http://localhost:8788/mcp`) |
| `X_APP_KEY` + `X_APP_SECRET` | X OAuth 1.0a app credentials |
| `X_ACCESS_TOKEN` + `X_ACCESS_SECRET` | X OAuth 1.0a user credentials |
| `X_BOT_USER_ID` | Numeric ID of the bot's X account |

Optional:

| Variable | Default | Description |
|----------|---------|-------------|
| `DRY_RUN` | `true` | Set `false` to post live replies |
| `POLL_INTERVAL_MS` | `300000` | Poll frequency (5 min) |
| `DAILY_RATE_LIMIT` | `20` | Max replies per user per day |
| `CACHE_TTL_SECONDS` | `300` | Doc search cache TTL |
| `BASE_MCP_URL` | — | Coinbase public Base MCP (optional) |
