import type { BlockscoutTransfer } from '../types.js';

const BASE_URL = 'https://base.blockscout.com/api/v2';

async function blockscoutFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch {
    return null;
  }
}

// Returns the most recent ERC-20 token transfers for a given address
export async function getRecentTokenTransfers(
  address: string,
  limit = 50,
): Promise<BlockscoutTransfer[]> {
  const data = await blockscoutFetch<{ items: BlockscoutTransfer[] }>(
    `/addresses/${address}/token-transfers?filter=to|from&type=ERC-20&limit=${limit}`,
  );
  return data?.items ?? [];
}
