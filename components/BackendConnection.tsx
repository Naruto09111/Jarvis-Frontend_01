import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../lib/store';
import {
  normalizeBackendUrl,
  resolveBackendConfig,
  testBackendConnection,
  type BackendTestResult,
} from '../lib/api';

const SOURCE_LABEL: Record<string, string> = {
  settings: 'saved in this browser',
  env: 'build setting (VITE_API_BASE_URL)',
  desktop: 'desktop app default',
  'same-origin': 'same origin as this page (no backend URL configured)',
};

const inputStyle = {
  background: 'var(--color-bg-secondary)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
} as const;

const buttonStyle = {
  background: 'var(--color-bg-secondary)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
} as const;

/**
 * Shows the backend URL that is ACTUALLY in use (and where it came from),
 * validates edits before saving, and runs a real connection test that reports
 * network / CORS / tunnel / auth / empty-model-list failures separately.
 */
export function BackendConnection() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  // Re-resolve whenever stored settings change.
  const cfg = resolveBackendConfig();
  const [draft, setDraft] = useState(cfg.url);
  const [formError, setFormError] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<BackendTestResult | null>(null);

  const runTest = useCallback(
    async (url: string) => {
      setTesting(true);
      setResult(null);
      try {
        setResult(await testBackendConnection(url, settings.apiKey));
      } finally {
        setTesting(false);
      }
    },
    [settings.apiKey],
  );

  // Test the active backend once when the panel opens.
  useEffect(() => {
    void runTest(resolveBackendConfig().url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = () => {
    const n = normalizeBackendUrl(draft);
    if (!n.ok) {
      setFormError(n.error);
      return;
    }
    setFormError('');
    if (n.url === cfg.envUrl) {
      // Same as the build default: no override needed.
      updateSettings({ apiUrl: '', apiUrlEnv: '' });
    } else {
      updateSettings({ apiUrl: n.url, apiUrlEnv: cfg.envUrl });
    }
    setDraft(n.url);
    void runTest(n.url);
  };

  const keepSaved = () => {
    updateSettings({ apiUrlEnv: cfg.envUrl });
    setDraft(cfg.ignoredSavedUrl);
    void runTest(cfg.ignoredSavedUrl);
  };

  const forgetSaved = () => {
    updateSettings({ apiUrl: '', apiUrlEnv: '' });
    setDraft(cfg.envUrl);
    void runTest(cfg.envUrl);
  };

  const good = result?.ok === true;
  const dot = testing || !result ? 'var(--color-text-tertiary)' : good ? 'var(--color-success)' : 'var(--color-error)';

  return (
    <div className="py-3" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
      <div className="text-sm" style={{ color: 'var(--color-text)' }}>Backend URL</div>
      <div className="text-xs mt-1 break-all" style={{ color: 'var(--color-text-tertiary)' }}>
        In use: <span style={{ color: 'var(--color-text-secondary)' }}>{cfg.url || '(none)'}</span>
        {' '}— {SOURCE_LABEL[cfg.source]}
      </div>

      {cfg.ignoredReason && (
        <div
          className="text-xs mt-2 p-2 rounded-lg break-words"
          style={{ border: '1px solid var(--color-error)', color: 'var(--color-text-secondary)' }}
        >
          {cfg.ignoredReason === 'stale' ? (
            <>
              A URL saved in this browser (<b>{cfg.ignoredSavedUrl}</b>) is being ignored because the
              deployment&apos;s build URL changed to <b>{cfg.envUrl}</b>.
            </>
          ) : (
            <>The URL saved in this browser (<b>{cfg.ignoredSavedUrl}</b>) is not a valid backend URL and is being ignored.</>
          )}
          <div className="flex gap-2 mt-2">
            {cfg.ignoredReason === 'stale' && (
              <button type="button" onClick={keepSaved} className="px-2 py-1 rounded cursor-pointer" style={buttonStyle}>
                Use saved URL
              </button>
            )}
            <button type="button" onClick={forgetSaved} className="px-2 py-1 rounded cursor-pointer" style={buttonStyle}>
              Forget saved URL
            </button>
          </div>
        </div>
      )}

      <div className="flex gap-2 mt-2">
        <input
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setFormError(''); }}
          placeholder="https://your-tunnel.trycloudflare.com"
          className="text-sm px-3 py-1.5 rounded-lg outline-none flex-1 min-w-0"
          style={inputStyle}
        />
        <button type="button" onClick={save} className="text-sm px-3 py-1.5 rounded-lg cursor-pointer" style={buttonStyle}>
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            const n = normalizeBackendUrl(draft);
            if (!n.ok) { setFormError(n.error); return; }
            setFormError('');
            void runTest(n.url);
          }}
          disabled={testing}
          className="text-sm px-3 py-1.5 rounded-lg cursor-pointer disabled:opacity-50"
          style={buttonStyle}
        >
          {testing ? 'Testing…' : 'Test'}
        </button>
      </div>
      {formError && (
        <div className="text-xs mt-1" style={{ color: 'var(--color-error)' }}>{formError}</div>
      )}
      <div className="text-xs mt-1" style={{ color: 'var(--color-text-tertiary)' }}>
        Trailing slashes and /v1 are removed automatically. A tunnel URL changes whenever the tunnel restarts.
      </div>

      {(testing || result) && (
        <div className="flex items-start gap-2 mt-2">
          <span className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ background: dot }} />
          <div className="text-xs break-words min-w-0" style={{ color: 'var(--color-text-secondary)' }}>
            {testing && !result ? 'Testing connection…' : result?.message}
            {result?.models && result.models.length > 0 && (
              <div className="mt-1" style={{ color: 'var(--color-text-tertiary)' }}>
                Models: {result.models.slice(0, 8).join(', ')}
                {result.models.length > 8 ? ` … (+${result.models.length - 8})` : ''}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
