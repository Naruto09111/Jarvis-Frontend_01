import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Backend URL configuration, connection classification, model parsing and chat
// request behaviour. Runs under node (no jsdom): localStorage/fetch are stubbed.

const SETTINGS_KEY = 'openjarvis-settings';
const fetchMock = vi.fn<typeof fetch>();

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, String(v));
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

const ls = () => (globalThis as unknown as { localStorage: MemoryStorage }).localStorage;
const save = (o: Record<string, unknown>) => ls().setItem(SETTINGS_KEY, JSON.stringify(o));

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key');
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
  (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('normalizeBackendUrl', () => {
  it('strips trailing slashes and /v1', async () => {
    const { normalizeBackendUrl } = await import('./api');
    for (const input of [
      'https://a.trycloudflare.com',
      'https://a.trycloudflare.com/',
      'https://a.trycloudflare.com/v1',
      'https://a.trycloudflare.com/v1/',
      '  https://a.trycloudflare.com//  ',
    ]) {
      expect(normalizeBackendUrl(input)).toEqual({ ok: true, url: 'https://a.trycloudflare.com' });
    }
  });
  it('treats empty as "not configured"', async () => {
    const { normalizeBackendUrl } = await import('./api');
    expect(normalizeBackendUrl('  ')).toEqual({ ok: true, url: '' });
  });
  it('rejects bad input with a reason', async () => {
    const { normalizeBackendUrl } = await import('./api');
    for (const bad of ['localhost:8000', 'ftp://x.com', 'https://u:p@x.com', 'https://x.com/?a=1', 'https://x.com/#h', 'http://']) {
      const r = normalizeBackendUrl(bad);
      expect(r.ok).toBe(false);
    }
  });
});

describe('resolveBackendConfig (URL precedence)', () => {
  it('reads VITE_API_BASE_URL (the variable name used on Vercel)', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://new.trycloudflare.com/');
    const { getBase, resolveBackendConfig } = await import('./api');
    expect(getBase()).toBe('https://new.trycloudflare.com');
    expect(resolveBackendConfig().source).toBe('env');
  });
  it('still honours the legacy VITE_API_URL', async () => {
    vi.stubEnv('VITE_API_URL', 'https://legacy.example.com');
    const { getBase } = await import('./api');
    expect(getBase()).toBe('https://legacy.example.com');
  });
  it('a stale saved URL does NOT override a changed build URL, but is kept and reported', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://new.trycloudflare.com');
    save({ apiUrl: 'https://old.trycloudflare.com', apiUrlEnv: 'https://older.trycloudflare.com' });
    const { getBase, resolveBackendConfig } = await import('./api');
    const cfg = resolveBackendConfig();
    expect(getBase()).toBe('https://new.trycloudflare.com');
    expect(cfg.ignoredReason).toBe('stale');
    expect(cfg.ignoredSavedUrl).toBe('https://old.trycloudflare.com');
    expect(JSON.parse(ls().getItem(SETTINGS_KEY) as string).apiUrl).toBe('https://old.trycloudflare.com');
  });
  it('a legacy saved URL (no recorded build URL) is stale once a build URL exists', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://new.trycloudflare.com');
    save({ apiUrl: 'https://old.trycloudflare.com' });
    const { getBase } = await import('./api');
    expect(getBase()).toBe('https://new.trycloudflare.com');
  });
  it('a saved URL made against the current build URL is an intentional override', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://env.trycloudflare.com');
    save({ apiUrl: 'https://mine.example.com', apiUrlEnv: 'https://env.trycloudflare.com' });
    const { getBase, resolveBackendConfig } = await import('./api');
    expect(getBase()).toBe('https://mine.example.com');
    expect(resolveBackendConfig().source).toBe('settings');
  });
  it('saved URL works when there is no build URL', async () => {
    save({ apiUrl: 'https://mine.example.com/v1/' });
    const { getBase } = await import('./api');
    expect(getBase()).toBe('https://mine.example.com');
  });
  it('an invalid saved URL is ignored and reported', async () => {
    save({ apiUrl: 'localhost:8000' });
    const { getBase, resolveBackendConfig } = await import('./api');
    expect(getBase()).toBe('');
    expect(resolveBackendConfig().ignoredReason).toBe('invalid');
  });
});

