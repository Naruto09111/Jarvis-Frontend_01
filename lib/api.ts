import type { ModelInfo, SavingsData, ServerInfo } from '../types';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './supabase';
import { serializeToolCallArguments } from './tool-call';

// ---------------------------------------------------------------------------
// Supabase config
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauri = () => typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

export type CloudKeyStatus = Record<string, boolean>;

export async function getCloudKeyStatus(): Promise<CloudKeyStatus> {
  if (!isTauri()) return {};
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const rows = await invoke<Array<{ key: string; set: boolean }>>('get_cloud_key_status');
    return Object.fromEntries(rows.map((row) => [row.key, row.set]));
  } catch (e: any) {
    throw new Error(e?.message ?? e ?? 'Failed to read cloud key status');
  }
}

export async function saveCloudKey(keyName: string, keyValue: string): Promise<void> {
  if (!isTauri()) {
    throw new Error('Cloud API keys can be saved in the desktop app only.');
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('save_cloud_key', { keyName, keyValue });
  } catch (e: any) {
    throw new Error(e?.message ?? e ?? 'Failed to save cloud key');
  }
}

// Cached API base URL fetched from the Tauri backend at startup.
// This avoids hardcoding the port — the Rust backend is the single
// source of truth for JARVIS_PORT.
let _tauriApiBase: string | null = null;

/** Pre-fetch the API base URL from the Tauri backend (call once at init). */
export async function initApiBase(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    _tauriApiBase = await invoke<string>('get_api_base');
  } catch {
    // Command may not exist on older builds; fall through to default.
  }
}

const DESKTOP_API_FALLBACK = 'http://127.0.0.1:8000';

// ---------------------------------------------------------------------------
// Backend URL configuration
// ---------------------------------------------------------------------------

export type NormalizedUrl = { ok: true; url: string } | { ok: false; error: string };

/**
 * Validate and normalise a backend URL typed by a person or set at build time.
 * - '' is valid and means "same origin / not configured".
 * - Must be http(s); no credentials, query string or fragment.
 * - Trailing slashes and a trailing "/v1" are stripped (the client appends
 *   "/v1/..." itself), so "https://x.trycloudflare.com/v1/" equals
 *   "https://x.trycloudflare.com".
 */
export function normalizeBackendUrl(input: string): NormalizedUrl {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: true, url: '' };
  if (!/^https?:\/\//i.test(raw)) {
    return {
      ok: false,
      error: 'The URL must start with http:// or https:// (for example https://your-tunnel.trycloudflare.com).',
    };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'That is not a valid URL.' };
  }
  if (u.username || u.password) {
    return { ok: false, error: 'Do not put credentials in the URL. Use the API key field instead.' };
  }
  if (u.search || u.hash) {
    return { ok: false, error: 'Remove the query string or # fragment from the URL.' };
  }
  const path = u.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
  return { ok: true, url: `${u.origin}${path}` };
}

const readStoredSettings = (): Record<string, unknown> => {
  try {
    const raw = localStorage.getItem('openjarvis-settings');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    }
  } catch {
    /* unreadable settings are treated as empty */
  }
  return {};
};

/** Build-time backend URL (Vercel env): VITE_API_BASE_URL, or legacy VITE_API_URL. */
export const getEnvApiUrl = (): string => {
  const raw = (import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || '') as string;
  const n = normalizeBackendUrl(raw);
  return n.ok ? n.url : '';
};

export type ApiUrlSource = 'settings' | 'env' | 'desktop' | 'same-origin';

export interface BackendConfig {
  /** The URL requests are actually sent to ('' = same origin). */
  url: string;
  source: ApiUrlSource;
  /** Build-time URL, '' when none was configured. */
  envUrl: string;
  /** A URL saved in this browser that is NOT being used, and why. */
  ignoredSavedUrl: string;
  ignoredReason: '' | 'stale' | 'invalid';
}

/**
 * Decide which backend URL is active.
 *
 * A URL saved in the browser wins only while it is still "current": it records
 * the build-time URL that existed when it was saved (apiUrlEnv). If the
 * deployment's VITE_API_BASE_URL has since changed (e.g. a new Cloudflare
 * quick-tunnel URL), the saved URL is stale, the new build URL wins, and the
 * saved value is kept (not deleted) so the person can choose to use it again.
 */
export const resolveBackendConfig = (): BackendConfig => {
  const stored = readStoredSettings();
  const envUrl = getEnvApiUrl();
  const savedRaw = typeof stored.apiUrl === 'string' ? stored.apiUrl : '';
  const savedEnv = typeof stored.apiUrlEnv === 'string' ? stored.apiUrlEnv : '';
  const saved = normalizeBackendUrl(savedRaw);

  let ignoredSavedUrl = '';
  let ignoredReason: BackendConfig['ignoredReason'] = '';
  if (savedRaw.trim()) {
    if (!saved.ok || !saved.url) {
      ignoredSavedUrl = savedRaw.trim();
      ignoredReason = 'invalid';
    } else if (!envUrl || savedEnv === envUrl) {
      return { url: saved.url, source: 'settings', envUrl, ignoredSavedUrl: '', ignoredReason: '' };
    } else if (saved.url === envUrl) {
      return { url: envUrl, source: 'env', envUrl, ignoredSavedUrl: '', ignoredReason: '' };
    } else {
      ignoredSavedUrl = saved.url;
      ignoredReason = 'stale';
    }
  }
  if (envUrl) return { url: envUrl, source: 'env', envUrl, ignoredSavedUrl, ignoredReason };
  if (isTauri()) {
    return {
      url: _tauriApiBase || DESKTOP_API_FALLBACK,
      source: 'desktop',
      envUrl,
      ignoredSavedUrl,
      ignoredReason,
    };
  }
  return { url: '', source: 'same-origin', envUrl, ignoredSavedUrl, ignoredReason };
};

