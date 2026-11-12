import type { ResearchEvent, SSEEvent } from '../types';
import { getBase, authHeaders } from './api';

export interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream: true;
  temperature?: number;
  max_tokens?: number;
}

/**
 * Turn a failed /v1/chat/completions response into a message that says what
 * went wrong. Reads the backend's own error text (FastAPI {"detail"} or
 * OpenAI-style {"error":{"message"}}). Never includes request headers/keys.
 */
export function describeChatFailure(status: number, bodyText: string, model: string): string {
  let detail = '';
  try {
    const j = JSON.parse(bodyText);
    const d = j?.detail ?? j?.error?.message ?? j?.error ?? j?.message;
    detail = typeof d === 'string' ? d : d ? JSON.stringify(d) : '';
  } catch {
    detail = bodyText.trim().slice(0, 300);
  }
  const suffix = detail ? ` Backend said: ${detail}` : '';
  if (status === 401 || status === 403) {
    return `Authentication failed (HTTP ${status}). Check the API key in Settings.${suffix}`;
  }
  if (status === 404 || (status === 400 && /model/i.test(detail))) {
    return `The backend rejected the model "${model}" (HTTP ${status}). Pick a model that appears in Settings → Connection.${suffix}`;
  }
  if (status === 530 || status === 502 || status === 504) {
    return `The tunnel/gateway could not reach the backend (HTTP ${status}). Make sure "jarvis serve" and cloudflared are running and that the URL is current.${suffix}`;
  }
  if (status >= 500) {
    return `The backend failed while generating (HTTP ${status}).${suffix}`;
  }
  return `Chat request failed (HTTP ${status}).${suffix}`;
}

export async function* streamChat(
  request: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const base = getBase();
  let response: Response;
  try {
    response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(request),
      signal,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    // The browser reports network failures and CORS blocks identically.
    throw new Error(
      'Could not reach the backend (network or CORS error). The tunnel/backend may be down or its URL changed. Open Settings → Connection and run the test.',
    );
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(describeChatFailure(response.status, bodyText, request.model));
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEvent: string | undefined;

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;
          yield { event: currentEvent, data };
          currentEvent = undefined;
        } else if (line.trim() === '') {
          currentEvent = undefined;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* streamResearch(
  query: string,
  model?: string,
  signal?: AbortSignal,
): AsyncGenerator<ResearchEvent> {
  // /api/research is mounted at the server root — strip any trailing /v1
  // from the base so configurations like "http://host:8000/v1" still resolve.
  const base = getBase().replace(/\/v1\/?$/, '');
  const response = await fetch(`${base}/api/research`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ query, ...(model ? { model } : {}) }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Research request failed: ${response.status}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data) as ResearchEvent;
          yield parsed;
          if (parsed.type === 'done') return;
        } catch {
          // skip malformed chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
