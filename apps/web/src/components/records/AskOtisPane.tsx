import { useState, useRef, useEffect } from 'react';
import type { RecordList, RecordRow } from './types.js';
import { Button } from '../ui/button.js';
import {
  SparklesIcon, CloseIcon, SendIcon, CheckIcon,
  SearchDocIcon
} from '../icons.js';

export interface AskOtisMessage {
  id: string;
  sender: 'user' | 'otis';
  text: string;
  timestamp: string;
  proposal?: {
    summary: string;
    changes: string[];
    applied?: boolean;
  };
}

export interface AskOtisPaneProps {
  list: RecordList;
  dirtyCount: number;
  focusedRow?: RecordRow | null;
  onClose: () => void;
  onApplyProposal?: (proposal: AskOtisMessage['proposal']) => void;
}

export function AskOtisPane({
  list,
  dirtyCount,
  focusedRow,
  onClose,
  onApplyProposal,
}: AskOtisPaneProps) {
  const [messages, setMessages] = useState<AskOtisMessage[]>([
    {
      id: 'msg-1',
      sender: 'otis',
      text: `I'm viewing your ${list.name} (${list.rows.length} records${dirtyCount > 0 ? `, ${dirtyCount} unsaved edits` : ''}). What would you like to update or calculate?`,
      timestamp: 'Just now',
    },
  ]);
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isThinking]);

  const presetSuggestions = [
    'Tidy delivery notes and organize columns',
    'Add a total column using price × quantity',
    'Find leads missing phone numbers',
    'Highlight hot leads needing follow-up',
  ];

  const handleSend = (textToSend?: string) => {
    const text = (textToSend ?? input).trim();
    if (!text || isThinking) return;

    const userMsg: AskOtisMessage = {
      id: `usr-${Date.now()}`,
      sender: 'user',
      text,
      timestamp: 'Just now',
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsThinking(true);

    // Simulate smart, prompt-aware response and proposal
    setTimeout(() => {
      setIsThinking(false);
      let replyText = `I analyzed the ${list.rows.length} records in ${list.name}.`;
      let proposal: AskOtisMessage['proposal'] | undefined;

      if (text.toLowerCase().includes('total') || text.toLowerCase().includes('calculate')) {
        replyText = `I created a validated calculation column 'Total' using unit price × quantity. The values will stay updated as quantity changes.`;
        proposal = {
          summary: "Added calculated 'Total' column",
          changes: [
            "Added 'Total' column definition: Unit price × Quantity",
            'Calculated values for 3 existing product rows',
            'Kept draft uncommitted until you click Save',
          ],
        };
      } else if (text.toLowerCase().includes('tidy') || text.toLowerCase().includes('organize')) {
        replyText = `I tidied the unstructured text in notes: extracted loading gate instructions into 'Access instructions' and normalized contact details.`;
        proposal = {
          summary: 'Tidied 4 delivery notes & extracted gate codes',
          changes: [
            "Extracted gate instructions for John Klakney: 'Gate code 4492 after 6 PM'",
            "Extracted dock instructions for Tariq Mansoor: 'Loading dock B on North entrance'",
            'Retained original notes text without discarding source facts',
          ],
        };
      } else if (text.toLowerCase().includes('missing')) {
        replyText = `Found 1 lead with missing contact information: Mark Batch currently has no access instructions recorded.`;
      } else {
        replyText = `I updated the draft with your requested adjustments for ${list.name}. Your changes remain local until you click Save.`;
      }

      const otisMsg: AskOtisMessage = {
        id: `otis-${Date.now()}`,
        sender: 'otis',
        text: replyText,
        timestamp: 'Just now',
        proposal,
      };

      setMessages(prev => [...prev, otisMsg]);
    }, 800);
  };

  return (
    <aside className="otis-records__ask-pane" aria-label="Ask Otis Assistant">
      {/* Pane header */}
      <div className="flex items-center justify-between border-b border-border p-4">
        <div className="flex items-center gap-2">
          <SparklesIcon />
          <h2 className="text-sm font-medium text-foreground">Ask Otis</h2>
          <span className="rounded bg-card border border-border px-2 py-1 text-xs text-subtle">
            {list.name}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label="Close Ask Otis panel"
          className="text-muted-foreground hover:text-foreground"
        >
          <CloseIcon />
        </Button>
      </div>

      {/* Focused record badge if active */}
      {focusedRow && (
        <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-2 text-xs">
          <SearchDocIcon />
          <span className="text-subtle">Row context:</span>
          <span className="font-medium text-foreground truncate">
            {focusedRow.cells[list.columns[0]?.id ?? 'name'] ?? focusedRow.id}
          </span>
        </div>
      )}

      {/* Message history */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {messages.map(msg => (
          <div
            key={msg.id}
            className={`flex flex-col gap-1 ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div className="flex items-center gap-1 text-xs text-subtle">
              <span>{msg.sender === 'user' ? 'You' : 'Otis'}</span>
              <span>·</span>
              <span>{msg.timestamp}</span>
            </div>
            <div
              className={`rounded-lg p-3 text-sm max-w-[85%] ${
                msg.sender === 'user'
                  ? 'bg-card text-foreground'
                  : 'bg-background border border-border text-foreground'
              }`}
            >
              <p className="whitespace-pre-wrap">{msg.text}</p>

              {/* Proposal card */}
              {msg.proposal && (
                <div className="mt-3 rounded-md border border-border bg-card p-3 flex flex-col gap-2">
                  <div className="flex items-center gap-1 text-xs font-medium text-foreground">
                    <SparklesIcon />
                    <span>{msg.proposal.summary}</span>
                  </div>
                  <ul className="text-xs text-muted-foreground list-disc pl-4 flex flex-col gap-1">
                    {msg.proposal.changes.map((change, i) => (
                      <li key={i}>{change}</li>
                    ))}
                  </ul>
                  {!msg.proposal.applied ? (
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => {
                        onApplyProposal?.(msg.proposal);
                        setMessages(prev =>
                          prev.map(m =>
                            m.id === msg.id && m.proposal
                              ? { ...m, proposal: { ...m.proposal, applied: true } }
                              : m
                          )
                        );
                      }}
                      className="mt-1 gap-1 text-xs font-medium h-7"
                    >
                      <CheckIcon />
                      <span>Apply proposal to draft</span>
                    </Button>
                  ) : (
                    <span className="flex items-center gap-1 text-xs text-success pt-1">
                      <CheckIcon />
                      <span>Applied to draft</span>
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}

        {isThinking && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground p-2">
            <span className="otis-spinner" aria-hidden="true" />
            <span>Otis is organizing information…</span>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Preset suggestions */}
      <div className="border-t border-border bg-background p-3 flex flex-col gap-2">
        <span className="text-xs text-subtle">Suggested actions:</span>
        <div className="flex flex-wrap gap-1">
          {presetSuggestions.map((sug, i) => (
            <button
              key={i}
              type="button"
              onClick={() => handleSend(sug)}
              className="otis-records__chip text-xs"
            >
              {sug}
            </button>
          ))}
        </div>
      </div>

      {/* Composer footer */}
      <div className="border-t border-border p-3 bg-card flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Ask Otis to calculate, tidy, or find..."
          className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground border-0 focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button
          type="button"
          size="icon-xs"
          onClick={() => handleSend()}
          disabled={!input.trim() || isThinking}
          className="size-7 rounded-full p-0"
          aria-label="Send to Otis"
        >
          <SendIcon />
        </Button>
      </div>
    </aside>
  );
}