export const getBase = (): string => resolveBackendConfig().url;

// Resolve the local server API key (OPENJARVIS_API_KEY). When `jarvis serve`
// is started with a key, AuthMiddleware 401s every /v1 and /api request that
// lacks a Bearer token — so the frontend must send it (#266). Sourced from the
// same settings blob as the API URL, with an optional build-time env override.
// Returns '' when unset, so a keyless local server keeps working unchanged.
export const getApiKey = (): string => {
  try {
    const raw = localStorage.getItem('openjarvis-settings');
    if (raw) {
      const parsed = JSON.parse(raw);
      // Trim: a pasted key with a trailing space/newline would otherwise be
      // rejected by the server ("Invalid API key") or make fetch() throw on an
      // illegal header value.
      if (parsed.apiKey && String(parsed.apiKey).trim()) {
        return String(parsed.apiKey).trim();
      }
    }
  } catch {}
  if (import.meta.env.VITE_OPENJARVIS_API_KEY) {
    return import.meta.env.VITE_OPENJARVIS_API_KEY as string;
  }
  return '';
};

// Build request headers with the Bearer Authorization token when a local key
// is configured, merging any caller-supplied headers. Adds no Authorization
// header when no key is set, so keyless local dev is byte-for-byte unchanged.
export const authHeaders = (
  extra: Record<string, string> = {},
): Record<string, string> => {
  const key = getApiKey();
  return key ? { ...extra, Authorization: `Bearer ${key}` } : { ...extra };
};

// Centralized fetch for the local server: prepends getBase() and injects the
// Bearer auth header (when a key is set) on every call. Using this everywhere
// guarantees no /v1 or /api request is sent without auth — the bug in #266 was
// that direct fetch() calls omitted the header and 401'd. `path` is the
// server-relative path (e.g. "/v1/savings").
export const apiFetch = (
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  const headers = authHeaders(
    (init.headers as Record<string, string> | undefined) ?? {},
  );
  return fetch(`${getBase()}${path}`, { ...init, headers });
};

async function tauriInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  const apiUrl = getBase();
  return invoke<T>(command, { apiUrl, ...args });
}

// ---------------------------------------------------------------------------
// Setup status (desktop only)
// ---------------------------------------------------------------------------

export interface SetupStatus {
  phase: string;
  detail: string;
  ollama_ready: boolean;
  server_ready: boolean;
  model_ready: boolean;
  error: string | null;
  source: 'unconfigured' | 'ollama' | 'custom';
  requires_source: boolean;
}

export async function getSetupStatus(): Promise<SetupStatus | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<SetupStatus>('get_setup_status');
  } catch {
    return null;
  }
}

/** Start desktop services after an inference source has been persisted. */
export async function startBackend(): Promise<void> {
  if (!isTauri()) throw new Error('The desktop backend is available in the desktop app only.');
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke<void>('start_backend');
  } catch (e: any) {
    throw new Error(e?.message ?? e ?? 'Failed to start the desktop backend');
  }
}

/** Stop an in-flight setup and return the desktop to its inert source chooser. */
export async function resetInferenceSource(): Promise<void> {
  if (!isTauri()) throw new Error('Inference setup recovery is available in the desktop app only.');
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke<void>('reset_inference_source');
  } catch (e: any) {
    throw new Error(e?.message ?? e ?? 'Failed to reset inference setup');
  }
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function fetchModels(): Promise<ModelInfo[]> {
  if (isTauri()) {
    try {
      const result = await tauriInvoke<{ data?: ModelInfo[] }>('fetch_models');
      return parseModelList(result);
    } catch {
      // Fall through to fetch
    }
  }
  const res = await apiFetch(`/v1/models`);
  if (res.status === 401 || res.status === 403) {
    throw new Error('Authentication failed (HTTP ' + res.status + ') — check the API key in Settings.');
  }
  if (!res.ok) throw new Error(`Failed to fetch models: HTTP ${res.status}`);
  return parseModelList(await res.json());
}

export async function fetchRecommendedModel(): Promise<{ model: string; reason: string }> {
  const res = await apiFetch(`/v1/recommended-model`);
  if (!res.ok) return { model: '', reason: 'Failed to fetch' };
  return res.json();
}