describe('API key handling', () => {
  it('empty key sends no Authorization header', async () => {
    save({ apiUrl: 'https://x.example.com', apiKey: '' });
    const { authHeaders } = await import('./api');
    expect('Authorization' in authHeaders()).toBe(false);
  });
  it('key is trimmed and sent as Bearer', async () => {
    save({ apiKey: '  sk-test \n' });
    const { authHeaders } = await import('./api');
    expect(authHeaders().Authorization).toBe('Bearer sk-test');
  });
});

describe('parseModelList', () => {
  it('parses the OpenAI-style list', async () => {
    const { parseModelList } = await import('./api');
    const r = parseModelList({ object: 'list', data: [{ id: 'a', object: 'model', created: 1, owned_by: 'x' }] });
    expect(r.map((m) => m.id)).toEqual(['a']);
  });
  it('empty list stays empty (no fake models)', async () => {
    const { parseModelList } = await import('./api');
    expect(parseModelList({ object: 'list', data: [] })).toEqual([]);
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList({})).toEqual([]);
  });
  it('accepts string arrays and drops entries without an id', async () => {
    const { parseModelList } = await import('./api');
    expect(parseModelList(['m1', '', { nope: 1 }, { id: 'm2' }]).map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});

describe('testBackendConnection', () => {
  const routes = (
    map: Record<string, () => Response | Promise<Response>>,
  ) =>
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      if (map[path]) return map[path]();
      return json({ detail: 'not found' }, 404);
    });

  it('OK only when health, auth and models all work', async () => {
    routes({
      '/health': () => json({ status: 'ok' }),
      '/v1/info': () => json({ model: '01-ai/yi-large', agent: 'orchestrator', engine: 'multi' }),
      '/v1/models': () => json({ object: 'list', data: [{ id: '01-ai/yi-large', object: 'model', created: 0, owned_by: 'openjarvis' }] }),
    });
    const { testBackendConnection } = await import('./api');
    const r = await testBackendConnection('https://x.trycloudflare.com/v1/', '');
    expect(r.ok).toBe(true);
    expect(r.models).toEqual(['01-ai/yi-large']);
    expect(r.url).toBe('https://x.trycloudflare.com');
  });
  it('the real failure: healthy backend but EMPTY /v1/models is NOT green', async () => {
    routes({
      '/health': () => json({ status: 'ok' }),
      '/v1/info': () => json({ model: '01-ai/yi-large', agent: 'orchestrator', engine: 'multi' }),
      '/v1/models': () => json({ object: 'list', data: [] }),
    });
    const { testBackendConnection } = await import('./api');
    const r = await testBackendConnection('https://x.trycloudflare.com', '');
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('no-models');
    expect(r.message).toContain('01-ai/yi-large');
  });
  it('detects CORS (cannot read response, but server reachable via no-cors)', async () => {
    fetchMock.mockImplementation(async (_u, init) => {
      if ((init as RequestInit | undefined)?.mode === 'no-cors') return new Response(null);
      throw new TypeError('Failed to fetch');
    });
    const { testBackendConnection } = await import('./api');
    const r = await testBackendConnection('https://x.trycloudflare.com', '');
    expect(r.stage).toBe('cors');
    expect(r.message).toContain('OPENJARVIS_CORS_ORIGINS');
  });
  it('detects an unreachable backend / changed tunnel URL', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { testBackendConnection } = await import('./api');
    const r = await testBackendConnection('https://x.trycloudflare.com', '');
    expect(r.stage).toBe('unreachable');
  });
  it('detects a Cloudflare tunnel with nothing behind it (530)', async () => {
    routes({ '/health': () => new Response('error code: 1033', { status: 530, headers: { server: 'cloudflare' } }) });
    const { testBackendConnection } = await import('./api');
    const r = await testBackendConnection('https://x.trycloudflare.com', '');
    expect(r.stage).toBe('tunnel');
  });
  it('does not call an HTML 200 a backend (SPA fallback / wrong site)', async () => {
    routes({ '/health': () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
    const { testBackendConnection } = await import('./api');
    const r = await testBackendConnection('https://frontend.vercel.app', '');
    expect(r.stage).toBe('not-openjarvis');
  });
  it('reports an auth failure without leaking the key', async () => {
    routes({ '/health': () => json({ status: 'ok' }), '/v1/info': () => json({ detail: 'Invalid API key' }, 401) });
    const { testBackendConnection } = await import('./api');
    const r = await testBackendConnection('https://x.trycloudflare.com', 'sk-secret-123');
    expect(r.stage).toBe('auth');
    expect(r.message).not.toContain('sk-secret-123');
  });
  it('sends the key to /v1/info and /v1/models only when set', async () => {
    const seen: Array<string | undefined> = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const h = (init as RequestInit | undefined)?.headers as Record<string, string> | undefined;
      if (url.endsWith('/v1/info') || url.endsWith('/v1/models')) seen.push(h?.Authorization);
      if (url.endsWith('/health')) return json({ status: 'ok' });
      if (url.endsWith('/v1/info')) return json({ model: 'm', engine: 'e' });
      return json({ data: [{ id: 'm' }] });
    });
    const { testBackendConnection } = await import('./api');
    await testBackendConnection('https://x.example.com', '');
    await testBackendConnection('https://x.example.com', 'k1');
    expect(seen).toEqual([undefined, undefined, 'Bearer k1', 'Bearer k1']);
  });
  it('rejects an invalid URL before any network call', async () => {
    const { testBackendConnection } = await import('./api');
    const r = await testBackendConnection('not a url', '');
    expect(r.stage).toBe('invalid-url');
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});

describe('checkConnection (no false-positive green)', () => {
  it('stays disconnected when the configured backend is down even if the page origin answers 200 HTML', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://dead.trycloudflare.com');
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('https://dead.trycloudflare.com')) throw new TypeError('Failed to fetch');
      return new Response('<html>spa</html>', { status: 200 });
    });
    const { checkConnection } = await import('./api');
    expect((await checkConnection()).reachable).toBe(false);
    for (const [u] of fetchMock.mock.calls) expect(String(u).startsWith('https://dead.trycloudflare.com')).toBe(true);
  });
  it('requires {"status":"ok"} JSON, not just HTTP 200', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://x.example.com');
    fetchMock.mockResolvedValue(new Response('<html></html>', { status: 200 }));
    const { checkConnection } = await import('./api');
    expect((await checkConnection()).reachable).toBe(false);
  });
});

