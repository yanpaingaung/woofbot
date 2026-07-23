import type { GeckoPool, GeckoTokenIncluded } from '../types.js';

const BASE_URL = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'base';
const HEADERS = { Accept: 'application/json;version=20230302' };

async function geckoFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, { headers: HEADERS });
    if (!res.ok) {
      console.error(`[gecko] ${res.status} ${path}`);
      return null;
    }
    return res.json() as Promise<T>;
  } catch (err) {
    console.error(`[gecko] fetch error ${path}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function getNewPools(page = 1): Promise<{
  pools: GeckoPool[];
  included: GeckoTokenIncluded[];
}> {
  const data = await geckoFetch<{ data: GeckoPool[]; included?: GeckoTokenIncluded[] }>(
    `/networks/${NETWORK}/new_pools?page=${page}&include=base_token,quote_token,dex`,
  );
  return { pools: data?.data ?? [], included: data?.included ?? [] };
}

// Extract base-chain token address from a GeckoTerminal relationship ID ("base_0x...")
export function extractTokenAddress(geckoId: string): string {
  const idx = geckoId.indexOf('_');
  return idx === -1 ? geckoId : geckoId.slice(idx + 1);
}