export async function pullModel(modelName: string): Promise<void> {
  // In Tauri, go through the Rust backend directly (avoids CORS / timeout
  // issues with long model downloads via fetch).
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('pull_ollama_model', { modelName });
      return;
    } catch (e: any) {
      throw new Error(e?.message || e || 'Download failed');
    }
  }
  const res = await apiFetch(`/v1/models/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName }),
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('Authentication failed — check the API key in Settings.');
    }
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body?.detail === 'string' ? body.detail : JSON.stringify(body);
    } catch {
      /* keep statusText */
    }
    if (res.status === 501) {
      throw new Error(
        detail || 'This server cannot download models (it is not using the Ollama engine).',
      );
    }
    throw new Error(`Failed to pull model (HTTP ${res.status}): ${detail}`);
  }
}

export interface ModelPullSupport {
  /** True only when the connected backend can actually download models. */
  supported: boolean;
  /** Engine reported by the backend (/v1/info), '' when unknown. */
  engine: string;
  /** Set when support could not be determined (auth / connectivity). */
  error?: string;
}

/**
 * The backend's POST /v1/models/pull only works with the Ollama engine
 * (every other engine answers 501), so ask /v1/info which engine is active
 * before offering downloads. Remote API engines (e.g. OmniRoute) expose
 * models but cannot download them.
 */
export async function getModelPullSupport(): Promise<ModelPullSupport> {
  if (isTauri()) return { supported: true, engine: 'ollama' };
  try {
    const res = await apiFetch('/v1/info', { cache: 'no-store' });
    if (res.status === 401 || res.status === 403) {
      return { supported: false, engine: '', error: 'Authentication failed — check the API key in Settings.' };
    }
    if (!res.ok) {
      return { supported: false, engine: '', error: `Could not read server info (HTTP ${res.status}).` };
    }
    const info = await res.json();
    const engine = String(info?.engine || '');
    return { supported: engine === 'ollama', engine };
  } catch {
    return { supported: false, engine: '', error: 'Cannot reach the backend.' };
  }
}

export async function deleteModel(modelName: string): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('delete_ollama_model', { modelName });
      return;
    } catch (e: any) {
      throw new Error(e?.message || e || 'Delete failed');
    }
  }
  const res = await apiFetch(`/v1/models/${encodeURIComponent(modelName)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to delete model: ${detail}`);
  }
}

const _CLOUD_PREFIXES = ['gpt-', 'o1-', 'o3-', 'o4-', 'claude-', 'gemini-', 'openrouter/'];

export async function preloadModel(modelName: string, owner?: string): Promise<void> {
  // Cloud models don't need Ollama preloading
  if (owner === 'litellm' || _CLOUD_PREFIXES.some(p => modelName.startsWith(p))) {
    return;
  }
  // Trigger Ollama to load the model into memory (empty prompt, no generation).
  const ollamaUrl = 'http://127.0.0.1:11434';
  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, prompt: '', keep_alive: '5m' }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Preload failed: ${res.status}`);
  } catch (e: any) {
    if (e.name === 'TimeoutError') throw new Error('Model load timed out (120s)');
    throw e;
  }
}

export async function fetchSavings(): Promise<SavingsData> {
  const res = await apiFetch(`/v1/savings`);
  if (!res.ok) throw new Error(`Failed to fetch savings: ${res.status}`);
  return res.json();
}

export async function fetchServerInfo(): Promise<ServerInfo> {
  const res = await apiFetch(`/v1/info`);
  if (!res.ok) throw new Error(`Failed to fetch server info: ${res.status}`);
  return res.json();
}

export interface ConnectionStatus {
  /** The backend answered its health probe with {"status":"ok"}. */
  reachable: boolean;
  /** The backend is reachable but rejected the configured API key (401/403). */
  authFailed: boolean;
}

export async function checkConnection(): Promise<ConnectionStatus> {
  if (isTauri()) {
    try {
      await tauriInvoke('check_health', { apiUrl: getBase() });
      return { reachable: true, authFailed: false };
    } catch {
      return { reachable: false, authFailed: false };
    }
  }
  // Only the configured backend counts. When a URL is configured (settings or
  // build env) we never fall back to the page's own origin: a static host that
  // rewrites unknown paths to index.html answers "200 OK" for /health and would
  // produce a false "connected". Every probe must return {"status":"ok"} JSON.
  const base = getBase().replace(/\/+$/, '');
  let reachable = false;
  try {
    const res = await fetch(`${base}/health`, { cache: 'no-store' });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      reachable = body?.status === 'ok';
    }
  } catch {
    reachable = false;
  }
  if (!reachable) return { reachable: false, authFailed: false };
  // /health is exempt from auth, so it cannot tell whether the key is valid.
  // /v1/info is protected: 401/403 means the configured key is missing/wrong.
  let authFailed = false;
  try {
    const res = await apiFetch('/v1/info', { cache: 'no-store' });
    authFailed = res.status === 401 || res.status === 403;
  } catch {
    /* a network error here does not prove an auth problem */
  }
  return { reachable: true, authFailed };
}

export async function checkHealth(): Promise<boolean> {
  return (await checkConnection()).reachable;
}

// ---------------------------------------------------------------------------
// Detailed connection test (used by Settings → Connection)
// ---------------------------------------------------------------------------

export type BackendTestStage =
  | 'ok'
  | 'invalid-url'
  | 'unreachable'
  | 'cors'
  | 'tunnel'
  | 'not-openjarvis'
  | 'server'
  | 'auth'
  | 'models-error'
  | 'no-models';

export interface BackendTestResult {
  /** True only when health, auth AND model discovery all work. */
  ok: boolean;
  stage: BackendTestStage;
  /** Human-readable explanation. Never contains the API key. */
  message: string;
  url: string;
  status?: number;
  engine?: string;
  defaultModel?: string;
  models: string[];
}

