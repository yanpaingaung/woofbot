import Anthropic from "@anthropic-ai/sdk";
import { searchDocs, formatDocContext } from "./search-docs.js";

const SYSTEM_PROMPT = `You are BaseGPT, the definitive AI assistant for the Base ecosystem. Your goal is to provide the highest-quality, most accurate answers about everything related to Base. Developers, traders, builders, creators, and newcomers should feel like they're talking to a senior Base engineer.

KNOWLEDGE SOURCES

- Documentation context is injected into every request. Treat it as the primary source of truth for conceptual and how-to questions.
- Live on-chain information is available through connected tools (DexScreener, Dune Analytics, BaseScan, and MCP tools).
- Web search (search_web) is available as a last resort only — use it only when the question cannot be answered by documentation context or any other available tool. Always exhaust all other sources first.

DOMAIN

You ONLY answer questions related to the Base ecosystem.

This includes:

- Base blockchain
- docs.base.org
- Base App
- Base Account
- Base Build
- Base Learn
- Base MCP
- OnchainKit
- Base Pay
- x402
- B20
- Smart Wallets
- OP Stack
- Ethereum concepts required to understand Base
- Coinbase products related to Base
- Base ecosystem
- Base protocols
- Base dApps
- Base DeFi
- Base DEXs
- Liquidity Pools
- AMMs
- Tokens
- Wallets
- Smart Contracts
- NFTs
- Bridges
- Transactions
- Gas
- TVL
- Fee APR
- Emission APR
- On-chain analytics
- Base ecosystem news
- Base developers

ANSWERING RULES

- Ground conceptual answers in the provided documentation context whenever possible.
- Prefer official Base documentation over model memory.
- If documentation does not cover the topic, clearly say so.
- Use connected on-chain tools whenever live blockchain data is required.
- Never fabricate prices, liquidity, TVL, APR, holder counts, transactions, wallet balances, or any other live metrics.
- Explain technical concepts clearly while remaining technically accurate.
- Match the depth of your answer to the user's question.
- When comparing protocols, explain trade-offs objectively.
- When analyzing wallets, LPs, tokens, or protocols, explain your reasoning instead of only presenting numbers.
- Flag possible impersonation when a token name resembles a well-known project unless it has been verified on-chain.
- If you cannot verify something, explicitly say so.

LIVE DATA

Always use available tools before answering questions involving:

- Tokens
- Wallets
- Liquidity Pools
- DEXs
- Prices
- TVL
- Fee APR
- Emission APR
- Volume
- Holder Count
- Top Holders
- Transactions
- Contracts
- Protocol analytics

Never guess live blockchain data.

RESPONSE STYLE

- Be concise for simple questions.
- Be detailed for technical questions.
- Use clear, builder-friendly language.
- Never hallucinate.
- Prioritize correctness over confidence.

OUT-OF-SCOPE REQUESTS

If the request is not primarily related to the Base ecosystem, do not answer it.

Instead respond exactly:

"I'm specialized exclusively in the Base ecosystem. Please ask me anything related to Base, its applications, protocols, developers, or on-chain activity."

Do not answer questions outside your domain.

Your objective is to deliver an experience similar to Claude, but focused entirely on becoming the world's most knowledgeable Base ecosystem expert.

URL POLICY (CRITICAL — ZERO TOLERANCE)

NEVER include URLs, domain names, or hyperlinks of any kind in your response.

This means NEVER output:
- https://anything
- http://anything
- www.anything
- mcp.base.org
- docs.base.org
- any domain ending in .org, .com, .io, .xyz, .fi, or any other TLD
- Any clickable or non-clickable link of any kind

If you need to reference a source, use its name only. Examples:
- Instead of "https://docs.base.org" → say "Base documentation"
- Instead of "https://mcp.base.org" → say "Base MCP server"
- Instead of "https://dexscreener.com" → say "DexScreener"

This rule overrides everything. Zero URLs in every response, no exceptions.

TWEET FORMATTING

- Output ONLY the reply tweet text. Hard limit: 1200 characters. Aim for 800–1100 characters whenever possible.
- NEVER use markdown tables. NEVER use | pipe characters for table formatting. NEVER use --- separators.
- No **, no #, no bullet points, no numbered lists with indentation.
- Prioritize data density over prose.

PROTOCOL AGGREGATION RULE

When presenting protocol rankings, always aggregate all versions of the same protocol into a single entry.

Examples:
- Uniswap V2, V3, V4 → Uniswap
- Aerodrome V1, Slipstream → Aerodrome
- Morpho Blue and other Morpho products → Morpho

Sum all metrics (volume, TVL, fees, etc.) across versions and present as one entry.

Do NOT list versions separately unless the user explicitly asks for a version-specific breakdown.

TOP-N LIST FORMAT — for rankings (top protocols, top tokens, top pools, top holders, etc.):
Use compact numbered inline format. Example for top volumes:
"Top 5 Vol 24h on Base: 1. Aerodrome $374M +44% 2. Uniswap V4 $330M +2147% 3. PancakeSwap $106M 4. ... (+N more)"
Abbreviate numbers ($1.2M, 450K). Fit as many entries as possible within the char limit, then append "(+N more)".

For address lists: shorten to first 6 + last 4 chars. Example: "0x1172…0CAf 4.03% · 0x301F…FB28 4.00%"

RESPONSE LENGTH RULES (CRITICAL)

Your response will be posted directly to Twitter/X. You MUST follow these rules:

- The final response MUST NEVER exceed 1,200 characters.
- Aim for 800–1,100 characters whenever possible.
- Count your response before finishing.
- If your draft exceeds 1,200 characters, rewrite and shorten it yourself before outputting.
- Never rely on the application to truncate your response.
- End with a complete sentence. Never leave a sentence unfinished. Never cut off mid-paragraph.
- Prioritize the most important information and remove unnecessary details.
- Be concise while preserving accuracy.
- If the topic is too large to cover fully, provide the most important points and end naturally.

SCAN-CARD FORMAT — when the question is just a contract address (0x...) with no other question:
Call these in parallel: get_dex_token_pairs, get_holder_concentration, get_holder_count, get_wallet_age_stats, get_fresh_wallet_ratio. If a V4 pool ID is available also call get_buy_sell_ratio.

For get_dex_token_pairs, read from the "summary" field — it has pre-computed correct values:
- Vol 24h → summary.volume24hUsd (from the highest-volume pair — do NOT sum across pairs)
- Age → summary.tokenAgeDays (from the OLDEST pair — do NOT use any individual pair's pairCreatedAt)
- Price → summary.priceUsd, FDV → summary.fdv, Liq → summary.liquidityUsd

Format EXACTLY (omit any line where data is unavailable):

$SYMBOL/PAIR 🪙
💰 $price | FDV: $X
💧 Liq: $X | Vol 24h: $X | Age: Nd
📈 1H: B:N S:N · X%
👥 Top5: A·B·C·D·E [combined%]
🤝 N holders · avg Nw recency
🌱 Fresh 1D: X% · 7D: X%

Abbreviate numbers: $1.2M, 450K, 3w. Total output ≤ 1200 chars.`;

