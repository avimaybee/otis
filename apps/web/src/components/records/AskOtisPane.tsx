/**
 * Real Otis Assistant Side Pane for Records.
 *
 * Replaces simulated canned mock responses with the authoritative,
 * live Otis conversation assistant connected to the workspace agent,
 * live SSE activity streams, tools, and real transcript.
 */

import type { RecordList, RecordRow } from './types.js';
import { ConversationScreen } from '../../ConversationScreen.js';
import { SparklesIcon, SearchDocIcon } from '../icons.js';

export interface AskOtisProposal {
  summary: string;
  changes: string[];
  applied?: boolean;
}

export interface AskOtisMessage {
  id: string;
  sender: 'user' | 'otis';
  text: string;
  timestamp: string;
  proposal?: AskOtisProposal;
}

export interface AskOtisPaneProps {
  list: RecordList;
  dirtyCount: number;
  focusedRow?: RecordRow | null;
  onClose: () => void;
  onApplyProposal?: (proposal: AskOtisProposal | undefined) => void;
  // Authoritative conversation props
  workspaceId?: string;
  userId?: string;
  members?: Record<string, string>;
  workspaces?: { id: string; name: string; role?: string }[];
  onSignOut?: () => void;
  onNavigate?: (workspace: string, chat: string | null, replace?: boolean) => void;
  onRefreshSession?: () => Promise<void>;
  chatId?: string | null;
  onSelectChat?: (chatId: string | null) => void;
  suggestedDraft?: string | null;
  /** Frozen records target for turns composed here; see ConversationScreen. */
  recordsContextProvider?: () => import('@otis/contracts').RecordsContext | null;
  /** Durable table patches from run steps; applied once per patch id. */
  onRecordsPatch?: (patch: import('@otis/contracts').RecordsPatch) => void;
}

export function AskOtisPane(props: AskOtisPaneProps) {
  const {
    list,
    dirtyCount,
    focusedRow,
    onClose,
    workspaceId = 'ws-default',
    userId = 'user-current',
    members = {},
    workspaces = [{ id: workspaceId, name: 'Workspace' }],
    onSignOut = () => {},
    onNavigate = () => {},
    onRefreshSession,
    chatId = null,
    onSelectChat,
  } = props;
  const headerBanner = (
    <div className="flex flex-col border-b border-border bg-card/60 text-xs shrink-0">
      <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
        <SparklesIcon />
        <span className="font-medium text-foreground truncate">
          {list.name} · {list.rows.length} records{dirtyCount > 0 ? ` · ${dirtyCount} unsaved edits` : ''}
        </span>
      </div>
      {focusedRow && (
        <div className="flex items-center gap-2 border-t border-border/50 px-3 py-1 text-subtle">
          <SearchDocIcon />
          <span>Active record:</span>
          <span className="font-medium text-foreground truncate">
            {focusedRow.cells[list.columns[0]?.id ?? 'name'] ?? focusedRow.id}
          </span>
        </div>
      )}
    </div>
  );

  return (
    <aside
      className="otis-records__ask-pane h-full w-full flex flex-col min-w-0 min-h-0 overflow-hidden bg-sidebar"
      aria-label="Ask Otis Assistant"
    >
      <ConversationScreen
        workspaceId={workspaceId}
        chat={chatId}
        chatParamPresent={Boolean(chatId)}
        workspaces={workspaces}
        userId={userId}
        members={members}
        onSignOut={onSignOut}
        onNavigate={(ws, nextChat) => {
          onSelectChat?.(nextChat);
          onNavigate(ws, nextChat);
        }}
        onRefreshSession={onRefreshSession}
        embedded={true}
        onClose={onClose}
        headerBanner={headerBanner}
        suggestedDraft={props.suggestedDraft}
        recordsContextProvider={props.recordsContextProvider}
        onRecordsPatch={props.onRecordsPatch}
      />
    </aside>
  );
}
