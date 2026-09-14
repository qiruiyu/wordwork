/**
 * Consume the server's `/events` feed.
 *
 * The feed exists so the client can notice "someone submitted" / "the round was
 * published" without polling every screen. Two transports are used together:
 *
 * - a WebSocket, which delivers the backlog immediately and tells us when the
 *   token has expired (the server closes with 4401 and never pushes afterwards),
 * - `GET /events?after=<last id>`, which is what actually discovers *new* events,
 *   because the server's socket loop only answers pings.
 *
 * Events are ordered and monotonic by id, so "have I seen this?" reduces to
 * `id > lastId` — that is the dedup, and it also makes a poll racing a socket
 * delivery harmless.
 */

export interface ServerEvent {
  id: number;
  project_id: number | null;
  kind: string;
  payload: unknown;
  created_at: string;
}

export interface MinimalSocket {
  close(): void;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
}

export type SocketFactory = (url: string) => MinimalSocket;

export interface EventStreamOptions {
  baseUrl: string;
  token: string;
  after?: number;
  onChange: (events: ServerEvent[]) => void;
  onAuthExpired: () => void;
  onStatus?: (online: boolean) => void;
  fetchImpl?: typeof fetch;
  socketFactory?: SocketFactory;
  pollMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

/** 4401 is the server's "your token is gone / you must change your password" close code. */
export const AUTH_CLOSE_CODE = 4401;

/** Keep only events we have not delivered yet, oldest first. */
export function freshEvents(events: ServerEvent[], lastId: number): ServerEvent[] {
  const seen = new Set<number>();
  const out: ServerEvent[] = [];
  for (const event of events) {
    if (!event || typeof event.id !== 'number' || event.id <= lastId || seen.has(event.id)) continue;
    seen.add(event.id);
    out.push(event);
  }
  return out.sort((a, b) => a.id - b.id);
}

export function backoffDelay(attempt: number, baseMs = 1000, capMs = 30000): number {
  const step = Math.max(0, attempt);
  return Math.min(capMs, baseMs * 2 ** step);
}

function defaultSocketFactory(url: string): MinimalSocket {
  return new WebSocket(url) as unknown as MinimalSocket;
}

export class EventStream {
  private readonly options: EventStreamOptions;
  private lastId: number;
  private stopped = true;
  private attempt = 0;
  private socket: MinimalSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;

  constructor(options: EventStreamOptions) {
    this.options = options;
    this.lastId = options.after ?? 0;
  }

  get lastEventId(): number {
    return this.lastId;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  /** Fetch everything newer than the last id we delivered. */
  async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const fetcher = this.options.fetchImpl ?? fetch;
      const response = await fetcher(`${this.options.baseUrl}/events?after=${this.lastId}`, {
        headers: this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {},
      });
      if (response.status === 401) {
        this.options.onAuthExpired();
        this.stop();
        return;
      }
      if (!response.ok) {
        this.options.onStatus?.(false);
        return;
      }
      const events = (await response.json()) as ServerEvent[];
      this.deliver(events);
      this.attempt = 0;
      this.options.onStatus?.(true);
    } catch {
      this.options.onStatus?.(false);
    } finally {
      this.polling = false;
      this.schedulePoll();
    }
  }

  private schedulePoll(): void {
    if (this.stopped) return;
    const interval = this.options.pollMs ?? 15000;
    this.timer = setTimeout(() => void this.poll(), interval);
  }

  private deliver(events: ServerEvent[]): void {
    const fresh = freshEvents(events, this.lastId);
    if (fresh.length === 0) return;
    this.lastId = fresh[fresh.length - 1].id;
    this.options.onChange(fresh);
  }

  private connect(): void {
    if (this.stopped) return;
    const factory = this.options.socketFactory ?? defaultSocketFactory;
    const wsBase = this.options.baseUrl.replace(/^http/, 'ws');
    let socket: MinimalSocket;
    try {
      socket = factory(
        `${wsBase}/events?token=${encodeURIComponent(this.options.token)}&after=${this.lastId}`,
      );
    } catch {
      this.reconnect();
      return;
    }
    this.socket = socket;
    socket.onmessage = (message) => {
      try {
        const parsed = JSON.parse(message.data) as ServerEvent | { type: string };
        if ('id' in parsed && typeof parsed.id === 'number') this.deliver([parsed]);
      } catch {
        /* a malformed frame must not kill the stream */
      }
    };
    socket.onclose = (event) => {
      this.socket = null;
      if (event?.code === AUTH_CLOSE_CODE) {
        this.options.onAuthExpired();
        this.stop();
        return;
      }
      this.reconnect();
    };
    socket.onerror = () => {
      /* `onclose` always follows, so reconnection is handled in one place */
    };
  }

  private reconnect(): void {
    if (this.stopped) return;
    const delay = backoffDelay(this.attempt++, this.options.backoffBaseMs, this.options.backoffCapMs);
    this.timer = setTimeout(() => this.connect(), delay);
  }
}
