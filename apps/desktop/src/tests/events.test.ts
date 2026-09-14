// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_CLOSE_CODE, backoffDelay, EventStream, freshEvents, type MinimalSocket, type ServerEvent } from '../lib/events';

function event(id: number, kind = 'submission.created'): ServerEvent {
  return { id, project_id: 1, kind, payload: {}, created_at: '2026-09-13T00:00:00Z' };
}

class FakeSocket implements MinimalSocket {
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;

  close(): void {
    this.closed = true;
  }

  emit(message: ServerEvent): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  closeWith(code: number): void {
    this.onclose?.({ code });
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('事件流去重与退避', () => {
  it('freshEvents 丢弃已见过的 id 并保持按 id 升序', () => {
    const incoming = [event(5), event(3), event(5), event(9)];
    expect(freshEvents(incoming, 4).map((e) => e.id)).toEqual([5, 9]);
  });

  it('freshEvents 忽略没有 id 的畸形事件', () => {
    const malformed = [{ project_id: 1, kind: 'x', payload: null, created_at: '' } as unknown as ServerEvent];
    expect(freshEvents(malformed, 0)).toEqual([]);
  });

  it('退避按指数增长并在上限封顶', () => {
    expect(backoffDelay(0, 1000, 30000)).toBe(1000);
    expect(backoffDelay(1, 1000, 30000)).toBe(2000);
    expect(backoffDelay(3, 1000, 30000)).toBe(8000);
    expect(backoffDelay(20, 1000, 30000)).toBe(30000);
  });
});

describe('EventStream', () => {
  function fetchReturning(batches: ServerEvent[][]) {
    let call = 0;
    const calls: string[] = [];
    const impl = (async (url: string) => {
      calls.push(String(url));
      const body = batches[Math.min(call, batches.length - 1)] ?? [];
      call += 1;
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('回填 GET /events?after=<last id> 并只投递一次', async () => {
    const seen: ServerEvent[] = [];
    const { impl, calls } = fetchReturning([[event(1), event(2)]]);
    const socket = new FakeSocket();
    const stream = new EventStream({
      baseUrl: 'http://127.0.0.1:8000',
      token: 't',
      onChange: (events) => seen.push(...events),
      onAuthExpired: () => undefined,
      fetchImpl: impl,
      socketFactory: () => socket,
      pollMs: 60_000,
    });

    stream.start();
    await vi.waitFor(() => expect(seen.map((e) => e.id)).toEqual([1, 2]));
    expect(calls[0]).toContain('/events?after=0');
    expect(stream.lastEventId).toBe(2);

    // The socket replays an event the poll already delivered: it must not be shown twice.
    socket.emit(event(2));
    socket.emit(event(3));
    await vi.waitFor(() => expect(seen.map((e) => e.id)).toEqual([1, 2, 3]));
    stream.stop();
  });

  it('token 失效（4401）时通知调用方并停止重连', async () => {
    vi.useFakeTimers();
    const { impl } = fetchReturning([[]]);
    const sockets: FakeSocket[] = [];
    const expired = vi.fn();
    const stream = new EventStream({
      baseUrl: 'http://127.0.0.1:8000',
      token: 't',
      onChange: () => undefined,
      onAuthExpired: expired,
      fetchImpl: impl,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      pollMs: 60_000,
      backoffBaseMs: 10,
    });

    stream.start();
    sockets[0].closeWith(AUTH_CLOSE_CODE);
    await vi.advanceTimersByTimeAsync(1000);

    expect(expired).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
  });

  it('普通断开后按退避重连', async () => {
    vi.useFakeTimers();
    const { impl } = fetchReturning([[]]);
    const sockets: FakeSocket[] = [];
    const stream = new EventStream({
      baseUrl: 'http://127.0.0.1:8000',
      token: 't',
      onChange: () => undefined,
      onAuthExpired: () => undefined,
      fetchImpl: impl,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      pollMs: 60_000,
      backoffBaseMs: 100,
      backoffCapMs: 400,
    });

    stream.start();
    // Let the first poll settle first: a successful poll resets the backoff counter.
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].closeWith(1006);
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(2);

    sockets[1].closeWith(1006);
    await vi.advanceTimersByTimeAsync(199);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
  });

  it('stop() 之后不再轮询', async () => {
    vi.useFakeTimers();
    const { impl, calls } = fetchReturning([[]]);
    const stream = new EventStream({
      baseUrl: 'http://127.0.0.1:8000',
      token: 't',
      onChange: () => undefined,
      onAuthExpired: () => undefined,
      fetchImpl: impl,
      socketFactory: () => new FakeSocket(),
      pollMs: 1000,
    });

    stream.start();
    await vi.advanceTimersByTimeAsync(0);
    const afterStart = calls.length;
    stream.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.length).toBe(afterStart);
  });
});