describe('chat requests', () => {
  const sse = (...events: string[]) =>
    new Response(events.map((e) => `data: ${e}\n\n`).join('') + 'data: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

  it('posts the selected model to <base>/v1/chat/completions without an auth header when no key', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://x.example.com');
    fetchMock.mockResolvedValue(sse(JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })));
    const { streamChat } = await import('./sse');
    const out: string[] = [];
    for await (const ev of streamChat({ model: '01-ai/yi-large', messages: [{ role: 'user', content: 'yo' }], stream: true })) out.push(ev.data);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://x.example.com/v1/chat/completions');
    expect(JSON.parse(init.body as string).model).toBe('01-ai/yi-large');
    expect('Authorization' in (init.headers as Record<string, string>)).toBe(false);
    expect(out.length).toBe(1);
  });
  it('explains backend failures instead of "failed: 500"', async () => {
    const { describeChatFailure } = await import('./sse');
    expect(describeChatFailure(401, '{"detail":"Invalid API key"}', 'm')).toContain('API key');
    expect(describeChatFailure(404, '{"detail":"Model not found"}', 'm')).toContain('rejected the model "m"');
    expect(describeChatFailure(530, 'error code: 1033', 'm')).toContain('cloudflared');
    expect(describeChatFailure(500, '{"detail":"boom"}', 'm')).toContain('boom');
  });
  it('turns a network/CORS failure into an actionable message', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://x.example.com');
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { streamChat } = await import('./sse');
    let msg = '';
    try {
      for await (const _ of streamChat({ model: 'm', messages: [], stream: true })) void _;
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('Settings → Connection');
  });
});