/** Parse the OpenAI-style model list ({object:'list', data:[{id}]}) defensively. */
export function parseModelList(data: unknown): ModelInfo[] {
  const d = data as { data?: unknown; models?: unknown } | null;
  const arr: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray(d?.data)
      ? (d!.data as unknown[])
      : Array.isArray(d?.models)
        ? (d!.models as unknown[])
        : [];
  const out: ModelInfo[] = [];
  for (const item of arr) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ id: item.trim(), object: 'model', created: 0, owned_by: '' });
    } else if (item && typeof item === 'object') {
      const m = item as Partial<ModelInfo>;
      if (typeof m.id === 'string' && m.id.trim()) {
        out.push({
          id: m.id,
          object: m.object ?? 'model',
          created: m.created ?? 0,
          owned_by: m.owned_by ?? '',
        });
      }
    }
  }
  return out;
}

const isLoopbackHost = (host: string): boolean =>
  host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

export async function testBackendConnection(
  rawUrl: string,
  apiKey: string,
): Promise<BackendTestResult> {
  const fail = (
    stage: BackendTestStage,
    message: string,
    extra: Partial<BackendTestResult> = {},
  ): BackendTestResult => ({ ok: false, stage, message, url: extra.url ?? '', models: [], ...extra });

  const n = normalizeBackendUrl(rawUrl);
  if (!n.ok) return fail('invalid-url', n.error);
  const base = n.url;
  const key = (apiKey || '').trim();
  const pageOrigin = typeof location !== 'undefined' ? location.origin : '';

  if (base && typeof location !== 'undefined' && location.protocol === 'https:') {
    const u = new URL(base);
    if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) {
      return fail(
        'invalid-url',
        'This page is served over HTTPS, so the browser blocks calls to an http:// backend (mixed content). Use the backend\'s https:// URL (for example the Cloudflare tunnel URL).',
        { url: base },
      );
    }
  }

  // 1. Health (open endpoint, simple request: no preflight).
  let health: Response;
  try {
    health = await fetch(`${base}/health`, { cache: 'no-store' });
  } catch {
    // A TypeError cannot say why. A no-cors request succeeds when the server
    // is reachable but did not send CORS headers, which separates "CORS" from
    // "cannot connect".
    try {
      await fetch(`${base}/health`, { mode: 'no-cors', cache: 'no-store' });
      return fail(
        'cors',
        `The backend answered, but the browser blocked the response (CORS). On the backend, set OPENJARVIS_CORS_ORIGINS to include ${pageOrigin || 'this site\'s origin'} and restart "jarvis serve".`,
        { url: base },
      );
    } catch {
      return fail(
        'unreachable',
        'Could not connect to the backend. The server or tunnel may be stopped, the URL may have changed (Cloudflare quick-tunnel URLs change on every restart), or there is no internet connection.',
        { url: base },
      );
    }
  }

  const viaCloudflare = (health.headers.get('server') || '').toLowerCase() === 'cloudflare';
  if (!health.ok) {
    if (health.status === 530 || (viaCloudflare && health.status >= 502)) {
      return fail(
        'tunnel',
        `Cloudflare answered (HTTP ${health.status}) but nothing is reachable behind the tunnel. Make sure "jarvis serve" and cloudflared are both running, then copy the CURRENT tunnel URL (it changes each time the tunnel restarts).`,
        { url: base, status: health.status },
      );
    }
    return fail('server', `The backend returned HTTP ${health.status} for /health.`, {
      url: base,
      status: health.status,
    });
  }
  const healthBody = await health.json().catch(() => null);
  if (healthBody?.status !== 'ok') {
    return fail(
      'not-openjarvis',
      'This URL responded, but /health did not return {"status":"ok"}, so it does not look like an OpenJarvis backend (it may be the frontend itself or another site).',
      { url: base },
    );
  }

  // 2. Authenticated info (also exercises the CORS preflight for the Authorization header).
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  let infoRes: Response;
  try {
    infoRes = await fetch(`${base}/v1/info`, { headers, cache: 'no-store' });
  } catch {
    return fail(
      'cors',
      key
        ? `/health works but a request carrying the Authorization header was blocked (CORS preflight). Make sure ${pageOrigin || 'this site\'s origin'} is listed in OPENJARVIS_CORS_ORIGINS on the backend.`
        : 'The connection dropped while reading /v1/info. Try again; if it persists, restart the tunnel.',
      { url: base },
    );
  }
  if (infoRes.status === 401 || infoRes.status === 403) {
    return fail(
      'auth',
      key
        ? 'The backend rejected the API key. Check OPENJARVIS_API_KEY on the backend.'
        : 'The backend requires an API key (OPENJARVIS_API_KEY is set) but none is configured here.',
      { url: base, status: infoRes.status },
    );
  }
  if (!infoRes.ok) {
    return fail('server', `The backend returned HTTP ${infoRes.status} for /v1/info.`, {
      url: base,
      status: infoRes.status,
    });
  }
  const info = (await infoRes.json().catch(() => ({}))) as {
    engine?: string;
    model?: string;
  };

  // 3. Model discovery.
  let modelsRes: Response;
  try {
    modelsRes = await fetch(`${base}/v1/models`, { headers, cache: 'no-store' });
  } catch {
    return fail('models-error', 'Could not read /v1/models (connection error).', { url: base });
  }
  if (!modelsRes.ok) {
    return fail('models-error', `GET /v1/models returned HTTP ${modelsRes.status}.`, {
      url: base,
      status: modelsRes.status,
      engine: info.engine,
      defaultModel: info.model,
    });
  }
  const models = parseModelList(await modelsRes.json().catch(() => null)).map((m) => m.id);
  if (models.length === 0) {
    return fail(
      'no-models',
      `The backend is up (engine "${info.engine ?? 'unknown'}", default model "${info.model ?? 'unknown'}") but GET /v1/models returned an empty list, so there is nothing to chat with. This is a backend model-discovery problem, not a frontend setting.`,
      { url: base, engine: info.engine, defaultModel: info.model },
    );
  }
  return {
    ok: true,
    stage: 'ok',
    message: `Connected: engine "${info.engine ?? 'unknown'}", ${models.length} model${models.length === 1 ? '' : 's'} available.`,
    url: base,
    engine: info.engine,
    defaultModel: info.model,
    models,
  };
}

