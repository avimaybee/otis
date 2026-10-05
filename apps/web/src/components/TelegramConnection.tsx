import { useEffect, useRef, useState } from 'react';
import type { TelegramConnectionResponse } from '@otis/contracts';
import { api, ApiError } from '../api/client.js';
import { Button } from './ui/button.js';
import { Alert, AlertDescription } from './ui/alert.js';

/**
 * Guided Telegram connection row for Settings > You (009A linking UX).
 *
 * Connect Telegram -> Open Telegram -> tap Start -> Connected, without
 * codes or identifiers. The generated deep link lives in component memory
 * only. The bounded refresh below is the only repeating timer: one status
 * read on open, then at most one check every five seconds for at most two
 * minutes / 24 checks while a just-generated link awaits completion; paused
 * while hidden with one coalesced refresh on return; stopped on connection,
 * expiry, disconnect, unmount, sign-out or workspace change. Idle states
 * never poll. Every status GET is read-only.
 */
const TELEGRAM_REFRESH_INTERVAL_MS = 5_000;
const TELEGRAM_REFRESH_WINDOW_MS = 2 * 60_000;
const TELEGRAM_REFRESH_MAX_CHECKS = 24;

type TelegramPhase =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'disconnected' }
  | { kind: 'preparing' }
  | { kind: 'ready'; link: string; expiresAt: number }
  | { kind: 'expired' }
  | { kind: 'connected'; routingName: string | null; multiple: boolean }
  | { kind: 'disconnecting'; previous: TelegramPhase }
  | { kind: 'disconnected_notice' };

