const BASE_URL = 'https://api.dexscreener.com';

export interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative: string;
  priceUsd?: string;
  txns: {
    m5?: { buys: number; sells: number };
    h1?: { buys: number; sells: number };
    h24?: { buys: number; sells: number };
  };
  volume: {
    m5?: number; h1?: number; h6?: number; h24?: number;
  };
  liquidity?: {
    usd?: number; base?: number; quote?: number;
  };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

async function dexFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      console.error(`[dex] ${res.status} ${path}`);
      return null;
    }
    return res.json() as Promise<T>;
  } catch (err) {
    console.error(`[dex] fetch error ${path}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// All pairs for a token on Base, sorted by liquidity desc
export async function getTokenPairs(tokenAddress: string): Promise<DexPair[]> {
  const data = await dexFetch<{ pairs: DexPair[] | null }>(
    `/latest/dex/tokens/${tokenAddress}`,
  );
  return (data?.pairs ?? [])
    .filter(p => p.chainId === 'base')
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
}

export async function searchBasePairs(query: string): Promise<DexPair[]> {
  const data = await dexFetch<{ pairs: DexPair[] | null }>(
    `/latest/dex/search?q=${encodeURIComponent(query)}`,
  );
  return (data?.pairs ?? []).filter(p => p.chainId === 'base');
}
