/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import * as matchers from 'vitest-axe/matchers';
import { axe } from 'vitest-axe';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../src/components/Composer.js';
import { Transcript } from '../src/components/Transcript.js';
import { WorkingDisclosure } from '../src/components/Transcript.js';
import { StatusPill } from '../src/components/StatusPill.js';
import { SignInView } from '../src/components/SignInView.js';
import { UnavailableScreen } from '../src/components/UnavailableScreen.js';
import { storyCommands, storyMembers, storyMessage, storyModels, storyRun } from '../src/stories/fixtures.js';

expect.extend(matchers);

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Settled-state accessibility checks on production components with synthetic
 * data. Color contrast is verified against the approved token ratios plus
 * real-browser review; happy-dom cannot compute layout-dependent contrast, so
 * that rule stays disabled here and enabled in the Storybook a11y panel.
 */
const RULES = {
  rules: {
    'color-contrast': { enabled: false },
  },
};

async function mount(element: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => {
    root.render(element);
  });
  return {
    host,
    unmount: async () => {
      await React.act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

const composerBase = {
  running: false,
  commands: storyCommands,
  models: storyModels,
  onSend: async () => true,
  onCommand: async () => true,
};

describe('008A settled-state accessibility', () => {
  it('composer empty has named controls and no violations', async () => {
    const view = await mount(<Composer {...composerBase} />);
    expect(view.host.querySelector('textarea')).toBeTruthy();
    expect(view.host.querySelector('button[aria-label="Send"]')).toBeTruthy();
    expect(await axe(view.host, RULES)).toHaveNoViolations();
    await view.unmount();
  });

  it('composer follow-up shows a single Send slot while running', async () => {
    const view = await mount(
      <Composer {...composerBase} running draftValue="actually Friday" onStop={async () => {}} />,
    );
    expect(view.host.querySelector('button[aria-label="Send"]')).toBeTruthy();
    // Single slot: with a valid follow-up draft the composer shows Send;
    // Stop stays reachable through chat overflow, never as a second button.
    expect(view.host.querySelector('.otis-composer__field > button[aria-label="Stop Otis"]')).toBeNull();
    expect(await axe(view.host, RULES)).toHaveNoViolations();
    await view.unmount();
  });

  it('short transcript exposes a log with labelled actions', async () => {
    const view = await mount(
      <Transcript
        messages={[
          storyMessage({ content_text: 'Thai Shop wants the offer by Friday.', run_id: 'run-story-1' }),
          storyMessage({
            content_text: 'Saved. Thai Shop is warm.',
            author_kind: 'system',
            author_user_id: null,
            run_id: 'run-story-1',
          }),
        ]}
        members={storyMembers}
        currentUserId="user-hunor"
        steps={[]}
        onInspectAction={() => {}}
      />,
    );
    expect(view.host.querySelector('[role="log"]')).toBeTruthy();
    expect(await axe(view.host, RULES)).toHaveNoViolations();
    await view.unmount();
  });

  it('failed run keeps its message attached and announced', async () => {
    const view = await mount(
      <Transcript
        messages={[storyMessage({ content_text: 'Mark Thai Shop warm.', run_id: 'run-story-1' })]}
        members={storyMembers}
        currentUserId="user-hunor"
        steps={[]}
        runs={{ 'run-story-1': storyRun('failed', { run: { ...storyRun('failed').run, error_code: 'provider_stream_error' } }) }}
        onInspectAction={() => {}}
      />,
    );
    expect(view.host.querySelector('[role="status"]')).toBeTruthy();
    expect(await axe(view.host, RULES)).toHaveNoViolations();
    await view.unmount();
  });

  it('working disclosure exposes its expanded state', async () => {
    const view = await mount(
      <WorkingDisclosure
        steps={[{ id: 's1', label: 'Updating the record', state: 'succeeded', actionId: 'action-7' }]}
        finished
        expanded
        onToggle={() => {}}
        onInspectAction={() => {}}
      />,
    );
    expect(view.host.querySelector('button[aria-expanded="true"]')).toBeTruthy();
    expect(await axe(view.host, RULES)).toHaveNoViolations();
    await view.unmount();
  });

  it('status pills are text, never color-only state', async () => {
    const view = await mount(
      <div>
        <StatusPill status="warm" />
        <StatusPill status="hot" />
        <StatusPill status="cold" />
        <StatusPill status="won" />
      </div>,
    );
    expect(view.host.textContent).toContain('warm');
    expect(view.host.textContent).toContain('hot');
    expect(await axe(view.host, RULES)).toHaveNoViolations();
    await view.unmount();
  });

  it('sign-in keeps one named action with its disclosure', async () => {
    const view = await mount(<SignInView onSignedIn={() => {}} />);
    expect(view.host.querySelector('h1')?.textContent).toBe('Sign in to Otis');
    expect(view.host.querySelector('main.otis-entry')).toBeTruthy();
    expect(await axe(view.host, RULES)).toHaveNoViolations();
    await view.unmount();
  });

  it('unavailable screen keeps the retry action inside the landmark', async () => {
    const view = await mount(<UnavailableScreen offline onRetry={() => {}} />);
    expect(view.host.querySelector('h1')?.textContent).toBe('Otis is unavailable');
    expect(view.host.querySelector('main.otis-entry')).toBeTruthy();
    expect(view.host.querySelector('main.otis-entry button')?.textContent).toBe('Try again');
    expect(await axe(view.host, RULES)).toHaveNoViolations();
    await view.unmount();
  });
});
