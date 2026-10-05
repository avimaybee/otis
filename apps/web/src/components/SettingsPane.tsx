import { useEffect, useId, useState } from 'react';
import type { MemberSettings, ModelOption, UpdateMemberSettingsRequest } from '@otis/contracts';
import { api, ApiError } from '../api/client.js';
import { CloseIcon } from './icons.js';
import { Overlay } from './Overlay.js';
import { ChoiceSelect } from './ui/select.js';
import { ProviderConnection } from './ProviderConnection.js';
import { TelegramConnection } from './TelegramConnection.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Alert, AlertDescription } from './ui/alert.js';
import { parseAppLanguage } from '../i18n/format.js';

export function SettingsPane({
  workspaceId,
  workspaceName,
  members = {},
  onClose,
  onSignOut,
  onAccessLost,
  onUpdated,
  onWorkspaceRenamed,
  onWorkspaceDeleted,
  onWorkspaceCreated,
}: {
  workspaceId: string;
  workspaceName: string;
  members?: Record<string, string>;
  onClose: () => void;
  onSignOut: () => void;
  onAccessLost?: () => void;
  onUpdated?: () => void;
  onWorkspaceRenamed?: (newName: string) => void;
  onWorkspaceDeleted?: () => void;
  onWorkspaceCreated?: (newId: string) => void;
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

  const [wsName, setWsName] = useState(workspaceName);
  const [memberList, setMemberList] = useState<{ user_id: string; role: string; display_name: string | null; email?: string }[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [newWsName, setNewWsName] = useState('');
  const [showCreateWs, setShowCreateWs] = useState(false);
  const [confirmDeleteWs, setConfirmDeleteWs] = useState(false);

  useEffect(() => {
    setWsName(workspaceName);
  }, [workspaceName]);

  const handleError = (err: unknown) => {
    if (err instanceof ApiError && (err.status === 401 || err.code === 'not_member')) onAccessLost?.();
    else setMessage(err instanceof Error ? err.message : 'Could not save the change. Try again.');
  };
  useEffect(() => {
    let cancelled = false; setMessage('');
    Promise.all([api.settings(workspaceId), api.memberSettings(workspaceId), api.models(workspaceId)]).then(([shared, own, options]) => {
      if (cancelled) return;
      setDefaultModel(shared.settings.default_model); setPersonal(own.settings); setTimezone(own.settings.brief_timezone ?? ''); setModels(options.models); setLoaded(true);
    }).catch(err => { if (!cancelled) { if (err instanceof ApiError && (err.status === 401 || err.code === 'not_member')) onAccessLost?.(); else setMessage('Could not load settings. Try again.'); } });
    api.listMembers(workspaceId).then(res => {
      if (!cancelled) setMemberList(res.members);
    }).catch(() => { /* non-fatal fallback to members prop */ });
    return () => { cancelled = true; };
  }, [workspaceId, reload]);
  // The application language follows the saved member reply language
  // (ro/hu/en, validated). Unknown content inherits it; no per-message
  // language metadata exists on ChatMessage, so no lang is asserted there.
  useEffect(() => {
    const language = parseAppLanguage(personal?.preferred_language) ?? 'en';
    try { document.documentElement.lang = language; } catch { /* App remains usable without DOM language metadata. */ }
  }, [personal?.preferred_language]);
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
  const saveWorkspaceName = async () => {
    const trimmed = wsName.trim();
    if (!trimmed || trimmed === workspaceName || busy) return;
    setBusy('workspace_name'); setMessage(''); setSaved('');
    try {
      await api.updateWorkspace(workspaceId, trimmed);
      setSaved('Saved');
      onWorkspaceRenamed?.(trimmed);
      onUpdated?.();
    } catch (err) { handleError(err); }
    finally { setBusy(null); }
  };
  const deleteWorkspace = async () => {
    if (busy) return;
    setBusy('delete_workspace'); setMessage(''); setSaved('');
    try {
      await api.deleteWorkspace(workspaceId);
      onWorkspaceDeleted?.();
      onClose();
    } catch (err) { handleError(err); }
    finally { setBusy(null); }
  };
  const createNewWorkspace = async () => {
    const trimmed = newWsName.trim();
    if (!trimmed || busy) return;
    setBusy('create_workspace'); setMessage(''); setSaved('');
    try {
      const result = await api.createWorkspace(trimmed);
      setNewWsName('');
      setShowCreateWs(false);
      setSaved('Workspace created');
      onWorkspaceCreated?.(result.workspace.id);
    } catch (err) { handleError(err); }
    finally { setBusy(null); }
  };
  const sendInvite = async () => {
    const trimmed = inviteEmail.trim();
    if (!trimmed || busy) return;
    setBusy('invite'); setMessage(''); setSaved('');
    try {
      await api.createInvite(workspaceId, trimmed);
      setInviteEmail('');
      setSaved(`Invite sent to ${trimmed}`);
    } catch (err) { handleError(err); }
    finally { setBusy(null); }
  };
  const copyShareableLink = async () => {
    if (busy) return;
    setBusy('copy_invite'); setMessage(''); setSaved('');
    try {
      const result = await api.createInvite(workspaceId, '*');
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      const link = `${origin}/?invite=${result.token}`;
      await navigator.clipboard.writeText(link);
      setSaved('Invite link copied to clipboard!');
    } catch (err) { handleError(err); }
    finally { setBusy(null); }
  };
  const removeMember = async (targetUserId: string) => {
    if (busy) return;
    setBusy(`remove_${targetUserId}`); setMessage(''); setSaved('');
    try {
      await api.removeMember(workspaceId, targetUserId);
      setMemberList(prev => prev.filter(m => m.user_id !== targetUserId));
      setSaved('Member removed');
    } catch (err) { handleError(err); }
    finally { setBusy(null); }
  };
  const connectionsUpdated = () => {
    void api.models(workspaceId).then(result => setModels(result.models)).catch(() => setMessage('Could not refresh available models. Close and reopen settings.'));
    onUpdated?.();
  };
  return <Overlay label="Settings" className="otis-overlay--settings" onClose={onClose}><section className="otis-settings">
    <header className="otis-pane-header"><h2 className="text-base font-medium">Settings</h2><Button variant="ghost" size="icon" type="button" className="otis-iconbutton" aria-label="Close settings" onClick={onClose}><CloseIcon/></Button></header>
    <div className="otis-settings__tabs" role="tablist" aria-label="Settings sections">
      {(['personal', 'workspace'] as const).map((value, index) => <button id={`${id}-${value}-tab`} key={value} type="button" role="tab" aria-selected={tab === value} aria-controls={`${id}-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = index === 0 ? 'workspace' : 'personal'; setTab(next); document.getElementById(`${id}-${next}-tab`)?.focus(); } }} className="text-sm">{value === 'personal' ? 'You' : workspaceName}</button>)}
    </div>
    <div className="otis-settings__content text-sm" id={`${id}-${tab}`} role="tabpanel" aria-labelledby={`${id}-${tab}-tab`}>
      {!loaded ? <p role="status" className="text-sm">Loading settings…</p> : tab === 'personal' ? <>
        <div className="otis-settings__section"><label htmlFor={`${id}-language`} className="text-sm font-medium">Reply language</label><ChoiceSelect id={`${id}-language`} label="Reply language" value={personal!.preferred_language} options={[{ value: 'en', label: 'English' }, { value: 'ro', label: 'Română' }, { value: 'hu', label: 'Magyar' }]} onChange={(value: string) => void savePersonal('language', { preferred_language: value })} disabled={Boolean(busy)}/></div>
        <form className="otis-settings__section" onSubmit={event => { event.preventDefault(); void saveTimezone(); }}><label htmlFor={`${id}-timezone`} className="text-sm font-medium">Timezone</label><p className="otis-detail__label text-xs">Used for dates and reminders. Your brief stays on its existing schedule.</p><Input id={`${id}-timezone`} value={timezone} placeholder="Not set" onChange={event => setTimezone(event.target.value)} autoComplete="off" spellCheck={false}/><div className="otis-settings__row mt-2"><Button variant="outline" size="sm" type="button" disabled={Boolean(busy)} onClick={() => setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)}>Use this device’s timezone</Button><Button size="sm" type="submit" disabled={Boolean(busy) || timezone === (personal!.brief_timezone ?? '')}>{busy === 'timezone' ? <><span className="otis-spinner" aria-hidden="true" /><span>Saving…</span></> : 'Save timezone'}</Button></div></form>
        <TelegramConnection workspaceId={workspaceId} workspaceName={workspaceName}/>
      </> : <>
        <form className="otis-settings__section" onSubmit={event => { event.preventDefault(); void saveWorkspaceName(); }}>
          <label htmlFor={`${id}-wsname`} className="text-sm font-medium">Workspace name</label>
          <div className="flex items-center gap-2 mt-1">
            <Input id={`${id}-wsname`} value={wsName} onChange={e => setWsName(e.target.value)} disabled={Boolean(busy)} />
            <Button size="sm" type="submit" disabled={Boolean(busy) || !wsName.trim() || wsName.trim() === workspaceName}>
              {busy === 'workspace_name' ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
        <div className="otis-settings__section"><label htmlFor={`${id}-model`} className="text-sm font-medium">Workspace model</label><p className="otis-detail__label text-xs">Chats follow this model unless you choose another in that chat.</p><ChoiceSelect id={`${id}-model`} label="Workspace model" value={defaultModel ?? 'none'} options={[{ value: 'none', label: 'No default model' }, ...models.filter(model => model.available || model.command_key === defaultModel).map(model => ({ value: model.command_key, label: model.display_name, disabled: !model.available }))]} onChange={(value: string) => void saveDefault(value)} disabled={Boolean(busy)}/></div>
        <div className="otis-settings__section"><h3 className="text-sm font-medium">Connections</h3><ProviderConnection workspaceId={workspaceId} provider="opencode_go" name="OpenCode Go" onUpdated={connectionsUpdated}/><ProviderConnection workspaceId={workspaceId} provider="gemini" name="Gemini" onUpdated={connectionsUpdated}/><ProviderConnection workspaceId={workspaceId} provider="groq" name="Groq (Voice Transcription)" onUpdated={connectionsUpdated}/></div>
        <div className="otis-settings__section">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Workspace members</h3>
            <Button variant="outline" size="sm" type="button" onClick={() => void copyShareableLink()} disabled={Boolean(busy)}>
              {busy === 'copy_invite' ? 'Generating…' : 'Copy invite link'}
            </Button>
          </div>
          <p className="otis-detail__label text-xs">Members can read all workspace chats and retained voice notes.</p>
          <form className="flex items-center gap-2 mt-2" onSubmit={e => { e.preventDefault(); void sendInvite(); }}>
            <Input
              type="email"
              placeholder="Invite by email"
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              disabled={Boolean(busy)}
            />
            <Button variant="outline" size="sm" type="submit" disabled={Boolean(busy) || !inviteEmail.trim()}>
              {busy === 'invite' ? 'Sending…' : 'Invite'}
            </Button>
          </form>
          <div className="flex flex-col gap-2 mt-3">
            {memberList.length > 0
              ? memberList.map(member => (
                  <div key={member.user_id} className="flex items-center justify-between py-1">
                    <div className="flex items-center gap-2">
                      <span className="otis-member-avatar text-xs" aria-hidden="true">
                        {(member.display_name || member.email || 'M').charAt(0).toUpperCase()}
                      </span>
                      <div className="flex flex-col">
                        <span className="text-sm">{member.display_name || member.email || 'Member'}</span>
                        <span className="text-xs text-muted-foreground capitalize">{member.role}</span>
                      </div>
                    </div>
                    {member.role !== 'owner' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        className="text-destructive hover:text-destructive h-6 px-2 text-xs"
                        onClick={() => void removeMember(member.user_id)}
                        disabled={busy === `remove_${member.user_id}`}
                      >
                        {busy === `remove_${member.user_id}` ? 'Removing…' : 'Remove'}
                      </Button>
                    )}
                  </div>
                ))
              : Object.entries(members).map(([memberId, name]) => (
                  <div key={memberId} className="flex items-center gap-2 py-1">
                    <span className="otis-member-avatar text-xs" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
                    <span className="text-sm">{name}</span>
                  </div>
                ))}
          </div>
        </div>
        <div className="otis-settings__section">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Create workspace</h3>
            {!showCreateWs && (
              <Button variant="outline" size="sm" type="button" onClick={() => setShowCreateWs(true)}>
                + New workspace
              </Button>
            )}
          </div>
          {showCreateWs && (
            <form className="flex items-center gap-2 mt-2" onSubmit={e => { e.preventDefault(); void createNewWorkspace(); }}>
              <Input
                placeholder="New workspace name"
                value={newWsName}
                onChange={e => setNewWsName(e.target.value)}
                disabled={Boolean(busy)}
              />
              <Button size="sm" type="submit" disabled={Boolean(busy) || !newWsName.trim()}>
                {busy === 'create_workspace' ? 'Creating…' : 'Create'}
              </Button>
              <Button variant="ghost" size="sm" type="button" onClick={() => setShowCreateWs(false)}>
                Cancel
              </Button>
            </form>
          )}
        </div>
        <div className="otis-settings__section border-t border-border pt-4 mt-4">
          <h3 className="text-sm font-medium text-destructive">Danger zone</h3>
          <p className="otis-detail__label text-xs">Permanently deletes this workspace, its chats, and all memory.</p>
          {!confirmDeleteWs ? (
            <Button variant="outline" size="sm" type="button" className="text-destructive hover:text-destructive mt-2" onClick={() => setConfirmDeleteWs(true)}>
              Delete workspace
            </Button>
          ) : (
            <div className="flex items-center gap-2 mt-2">
              <Button variant="destructive" size="sm" type="button" onClick={() => void deleteWorkspace()} disabled={busy === 'delete_workspace'}>
                {busy === 'delete_workspace' ? 'Deleting…' : 'Confirm delete'}
              </Button>
              <Button variant="ghost" size="sm" type="button" onClick={() => setConfirmDeleteWs(false)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      </>}
      {message && <Alert variant="destructive" className="my-2"><AlertDescription>{message}</AlertDescription>{!loaded && <Button variant="outline" size="sm" className="mt-2" onClick={() => setReload(value => value + 1)}>Retry</Button>}</Alert>}
    </div>
    <footer className="otis-settings__footer text-xs"><span role="status">{saved}</span><Button variant="ghost" size="sm" onClick={onSignOut}>Sign out</Button></footer>
  </section></Overlay>;
}

