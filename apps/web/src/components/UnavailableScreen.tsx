import { Button } from './ui/button.js';

/**
 * Production offline/unavailable screen: the cached static shell explaining
 * connectivity honestly. It never asserts a renewed session or membership
 * and never calls a model; retry re-checks through the normal session path.
 */
export function UnavailableScreen({ offline, onRetry }: { offline: boolean; onRetry: () => void }) {
  return (
    <div className="otis-entry">
      <div className="otis-entry__inner">
        <h1 className="otis-entry__title text-xl font-medium">Otis is unavailable</h1>
        <p className="text-sm text-muted-foreground">
          {offline
            ? 'You appear to be offline. Saved unsent input retries when your connection returns — nothing was sent.'
            : 'We could not check your session. Try again shortly.'}
        </p>
        <Button className="otis-entry__action" type="button" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}
