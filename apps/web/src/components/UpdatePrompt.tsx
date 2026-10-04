import { useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { toast } from 'sonner';
import { Button } from './ui/button.js';
import { entriesForUser } from '../api/outbox.js';
import { flushUserDraftSaves, hasUnsafeDrafts } from '../api/drafts.js';

/**
 * Safe service-worker update prompt. It never auto-reloads: the notice
 * appears only when the new worker is waiting, and Reload is refused while
 * this account still has unsent local entries (they resume after a manual
 * reload, but interrupting an in-flight send is never forced). Otherwise the
 * action first commits this account's pending debounced drafts to IndexedDB
 * and awaits them — a browser reload does not promise a React unmount, so a
 * keystroke inside the debounce window would otherwise disappear when the
 * new worker takes over. A send landing while the draft commit is held, or
 * keystrokes typed during the hold, are caught by bounded re-checks (one
 * re-drain, never a loop — typing must not trap the action) immediately
 * before activation, with no await between the final check and the call.
 * A last synchronous inspection of the draft owner's pending/running/dirty
 * state catches an edit that landed during the final drain's own awaits;
 * the action holds instead of looping or risking reload data loss.
 * Only a committed flush activates; failed or fenced storage holds the
 * update with an honest toast instead. Activating goes
 * through the supported update path — telling the waiting worker to take
 * over — because a plain reload can leave the old worker controlling the
 * page forever. Drafts live in scoped IndexedDB records and survive a
 * same-tab reload once committed, regardless.
 */
export function UpdatePrompt({ userId, onReload }: { userId: string; onReload?: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  const [applying, setApplying] = useState(false);
  const { needRefresh, updateServiceWorker } = useRegisterSW();
  if (!needRefresh[0] || dismissed) return null;
  const reload = async () => {
    if (applying) return;
    const hasUnsent = () => entriesForUser(userId).some(entry => entry.state !== 'saved');
    if (hasUnsent()) {
      toast('Finish sending first — an update is ready and will apply afterwards.');
      return;
    }
    setApplying(true);
    try {
      if (!await flushUserDraftSaves(userId)) {
        toast('Could not save your draft — the update is held until it is safe.');
        return;
      }
      // A send may have landed while the draft commit was held.
      if (hasUnsent()) {
        toast('Finish sending first — an update is ready and will apply afterwards.');
        return;
      }
      // Keystrokes typed during the hold scheduled fresh writes: drain them
      // in one bounded pass, then re-check once more before activating.
      if (!await flushUserDraftSaves(userId)) {
        toast('Could not save your draft — the update is held until it is safe.');
        return;
      }
      if (hasUnsent()) {
        toast('Finish sending first — an update is ready and will apply afterwards.');
        return;
      }
      // Synchronous last look: an edit may have scheduled fresh draft work
      // during the drain above. Hold rather than loop or lose it on reload.
      // No await sits between this check and activation below.
      if (hasUnsafeDrafts(userId)) {
        toast('Could not save your draft — the update is held until it is safe.');
        return;
      }
    } finally {
      setApplying(false);
    }
    if (onReload) {
      onReload();
      return;
    }
    void updateServiceWorker(true);
  };
  return (
    <div className="otis-connection text-xs" role="status">
      <span>An Otis update is ready.</span>
      <Button variant="ghost" size="sm" type="button" aria-busy={applying} disabled={applying} onClick={() => void reload()}>
        Reload to update
      </Button>
      <Button variant="ghost" size="sm" type="button" aria-label="Dismiss update" onClick={() => setDismissed(true)}>
        Later
      </Button>
    </div>
  );
}
