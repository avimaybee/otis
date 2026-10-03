import { useEffect, useId, useState } from 'react';
import { api } from '../api/client.js';

export function ProviderConnection({ workspaceId, provider, name, onUpdated }: {
  workspaceId: string; provider: 'gemini' | 'opencode_go'; name: string; onUpdated: () => void;
}) {
  const id = useId();
  const [status, setStatus] = useState('Loading…');
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    api.credentialStatus(workspaceId, provider).then(result => { if (!cancelled) setStatus(result.credential?.status === 'available' ? 'Connected' : result.credential ? 'Needs checking' : 'Not connected'); }).catch(() => { if (!cancelled) setStatus('Could not load connection'); });
    return () => { cancelled = true; };
  }, [workspaceId, provider]);
  const save = async () => {
    if (!key.trim() || busy) return;
    setBusy(true); setError('');
    try {
      await api.putCredential(workspaceId, provider, key.trim());
      setKey(''); // Never retain a saved key in client state or browser storage.
      setStatus('Checking…');
      const result = await api.verifyCredential(workspaceId, provider);
      setStatus(result.verified ? 'Connected' : 'Needs checking');
      if (result.verified) setEditing(false);
      else setError('The key was saved, but the provider could not verify it. Check the key and try again.');
      onUpdated();
    } catch { setError('Could not finish connecting. Check the key and try again.'); setStatus('Needs checking'); }
    finally { setBusy(false); }
  };
  return <div className="otis-settings__provider">
    <div className="otis-settings__row"><div><h3>{name}</h3><p className="otis-detail__label" role="status">{status}</p></div><button type="button" className="otis-button" disabled={busy} onClick={() => { setEditing(!editing); setKey(''); setError(''); }}>{editing ? 'Cancel' : status === 'Connected' ? 'Replace key' : 'Connect'}</button></div>
    {editing && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label htmlFor={id}>{name} API key</label><input id={id} type="password" autoComplete="new-password" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} disabled={busy}/>
      <p className="otis-detail__label">Shared by this workspace. Saved keys cannot be displayed.</p>
      <button type="submit" className="otis-button otis-button--primary" disabled={busy || !key.trim()}>{busy ? 'Connecting…' : 'Save and check key'}</button>
    </form>}
    {error && <p className="otis-settings__error" role="alert">{error}</p>}
  </div>;
}
