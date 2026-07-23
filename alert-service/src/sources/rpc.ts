import { config } from '../config.js';

async function rpcCall<T>(method: string, params: unknown[] = []): Promise<T | null> {
  try {
    const res = await fetch(config.baseRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) return null;
    const json = await res.json() as { result?: T; error?: { message: string } };
    if (json.error) return null;
    return json.result ?? null;
  } catch {
    return null;
  }
}

export async function getLatestBlockNumber(): Promise<number> {
  const hex = await rpcCall<string>('eth_blockNumber');
  return hex ? parseInt(hex, 16) : 0;
}
