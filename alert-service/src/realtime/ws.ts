import { WebSocket } from 'ws';

type Handler = (data: unknown) => void;

interface Sub {
  filter: unknown;
  handler: Handler;
  subId: string | null;
}

// Persistent WebSocket connection to Alchemy Base RPC with auto-reconnect.
// All eth_subscribe subscriptions are automatically re-registered on reconnect.
export class RpcWs {
  private ws: WebSocket | null = null;
  private subs: Sub[] = [];
  private pendingMap = new Map<number, Sub>(); // msgId → sub waiting for confirmation
  private subIdMap = new Map<string, Sub>();   // subId → active sub
  private msgId = 1;

  constructor(private readonly wssUrl: string) {}

  start(): void {
    this.connect();
  }

  private connect(): void {
    console.log('[ws] Connecting to Base...');
    const ws = new WebSocket(this.wssUrl);
    this.ws = ws;

    ws.on('open', () => {
      console.log('[ws] Connected');
      for (const sub of this.subs) this.sendSub(sub);
    });

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          id?: number;
          result?: unknown;
          method?: string;
          params?: { subscription: string; result: unknown };
          error?: { message: string };
        };

        if (msg.error) {
          console.error('[ws] RPC error:', msg.error.message);
          return;
        }

        // eth_subscribe confirmation — result is the new subscription ID
        if (typeof msg.id === 'number' && typeof msg.result === 'string') {
          const sub = this.pendingMap.get(msg.id);
          if (sub) {
            sub.subId = msg.result;
            this.subIdMap.set(msg.result, sub);
            this.pendingMap.delete(msg.id);
          }
          return;
        }

        // Incoming event
        if (msg.method === 'eth_subscription' && msg.params) {
          this.subIdMap.get(msg.params.subscription)?.handler(msg.params.result);
        }
      } catch {
        // ignore malformed frames
      }
    });

    ws.on('close', () => {
      this.subIdMap.clear();
      for (const sub of this.subs) sub.subId = null;
      console.log('[ws] Disconnected — reconnecting in 5s');
      setTimeout(() => this.connect(), 5_000);
    });

    ws.on('error', (err: Error) => {
      console.error('[ws] Error:', err.message);
    });
  }

  subscribe(filter: unknown, handler: Handler): void {
    const sub: Sub = { filter, handler, subId: null };
    this.subs.push(sub);
    if (this.ws?.readyState === WebSocket.OPEN) this.sendSub(sub);
  }

  private sendSub(sub: Sub): void {
    const id = this.msgId++;
    this.pendingMap.set(id, sub);
    this.ws?.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'eth_subscribe',
      params: ['logs', sub.filter],
    }));
  }
}
