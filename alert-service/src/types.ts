export type TradeKind = 'buy' | 'sell';

export interface GeckoPool {
  id: string;
  attributes: {
    name: string;
    address: string;
    pool_created_at: string | null;
    base_token_price_usd: string;
    fdv_usd: string | null;
    market_cap_usd: string | null;
    reserve_in_usd: string;
    price_change_percentage: {
      m5?: string; h1?: string; h6?: string; h24?: string;
    };
    transactions: {
      m5?: { buys: number; sells: number; buyers: number; sellers: number };
      h1?: { buys: number; sells: number; buyers: number; sellers: number };
      h6?: { buys: number; sells: number; buyers: number; sellers: number };
      h24?: { buys: number; sells: number; buyers: number; sellers: number };
    };
    volume_usd: {
      m5?: string; h1?: string; h6?: string; h24?: string;
    };
  };
  relationships?: {
    base_token?: { data: { id: string; type: string } };
    quote_token?: { data: { id: string; type: string } };
    dex?: { data: { id: string } };
  };
}

export interface GeckoTrade {
  id: string;
  attributes: {
    block_number: number;
    tx_hash: string;
    tx_from_address: string;
    from_token_amount: string;
    to_token_amount: string;
    price_from_in_usd: string;
    price_to_in_usd: string;
    kind: TradeKind;
    volume_in_usd: string;
    block_timestamp: string;
  };
}

export interface GeckoTokenIncluded {
  id: string;
  type: string;
  attributes: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    image_url?: string | null;
    coingecko_coin_id?: string | null;
  };
}

export interface BlockscoutTransfer {
  tx_hash: string;
  block_number: number;
  timestamp: string;
  from: { hash: string };
  to: { hash: string };
  token: {
    address: string;
    name: string;
    symbol: string;
    decimals: string;
    type: string;
  };
  total: { value: string; decimals: string };
  type: string;
}
