import { config } from './config.js';
import { RpcWs } from './realtime/ws.js';
import { startTokenStream } from './realtime/token-stream.js';
import { startWalletStream } from './realtime/wallet-stream.js';

// Alchemy Base RPC: https → wss
const wssUrl = config.baseRpcUrl.replace(/^https?:\/\//, 'wss://');

console.log('[alert-service] Real-time degen alert service | Base');
console.log(`[alert-service] DRY_RUN       = ${config.dryRun}`);
console.log(`[alert-service] New token liq = $${config.newTokenLiquidityMin.toLocaleString()}`);
console.log(`[alert-service] New token buy = $${config.newTokenBuyThreshold.toLocaleString()} / 1h`);
console.log(`[alert-service] WebSocket     = ${wssUrl.replace(/\/v2\/.+/, '/v2/***')}`);

const ws = new RpcWs(wssUrl);
ws.start();

startWalletStream(ws).catch(err =>
  console.error('[alert-service] Wallet stream error:', err instanceof Error ? err.message : err),
);
startTokenStream(ws);

process.on('uncaughtException', err => {
  console.error('[alert-service] Uncaught exception:', err.message);
});
process.on('unhandledRejection', reason => {
  console.error('[alert-service] Unhandled rejection:', reason);
});
