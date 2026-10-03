import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../api/client.js';
import { CloseIcon } from './icons.js';
import { Overlay } from './Overlay.js';
export function SettingsPane({ workspaceId, workspaceName, onClose, onSignOut, onAccessLost }: { workspaceId: string; workspaceName: string; onClose: () => void; onSignOut: () => void; onAccessLost?: () => void }) {
  const [language, setLanguage] = useState(''); const [timezone, setTimezone] = useState(''); const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  useEffect(() => { let cancelled = false; Promise.all([api.settings(workspaceId), api.memberSettings(workspaceId)]).then(([shared, personal]) => { if (cancelled) return; setDefaultModel(shared.settings.default_model); setLanguage(personal.settings.preferred_language); setTimezone(personal.settings.brief_timezone ?? ''); setLoaded(true); }).catch(err => { if (cancelled) return; if (err instanceof ApiError && [401, 403, 404].includes(err.status)) onAccessLost?.(); else setMessage('Could not load settings. Close and try again.'); }); return () => { cancelled = true; }; }, [workspaceId]);
  const save = async () => { try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { setMessage('Enter an IANA timezone, such as Europe/Bucharest.'); return; } setBusy(true); setMessage(''); try { await api.updateMemberSettings(workspaceId, { preferred_language: language, brief_timezone: timezone }); toast('Preferences saved'); } catch (err) { if (err instanceof ApiError && [401, 403, 404].includes(err.status)) onAccessLost?.(); else setMessage('Could not save your preferences. Try again.'); } finally { setBusy(false); } };
  return <Overlay label="Settings" className="otis-overlay--sheet" onClose={onClose}><section className="otis-settings">
    <header className="otis-pane-header"><h2>Settings</h2><button type="button" className="otis-iconbutton" aria-label="Close settings" onClick={onClose}><CloseIcon/></button></header>
    <p className="otis-detail__label">{workspaceName}</p><p>Workspace members can read all conversations and retained voice notes.</p>
    {loaded && <><div className="otis-detail__section"><span className="otis-detail__label">Workspace model</span><span>{defaultModel ?? 'No model configured'}</span></div>
    <form onSubmit={event => { event.preventDefault(); void save(); }}><label htmlFor="settings-language">Reply language</label><select id="settings-language" value={language} onChange={event => setLanguage(event.target.value)}><option value="en">English</option><option value="ro">Română</option><option value="hu">Magyar</option></select><label htmlFor="settings-timezone">Your timezone</label><input id="settings-timezone" name="timezone" placeholder="Europe/Bucharest" value={timezone} onChange={event => setTimezone(event.target.value)} autoComplete="off"/><p className="otis-detail__label">Dates & due work</p><button type="submit" className="otis-button otis-button--primary" disabled={busy || !timezone.trim()}>{busy ? 'Saving…' : 'Save preferences'}</button></form></>}
    {message && <p role="status">{message}</p>}<div className="otis-settings__account"><button type="button" className="otis-button" onClick={onSignOut}>Sign out</button></div>
  </section></Overlay>;
}
