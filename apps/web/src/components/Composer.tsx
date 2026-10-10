import { useEffect, useId, useRef, useState } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import type { CommandDescriptor, ModelOption, VoiceMediaSummary } from '@otis/contracts';
import { DOMAIN_BOUNDS, IMAGE_BOUNDS, DOCUMENT_BOUNDS } from '@otis/contracts';
import { cancelDraftSave, deleteDraft, draftSession, flushDraftSaves, loadDraft, scheduleDraftSave } from '../api/drafts.js';
import type { VoiceUploadAdapter } from '../api/voice.js';
import { validateImageFile, type ImageUploadRequest, type ImageUploadResult } from '../api/images.js';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { useVoiceRecorder, type VoiceController, type VoiceRecorderEnvironment, type VoiceRecorderScope } from '../hooks/useVoiceRecorder.js';
import { ChevronDownIcon, CloseIcon, FileTextIcon, ImageIcon, MicIcon, PlusIcon, SendIcon, StopIcon } from './icons.js';
import { VoiceCapturePanel } from './VoiceCapturePanel.js';
import { Command, CommandItem, CommandList } from './ui/command.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';

export interface VoiceComposerConfig {
  /** True only when the server reports a usable route and an adapter is confirmed. */
  available: boolean;
  adapter?: VoiceUploadAdapter | null;
  scope?: VoiceRecorderScope;
  environment?: VoiceRecorderEnvironment;
  /** Story/test seam: replaces the internal recorder hook entirely. */
  controller?: VoiceController;
  /** Resolves only after durable outbox acceptance; rejection retains local bytes. */
  onSent?: (result: { clientMessageId: string; media: VoiceMediaSummary; durationMs: number; mimeType: string; chatId?: string }) => Promise<void>;
}
export interface ImageComposerConfig {
  /** True when the chat scope can take attachments (workspace always; chat ensured at send). */
  available: boolean;
  workspaceId: string;
  chatId: string | null;
  /** Creates the conversation for a first message, or returns the active id. Null aborts the send. */
  onEnsureChat: () => Promise<string | null>;
  /** Claim/PUT/finalize handoff for one file; resolves only with a server media identity. */
  upload: (request: ImageUploadRequest) => Promise<ImageUploadResult>;
  /** Story/test seam: bypasses the transport with scripted results. */
  controller?: ImageAttachmentController;
}
export interface ImageAttachment {
  id: string;
  file: File;
  previewUrl: string;
  status: 'ready' | 'uploading' | 'done' | 'error';
  mediaId?: string;
  error?: string;
}
export interface ImageAttachmentController {
  attachments: ImageAttachment[];
  addFiles: (files: File[]) => void;
  remove: (id: string) => void;
  clear: () => void;
}
export interface DocumentAttachment {
  id: string;
  file: File;
  name: string;
  size: number;
  status: 'ready' | 'uploading' | 'done' | 'error';
  mediaId?: string;
  error?: string;
  isPastedText?: boolean;
}
export interface DocumentAttachmentController {
  attachments: DocumentAttachment[];
  addFiles: (files: File[], isPastedText?: boolean) => string[];
  remove: (id: string) => void;
  clear: () => void;
}
export interface DocumentComposerConfig {
  available: boolean;
  workspaceId: string;
  userId?: string;
  chatId: string | null;
  onEnsureChat: () => Promise<string | null>;
  upload: (request: { workspaceId: string; file: File; uploadId: string; userId: string }) => Promise<{ mediaId: string; filename: string }>;
  controller?: DocumentAttachmentController;
}
export interface ComposerProps {
  disabled?: boolean; disabledReason?: string; running: boolean;
  commands: CommandDescriptor[]; models?: ModelOption[]; workspaces?: { id: string; name: string }[];
  placeholder?: string; draftKey?: string; draftValue?: string | null;
  controlPending?: boolean; modelReady?: boolean; modelsLoading?: boolean; voice?: VoiceComposerConfig;
  images?: ImageComposerConfig;
  documents?: DocumentComposerConfig;
  modelsError?: string; onRetryModels?: () => void;
  onCommand?: (text: string) => Promise<boolean>;
  onStop?: () => Promise<void>;
  onSend: (
    text: string,
    imageMediaIds?: string[],
    extra?: { documentMediaIds?: string[]; isPastedText?: boolean },
  ) => void | boolean | Promise<boolean>;
}
export interface SuggestionItem { name: string; label?: string; summary: string; insert: string; hasSubmenu?: boolean; }
export function Composer({ disabled, disabledReason, running, commands, models = [], workspaces = [],
  placeholder = 'Message Otis', draftKey, draftValue, controlPending, modelReady = true, modelsLoading = false, voice, images, documents, modelsError, onRetryModels, onCommand, onStop, onSend }: ComposerProps) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false);
  const [value, setValue] = useState('');
  // Drafts live in the scoped IndexedDB module; the component keeps its own
  // value while mounted and schedules debounced persists there. Each
  // scheduled write carries the owner session observed at keystroke time,
  // so a trailing save can never resurrect input after logout. Storage
  // failure never blocks typing: the in-memory draft stays fully usable.
  const valueRef = useRef('');
  const commitDraft = (next: string) => {
    setValue(next);
    valueRef.current = next;
    if (draftKey) scheduleDraftSave(draftKey, next);
  };
  const clearDraft = () => {
    setValue('');
    valueRef.current = '';
    if (draftKey) {
      cancelDraftSave(draftKey);
      void deleteDraft(draftKey);
    }
  };
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const [index, setIndex] = useState(0);
  const desktop = useMediaQuery('(min-width: 900px) and (pointer: fine)');
  // Attached still images are session-local previews, never drafted: each
  // file carries a stable upload UUID so a retried handoff reuses one media
  // identity, and object URLs are revoked on remove/send/unmount.
  const fileInput = useRef<HTMLInputElement>(null);
  const docFileInput = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const attachmentsRef = useRef<ImageAttachment[]>([]);
  const [docAttachments, setDocAttachments] = useState<DocumentAttachment[]>([]);
  const docAttachmentsRef = useRef<DocumentAttachment[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const [pasteUndoSnapshot, setPasteUndoSnapshot] = useState<{
    draft: string;
    selectionStart: number;
    selectionEnd: number;
    attachmentId: string;
  } | null>(null);

  const setAttachmentList = (next: ImageAttachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  };
  const setDocAttachmentList = (next: DocumentAttachment[]) => {
    docAttachmentsRef.current = next;
    setDocAttachments(next);
  };
  const revokeAttachments = (list: ImageAttachment[]) => {
    for (const attachment of list) URL.revokeObjectURL(attachment.previewUrl);
  };
  useEffect(() => () => revokeAttachments(attachmentsRef.current), []);
  const patchAttachment = (id: string, patch: Partial<ImageAttachment>) => {
    setAttachmentList(attachmentsRef.current.map(item => (item.id === id ? { ...item, ...patch } : item)));
  };
  const internalAttachments: ImageAttachmentController = {
    attachments,
    addFiles: files => {
      const room = IMAGE_BOUNDS.MAX_PER_MESSAGE - attachmentsRef.current.length;
      if (room <= 0) {
        setError(`At most ${IMAGE_BOUNDS.MAX_PER_MESSAGE} photos per message.`);
        return;
      }
      const accepted: ImageAttachment[] = [];
      for (const file of files.slice(0, room)) {
        const gate = validateImageFile(file);
        if (!gate.valid) {
          setError(gate.message);
          continue;
        }
        accepted.push({
          id: crypto.randomUUID(),
          file,
          previewUrl: URL.createObjectURL(file),
          status: 'ready',
        });
      }
      if (accepted.length > 0) {
        setError('');
        setAttachmentList([...attachmentsRef.current, ...accepted]);
      }
    },
    remove: id => {
      const target = attachmentsRef.current.find(item => item.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      setAttachmentList(attachmentsRef.current.filter(item => item.id !== id));
    },
    clear: () => {
      revokeAttachments(attachmentsRef.current);
      setAttachmentList([]);
    },
  };
  const imageController = images?.controller ?? internalAttachments;

  const validateDocFile = (file: File): { valid: boolean; message: string } => {
    const lower = file.name.toLowerCase();
    const isPdf = lower.endsWith('.pdf') || file.type === 'application/pdf';
    const isTxt = lower.endsWith('.txt') || file.type === 'text/plain';
    const isMd = lower.endsWith('.md') || file.type === 'text/markdown';

    if (!isPdf && !isTxt && !isMd) {
      return { valid: false, message: 'Only PDF, text, and Markdown files are supported.' };
    }
    if (isPdf && file.size > DOCUMENT_BOUNDS.MAX_DOCUMENT_BYTES) {
      return { valid: false, message: 'PDF files must be 20 MiB or smaller.' };
    }
    if ((isTxt || isMd) && file.size > DOCUMENT_BOUNDS.MAX_TEXT_BYTES) {
      return { valid: false, message: 'Text and Markdown files must be 2 MiB or smaller.' };
    }
    return { valid: true, message: '' };
  };

  const internalDocAttachments: DocumentAttachmentController = {
    attachments: docAttachments,
    addFiles: (files, isPastedText) => {
      const room = DOCUMENT_BOUNDS.MAX_PER_MESSAGE - docAttachmentsRef.current.length;
      if (room <= 0) {
        setError(`At most ${DOCUMENT_BOUNDS.MAX_PER_MESSAGE} documents per message.`);
        return [];
      }
      const accepted: DocumentAttachment[] = [];
      for (const file of files.slice(0, room)) {
        const gate = validateDocFile(file);
        if (!gate.valid) {
          setError(gate.message);
          continue;
        }
        accepted.push({
          id: crypto.randomUUID(),
          file,
          name: file.name,
          size: file.size,
          status: 'ready',
          isPastedText,
        });
      }
      if (accepted.length > 0) {
        setError('');
        setDocAttachmentList([...docAttachmentsRef.current, ...accepted]);
      }
      return accepted.map(a => a.id);
    },
    remove: id => {
      setDocAttachmentList(docAttachmentsRef.current.filter(item => item.id !== id));
      if (pasteUndoSnapshot?.attachmentId === id) {
        setPasteUndoSnapshot(null);
        setAnnouncement('');
      }
    },
    clear: () => {
      setDocAttachmentList([]);
      setPasteUndoSnapshot(null);
      setAnnouncement('');
    },
  };
  const docController = documents?.controller ?? internalDocAttachments;
  // The internal recorder only runs when the composer owns the capture scope
  // and no story/test controller was injected. Capture never touches the
  // typed draft: the field is swapped out visually, not cleared.
  const internalVoice = useVoiceRecorder({
    scope: voice?.scope ?? null,
    adapter: voice?.adapter ?? null,
    environment: voice?.environment,
    enabled: Boolean(voice?.scope) && !voice?.controller,
    onSent: voice?.onSent,
  });
  const voiceController = voice?.controller ?? internalVoice;
  const voiceActive = voiceController.phase === 'recording'
    || voiceController.phase === 'finalizing'
    || voiceController.phase === 'review';
  // The composer is ordinary chat only: answers travel through the explicit
  // question panel, so photos and the mic stay visible here. Voice notes
  // never carry a question identity.
  const micVisible = Boolean(voice?.available) && !voiceActive;
  const voiceError = voiceActive ? null : voiceController.error;
  const voiceStorageWarning = voiceController.phase === 'recording' && !voiceController.durable
    ? 'This recording is not saved in the browser. Keep this tab open.'
    : '';
  const tooLong = value.length > DOMAIN_BOUNDS.MAX_INPUT_CHARS;
  const current = models.find(model => model.is_current);
  const modelQuery = /^\/model\s+(.*)$/i.exec(value);
  const thinkingQuery = /^\/thinking\s+(.*)$/i.exec(value);
  const workspaceQuery = /^\/workspace\s+(.*)$/i.exec(value);
  // A double slash is literal text, never a command.
  const isSlash = !value.startsWith('//') && /^\/\S*\s*[^\n]*$/.test(value);
  const root = commands.filter(command => command.available && command.name.toLowerCase().includes(value.slice(1).trim().toLowerCase())).map(command => ({
    name: command.name, label: `/${command.name}`, summary: command.summary,
    insert: `/${command.name}${['model', 'thinking', 'workspace'].includes(command.name) ? ' ' : ''}`,
  }));
  const suggestions: SuggestionItem[] = modelQuery
    ? [{ name: 'default', label: 'Workspace default', summary: models.find(model => model.is_default)?.display_name ?? 'No default model', insert: '/model default' }, ...models.filter(model => model.available).map(model => ({ name: model.command_key, label: model.display_name, summary: '', insert: `/model ${model.command_key}` }))].filter(row => `${row.name} ${row.label}`.toLowerCase().includes(modelQuery[1]!.toLowerCase()))
    : thinkingQuery
    ? (current?.thinking?.state === 'supported' ? [{ name: 'default', label: 'Provider default', summary: '', insert: '/thinking default' }, ...current.thinking.choices.map(choice => ({ name: choice.id, label: choice.label, summary: '', insert: `/thinking ${choice.id}` }))].filter(row => `${row.name} ${row.label}`.toLowerCase().includes(thinkingQuery[1]!.toLowerCase())) : [])
    : workspaceQuery
    ? workspaces.filter(workspace => workspace.name.toLowerCase().includes(workspaceQuery[1]!.toLowerCase())).map(workspace => ({ name: workspace.id, label: workspace.name, summary: '', insert: `/workspace ${workspace.name}` }))
    : root;
  const pickerOpen = !disabled && !dismissed && isSlash && suggestions.length > 0;
  const activeIndex = Math.min(index, Math.max(0, suggestions.length - 1));

  useEffect(() => { if (draftValue !== undefined && draftValue !== null) { commitDraft(draftValue); setDismissed(false); input.current?.focus(); } }, [draftValue]);
  useEffect(() => {
    if (!draftKey) return;
    const key = draftKey;
    const session = draftSession(key);
    let live = true;
    void loadDraft(key).then(text => {
      // Explicit edits and keystrokes since mount always win over storage. A
      // null mount session means this instance never observed the owner: the
      // load above adopted the persisted generation, so its result IS the
      // authenticated session and is accepted (this is the normal
      // reload/remount path). Otherwise a session move mid-hydration means a
      // purge landed — drop it instead of filling abolished input.
      if (live && text != null && (session === null || draftSession(key) === session)) {
        setValue(current => (current === '' ? text : current));
      }
    });
    return () => {
      live = false;
      // Flush a trailing debounced write so reload recovers the last word.
      // The flush replays the keystroke-time owner session, never a fresh
      // one, so an unmount after logout cannot resurrect purged input.
      flushDraftSaves(key);
    };
  }, [draftKey]);

  const command = async (text: string, clearCommandDraft = false) => {
    if (!onCommand || controlPending) return false;
    setError('');
    try { const applied = await onCommand(text); if (applied && clearCommandDraft) { if (valueRef.current.trim() === value.trim()) clearDraft(); } return applied; }
    catch { setError('Could not apply that command. Try again.'); return false; }
  };
  const select = async (selected: number) => {
    const row = suggestions[selected]; if (!row) return;
    if (row.insert.endsWith(' ')) { commitDraft(row.insert); setIndex(0); return; }
    setDismissed(true); await command(row.insert, true); input.current?.focus();
  };
  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (event.clipboardData.files && event.clipboardData.files.length > 0) {
      const imgFiles = Array.from(event.clipboardData.files).filter(f => f.type.startsWith('image/'));
      if (imgFiles.length > 0 && images?.available) {
        event.preventDefault();
        imageController.addFiles(imgFiles);
        return;
      }
    }
    const pasted = event.clipboardData.getData('text/plain');
    if (!pasted) return;

    const el = event.currentTarget;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const prefix = value.slice(0, start);
    const suffix = value.slice(end);
    const prospective = prefix + pasted + suffix;

    if (prospective.length <= DOMAIN_BOUNDS.MAX_INPUT_CHARS) {
      return;
    }

    event.preventDefault();

    const utf8Bytes = new TextEncoder().encode(pasted).length;
    if (utf8Bytes > DOCUMENT_BOUNDS.MAX_TEXT_BYTES) {
      setError('Pasted text exceeds the 2 MiB file limit.');
      return;
    }

    const room = DOCUMENT_BOUNDS.MAX_PER_MESSAGE - docController.attachments.length;
    if (room <= 0) {
      setError('Remove an attachment to add this pasted text.');
      return;
    }

    const surrounding = prefix + suffix;

    if (surrounding.length <= DOMAIN_BOUNDS.MAX_INPUT_CHARS) {
      const file = new File([new Blob([pasted], { type: 'text/plain;charset=utf-8' })], 'Pasted text.txt', { type: 'text/plain' });
      const addedIds = docController.addFiles([file], true) ?? [];
      const attachmentId = addedIds[0] ?? '';
      commitDraft(surrounding);
      setPasteUndoSnapshot({
        draft: prospective,
        selectionStart: start,
        selectionEnd: start + pasted.length,
        attachmentId,
      });
      setAnnouncement('Long text attached as a file. You can add instructions and send.');
      setTimeout(() => {
        if (input.current) {
          input.current.selectionStart = start;
          input.current.selectionEnd = start;
        }
      }, 0);
    } else {
      const file = new File([new Blob([prospective], { type: 'text/plain;charset=utf-8' })], 'Pasted text.txt', { type: 'text/plain' });
      const addedIds = docController.addFiles([file], true) ?? [];
      const attachmentId = addedIds[0] ?? '';
      commitDraft('');
      setPasteUndoSnapshot({
        draft: prospective,
        selectionStart: start,
        selectionEnd: start + pasted.length,
        attachmentId,
      });
      setAnnouncement('Long text attached as a file. You can add instructions and send.');
    }
  };

  const handleUndoPaste = () => {
    if (!pasteUndoSnapshot) return;
    docController.remove(pasteUndoSnapshot.attachmentId);
    commitDraft(pasteUndoSnapshot.draft);
    const start = pasteUndoSnapshot.selectionStart;
    const end = pasteUndoSnapshot.selectionEnd;
    setPasteUndoSnapshot(null);
    setAnnouncement('');
    setTimeout(() => {
      if (input.current) {
        input.current.focus();
        input.current.selectionStart = start;
        input.current.selectionEnd = end;
      }
    }, 0);
  };

  const handleConvertDraftToAttachment = () => {
    const utf8Bytes = new TextEncoder().encode(value).length;
    if (utf8Bytes > DOCUMENT_BOUNDS.MAX_TEXT_BYTES) {
      setError('Draft text exceeds the 2 MiB limit.');
      return;
    }
    const room = DOCUMENT_BOUNDS.MAX_PER_MESSAGE - docController.attachments.length;
    if (room <= 0) {
      setError('Remove an attachment to add this text.');
      return;
    }
    const file = new File([new Blob([value], { type: 'text/plain;charset=utf-8' })], 'Pasted text.txt', { type: 'text/plain' });
    docController.addFiles([file], true);
    commitDraft('');
    setAnnouncement('Long text attached as a file. You can add instructions and send.');
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (disabled || sending) return;
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    if (disabled || sending) return;
    e.preventDefault();
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (!droppedFiles.length) return;
    const imageFiles: File[] = [];
    const docFiles: File[] = [];
    for (const f of droppedFiles) {
      if (f.type.startsWith('image/')) {
        imageFiles.push(f);
      } else {
        docFiles.push(f);
      }
    }
    if (imageFiles.length && images?.available) {
      imageController.addFiles(imageFiles);
    }
    if (docFiles.length && documents?.available) {
      docController.addFiles(docFiles);
    }
  };

  const submit = async () => {
    const text = value.trim();
    const pendingImages = imageController.attachments;
    const pendingDocs = docController.attachments;
    const hasImages = Boolean(images) && pendingImages.length > 0;
    const hasDocs = Boolean(documents) && pendingDocs.length > 0;
    if ((!text && !hasImages && !hasDocs) || disabled || sendingRef.current || tooLong || controlPending) return;
    // A double slash is literal text (product command escape), never a command.
    if (text.startsWith('/') && !text.startsWith('//') && !hasImages && !hasDocs) { await command(text, true); return; }
    if (!modelReady) return;

    let imageMediaIds: string[] | undefined;
    if (hasImages && images && !images.controller) {
      const chatId = images.chatId ?? await images.onEnsureChat();
      if (!chatId) {
        setError('Could not open a conversation. Try again.');
        return;
      }
      const uploaded: string[] = [];
      for (const attachment of pendingImages) {
        if (attachment.status === 'done' && attachment.mediaId) {
          uploaded.push(attachment.mediaId);
          continue;
        }
        patchAttachment(attachment.id, { status: 'uploading', error: undefined });
        try {
          const result = await images.upload({
            workspaceId: images.workspaceId,
            chatId,
            clientMessageId: attachment.id,
            file: attachment.file,
          });
          patchAttachment(attachment.id, { status: 'done', mediaId: result.mediaId });
          uploaded.push(result.mediaId);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Photo upload failed. Try again.';
          patchAttachment(attachment.id, { status: 'error', error: message });
          setError(message);
          return;
        }
      }
      imageMediaIds = uploaded;
    } else if (hasImages && images?.controller) {
      imageMediaIds = pendingImages.map(attachment => attachment.mediaId ?? attachment.id);
    }

    let documentMediaIds: string[] | undefined;
    let isPastedText = false;
    if (hasDocs && documents && !documents.controller) {
      const chatId = documents.chatId ?? await documents.onEnsureChat();
      if (!chatId) {
        setError('Could not open a conversation. Try again.');
        return;
      }
      const uploadedDocs: string[] = [];
      for (const attachment of pendingDocs) {
        if (attachment.isPastedText) isPastedText = true;
        if (attachment.status === 'done' && attachment.mediaId) {
          uploadedDocs.push(attachment.mediaId);
          continue;
        }
        setDocAttachmentList(
          docAttachmentsRef.current.map(item => item.id === attachment.id ? { ...item, status: 'uploading', error: undefined } : item)
        );
        try {
          const result = await documents.upload({
            workspaceId: documents.workspaceId,
            file: attachment.file,
            uploadId: attachment.id,
            userId: documents.userId ?? '',
          });
          setDocAttachmentList(
            docAttachmentsRef.current.map(item => item.id === attachment.id ? { ...item, status: 'done', mediaId: result.mediaId } : item)
          );
          uploadedDocs.push(result.mediaId);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Document upload failed. Try again.';
          setDocAttachmentList(
            docAttachmentsRef.current.map(item => item.id === attachment.id ? { ...item, status: 'error', error: message } : item)
          );
          setError(message);
          return;
        }
      }
      documentMediaIds = uploadedDocs;
    } else if (hasDocs && documents?.controller) {
      documentMediaIds = pendingDocs.map(attachment => attachment.mediaId ?? attachment.id);
      isPastedText = pendingDocs.some(a => a.isPastedText);
    }

    // The submitted snapshot is accepted locally here: the outbox entry owns
    // retry and redraft, so the composer clears without waiting for HTTP and
    // a second message can submit immediately with its own identity.
    sendingRef.current = true;
    clearDraft();
    const sentAttachments = imageController.attachments;
    if (!images?.controller) {
      revokeAttachments(sentAttachments);
      setAttachmentList([]);
    }
    if (!documents?.controller) {
      setDocAttachmentList([]);
    }
    setPasteUndoSnapshot(null);
    setAnnouncement('');
    if (fileInput.current) fileInput.current.value = '';
    if (docFileInput.current) docFileInput.current.value = '';
    setSending(true); setError('');
    sendingRef.current = false;
    try {
      if (documentMediaIds?.length || isPastedText) {
        await onSend(text, imageMediaIds, { documentMediaIds, isPastedText });
      } else if (imageMediaIds?.length) {
        await onSend(text, imageMediaIds);
      } else {
        await onSend(text);
      }
    } catch { setError('Message not confirmed. It is kept in the conversation with Retry.'); }
    finally { setSending(false); }
  };
  const stop = async () => { if (!onStop || stopping) return; setStopping(true); setError(''); try { await onStop(); } catch { setError('Could not stop yet. Try again.'); } finally { setStopping(false); } };

  const currentModelLabel = current?.display_name ?? 'Model';
  const currentThinking = current?.thinking;
  const currentThinkingLabel =
    !currentThinking || currentThinking.is_default || !currentThinking.current_choice_id
      ? 'Provider default'
      : (currentThinking.choices.find(c => c.id === currentThinking.current_choice_id)?.label ?? 'Provider default');
  const followsDefault = !models.some(m => m.is_current && !m.is_default);
  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  const attachImages = Boolean(images?.available) && !voiceActive;
  const attachDocs = Boolean(documents?.available) && !voiceActive;
  const hasContent = value.trim() !== '' || imageController.attachments.length > 0 || docController.attachments.length > 0;
  const statusText = tooLong
    ? `Keep the message under ${DOMAIN_BOUNDS.MAX_INPUT_CHARS.toLocaleString()} characters.`
    : announcement || voiceError || error || (modelsLoading ? 'Checking available model…' : !modelReady ? 'Choose a model to start. Connections are in Settings.' : voiceStorageWarning || '');

  return <div className="otis-composer"><div className="otis-composer__inner">
    {pickerOpen && <Command label={modelQuery ? 'Models' : thinkingQuery ? 'Thinking effort options' : 'Commands'} value={suggestions[activeIndex]?.insert ?? ''} onValueChange={next => { const found = suggestions.findIndex(row => row.insert === next); if (found >= 0) setIndex(found); }} shouldFilter={false} loop>
      <CommandList id={`${id}-picker`}>
        {suggestions.map((row, rowIndex) => <CommandItem key={row.name} id={`${id}-option-${rowIndex}`} value={row.insert} disabled={controlPending} onSelect={() => void select(rowIndex)}><span>{row.label}</span>{row.summary && <small className="text-xs">{row.summary}</small>}</CommandItem>)}
      </CommandList>
    </Command>}
    <div className="otis-composer__field flex flex-col gap-2" onDragOver={handleDragOver} onDrop={handleDrop}>
      {imageController.attachments.length > 0 && (
        <div className="otis-composer__attachments flex gap-2 overflow-x-auto" role="list" aria-label="Attached photos">
          {imageController.attachments.map(attachment => (
            <div key={attachment.id} role="listitem" className="relative shrink-0">
              <img
                src={attachment.previewUrl}
                alt="Attached file preview"
                className="h-20 w-20 rounded-xl border border-border/40 object-cover"
              />
              {attachment.status === 'uploading' && (
                <span className="absolute inset-0 grid place-items-center rounded-xl bg-card/60" aria-label="Uploading photo">
                  <span className="otis-spinner" aria-hidden="true" />
                </span>
              )}
              {attachment.status === 'error' && (
                <span className="absolute inset-x-0 bottom-0 rounded-b-xl bg-destructive/90 px-1 text-xs text-destructive-foreground" role="alert">
                  Failed
                </span>
              )}
              <button
                type="button"
                className="otis-attach-remove absolute -right-2 -top-2 grid size-6 place-items-center rounded-full border border-border bg-card text-muted-foreground hover:text-foreground"
                aria-label="Remove photo"
                disabled={sending}
                onClick={() => imageController.remove(attachment.id)}
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
      )}
      {docController.attachments.length > 0 && (
        <div className="otis-composer__doc-attachments flex flex-wrap gap-2" role="list" aria-label="Attached documents">
          {docController.attachments.map(doc => (
            <div
              key={doc.id}
              role="listitem"
              className="relative flex items-center gap-2 rounded-xl border border-border/60 bg-secondary/30 px-3 py-1 text-xs text-foreground"
            >
              <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
              <div className="flex flex-col min-w-0 max-w-44">
                <span className="truncate font-medium">{doc.name}</span>
                <span className="text-xs text-muted-foreground">{formatBytes(doc.size)}</span>
              </div>
              {doc.status === 'uploading' && (
                <span className="otis-spinner size-3.5 shrink-0" aria-label="Uploading file" />
              )}
              {doc.status === 'error' && (
                <span className="text-destructive font-medium shrink-0" role="alert">Failed</span>
              )}
              <button
                type="button"
                className="otis-attach-remove ml-1 grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-card hover:text-foreground cursor-pointer"
                aria-label="Remove document"
                disabled={sending}
                onClick={() => docController.remove(doc.id)}
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
      )}
      {voiceActive ? (
        <div className="flex min-h-[76px] items-center gap-1 rounded-2xl bg-card px-3 py-2 nav:min-h-[56px]">
          <VoiceCapturePanel
            controller={voiceController}
            canSend={Boolean(voice?.adapter) && Boolean(voice?.scope?.workspaceId)}
            onCancel={() => voiceController.cancel()}
            onSend={() => void voiceController.send()}
          />
        </div>
      ) : (
        <div className="grid min-h-[76px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 rounded-2xl border border-border/40 bg-card py-2 pr-2 pl-3 transition-colors duration-150 focus-within:border-border">
          <label className="otis-visually-hidden" htmlFor={id}>{placeholder}</label>
          <TextareaAutosize id={id} ref={input} name="message" minRows={1} maxRows={6} className="otis-composer__input col-span-2 col-start-1 row-start-1 max-h-36 min-h-6 w-full min-w-0 resize-none bg-transparent text-base leading-6 outline-none placeholder:text-muted-foreground" placeholder={disabled ? disabledReason ?? placeholder : placeholder} autoComplete="off" value={value} disabled={disabled}
            {...(statusText ? { 'aria-describedby': `${id}-status` } : {})} aria-haspopup="listbox" aria-expanded={pickerOpen ? 'true' : undefined} aria-controls={pickerOpen ? `${id}-picker` : undefined} aria-activedescendant={pickerOpen && suggestions[activeIndex] ? `${id}-option-${activeIndex}` : undefined} aria-autocomplete="list"
            onChange={event => { commitDraft(event.target.value); setDismissed(false); setIndex(0); }}
            onPaste={handlePaste}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (pickerOpen) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length); return; }
                if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return; }
                if (event.key === 'Tab' || event.key === 'Enter') { event.preventDefault(); void select(activeIndex); return; }
              }
              if (event.key === 'Enter' && desktop && !event.shiftKey) { event.preventDefault(); void submit(); }
            }} />
          <div className="col-start-1 row-start-2 flex min-h-5 min-w-0 items-center">
              {modelsError ? (
                <div className="flex min-w-0 items-center gap-2 text-xs text-destructive" role="alert">
                  <span className="truncate">{modelsError}</span>
                  {onRetryModels && (
                    <button type="button" className="shrink-0 underline hover:text-foreground" onClick={onRetryModels}>
                      Retry
                    </button>
                  )}
                </div>
              ) : models.length > 0 && current ? (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-[22px] min-w-0 max-w-36 items-center gap-1 truncate rounded-full border border-border bg-secondary/40 px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer select-none"
                      disabled={controlPending}
                      aria-label="Select model and thinking effort"
                    >
                      <span className="truncate font-medium">{currentModelLabel}</span>
                      {currentThinking?.state === 'supported' && currentThinkingLabel !== 'Provider default' && (
                        <span className="shrink-0 text-subtle">· {currentThinkingLabel}</span>
                      )}
                      <ChevronDownIcon />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="top" className="w-56" aria-label="Select model">
                    <DropdownMenuLabel>Model</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={followsDefault ? 'default' : current.command_key}
                      onValueChange={key => { void onCommand?.(`/model ${key}`); }}
                    >
                      <DropdownMenuRadioItem value="default" disabled={controlPending}>
                        <div className="flex flex-col">
                          <span className="font-medium">Workspace default</span>
                          <span className="text-xs text-muted-foreground">
                            {models.find(m => m.is_default)?.display_name ?? 'No default model'}
                          </span>
                        </div>
                      </DropdownMenuRadioItem>
                      {models.filter(m => m.available).map(m => (
                        <DropdownMenuRadioItem key={m.command_key} value={m.command_key} disabled={controlPending}>
                          <span className="font-medium">{m.display_name}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>

                    {currentThinking?.state === 'supported' && currentThinking.choices.length > 0 && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>Thinking effort</DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                          value={currentThinking.is_default ? 'default' : currentThinking.current_choice_id ?? 'default'}
                          onValueChange={key => { void onCommand?.(`/thinking ${key}`); }}
                        >
                          <DropdownMenuRadioItem value="default" disabled={controlPending}>Provider default</DropdownMenuRadioItem>
                          {currentThinking.choices.map(choice => (
                            <DropdownMenuRadioItem key={choice.id} value={choice.id} disabled={controlPending}>
                              {choice.label}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>

            <div className="col-start-2 row-start-2 flex items-center gap-1 shrink-0">
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="otis-visually-hidden"
                aria-hidden="true"
                tabIndex={-1}
                disabled={disabled || sending}
                onChange={event => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = '';
                  if (files.length > 0) imageController.addFiles(files);
                }}
              />
              <input
                ref={docFileInput}
                type="file"
                accept="application/pdf,text/plain,text/markdown,.pdf,.txt,.md"
                multiple
                className="otis-visually-hidden"
                aria-hidden="true"
                tabIndex={-1}
                disabled={disabled || sending}
                onChange={event => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = '';
                  if (files.length > 0) docController.addFiles(files);
                }}
              />
              {attachImages && !attachDocs && (
                <button
                  type="button"
                  className="otis-composer__action grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground nav:size-8"
                  aria-label="Attach photos"
                  disabled={disabled || sending}
                  onClick={() => fileInput.current?.click()}
                >
                  <PlusIcon />
                </button>
              )}
              {!attachImages && attachDocs && (
                <button
                  type="button"
                  className="otis-composer__action grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground nav:size-8"
                  aria-label="Attach files"
                  disabled={disabled || sending}
                  onClick={() => docFileInput.current?.click()}
                >
                  <PlusIcon />
                </button>
              )}
              {attachImages && attachDocs && (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="otis-composer__action grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground nav:size-8"
                      aria-label="Attach"
                      disabled={disabled || sending}
                    >
                      <PlusIcon />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" side="top" className="w-40">
                    <DropdownMenuItem
                      className="cursor-pointer"
                      aria-label="Attach photos"
                      onClick={() => fileInput.current?.click()}
                    >
                      <ImageIcon className="mr-2 size-4" />
                      <span>Photos</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="cursor-pointer"
                      aria-label="Attach files"
                      onClick={() => docFileInput.current?.click()}
                    >
                      <FileTextIcon className="mr-2 size-4" />
                      <span>Files</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {micVisible && (
                <button
                  type="button"
                  className="otis-composer__action grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground nav:size-8"
                  aria-label={voiceController.phase === 'requesting' ? 'Starting recording' : 'Record voice note'}
                  aria-busy={voiceController.phase === 'requesting'}
                  disabled={disabled || voiceController.phase === 'requesting'}
                  onClick={() => void voiceController.start()}
                >
                  {voiceController.phase === 'requesting' ? <span className="otis-spinner" aria-hidden="true"/> : <MicIcon className="nav:size-4"/>}
                </button>
              )}
              {running && onStop && !value.trim() && imageController.attachments.length === 0 && docController.attachments.length === 0 ? (
                <button
                  type="button"
                  className="otis-composer__action otis-composer__send grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground nav:size-8"
                  aria-label="Stop Otis"
                  disabled={stopping}
                  onClick={() => void stop()}
                >
                  <StopIcon/>
                </button>
              ) : (
                <button
                  type="button"
                  className={`otis-composer__action otis-composer__send grid size-9 shrink-0 place-items-center rounded-full nav:size-8 ${
                    hasContent && !disabled
                      ? 'bg-highlight text-highlight-foreground hover:bg-highlight-hover active:bg-highlight-pressed'
                      : 'bg-accent text-subtle'
                  }`}
                  aria-label="Send"
                  aria-busy={sending}
                  disabled={disabled || tooLong || !hasContent || controlPending || (!modelReady && !(value.trim().startsWith('/') && !value.trim().startsWith('//')))}
                  onClick={() => void submit()}
                >
                  {sending ? <span className="otis-spinner" aria-hidden="true"/> : <SendIcon className="nav:size-4"/>}
                </button>
              )}
            </div>
          </div>
      )}
    </div>
    {tooLong ? (
      <div id={`${id}-status`} className="otis-composer__status text-xs otis-composer__status--error flex items-center justify-between gap-2" role="status">
        <span>Keep the message under {DOMAIN_BOUNDS.MAX_INPUT_CHARS.toLocaleString()} characters.</span>
        <button
          type="button"
          className="underline hover:text-foreground font-medium shrink-0 cursor-pointer"
          onClick={handleConvertDraftToAttachment}
        >
          Attach long text
        </button>
      </div>
    ) : (statusText || pasteUndoSnapshot) ? (
      <div id={`${id}-status`} className={`otis-composer__status text-xs${voiceError || error ? ' otis-composer__status--error' : ''} flex items-center justify-between gap-2`} role="status">
        <span>{statusText}</span>
        {pasteUndoSnapshot && (
          <button
            type="button"
            className="underline hover:text-foreground shrink-0 cursor-pointer text-xs"
            aria-label="Undo paste conversion"
            onClick={handleUndoPaste}
          >
            Undo paste conversion
          </button>
        )}
      </div>
    ) : (
      <span className="otis-visually-hidden" role="status">{sending ? 'Sending your message.' : ''}</span>
    )}
  </div></div>;
}
