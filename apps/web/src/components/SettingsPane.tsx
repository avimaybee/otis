import { useEffect, useId, useRef, useState } from 'react';
import type { ModelOption } from '@otis/contracts';
import { api, ApiError } from '../api/client.js';
import { CloseIcon, UserIcon, BriefcaseIcon, PanelLeftIcon, ArrowLeftIcon, LogOutIcon } from './icons.js';
import { Overlay } from './Overlay.js';
import { ChoiceSelect } from './ui/select.js';
import { TelegramConnection } from './TelegramConnection.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Alert, AlertDescription } from './ui/alert.js';
import { Badge } from './ui/badge.js';

export function SettingsPane({
  workspaceId,
  workspaceName,
  members = {},
  currentUserId,
  currentUserRole = 'owner',
  models: providedModels,
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
  currentUserId?: string;
  currentUserRole?: 'owner' | 'member';
  /** App model catalog reuse: when supplied, no duplicate catalog fetch runs. */
  models?: ModelOption[];
  onClose: () => void;
  onSignOut: () => void;
  onAccessLost?: () => void;
  onUpdated?: () => void;
  onWorkspaceRenamed?: (newName: string) => void;
  onWorkspaceDeleted?: () => void;
  onWorkspaceCreated?: (newId: string) => void;
}) {
  const id = useId();
  const isOwner = currentUserRole === 'owner';
  const [tab, setTab] = useState<'personal' | 'workspace'>('personal');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [models, setModels] = useState<ModelOption[]>(providedModels ?? []);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [saved, setSaved] = useState('');

  const [wsName, setWsName] = useState(workspaceName);
  const [memberList, setMemberList] = useState<{ user_id: string; role: string; display_name: string | null; email?: string }[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [createdInviteLink, setCreatedInviteLink] = useState<{ email: string; link: string; expiresAt: string } | null>(null);
  const [newWsName, setNewWsName] = useState('');
  const [showCreateWs, setShowCreateWs] = useState(false);
  const [confirmDeleteWs, setConfirmDeleteWs] = useState(false);
  const [confirmRemoveUserId, setConfirmRemoveUserId] = useState<string | null>(null);
  const newWsInputRef = useRef<HTMLInputElement>(null);
  const newWsBtnRef = useRef<HTMLButtonElement>(null);
  // Scope fence: the pane is not remounted on workspace switches, so late
  // responses for a previous workspace must never fill this one's sections.
  const liveScope = useRef(workspaceId);
  liveScope.current = workspaceId;
  // Independent section readiness (F24): personal settings, workspace
  // settings and the model catalog load and fail separately, so a dead
  // catalog never blanks personal settings and vice versa.
  const [loadedPersonal, setLoadedPersonal] = useState(false);
  const [loadedWorkspace, setLoadedWorkspace] = useState(false);
  const [loadedModels, setLoadedModels] = useState(providedModels !== undefined);
  const [personalError, setPersonalError] = useState('');
  const [workspaceError, setWorkspaceError] = useState('');
  const [modelsError, setModelsError] = useState('');

  useEffect(() => {
    if (showCreateWs) {
      newWsInputRef.current?.focus();
    }
  }, [showCreateWs]);

  useEffect(() => {
    setWsName(workspaceName);
  }, [workspaceName]);

  const handleError = (err: unknown) => {
    if (err instanceof ApiError && (err.status === 401 || err.code === 'not_member')) onAccessLost?.();
    else setMessage(err instanceof Error ? err.message : 'Could not save the change. Try again.');
  };
  const loadPersonal = async () => {
    const scope = workspaceId;
    const live = () => liveScope.current === scope;
    setPersonalError('');
    try {
      await api.memberSettings(workspaceId);
      if (!live()) return;
      setLoadedPersonal(true);
    } catch (err) {
      if (!live()) return;
      if (err instanceof ApiError && (err.status === 401 || err.code === 'not_member')) onAccessLost?.();
      else setPersonalError('Could not load personal settings. Try again.');
    }
  };
  const loadWorkspace = async () => {
    const scope = workspaceId;
    const live = () => liveScope.current === scope;
    setWorkspaceError('');
    try {
      const shared = await api.settings(workspaceId);
      if (!live()) return;
      setDefaultModel(shared.settings.default_model);
      setLoadedWorkspace(true);
    } catch (err) {
      if (!live()) return;
      if (err instanceof ApiError && (err.status === 401 || err.code === 'not_member')) onAccessLost?.();
      else setWorkspaceError('Could not load workspace settings. Try again.');
    }
  };
  const loadModels = async () => {
    if (providedModels !== undefined) return;
    const scope = workspaceId;
    const live = () => liveScope.current === scope;
    setModelsError('');
    try {
      const options = await api.models(workspaceId);
      if (!live()) return;
      setModels(options.models);
      setLoadedModels(true);
    } catch {
      if (!live()) return;
      setModelsError('Could not load the model catalog. Personal settings still work.');
    }
  };
  useEffect(() => {
    setMessage('');
    void loadPersonal();
    void loadWorkspace();
    void loadModels();
    api.listMembers(workspaceId).then(res => {
      if (liveScope.current !== workspaceId) return;
      setMemberList(res.members);
    }).catch(() => { /* non-fatal fallback to members prop */ });
    // Workspace scope only; loaders capture their scope and ignore late responses.
  }, [workspaceId]);
  // App-supplied catalog wins over the local fetch whenever it arrives.
  useEffect(() => {
    if (providedModels !== undefined) {
      setModels(providedModels);
      setModelsError('');
      setLoadedModels(true);
    }
  }, [providedModels]);
  // The application interface is English. Member preferred_language
  // governs agent response language, not the interface shell itself.
  // Document language remains 'en' to ensure correct screen-reader pronunciation.
  useEffect(() => {
    try { document.documentElement.lang = 'en'; } catch { /* App remains usable without DOM language metadata. */ }
  }, []);
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
  const downloadExport = async (format: 'json' | 'xlsx') => {
    if (busy) return;
    setBusy(format === 'xlsx' ? 'export_xlsx' : 'export_json'); setMessage(''); setSaved('');
    try {
      const response = await api.downloadWorkspaceExport(workspaceId, format);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? 'Workspace export is unavailable right now.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `otis-export-${workspaceId}.${format === 'xlsx' ? 'xlsx' : 'json'}`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
      setSaved('Workspace data downloaded');
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
      setTimeout(() => newWsBtnRef.current?.focus(), 0);
      onWorkspaceCreated?.(result.workspace.id);
    } catch (err) { handleError(err); }
    finally { setBusy(null); }
  };
  const sendInvite = async () => {
    const trimmed = inviteEmail.trim();
    if (!trimmed || busy) return;
    setBusy('invite'); setMessage(''); setSaved(''); setCreatedInviteLink(null);
    try {
      const result = await api.createInvite(workspaceId, trimmed);
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      const link = `${origin}/?invite=${result.token}`;
      setInviteEmail('');
      setCreatedInviteLink({ email: trimmed, link, expiresAt: result.expires_at });
      await navigator.clipboard.writeText(link).catch(() => {});
      setSaved(`Invite link ready for ${trimmed} (copied to clipboard)`);
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
      setConfirmRemoveUserId(null);
    } catch (err) { handleError(err); }
    finally { setBusy(null); }
  };
  return (
    <Overlay label="Settings" className="otis-overlay--settings" onClose={onClose}>
      <section className="otis-settings">
        <aside className={`otis-settings__sidebar ${mobileNavOpen ? 'otis-settings__sidebar--open' : ''}`}>
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground h-7 px-2 flex items-center gap-1"
              onClick={onClose}
            >
              <ArrowLeftIcon size={14} />
              <span>Back to app</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              type="button"
              className="otis-iconbutton size-7 sm:hidden text-muted-foreground hover:text-foreground"
              aria-label="Close settings menu"
              onClick={() => setMobileNavOpen(false)}
            >
              <PanelLeftIcon size={16} />
            </Button>
          </div>

          <div>
            <Input
              placeholder="Search settings…"
              value={searchFilter}
              onChange={e => setSearchFilter(e.target.value)}
              className="h-7 text-xs bg-card/60"
            />
          </div>

          <div className="otis-settings__tabs flex flex-col gap-1 flex-1 overflow-y-auto" role="tablist" aria-label="Settings sections">
            {(!searchFilter || 'account personal you'.includes(searchFilter.toLowerCase())) && (
              <>
                <div className="text-xs font-medium text-muted-foreground px-2 pt-1 pb-1">Personal</div>
                <button
                  id={`${id}-personal-tab`}
                  key="personal"
                  type="button"
                  role="tab"
                  aria-selected={tab === 'personal'}
                  aria-controls={`${id}-personal`}
                  tabIndex={tab === 'personal' ? 0 : -1}
                  onClick={() => {
                    setTab('personal');
                    setMobileNavOpen(false);
                  }}
                  onKeyDown={event => {
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                      event.preventDefault();
                      setTab('workspace');
                      document.getElementById(`${id}-workspace-tab`)?.focus();
                    }
                  }}
                  className="otis-settings__nav-item text-sm"
                >
                  <UserIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>Account</span>
                </button>
              </>
            )}

            {(!searchFilter || workspaceName.toLowerCase().includes(searchFilter.toLowerCase()) || 'workspace general'.includes(searchFilter.toLowerCase())) && (
              <>
                <div className="text-xs font-medium text-muted-foreground px-2 pt-2 pb-1">Workspace</div>
                <button
                  id={`${id}-workspace-tab`}
                  key="workspace"
                  type="button"
                  role="tab"
                  aria-selected={tab === 'workspace'}
                  aria-controls={`${id}-workspace`}
                  tabIndex={tab === 'workspace' ? 0 : -1}
                  onClick={() => {
                    setTab('workspace');
                    setMobileNavOpen(false);
                  }}
                  onKeyDown={event => {
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                      event.preventDefault();
                      setTab('personal');
                      document.getElementById(`${id}-personal-tab`)?.focus();
                    }
                  }}
                  className="otis-settings__nav-item text-sm"
                >
                  <BriefcaseIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">{workspaceName}</span>
                </button>
              </>
            )}
          </div>

          <div className="mt-auto pt-2 border-t border-border flex flex-col gap-1">
            {saved && <span role="status" className="text-xs text-muted-foreground truncate">{saved}</span>}
            <Button
              variant="ghost"
              size="sm"
              className="justify-start text-muted-foreground hover:text-foreground text-xs h-7 px-2 w-full flex items-center gap-1"
              onClick={onSignOut}
            >
              <LogOutIcon size={14} />
              <span>Sign out</span>
            </Button>
          </div>
        </aside>

        <div className="otis-settings__main">
          <header className="otis-settings__header">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                type="button"
                className="otis-iconbutton size-8 sm:hidden text-muted-foreground hover:text-foreground"
                aria-label="Open settings menu"
                onClick={() => setMobileNavOpen(true)}
              >
                <PanelLeftIcon size={18} />
              </Button>
              <h3 className="text-base font-medium text-foreground">{tab === 'personal' ? 'Account' : workspaceName}</h3>
            </div>
            <Button
              variant="ghost"
              size="icon"
              type="button"
              className="otis-iconbutton"
              aria-label="Close settings"
              onClick={onClose}
            >
              <CloseIcon />
            </Button>
          </header>

          <div
            className="otis-settings__body text-sm"
            id={`${id}-${tab}`}
            role="tabpanel"
            aria-labelledby={`${id}-${tab}-tab`}
          >
            {tab === 'personal' ? (
              !loadedPersonal ? (
                personalError ? (
                  <div role="alert">
                    <Alert variant="destructive" className="my-2">
                      <AlertDescription>{personalError}</AlertDescription>
                      <Button variant="outline" size="sm" className="mt-2" onClick={() => void loadPersonal()}>
                        Retry
                      </Button>
                    </Alert>
                  </div>
                ) : (
                  <p role="status" className="text-sm">Loading settings…</p>
                )
              ) : (
                <>
                  {personalError && (
                    <Alert variant="destructive" className="my-2">
                      <AlertDescription>{personalError}</AlertDescription>
                    </Alert>
                  )}

                  <div className="flex flex-col gap-1">
                    <h4 className="text-sm font-medium text-foreground">Account</h4>
                  </div>

                  {/* Card 1: Account profile card matching Screenshot 1 */}
                  <div className="otis-settings__card otis-settings__section">
                    <div className="otis-settings__card-row">
                      <span className="text-sm font-medium text-foreground">Status</span>
                      <span className="text-sm text-muted-foreground">{isOwner ? 'Owner' : 'Member'}</span>
                    </div>

                    <hr className="otis-settings__card-divider" />

                    <div className="otis-settings__card-row">
                      <span className="text-sm font-medium text-foreground">User ID</span>
                      <span className="text-sm font-mono text-muted-foreground truncate max-w-48" title={currentUserId ?? ''}>
                        {currentUserId ?? '—'}
                      </span>
                    </div>

                    <hr className="otis-settings__card-divider" />

                    <div className="otis-settings__card-row">
                      <span className="text-sm font-medium text-foreground">Name</span>
                      <span className="text-sm text-foreground">
                        {memberList.find(m => m.user_id === currentUserId)?.display_name || (currentUserId && members[currentUserId]) || 'You'}
                      </span>
                    </div>

                    <hr className="otis-settings__card-divider" />

                    <div className="otis-settings__card-row">
                      <span className="text-sm font-medium text-foreground">Email</span>
                      <span className="text-sm text-muted-foreground truncate max-w-48">
                        {memberList.find(m => m.user_id === currentUserId)?.email || (currentUserId?.includes('@') ? currentUserId : 'Not set')}
                      </span>
                    </div>

                    <hr className="otis-settings__card-divider" />

                    <div className="otis-settings__card-row">
                      <span className="text-sm font-medium text-foreground">Time standard</span>
                      <span className="text-sm text-muted-foreground">UTC (Auto-converted)</span>
                    </div>

                  </div>

                  {/* Card 2: Telegram connection */}
                  <div className="flex flex-col gap-1 pt-1">
                    <h4 className="text-sm font-medium text-foreground">Integrations</h4>
                  </div>
                  <div className="otis-settings__card otis-settings__section">
                    <TelegramConnection workspaceId={workspaceId} workspaceName={workspaceName} />
                  </div>

                  {/* Card 3: Session & Sign out matching Screenshot 1 */}
                  <div className="otis-settings__card otis-settings__section">
                    <div className="otis-settings__card-row">
                      <div className="flex flex-col gap-1">
                        <h4 className="text-sm font-medium text-foreground">Active session</h4>
                        <p className="otis-detail__label text-xs">Sign out of your active session on this device.</p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        type="button"
                        className="text-destructive hover:text-destructive border-border shrink-0 h-7 px-3 text-xs"
                        onClick={onSignOut}
                      >
                        Sign out
                      </Button>
                    </div>
                  </div>
                </>
              )
            ) : (
              !loadedWorkspace ? (
                workspaceError ? (
                  <div role="alert">
                    <Alert variant="destructive" className="my-2">
                      <AlertDescription>{workspaceError}</AlertDescription>
                      <Button variant="outline" size="sm" className="mt-2" onClick={() => void loadWorkspace()}>
                        Retry
                      </Button>
                    </Alert>
                  </div>
                ) : (
                  <p role="status" className="text-sm">Loading settings…</p>
                )
              ) : (
                <>
                  {workspaceError && (
                    <Alert variant="destructive" className="my-2">
                      <AlertDescription>{workspaceError}</AlertDescription>
                    </Alert>
                  )}

                  {/* Card 1: Workspace info & model */}
                  <div className="otis-settings__card otis-settings__section">
                    {isOwner ? (
                      <form onSubmit={event => { event.preventDefault(); void saveWorkspaceName(); }}>
                        <label htmlFor={`${id}-wsname`} className="text-sm font-medium">Workspace name</label>
                        <div className="flex items-center gap-2 mt-1">
                          <Input
                            id={`${id}-wsname`}
                            value={wsName}
                            onChange={e => setWsName(e.target.value)}
                            disabled={Boolean(busy)}
                          />
                          <Button
                            size="sm"
                            type="submit"
                            disabled={Boolean(busy) || !wsName.trim() || wsName.trim() === workspaceName}
                          >
                            {busy === 'workspace_name' ? 'Saving…' : 'Save'}
                          </Button>
                        </div>
                      </form>
                    ) : (
                      <div>
                        <h4 className="text-sm font-medium">Workspace name</h4>
                        <p className="text-sm mt-1 text-foreground">{workspaceName}</p>
                        <p className="otis-detail__label text-xs mt-1">Only workspace owners can rename this workspace.</p>
                      </div>
                    )}

                    <hr className="otis-settings__card-divider" />

                    <div>
                      <label htmlFor={`${id}-model`} className="text-sm font-medium">Workspace model</label>
                      <p className="otis-detail__label text-xs">Chats follow this model unless you choose another in that chat.</p>
                      {modelsError ? (
                        <div role="alert" className="mt-1 flex items-center gap-2 text-xs text-destructive">
                          <span>{modelsError}</span>
                          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" type="button" onClick={() => void loadModels()}>
                            Retry
                          </Button>
                        </div>
                      ) : !loadedModels ? (
                        <p role="status" className="text-xs mt-1">Loading models…</p>
                      ) : (
                        <div className="mt-2">
                          <ChoiceSelect
                            id={`${id}-model`}
                            label="Workspace model"
                            value={defaultModel ?? 'none'}
                            options={[
                              { value: 'none', label: 'No default model' },
                              ...models.filter(m => m.available || m.command_key === defaultModel).map(m => ({
                                value: m.command_key,
                                label: m.display_name,
                                disabled: !m.available,
                              })),
                            ]}
                            onChange={(value: string) => void saveDefault(value)}
                            disabled={Boolean(busy)}
                          />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Card 2: Workspace members */}
                  <div className="otis-settings__card otis-settings__section">
                    <div className="otis-settings__card-row">
                      <div className="flex flex-col gap-1">
                        <h4 className="text-sm font-medium">Workspace members</h4>
                        <p className="otis-detail__label text-xs">Members can read all workspace chats and retained voice notes.</p>
                      </div>
                      <Button variant="outline" size="sm" type="button" onClick={() => void copyShareableLink()} disabled={Boolean(busy)}>
                        {busy === 'copy_invite' ? 'Generating…' : 'Copy invite link'}
                      </Button>
                    </div>

                    <form className="flex items-center gap-2 mt-1" onSubmit={e => { e.preventDefault(); void sendInvite(); }}>
                      <Input
                        type="email"
                        placeholder="Invite by email"
                        aria-label="Invite email address"
                        value={inviteEmail}
                        onChange={e => setInviteEmail(e.target.value)}
                        disabled={Boolean(busy)}
                      />
                      <Button variant="outline" size="sm" type="submit" disabled={Boolean(busy) || !inviteEmail.trim()}>
                        {busy === 'invite' ? 'Creating…' : 'Create invite link'}
                      </Button>
                    </form>

                    {createdInviteLink && (
                      <div className="rounded-lg border border-border bg-card/60 p-2 flex items-center justify-between gap-2">
                        <div className="flex flex-col min-w-0">
                          <span className="text-xs font-medium truncate">Invite link ready for {createdInviteLink.email}</span>
                          <span className="text-xs text-muted-foreground">Expires {new Date(createdInviteLink.expiresAt).toLocaleDateString()}</span>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          type="button"
                          className="h-7 px-2 text-xs shrink-0"
                          onClick={async () => {
                            await navigator.clipboard.writeText(createdInviteLink.link).catch(() => {});
                            setSaved('Copied to clipboard');
                          }}
                        >
                          Copy link
                        </Button>
                      </div>
                    )}

                    <hr className="otis-settings__card-divider" />

                    <div className="flex flex-col gap-2">
                      {memberList.length > 0
                        ? memberList.map(member => {
                            const isCurrent = member.user_id === currentUserId;
                            const primaryName = member.display_name || member.email;
                            const displayName = primaryName
                              ? (isCurrent ? `${primaryName} (You)` : primaryName)
                              : (isCurrent ? 'You' : `Member (${member.user_id.slice(0, 6)})`);
                            const avatarInitial = (primaryName || (isCurrent ? 'Y' : 'M')).charAt(0).toUpperCase();
                            const roleText = member.role === 'owner' ? 'Owner' : 'Member';
                            const subtitle = member.email && member.display_name && member.display_name !== member.email
                              ? `${roleText} · ${member.email}`
                              : roleText;

                            return (
                              <div key={member.user_id} className="flex items-center justify-between py-1">
                                <div className="flex items-center gap-2">
                                  <span className="otis-member-avatar text-xs" aria-hidden="true">
                                    {avatarInitial}
                                  </span>
                                  <div className="flex flex-col">
                                    <span className="text-sm">{displayName}</span>
                                    <span className="text-xs text-muted-foreground capitalize">{subtitle}</span>
                                  </div>
                                </div>
                                {isOwner && member.role !== 'owner' && !isCurrent && (
                                  confirmRemoveUserId === member.user_id ? (
                                    <div className="flex items-center gap-1">
                                      <Button
                                        variant="destructive"
                                        size="sm"
                                        type="button"
                                        className="h-6 px-2 text-xs"
                                        onClick={() => void removeMember(member.user_id)}
                                        disabled={busy === `remove_${member.user_id}`}
                                      >
                                        {busy === `remove_${member.user_id}` ? 'Removing…' : 'Confirm'}
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        type="button"
                                        className="h-6 px-2 text-xs"
                                        onClick={() => setConfirmRemoveUserId(null)}
                                      >
                                        Cancel
                                      </Button>
                                    </div>
                                  ) : (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      type="button"
                                      className="text-destructive hover:text-destructive h-6 px-2 text-xs"
                                      onClick={() => setConfirmRemoveUserId(member.user_id)}
                                      disabled={Boolean(busy)}
                                    >
                                      Remove
                                    </Button>
                                  )
                                )}
                              </div>
                            );
                          })
                        : Object.entries(members).map(([memberId, name]) => {
                            const isCurrent = memberId === currentUserId;
                            return (
                              <div key={memberId} className="flex items-center gap-2 py-1">
                                <span className="otis-member-avatar text-xs" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
                                <span className="text-sm">{isCurrent ? `${name} (You)` : name}</span>
                              </div>
                            );
                          })}
                    </div>
                  </div>

                  {/* Card 3: Workspaces & Data */}
                  <div className="otis-settings__card otis-settings__section">
                    <div className="otis-settings__card-row">
                      <div className="flex flex-col gap-1">
                        <h4 className="text-sm font-medium">Create workspace</h4>
                        <p className="otis-detail__label text-xs">Set up a distinct workspace for a new business, branch, or team.</p>
                      </div>
                      {!showCreateWs && (
                        <Button ref={newWsBtnRef} variant="outline" size="sm" type="button" onClick={() => setShowCreateWs(true)}>
                          + New workspace
                        </Button>
                      )}
                    </div>
                    {showCreateWs && (
                      <form className="flex items-center gap-2 mt-1" onSubmit={e => { e.preventDefault(); void createNewWorkspace(); }}>
                        <Input
                          ref={newWsInputRef}
                          placeholder="New workspace name"
                          aria-label="New workspace name"
                          value={newWsName}
                          onChange={e => setNewWsName(e.target.value)}
                          disabled={Boolean(busy)}
                        />
                        <Button size="sm" type="submit" disabled={Boolean(busy) || !newWsName.trim()}>
                          {busy === 'create_workspace' ? 'Creating…' : 'Create'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          onClick={() => {
                            setShowCreateWs(false);
                            setNewWsName('');
                            setTimeout(() => newWsBtnRef.current?.focus(), 0);
                          }}
                        >
                          Cancel
                        </Button>
                      </form>
                    )}

                    <hr className="otis-settings__card-divider" />

                    <div>
                      <h4 className="text-sm font-medium">Workspace data</h4>
                      <p className="otis-detail__label text-xs">
                        Download everything in this workspace as JSON or a spreadsheet: conversations, business records, tasks, drafts, memory, briefs and reminders. Secrets and sessions are never included.
                      </p>
                      <div className="flex items-center gap-2 mt-2">
                        <Button variant="outline" size="sm" type="button" onClick={() => void downloadExport('json')} disabled={Boolean(busy)}>
                          {busy === 'export_json' ? 'Preparing…' : 'Download JSON'}
                        </Button>
                        <Button variant="outline" size="sm" type="button" onClick={() => void downloadExport('xlsx')} disabled={Boolean(busy)}>
                          {busy === 'export_xlsx' ? 'Preparing…' : 'Download spreadsheet'}
                        </Button>
                      </div>
                    </div>
                  </div>

                  {/* Card 4: Danger zone */}
                  {isOwner ? (
                    <div className="otis-settings__card otis-settings__section border-destructive/30">
                      <div className="otis-settings__card-row">
                        <div className="flex flex-col gap-1">
                          <h4 className="text-sm font-medium text-destructive">Danger zone</h4>
                          <p className="otis-detail__label text-xs">
                            Permanently deletes this workspace and all of its conversations, business records, drafts, memory, briefs, reminders, media and ledger history for every member. The erasure itself is logged; no workspace content is kept. This cannot be undone.
                          </p>
                        </div>
                        <Badge variant="outline" className="text-xs text-destructive border-border">
                          Irreversible
                        </Badge>
                      </div>
                      {!confirmDeleteWs ? (
                        <Button variant="outline" size="sm" type="button" className="text-destructive hover:text-destructive mt-1 w-fit" onClick={() => setConfirmDeleteWs(true)}>
                          Delete workspace
                        </Button>
                      ) : (
                        <div className="rounded-lg border border-border bg-card p-3 flex flex-col gap-2">
                          <p className="text-xs text-destructive font-medium">Permanently delete &ldquo;{workspaceName}&rdquo;? This cannot be undone.</p>
                          <p className="otis-detail__label text-xs">Download a backup first if you need one — deletion proceeds either way.</p>
                          <div className="flex items-center gap-2 mt-1">
                            <Button variant="outline" size="sm" type="button" onClick={() => void downloadExport('json')} disabled={Boolean(busy)}>
                              {busy === 'export_json' ? 'Preparing…' : 'Download backup'}
                            </Button>
                            <Button variant="destructive" size="sm" type="button" onClick={() => void deleteWorkspace()} disabled={busy === 'delete_workspace'}>
                              {busy === 'delete_workspace' ? 'Deleting…' : 'Delete workspace'}
                            </Button>
                            <Button variant="ghost" size="sm" type="button" onClick={() => setConfirmDeleteWs(false)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="otis-settings__card otis-settings__section">
                      <h4 className="text-sm font-medium text-muted-foreground">Workspace administration</h4>
                      <p className="otis-detail__label text-xs">Only workspace owners can delete this workspace.</p>
                    </div>
                  )}
                </>
              )
            )}
            {message && (
              <Alert variant="destructive" className="my-2">
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            )}
          </div>
        </div>
      </section>
    </Overlay>
  );
}