export function TelegramConnection({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const [phase, setPhase] = useState<TelegramPhase>({ kind: 'loading' });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [copiedLink, setCopiedLink] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  // Coalescing state is owned by the ready generation that started the
  // request: a hung old-workspace check must never block a new workspace.
  const inFlight = useRef(0);
  const pendingCheck = useRef(0);
  const autoChecks = useRef(0);
  const windowStartedAt = useRef(0);
  const runCheckRef = useRef<() => void>(() => {});

  // Invalidate every in-flight async response when the workspace changes or
  // the row unmounts: a late issuer/status/disconnect response must never
  // paint onto a different workspace or an unmounted row.
  useEffect(() => {
    return () => {
      generation.current += 1;
    };
  }, [workspaceId]);

  // One read on open / workspace change; never a write.
  useEffect(() => {
    const gen = ++generation.current;
    let cancelled = false;
    setPhase({ kind: 'loading' });
    setNotice('');
    setError('');
    setLoadError(false);
    api
      .telegramConnection(workspaceId)
      .then((status) => {
        if (cancelled || gen !== generation.current) return;
        if (!status.available) {
          setPhase({ kind: 'unavailable' });
          return;
        }
        if (status.state === 'disconnected') {
          setPhase({ kind: 'disconnected' });
          return;
        }
        setPhase({
          kind: 'connected',
          routingName: status.routing_workspace?.name ?? null,
          multiple: status.connections.length > 1,
        });
      })
      .catch((err: unknown) => {
        if (cancelled || gen !== generation.current) return;
        if (err instanceof ApiError && (err.status === 401 || err.code === 'not_member')) {
          setPhase({ kind: 'unavailable' });
          return;
        }
        setPhase({ kind: 'disconnected' });
        setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, reload]);

  // Bounded automatic refresh while a just-generated link awaits completion.
  useEffect(() => {
    if (phase.kind !== 'ready') return;
    // The load effect owns generation increments; a stale ready phase from
    // the previous workspace must not invalidate the new workspace's status
    // read by claiming a newer generation of its own.
    const gen = generation.current;
    const expiresAt = phase.expiresAt;
    let stopped = false;

    const applyStatus = (status: TelegramConnectionResponse) => {
      if (stopped || gen !== generation.current) return;
      if (status.state === 'disconnected') {
        if (Date.now() > expiresAt) {
          setPhase({ kind: 'expired' });
          return;
        }
        setNotice('Not connected yet. Open Telegram and tap Start.');
        return;
      }
      // Only the current server binding ever becomes Connected.
      setNotice('');
      setError('');
      setPhase({
        kind: 'connected',
        routingName: status.routing_workspace?.name ?? null,
        multiple: status.connections.length > 1,
      });
    };

    const runCheck = async () => {
      if (stopped || gen !== generation.current) return;
      if (inFlight.current === gen) {
        pendingCheck.current = gen;
        return;
      }
      inFlight.current = gen;
      try {
        const status = await api.telegramConnection(workspaceId);
        applyStatus(status);
      } catch (err) {
        if (stopped || gen !== generation.current) return;
        if (err instanceof ApiError && (err.status === 401 || err.code === 'not_member')) return;
        setError('Couldn\u2019t check the connection. You can still finish in Telegram, then try again.');
      } finally {
        if (inFlight.current === gen) inFlight.current = 0;
        if (pendingCheck.current === gen && !stopped) {
          pendingCheck.current = 0;
          void runCheck();
        }
      }
    };
    runCheckRef.current = () => {
      void runCheck();
    };

    const timer = setInterval(() => {
      if (stopped || gen !== generation.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (Date.now() - windowStartedAt.current > TELEGRAM_REFRESH_WINDOW_MS) return;
      if (autoChecks.current >= TELEGRAM_REFRESH_MAX_CHECKS) return;
      autoChecks.current += 1;
      void runCheck();
    }, TELEGRAM_REFRESH_INTERVAL_MS);
    // The ten-minute link expiry is honored even when no automatic check
    // happens to run (window exhausted, page backgrounded, checks failing).
    const expiryTimer = setTimeout(() => {
      if (!stopped && gen === generation.current) setPhase({ kind: 'expired' });
    }, Math.max(0, expiresAt - Date.now()));
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') void runCheck();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      // Release only this generation's coalescing ownership; a newer
      // workspace's in-flight request stays untouched.
      if (inFlight.current === gen) inFlight.current = 0;
      if (pendingCheck.current === gen) pendingCheck.current = 0;
      clearInterval(timer);
      clearTimeout(expiryTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [phase, workspaceId]);

  const connect = async () => {
    const gen = generation.current;
    setPhase({ kind: 'preparing' });
    setNotice('');
    setError('');
    try {
      const link = await api.issueTelegramLink(workspaceId);
      if (gen !== generation.current) return;
      windowStartedAt.current = Date.now();
      autoChecks.current = 0;
      setPhase({ kind: 'ready', link: link.deep_link, expiresAt: Date.parse(link.expires_at) });
    } catch (err) {
      if (gen !== generation.current) return;
      if (err instanceof ApiError && err.status === 503) {
        setPhase({ kind: 'unavailable' });
        return;
      }
      setPhase({ kind: 'disconnected' });
      setError('Couldn\u2019t prepare the Telegram link. Try again.');
    }
  };

  const disconnect = async () => {
    if (phase.kind !== 'connected') return;
    const gen = generation.current;
    const previous = phase;
    setPhase({ kind: 'disconnecting', previous });
    setNotice('');
    setError('');
    try {
      await api.disconnectTelegram(workspaceId);
      if (gen !== generation.current) return;
      setPhase({ kind: 'disconnected_notice' });
    } catch (err) {
      if (gen !== generation.current) return;
      if (err instanceof ApiError && (err.status === 401 || err.code === 'not_member')) return;
      setPhase(previous);
      setError('Could not disconnect Telegram. Try again.');
    }
  };

  return (
    <div className="otis-settings__section">
      <h3 className="text-sm font-medium">Telegram</h3>
      {phase.kind === 'loading' && (
        <p role="status" className="text-sm mt-1">
          Checking connection…
        </p>
      )}
      {phase.kind === 'unavailable' && <p className="text-sm mt-1">Telegram isn’t available yet.</p>}
      {(phase.kind === 'disconnected' || phase.kind === 'preparing' || phase.kind === 'disconnected_notice') && (
        <>
          {phase.kind === 'disconnected_notice' && (
            <p className="text-sm mt-1" role="status">
              Disconnected. You can reconnect anytime.
            </p>
          )}
          <p className="text-sm mt-1 text-muted-foreground">Message Otis from Telegram. Your messages are saved in {workspaceName}.</p>
          <div className="otis-settings__row mt-3">
            <Button size="sm" className="otis-button" disabled={phase.kind === 'preparing'} onClick={() => void connect()}>
              {phase.kind === 'preparing' ? (
                <>
                  <span className="otis-spinner" aria-hidden="true" />
                  <span>Preparing link…</span>
                </>
              ) : (
                'Connect Telegram'
              )}
            </Button>
          </div>
        </>
      )}
      {phase.kind === 'ready' && (
        <>
          <p className="text-sm mt-1">Open Telegram, then tap Start to connect your account.</p>
          <div className="otis-settings__row mt-2 flex items-center gap-2 flex-wrap">
            <Button asChild size="sm" className="otis-button">
              <a href={phase.link} target="_blank" rel="noopener noreferrer">
                Open Telegram
              </a>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="otis-button"
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(phase.link);
                  setCopiedLink(true);
                  setTimeout(() => setCopiedLink(false), 2000);
                } catch {
                  /* clipboard fallback */
                }
              }}
            >
              {copiedLink ? 'Link copied!' : 'Copy link'}
            </Button>
            <Button variant="outline" size="sm" className="otis-button" onClick={() => runCheckRef.current()}>
              I’ve tapped Start
            </Button>
          </div>
          <p className="otis-detail__label text-xs mt-1">This link expires in 10 minutes.</p>
        </>
      )}
      {phase.kind === 'expired' && (
        <>
          <p className="text-sm mt-1">This link expired. Get a new link to continue.</p>
          <div className="otis-settings__row mt-2">
            <Button size="sm" className="otis-button" onClick={() => void connect()}>
              Get a new link
            </Button>
          </div>
        </>
      )}
      {phase.kind === 'connected' && (
        <>
          <p className="text-sm mt-1">Connected to Telegram.</p>
          {phase.routingName ? (
            <p className="text-sm">Messages go to {phase.routingName}.</p>
          ) : (
            <p className="text-sm">Choose where Telegram messages go: send /workspace to the bot.</p>
          )}
          {phase.multiple && (
            <p className="otis-detail__label text-xs">You have more than one Telegram connection.</p>
          )}
          <div className="otis-settings__row mt-2">
            <Button variant="outline" size="sm" className="otis-button" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </div>
        </>
      )}
      {phase.kind === 'disconnecting' && (
        <div role="status" className="flex items-center gap-2 text-sm mt-1">
          <span className="otis-spinner" aria-hidden="true" />
          <span>Disconnecting…</span>
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm mt-2">
          {notice}
        </p>
      )}
      {error && (
        <Alert variant="destructive" className="mt-2">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {loadError && phase.kind === 'disconnected' && (
        <Alert variant="destructive" className="mt-2">
          <AlertDescription>Couldn’t load the Telegram connection. Try again.</AlertDescription>
          <Button variant="outline" size="sm" className="otis-button mt-2" onClick={() => setReload((value) => value + 1)}>
            Retry
          </Button>
        </Alert>
      )}
    </div>
  );
}