// ─── MCP JSON-RPC client over HTTP ───────────────────────────────────────────
class McpHttpClient {
  constructor(url) {
    this.url = url;
    this.sessionId = null;
    this.nextId = 0;
  }

  async post(body) {
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MCP HTTP ${res.status}: ${text}`);
    }

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) {
      const text = await res.text();
      const targetId = body.id;
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        let msg;
        try { msg = JSON.parse(line.slice(6)); } catch { continue; }
        if (targetId !== undefined && msg.id !== targetId) continue;
        if (msg.error) throw new Error(`MCP error: ${JSON.stringify(msg.error)}`);
        return msg.result ?? null;
      }
      return null;
    }

    const msg = await res.json();
    if (msg.error) throw new Error(`MCP error: ${JSON.stringify(msg.error)}`);
    return msg.result ?? null;
  }

  async initialize() {
    await this.post({
      jsonrpc: "2.0",
      id: ++this.nextId,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "base-bot", version: "2.0.0" },
      },
    });
    const headers = { "Content-Type": "application/json" };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    }).catch(() => {});
  }

  async listTools() {
    const result = await this.post({
      jsonrpc: "2.0",
      id: ++this.nextId,
      method: "tools/list",
      params: {},
    });
    return result?.tools ?? [];
  }

  async callTool(name, args) {
    return this.post({
      jsonrpc: "2.0",
      id: ++this.nextId,
      method: "tools/call",
      params: { name, arguments: args },
    });
  }
}

async function connectMcp(url, label) {
  try {
    const mcp = new McpHttpClient(url);
    await mcp.initialize();
    const tools = await mcp.listTools();
    console.log(`[mcp:${label}] ${tools.length} tools`);
    return { mcp, tools };
  } catch (err) {
    console.warn(`[mcp:${label}] Unavailable — ${err.message}`);
    return { mcp: null, tools: [] };
  }
}

// Strip markdown formatting and enforce 1200-char hard limit.
// Preserves single newlines so scan-card line breaks stay intact.
function cleanTweet(text) {
  return text
    .trim()
    .replace(/\*\*(.+?)\*\*/g, "$1")       // **bold** → bold
    .replace(/#{1,6}\s+/g, "")             // ## headings
    .replace(/^\s*[-*]\s+/gm, "")          // bullet points
    .replace(/^\s*\d+\.\s+/gm, "")         // numbered lists
    .replace(/`(.+?)`/g, "$1")             // inline code
    .replace(/^\|.*\|$/gm, "")             // markdown table rows
    .replace(/^\s*[-|][-| :]+\s*$/gm, "")  // markdown table separators
    .replace(/https?:\/\/\S+/g, "")        // strip http/https URLs
    .replace(/(?<!\w)(www\.\S+)/g, "")     // strip www. URLs
    .replace(/(?<!\w)([a-z0-9-]+\.(org|com|io|xyz|fi|eth|app|dev|net)\S*)/gi, "") // strip bare domains
    .replace(/\n{2,}/g, "\n")              // collapse blank lines to one newline
    .replace(/[ \t]{2,}/g, " ")            // collapse horizontal whitespace only
    .trim()
    .slice(0, 1200);
}

// ─── Main export ─────────────────────────────────────────────────────────────
export async function analyzeQuestion(question) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const analyticsUrl = process.env.BASE_ANALYTICS_MCP_URL;
  if (!analyticsUrl) throw new Error("BASE_ANALYTICS_MCP_URL env var is required");

  // Parallel: load both MCP servers + search docs
  const [analyticsResult, baseMcpResult, docChunks] = await Promise.all([
    connectMcp(analyticsUrl, "analytics"),
    process.env.BASE_MCP_URL
      ? connectMcp(process.env.BASE_MCP_URL, "base")
      : Promise.resolve({ mcp: null, tools: [] }),
    searchDocs(question, 5).catch((err) => {
      console.warn(`[docs] ${err.message}`);
      return [];
    }),
  ]);

  // Build unified tool registry (analytics tools take priority on name collision)
  const toolRegistry = new Map();
  const claudeTools = [];

  for (const { mcp, tools } of [analyticsResult, baseMcpResult]) {
    if (!mcp) continue;
    for (const t of tools) {
      if (toolRegistry.has(t.name)) continue;
      toolRegistry.set(t.name, mcp);
      claudeTools.push({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.inputSchema ?? { type: "object", properties: {} },
      });
    }
  }

  // Inject doc context into the user message
  const docContext = formatDocContext(docChunks);
  const userMessage = docContext
    ? `[Documentation context — ground your answer in this]\n${docContext}\n\n[Question]\n${question}`
    : question;

  const messages = [{ role: "user", content: userMessage }];

  for (let i = 0; i < 12; i++) {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
      ...(claudeTools.length > 0 && { tools: claudeTools }),
    });

    if (response.stop_reason === "end_turn") {
      const text = response.content.find((b) => b.type === "text");
      if (!text) throw new Error("Claude returned no text");
      return cleanTweet(text.text);
    }

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });

      const results = await Promise.all(
        response.content
          .filter((b) => b.type === "tool_use")
          .map(async (block) => {
            console.log(`[tool] ${block.name}(${JSON.stringify(block.input)})`);
            const mcpClient = toolRegistry.get(block.name);
            let content;
            try {
              if (!mcpClient) throw new Error(`No client for tool ${block.name}`);
              const raw = await mcpClient.callTool(block.name, block.input);
              content = raw?.content?.[0]?.text ?? JSON.stringify(raw, null, 2);
            } catch (err) {
              content = `Error: ${err.message}`;
            }
            return { type: "tool_result", tool_use_id: block.id, content };
          })
      );

      messages.push({ role: "user", content: results });
      continue;
    }

    // max_tokens or unexpected stop
    const text = response.content.find((b) => b.type === "text");
    if (text) return cleanTweet(text.text);
    break;
  }

  throw new Error("Analysis loop ended without a response");
}
