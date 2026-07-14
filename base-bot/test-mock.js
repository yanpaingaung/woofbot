/**
 * test-mock.js — test the full Claude+MCP analysis pipeline without hitting X at all.
 *
 * Usage:
 *   DRY_RUN=true BASE_ANALYTICS_MCP_URL=http://localhost:8788/mcp \
 *   ANTHROPIC_API_KEY=sk-... node test-mock.js
 *
 * Set BASE_ANALYTICS_MCP_URL to your deployed URL when testing against production.
 */

import { analyzeQuestion } from "./src/analyze.js";

// Addresses you can verify on basescan.org/base
const MOCK_MENTIONS = [
  {
    id: "mock-001",
    text: "should i buy 0xb200000000000000000000c22cf240b83e39e701",
  },
];

async function runMocks() {
  console.log("=== base-bot test-mock.js ===");
  console.log(`DRY_RUN=${process.env.DRY_RUN ?? "true"}`);
  console.log(`BASE_ANALYTICS_MCP_URL=${process.env.BASE_ANALYTICS_MCP_URL}`);
  console.log("");

  for (const mention of MOCK_MENTIONS) {
    console.log(`--- Mention ${mention.id} ---`);
    console.log(`Q: ${mention.text}`);

    try {
      const reply = await analyzeQuestion(mention.text);
      console.log(`A (${reply.length} chars): ${reply}`);
    } catch (err) {
      console.error(`ERROR: ${err.message}`);
    }

    console.log("");
  }
}

runMocks().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