export async function fetchEnergy(): Promise<unknown> {
  if (isTauri()) {
    try {
      return await tauriInvoke('fetch_energy', { apiUrl: getBase() });
    } catch {}
  }
  const res = await apiFetch(`/v1/telemetry/energy`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function fetchTelemetry(): Promise<unknown> {
  if (isTauri()) {
    try {
      return await tauriInvoke('fetch_telemetry', { apiUrl: getBase() });
    } catch {}
  }
  const res = await apiFetch(`/v1/telemetry/stats`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function fetchTraces(limit: number = 50): Promise<unknown> {
  if (isTauri()) {
    try {
      return await tauriInvoke('fetch_traces', { apiUrl: getBase(), limit });
    } catch {}
  }
  const res = await apiFetch(`/v1/traces?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------

export interface TranscriptionResult {
  text: string;
  language: string | null;
  confidence: number | null;
  duration_seconds: number;
}

export interface SpeechHealth {
  available: boolean;
  backend?: string;
  reason?: string;
}

export async function transcribeAudio(audioBlob: Blob, filename = 'recording.webm'): Promise<TranscriptionResult> {
  if (isTauri()) {
    try {
      const buffer = await audioBlob.arrayBuffer();
      return await tauriInvoke<TranscriptionResult>('transcribe_audio', {
        audioData: Array.from(new Uint8Array(buffer)),
        filename,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(msg || 'Transcription failed');
    }
  }
  const formData = new FormData();
  formData.append('file', audioBlob, filename);
  const res = await apiFetch(`/v1/speech/transcribe`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = typeof body.detail === 'string' ? body.detail : "";
    } catch {
      // Keep the status-only message below when the body is not JSON.
    }
    throw new Error(detail || `Transcription failed: ${res.status}`);
  }
  return res.json();
}

export interface TtsHealth {
  available: boolean;
  backend?: string;
  voice_id?: string;
  speed?: number;
  reason?: string;
}

export async function synthesizeSpeech(
  text: string,
  opts: { voiceId?: string; speed?: number; signal?: AbortSignal } = {},
): Promise<Blob> {
  const res = await apiFetch(`/v1/speech/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: opts.voiceId, speed: opts.speed }),
    signal: opts.signal,
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = typeof body.detail === 'string' ? body.detail : '';
    } catch {
      // Keep the status-only message below when the body is not JSON.
    }
    throw new Error(detail || `Speech synthesis failed: ${res.status}`);
  }
  return res.blob();
}

export async function fetchTtsHealth(): Promise<TtsHealth> {
  const res = await apiFetch(`/v1/speech/tts/health`);
  if (!res.ok) return { available: false };
  return res.json();
}

export async function fetchSpeechHealth(): Promise<SpeechHealth> {
  if (isTauri()) {
    try {
      return await tauriInvoke<SpeechHealth>('speech_health');
    } catch {
      return { available: false };
    }
  }
  const res = await apiFetch(`/v1/speech/health`);
  if (!res.ok) return { available: false };
  return res.json();
}

// ---------------------------------------------------------------------------
// Agent Manager
// ---------------------------------------------------------------------------

export interface ManagedAgentConfig extends Record<string, unknown> {
  schedule_type?: string;
  schedule_value?: string | number;
}

export interface ManagedAgent {
  id: string;
  name: string;
  agent_type: string;
  config: ManagedAgentConfig;
  status: 'idle' | 'running' | 'paused' | 'error' | 'archived' | 'needs_attention' | 'budget_exceeded' | 'stalled';
  summary_memory: string;
  created_at: number;
  updated_at: number;
  // Runtime stats
  total_runs?: number;
  total_cost?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  last_run_at?: number | null;
  // Budget
  budget?: number;
  // Learning
  learning_enabled?: boolean;
  // Live progress
  current_activity?: string;
}

export interface AgentTask {
  id: string;
  agent_id: string;
  description: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  progress: Record<string, unknown>;
  findings: unknown[];
  created_at: number;
}

export interface ChannelBinding {
  id: string;
  agent_id: string;
  channel_type: string;
  config: Record<string, unknown>;
  session_id: string;
  routing_mode: string;
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  source: 'built-in' | 'user';
  agent_type: string;
  [key: string]: unknown;
}

export interface PersistedToolCall {
  tool: string;
  arguments: string;
  result?: string;
  success?: boolean;
  latency?: number;
}

export interface AgentMessage {
  id: string;
  agent_id: string;
  direction: 'user_to_agent' | 'agent_to_user';
  content: string;
  mode: 'immediate' | 'queued';
  status: 'pending' | 'delivered' | 'responded';
  created_at: number;
  tool_calls?: PersistedToolCall[] | null;
}

export async function fetchManagedAgents(): Promise<ManagedAgent[]> {
  const res = await apiFetch(`/v1/managed-agents`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  const data = await res.json();
  return data.agents || [];
}

export async function fetchManagedAgent(agentId: string): Promise<ManagedAgent> {
  const res = await apiFetch(`/v1/managed-agents/${agentId}`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function createManagedAgent(body: {
  name: string;
  agent_type?: string;
  template_id?: string;
  config?: Record<string, unknown>;
}): Promise<ManagedAgent> {
  const res = await apiFetch(`/v1/managed-agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function updateManagedAgent(
  agentId: string,
  body: Partial<{ name: string; agent_type: string; config: Record<string, unknown> }>,
): Promise<ManagedAgent> {
  const res = await apiFetch(`/v1/managed-agents/${agentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function deleteManagedAgent(agentId: string): Promise<void> {
  const res = await apiFetch(`/v1/managed-agents/${agentId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
}

export async function pauseManagedAgent(agentId: string): Promise<void> {
  const res = await apiFetch(`/v1/managed-agents/${agentId}/pause`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
}

export async function resumeManagedAgent(agentId: string): Promise<void> {
  const res = await apiFetch(`/v1/managed-agents/${agentId}/resume`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
}

export async function fetchAgentTasks(agentId: string): Promise<AgentTask[]> {
  const res = await apiFetch(`/v1/managed-agents/${agentId}/tasks`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  const data = await res.json();
  return data.tasks || [];
}

export async function createAgentTask(agentId: string, description: string): Promise<AgentTask> {
  const res = await apiFetch(`/v1/managed-agents/${agentId}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function fetchAgentChannels(agentId: string): Promise<ChannelBinding[]> {
  const res = await apiFetch(`/v1/managed-agents/${agentId}/channels`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  const data = await res.json();
  return data.bindings || [];
}

export async function bindAgentChannel(
  agentId: string,
  channelType: string,
  config?: Record<string, unknown>,
): Promise<ChannelBinding> {
  const res = await apiFetch(
    `/v1/managed-agents/${agentId}/channels`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_type: channelType,
        config: config || {},
        routing_mode: 'dedicated',
      }),
    },
  );
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function unbindAgentChannel(
  agentId: string,
  bindingId: string,
): Promise<void> {
  const res = await apiFetch(
    `/v1/managed-agents/${agentId}/channels/${bindingId}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
}

// -- SendBlue auto-setup helpers ------------------------------------------

export async function sendblueVerify(
  apiKeyId: string,
  apiSecretKey: string,
): Promise<{ valid: boolean; numbers: string[]; raw: unknown }> {
  const res = await apiFetch(`/v1/channels/sendblue/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key_id: apiKeyId, api_secret_key: apiSecretKey }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Verification failed: ${res.status}`);
  }
  return res.json();
}

export async function sendblueRegisterWebhook(
  apiKeyId: string,
  apiSecretKey: string,
  webhookUrl: string,
): Promise<{ registered: boolean; status: number }> {
  const res = await apiFetch(`/v1/channels/sendblue/register-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key_id: apiKeyId,
      api_secret_key: apiSecretKey,
      webhook_url: webhookUrl,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Webhook registration failed: ${res.status}`);
  }
  return res.json();
}

export async function sendblueTest(
  apiKeyId: string,
  apiSecretKey: string,
  fromNumber: string,
  toNumber: string,
): Promise<{ sent: boolean; status: number }> {
  const res = await apiFetch(`/v1/channels/sendblue/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key_id: apiKeyId,
      api_secret_key: apiSecretKey,
      from_number: fromNumber,
      to_number: toNumber,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Test message failed: ${res.status}`);
  }
  return res.json();
}

export async function sendblueHealth(): Promise<{ channel_connected: boolean; bridge_wired: boolean; ready: boolean }> {
  const res = await apiFetch(`/v1/channels/sendblue/health`);
  if (!res.ok) return { channel_connected: false, bridge_wired: false, ready: false };
  return res.json();
}

export async function fetchTemplates(): Promise<AgentTemplate[]> {
  const res = await apiFetch(`/v1/templates`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  const data = await res.json();
  return data.templates || [];
}

export async function runManagedAgent(agentId: string): Promise<void> {
  const res = await apiFetch(`/v1/managed-agents/${agentId}/run`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail || `Failed: ${res.status}`);
  }
}

export async function recoverManagedAgent(agentId: string): Promise<{ recovered: boolean; checkpoint: unknown }> {
  const res = await apiFetch(`/v1/managed-agents/${agentId}/recover`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail || `Failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchAgentState(agentId: string): Promise<{
  agent: ManagedAgent;
  tasks: AgentTask[];
  channels: ChannelBinding[];
  messages: AgentMessage[];
  checkpoint: unknown;
}> {
  const res = await apiFetch(`/v1/managed-agents/${agentId}/state`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export interface AgentToolCallStart {
  tool: string;
  arguments: string;
}

export interface AgentToolCallEnd {
  tool: string;
  success: boolean;
  latency: number;
  result?: string;
}

export async function sendAgentMessage(
  agentId: string,
  content: string,
  mode: 'immediate' | 'queued' = 'queued',
  callbacks?: {
    onProgress?: (label: string) => void;
    onContentDelta?: (delta: string, fullContent: string) => void;
    onToolCallStart?: (info: AgentToolCallStart) => void;
    onToolCallEnd?: (info: AgentToolCallEnd) => void;
    onDone?: (fullContent: string, usage?: Record<string, number>, telemetry?: Record<string, unknown>) => void;
  },
): Promise<AgentMessage> {
  const res = await apiFetch(`/v1/managed-agents/${agentId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, mode, stream: true }),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);

  // If streaming, consume the SSE response so the agent runs
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream') && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';
    let lastUsage: Record<string, number> | undefined;
    let lastTelemetry: Record<string, unknown> | undefined;
    let currentEvent: string | undefined;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (!line.startsWith('data: ')) {
            if (line.trim() === '') currentEvent = undefined;
            continue;
          }
          const data = line.slice(6);
          if (data === '[DONE]') {
            currentEvent = undefined;
            continue;
          }
          const evName = currentEvent;
          currentEvent = undefined;

          if (evName === 'tool_call_start') {
            try {
              const parsed = JSON.parse(data);
              callbacks?.onToolCallStart?.({
                tool: parsed.tool,
                arguments: serializeToolCallArguments(parsed.arguments),
              });
            } catch {
              /* skip */
            }
            continue;
          }
          if (evName === 'tool_call_end') {
            try {
              const parsed = JSON.parse(data);
              callbacks?.onToolCallEnd?.({
                tool: parsed.tool,
                success: !!parsed.success,
                latency: typeof parsed.latency === 'number' ? parsed.latency : 0,
                result: parsed.result,
              });
            } catch {
              /* skip */
            }
            continue;
          }

          try {
            const chunk = JSON.parse(data);
            // Deep-research branch still uses tool_progress in a data chunk
            const toolProgress = chunk.choices?.[0]?.tool_progress;
            if (toolProgress) {
              callbacks?.onProgress?.(toolProgress);
            }
            const delta = chunk.choices?.[0]?.delta?.content || '';
            if (delta) {
              fullContent += delta;
              callbacks?.onContentDelta?.(delta, fullContent);
            }
            if (chunk.usage) lastUsage = chunk.usage;
            if (chunk.telemetry) lastTelemetry = chunk.telemetry;
          } catch {
            /* skip malformed chunks */
          }
        }
      }
    } catch { /* stream ended */ }

    callbacks?.onDone?.(fullContent, lastUsage, lastTelemetry);

    return {
      id: '',
      agent_id: agentId,
      direction: 'agent_to_user',
      content: fullContent,
      mode,
      status: 'delivered',
      created_at: Date.now() / 1000,
    };
  }

  return res.json();
}

/**
 * Ask the agent a question by triggering an ad-hoc run.
 *
 * Posts the question as an `immediate`, non-streamed message — the backend
 * stores it and spawns a real agent tick (`execute_tick`) that consumes it as
 * the run's input (tools, trace, and all), rather than a raw one-shot chat.
 * Returns immediately with the stored user message; progress is observed via
 * the `/v1/agents/events` WebSocket and the resulting trace.
 */
export async function askAgent(agentId: string, content: string): Promise<AgentMessage> {
  const res = await apiFetch(`/v1/managed-agents/${agentId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, mode: 'immediate', stream: false }),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function fetchAgentMessages(agentId: string): Promise<AgentMessage[]> {
  const res = await apiFetch(`/v1/managed-agents/${agentId}/messages`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  const data = await res.json();
  return data.messages || [];
}

export async function fetchErrorAgents(): Promise<ManagedAgent[]> {
  const res = await apiFetch(`/v1/agents/errors`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  const data = await res.json();
  return data.agents || [];
}

// ---------------------------------------------------------------------------
// Agent Learning + Traces
// ---------------------------------------------------------------------------

export interface LearningLogEntry {
  id: string;
  agent_id: string;
  event_type: string;
  description: string;
  data: Record<string, unknown>;
  created_at: number;
}

export interface AgentTrace {
  id: string;
  outcome: string;
  duration: number;
  started_at: number;
  steps: number;
  error_message?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolInfo {
  name: string;
  description: string;
  category: string;
  source: 'tool' | 'channel';
  requires_credentials: boolean;
  credential_keys: string[];
  configured: boolean;
}

export async function fetchAvailableTools(): Promise<ToolInfo[]> {
  const res = await apiFetch(`/v1/tools`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  const data = await res.json();
  return data.tools || [];
}

export async function saveToolCredentials(
  toolName: string,
  credentials: Record<string, string>,
): Promise<void> {
  const res = await apiFetch(`/v1/tools/${toolName}/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
}

export async function fetchToolCredentialStatus(
  toolName: string,
): Promise<Record<string, boolean>> {
  const res = await apiFetch(`/v1/tools/${toolName}/credentials/status`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return await res.json();
}

export async function deleteToolCredential(
  toolName: string,
  keyName: string,
): Promise<void> {
  const res = await apiFetch(
    `/v1/tools/${encodeURIComponent(toolName)}/credentials/${encodeURIComponent(keyName)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
}

export interface AgentTraceDetail {
  id: string;
  agent: string;
  outcome: string;
  duration: number;
  started_at: number;
  steps: Array<{
    step_type: string;
    input: unknown;
    output: string;
    duration: number;
    metadata: Record<string, unknown>;
  }>;
}

export async function fetchLearningLog(agentId: string): Promise<LearningLogEntry[]> {
  const res = await apiFetch(`/v1/managed-agents/${agentId}/learning`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  const data = await res.json();
  return data.learning_log || [];
}

export async function triggerLearning(agentId: string): Promise<void> {
  const res = await apiFetch(`/v1/managed-agents/${agentId}/learning/run`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
}

export async function fetchAgentTraces(agentId: string, limit = 20): Promise<AgentTrace[]> {
  const res = await apiFetch(`/v1/managed-agents/${agentId}/traces?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  const data = await res.json();
  return data.traces || [];
}

export async function fetchAgentTrace(agentId: string, traceId: string): Promise<AgentTraceDetail> {
  const res = await apiFetch(`/v1/managed-agents/${agentId}/traces/${traceId}`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Leaderboard savings submission (Supabase)
// ---------------------------------------------------------------------------

export interface SavingsSubmission {
  anon_id: string;
  display_name: string;
  email: string;
  total_calls: number;
  total_tokens: number;
  dollar_savings: number;
  energy_wh_saved: number;
  flops_saved: number;
  token_counting_version?: number;
}

export async function submitSavings(data: SavingsSubmission): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return false;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/savings_entries?on_conflict=anon_id`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify(data),
      },
    );
    return res.ok || res.status === 201 || res.status === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export interface MemorySearchResult {
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface MemoryStats {
  entries: number;
  backend: string;
  [key: string]: unknown;
}

export interface MemoryConfig {
  backend: string;
  // Set by the server when the native `openjarvis_rust` extension is missing,
  // so the UI can show the real cause instead of a healthy-looking config.
  available?: boolean;
  detail?: string | null;
  context_from_memory: boolean;
  context_top_k: number;
  context_min_score: number;
  context_max_tokens: number;
}

/**
 * Extract the server's `detail` message from a failed JSON response so the UI
 * surfaces the real cause (e.g. "openjarvis_rust extension is not installed")
 * instead of a blanket fallback string (#502).
 */
async function memoryErrorDetail(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.detail === 'string' && data.detail) return data.detail;
  } catch {
    // Non-JSON body — fall through to the generic message below.
  }
  return fallback;
}

export async function getMemoryStats(): Promise<MemoryStats> {
  let res: Response;
  try {
    res = await apiFetch(`/v1/memory/stats`);
  } catch {
    throw new Error('Could not reach the OpenJarvis API. Check the server status and API URL, then retry.');
  }
  if (!res.ok) {
    const detail = await memoryErrorDetail(res, 'Memory status request failed');
    throw new Error(`${detail} (HTTP ${res.status})`);
  }
  return res.json();
}

export async function searchMemory(query: string, topK: number = 5): Promise<MemorySearchResult[]> {
  const res = await apiFetch(`/v1/memory/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, top_k: topK }),
  });
  if (!res.ok) throw new Error('Failed to search memory');
  const data = await res.json();
  return data.results;
}

export async function storeMemory(content: string, metadata?: Record<string, unknown>): Promise<void> {
  const res = await apiFetch(`/v1/memory/store`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, metadata }),
  });
  if (!res.ok) throw new Error(await memoryErrorDetail(res, 'Failed to store memory'));
}

export async function indexMemoryPath(path: string): Promise<{ chunks_indexed: number; note?: string }> {
  const res = await apiFetch(`/v1/memory/index`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(await memoryErrorDetail(res, 'Failed to index path'));
  return res.json();
}

export async function getMemoryConfig(): Promise<MemoryConfig> {
  const res = await apiFetch(`/v1/memory/config`);
  if (!res.ok) throw new Error('Failed to fetch memory config');
  return res.json();
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export interface PendingApproval {
  id: string;
  action_type: string;
  description: string;
  payload: Record<string, unknown>;
  permission_key: string;
  tier: 'trivial' | 'low' | 'medium' | 'high';
  status: string;
  created_at: string;
  expires_at: string;
}

export async function fetchPendingApprovals(): Promise<PendingApproval[]> {
  const res = await apiFetch(`/v1/approvals/pending`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  const data = await res.json();
  return data.actions || [];
}

export async function approveAction(actionId: string): Promise<void> {
  const res = await apiFetch(`/v1/approvals/${actionId}/approve`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
}

export async function denyAction(actionId: string): Promise<void> {
  const res = await apiFetch(`/v1/approvals/${actionId}/deny`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
}

// ---------------------------------------------------------------------------
// Inference source (desktop only)
// ---------------------------------------------------------------------------

export type InferenceSource = {
  kind: 'ollama' | 'custom';
  model?: string;
  host?: string;
  engine?: string;
};

export async function getInferenceSource(): Promise<InferenceSource> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<InferenceSource>('get_inference_source');
    } catch (e: any) {
      throw new Error(e?.message ?? e ?? 'Failed to read inference source');
    }
  }
  return { kind: 'ollama' };
}

export async function setInferenceSource(
  src: InferenceSource & { apiKey?: string },
  options: { pending?: boolean } = {},
): Promise<void> {
  if (!isTauri()) throw new Error('Inference source is configurable in the desktop app only.');
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke<void>('set_inference_source', {
      kind: src.kind,
      model: src.model ?? null,
      host: src.host ?? null,
      engine: src.engine ?? null,
      apiKey: src.apiKey ?? null,
      pending: options.pending ?? null,
    });
  } catch (e: any) {
    // Surface the backend's actionable error strings (e.g. "A server URL is
    // required…", "Could not store the API key…") as proper Error instances.
    throw new Error(e?.message ?? e ?? 'Failed to save inference source');
  }
}

/** Stage a first-run choice; Rust confirms it only after backend readiness. */
export const stageInferenceSource = (
  src: InferenceSource & { apiKey?: string },
): Promise<void> => setInferenceSource(src, { pending: true });
