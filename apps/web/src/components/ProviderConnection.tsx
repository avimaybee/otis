import { useEffect, useId, useState } from 'react';
import type { ProviderCredentialMetadata, ProviderName } from '@otis/contracts';
import { api } from '../api/client.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Badge } from './ui/badge.js';
import { Alert, AlertDescription } from './ui/alert.js';

const PROVIDER_ROLES: Record<string, string> = {
  opencode_go: 'Chat & reasoning inference',
  gemini: 'Chat & multimodal inference',
  groq: 'Voice note transcription',
};

export function ProviderConnection({
  workspaceId,
  provider,
  name,
  role: customRole,
  onUpdated,
}: {
  workspaceId: string;
  provider: ProviderName;
  name: string;
  role?: string;
  onUpdated: () => void;
}) {
  const id = useId();
  const providerRole = customRole || PROVIDER_ROLES[provider] || 'Model inference';
  const [meta, setMeta] = useState<ProviderCredentialMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.credentialStatus(workspaceId, provider)
      .then((result) => {
        if (!cancelled) {
          setMeta(result.credential);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMeta(null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, provider]);

  const save = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.putCredential(workspaceId, provider, key.trim());
      setKey(''); // Never retain a saved key in client state or browser storage.
      const result = await api.verifyCredential(workspaceId, provider);
      const res = await api.credentialStatus(workspaceId, provider).catch(() => null);
      if (res?.credential) {
        setMeta(res.credential);
      }
      if (result.verified) {
        setEditing(false);
      } else {
        setError('The key was saved, but the provider could not verify it. Check the key and try again.');
      }
      onUpdated();
    } catch {
      setError('Could not finish connecting. Check the key and try again.');
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setConfirmRemove(false);
    try {
      await api.deleteCredential(workspaceId, provider);
      setEditing(false);
      setKey('');
      try {
        const res = await api.credentialStatus(workspaceId, provider);
        setMeta(res.credential);
      } catch {
        setMeta(null);
      }
      onUpdated();
    } catch {
      setError('Could not remove key. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const isPlatform = meta?.source === 'platform';
  const isWorkspace = meta?.source === 'workspace';

  return (
    <div className="otis-settings__provider">
      <div className="otis-settings__row">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">{name}</h3>
            {loading ? (
              <Badge variant="secondary" role="status" className="text-xs">
                Loading…
              </Badge>
            ) : isPlatform ? (
              <Badge variant="outline" role="status" className="inline-flex items-center gap-1 text-xs">
                <span className="otis-status-dot" aria-hidden="true" />
                Included
              </Badge>
            ) : isWorkspace ? (
              <Badge
                variant={meta.status === 'available' ? 'outline' : 'destructive'}
                role="status"
                className="inline-flex items-center gap-1 text-xs"
              >
                {meta.status === 'available' && <span className="otis-status-dot" aria-hidden="true" />}
                {meta.status === 'available' ? 'Custom key' : 'Needs checking'}
              </Badge>
            ) : (
              <Badge variant="secondary" role="status" className="text-xs">
                Not connected
              </Badge>
            )}
          </div>
          <p className="otis-detail__label text-xs mt-1">
            {providerRole}
            {isPlatform ? ' · Included with Otis platform' : isWorkspace ? ' · Workspace custom key' : ''}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {!loading && isWorkspace && !editing && (
            confirmRemove ? (
              <div className="flex items-center gap-1">
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={busy}
                  onClick={() => void removeKey()}
                >
                  {busy ? 'Removing…' : 'Confirm remove'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={busy}
                  onClick={() => setConfirmRemove(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground hover:text-destructive"
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
              >
                Remove key
              </Button>
            )
          )}
          {!loading && !confirmRemove && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setEditing(!editing);
                setKey('');
                setError('');
              }}
            >
              {editing ? 'Cancel' : isPlatform ? 'Provide custom key' : isWorkspace ? 'Replace key' : 'Connect'}
            </Button>
          )}
        </div>
      </div>

      {confirmRemove && (
        <p className="text-xs text-muted-foreground mt-2">
          {meta?.has_platform_fallback
            ? 'Removing this key will revert this workspace to included platform access.'
            : 'Removing this key will disable this provider for this workspace.'}
        </p>
      )}

      {editing && (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor={id} className="text-sm font-medium">
            {name} API key
          </label>
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            disabled={busy}
            placeholder="Paste API key…"
          />
          <p className="otis-detail__label text-xs">
            Shared by this workspace. Saved keys are encrypted server-side and never displayed.
          </p>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={busy || !key.trim()}>
              {busy ? (
                <>
                  <span className="otis-spinner" aria-hidden="true" />
                  <span>Connecting…</span>
                </>
              ) : (
                'Save and check key'
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setKey('');
                setError('');
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {error && (
        <Alert variant="destructive" className="mt-2 text-xs">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
