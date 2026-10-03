import { useEffect, useId, useState } from 'react';
import type { MemberSettings, ModelOption, UpdateMemberSettingsRequest } from '@otis/contracts';
import { api, ApiError } from '../api/client.js';
import { CloseIcon } from './icons.js';
import { Overlay } from './Overlay.js';
import { ChoiceSelect } from './ui/select.js';
import { ProviderConnection } from './ProviderConnection.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Alert, AlertDescription } from './ui/alert.js';

export function SettingsPane({ workspaceId, workspaceName, members = {}, onClose, onSignOut, onAccessLost, onUpdated }: {
  workspaceId: string; workspaceName: string; members?: Record<string, string>;
  onClose: () => void; onSignOut: () => void; onAccessLost?: () => void; onUpdated?: () => void;
}) {
  const id = useId();
  const [tab, setTab] = useState<'personal' | 'workspace'>('personal');
  const [personal, setPersonal] = useState<MemberSettings | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [timezone, setTimezone] = useState('');
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [saved, setSaved] = useState('');
  const [reload, setReload] = useState(0);
  const handleError = (err: unknown) => {
    if (err instanceof ApiError && (err.status === 401 || err.code === 'not_member')) onAccessLost?.();
    else setMessage('Could not save the change. Try again.');
  };
  useEffect(() => {
    let cancelled = false; setMessage('');
    Promise.all([api.settings(workspaceId), api.memberSettings(workspaceId), api.models(workspaceId)]).then(([shared, own, options]) => {
      if (cancelled) return;
      setDefaultModel(shared.settings.default_model); setPersonal(own.settings); setTimezone(own.settings.brief_timezone ?? ''); setModels(options.models); setLoaded(true);
    }).catch(err => { if (!cancelled) { if (err instanceof ApiError && (err.status === 401 || err.code === 'not_member')) onAccessLost?.(); else setMessage('Could not load settings. Try again.'); } });
    return () => { cancelled = true; };
  }, [workspaceId, reload]);
  const savePersonal = async (field: string, body: UpdateMemberSettingsRequest) => {
    if (busy) return;
    setBusy(field); setMessage(''); setSaved('');
    try { const result = await api.updateMemberSettings(workspaceId, body); setPersonal(result.settings); if (field === 'timezone') setTimezone(result.settings.brief_timezone ?? ''); setSaved('Saved'); }
    catch (err) { handleError(err); }
    finally { setBusy(null); }
  };
  const saveTimezone = async () => {
    if (timezone.trim()) { try { new Intl.DateTimeFormat('en', { timeZone: timezone.trim() }); } catch { setMessage('Choose a valid timezone, such as Asia/Kolkata or Europe/Bucharest.'); return; } }
    await savePersonal('timezone', { brief_timezone: timezone.trim() || null });
  };
  const saveDefault = async (key: string) => {
    if (busy) return;
    setBusy('model'); setMessage(''); setSaved('');
    try { const result = await api.updateWorkspaceSettings(workspaceId, { default_model: key === 'none' ? null : key }); setDefaultModel(result.settings.default_model); setSaved('Saved'); onUpdated?.(); }
    catch (err) { handleError(err); }
    finally { setBusy(null); }
  };
  const connectionsUpdated = () => {
    void api.models(workspaceId).then(result => setModels(result.models)).catch(() => setMessage('Could not refresh available models. Close and reopen settings.'));
    onUpdated?.();
  };
  return <Overlay label="Settings" className="otis-overlay--settings" onClose={onClose}><section className="otis-settings">
    <header className="otis-pane-header"><h2>Settings</h2><Button variant="ghost" size="icon" type="button" className="otis-iconbutton" aria-label="Close settings" onClick={onClose}><CloseIcon/></Button></header>
    <div className="otis-settings__tabs" role="tablist" aria-label="Settings sections">
      {(['personal', 'workspace'] as const).map((value, index) => <button id={`${id}-${value}-tab`} key={value} type="button" role="tab" aria-selected={tab === value} aria-controls={`${id}-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = index === 0 ? 'workspace' : 'personal'; setTab(next); document.getElementById(`${id}-${next}-tab`)?.focus(); } }}>{value === 'personal' ? 'You' : workspaceName}</button>)}
    </div>
    <div className="otis-settings__content" id={`${id}-${tab}`} role="tabpanel" aria-labelledby={`${id}-${tab}-tab`}>
      {!loaded ? <p role="status">Loading settings…</p> : tab === 'personal' ? <>
        <div className="otis-settings__section"><label htmlFor={`${id}-language`}>Reply language</label><ChoiceSelect id={`${id}-language`} label="Reply language" value={personal!.preferred_language} options={[{ value: 'en', label: 'English' }, { value: 'ro', label: 'Română' }, { value: 'hu', label: 'Magyar' }]} onChange={(value: string) => void savePersonal('language', { preferred_language: value })} disabled={Boolean(busy)}/></div>
        <form className="otis-settings__section" onSubmit={event => { event.preventDefault(); void saveTimezone(); }}><label htmlFor={`${id}-timezone`}>Timezone</label><p className="otis-detail__label">Used for dates and reminders. Your brief stays on its existing schedule.</p><Input id={`${id}-timezone`} value={timezone} placeholder="Not set" onChange={event => setTimezone(event.target.value)} autoComplete="off" spellCheck={false}/><div className="otis-settings__row mt-2"><Button variant="outline" size="sm" type="button" disabled={Boolean(busy)} onClick={() => setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)}>Use this device’s timezone</Button><Button size="sm" type="submit" disabled={Boolean(busy) || timezone === (personal!.brief_timezone ?? '')}>{busy === 'timezone' ? 'Saving…' : 'Save timezone'}</Button></div></form>
      </> : <>
        <div className="otis-settings__section"><label htmlFor={`${id}-model`}>Workspace model</label><p className="otis-detail__label">Chats follow this model unless you choose another in that chat.</p><ChoiceSelect id={`${id}-model`} label="Workspace model" value={defaultModel ?? 'none'} options={[{ value: 'none', label: 'No default model' }, ...models.filter(model => model.available || model.command_key === defaultModel).map(model => ({ value: model.command_key, label: model.display_name, disabled: !model.available }))]} onChange={(value: string) => void saveDefault(value)} disabled={Boolean(busy)}/></div>
        <div className="otis-settings__section"><h3>Connections</h3><ProviderConnection workspaceId={workspaceId} provider="opencode_go" name="OpenCode Go" onUpdated={connectionsUpdated}/><ProviderConnection workspaceId={workspaceId} provider="gemini" name="Gemini" onUpdated={connectionsUpdated}/></div>
        <div className="otis-settings__section"><h3>Workspace members</h3><p className="otis-detail__label">Members can read all workspace chats and retained voice notes.</p><div className="flex flex-col gap-2 mt-1">{Object.entries(members).map(([memberId, name]) => <div key={memberId} className="flex items-center gap-2.5 py-0.5"><span className="otis-member-avatar" aria-hidden="true">{name.charAt(0).toUpperCase()}</span><span className="text-sm">{name}</span></div>)}</div></div>
      </>}
      {message && <Alert variant="destructive" className="my-2"><AlertDescription>{message}</AlertDescription>{!loaded && <Button variant="outline" size="sm" className="mt-2" onClick={() => setReload(value => value + 1)}>Retry</Button>}</Alert>}
    </div>
    <footer className="otis-settings__footer"><span role="status">{saved}</span><Button variant="ghost" size="sm" onClick={onSignOut}>Sign out</Button></footer>
  </section></Overlay>;
}
