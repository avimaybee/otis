import { Collapsible } from 'radix-ui';
import { ChevronDownIcon } from './icons.js';
import type { ThinkingBlock } from '../api/thinking.js';

/**
 * One nested Thinking disclosure inside expanded Working. Renders only after
 * displayable provider content exists; collapsed initially with manual choice
 * preserved by the uncontrolled Collapsible. Blocks keep provider round/block
 * boundaries in original order. Summaries and provider-exposed reasoning are
 * labeled as such, never as complete private thoughts. No Undo: reasoning
 * text is tentative provider output, not a committed business fact.
 */
export function ThinkingDisclosure({
  blocks,
  defaultOpen = false,
  active = false,
  finished = false,
  isWaiting = false,
}: {
  blocks: ThinkingBlock[];
  defaultOpen?: boolean;
  active?: boolean;
  finished?: boolean;
  isWaiting?: boolean;
}) {
  if (blocks.length === 0) return null;
  let lastAttribution = '';
  return (
    <Collapsible.Root className="otis-thinking mt-2 flex flex-col gap-2" defaultOpen={defaultOpen}>
      <Collapsible.Trigger className="otis-thinking__trigger flex min-h-8 items-center gap-2 text-xs text-muted-foreground">
        {active && !isWaiting && (
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-highlight otis-working__pulse-dot--active" />
        )}
        {isWaiting && (
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-muted-foreground/60" />
        )}
        <span className="size-4 text-subtle" aria-hidden="true"><ChevronDownIcon /></span>
        <span className={active && !isWaiting ? 'otis-working__label--active' : undefined}>
          {finished ? 'Thought' : isWaiting ? 'Paused · Needs your answer' : active ? 'Thinking…' : 'Thinking'}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Content className="flex flex-col gap-2">
        {blocks.map(block => {
          const attribution = `${block.provider ?? 'Provider'} · ${block.contentKind === 'provider_reasoning' ? 'exposed reasoning' : 'summary'}${
            block.roundIndex > 0 ? ` · round ${block.roundIndex + 1}` : ''
          }`;
          const showAttribution = attribution !== lastAttribution;
          lastAttribution = attribution;
          return (
            <div key={block.key} className="flex flex-col gap-1">
              {showAttribution && <p className="text-xs text-subtle">{attribution}</p>}
              <p className="whitespace-pre-wrap text-xs text-muted-foreground">{block.text}</p>
              {block.state === 'interrupted' && <p className="text-xs text-subtle">Interrupted. Kept what arrived.</p>}
              {block.state === 'truncated' && <p className="text-xs text-subtle">Thinking truncated. The answer is unaffected.</p>}
            </div>
          );
        })}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
