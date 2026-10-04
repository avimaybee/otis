import { useEffect, useState } from 'react';
import type { MemorySourceResponse } from '@otis/contracts';
import { api, ApiError } from '../api/client.js';
import { Overlay } from './Overlay.js';
import { CloseIcon } from './icons.js';
import { Button } from './ui/button.js';
import { Badge } from './ui/badge.js';
import { Alert, AlertDescription } from './ui/alert.js';
import { formatDayLabel } from '../i18n/format.js';

export function SourcePane({ workspaceId, memoryId, onClose, onAccessLost, onOpenChat }: { workspaceId: string; memoryId: string; onClose: () => void; onAccessLost: () => void; onOpenChat: (chatId: string) => void }) {
  const [detail, setDetail] = useState<MemorySourceResponse | null>(null); const [error, setError] = useState(false);
  useEffect(() => { let cancelled = false; api.memorySource(workspaceId, memoryId).then(value => { if (!cancelled) setDetail(value); }).catch(err => { if (cancelled) return; if (err instanceof ApiError && [401, 403].includes(err.status)) onAccessLost(); else setError(true); }); return () => { cancelled = true; }; }, [workspaceId, memoryId, onAccessLost]);
  return <Overlay label="Original source" className="otis-overlay--settings" onClose={onClose}><section className="otis-settings" aria-label="Original source"><header className="otis-pane-header"><h2 className="text-base font-medium">Source</h2><Button variant="ghost" size="icon" type="button" aria-label="Close source" onClick={onClose}><CloseIcon/></Button></header>
    {error ? <Alert variant="destructive"><AlertDescription>This source is unavailable. Its content may no longer be retained.</AlertDescription></Alert> : !detail ? <p role="status" className="text-sm text-muted-foreground">Opening the original source…</p> : <><div className="otis-detail__section"><div className="mb-2"><Badge variant="outline">Saved context · {detail.memory.provenance === 'inferred' ? 'Inferred, not stated directly' : 'Stated directly'}</Badge></div><p className="otis-turn__body text-base text-foreground">{detail.memory.content}</p></div><div className="otis-detail__section"><span className="otis-detail__label text-xs">{detail.source?.author_name ?? 'Workspace'} · {formatDayLabel(detail.source?.created_at ?? detail.memory.observed_at)}</span><blockquote className="otis-detail__value text-sm">{detail.source?.text ?? 'The original input is no longer available. This is the retained context record.'}</blockquote></div>{detail.source?.chat_id && <Button type="button" onClick={() => onOpenChat(detail.source!.chat_id!)}>Open source conversation</Button>}</>}
  </section></Overlay>;
}
