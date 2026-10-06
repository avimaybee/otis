/**
 * Shared command surface: the registry the client renders, the approved model
 * list for /model, and the deterministic executor for command turns.
 *
 * Commands are attributed durable turns. They never require a model call, and
 * an unrecognised command answers with help rather than starting a run.
 */

import type {
  Chat,
  CommandRegistryResponse,
  CommandSurface,
  ModelListResponse,
  ModelOption,
  ThinkingChoiceDTO,
  ThinkingOptionDTO,
} from '@otis/contracts';
import { validateChatMessageRequest, VOICE_FORMATS } from '@otis/contracts';
import {
  findCommand,
  listCommands,
  parseCommandText,
  renderHelp,
  renderUnknownCommand,
} from '@otis/commands';
import {
  buildWorkspaceSttConfig,
  extractPlatformKeys,
  type PlatformKeys,
  validateWorkspaceDefaultModel,
  workspaceCredentialStatuses,
} from '../providers/service.js';
import { getCredentialMetadata, getWorkspaceVoiceSettings } from '@otis/identity';
import { acceptWebMessage, getChat } from '../inbox/repository.js';
import { handleCommitUndo, handleUndoPreview } from './actions.js';
import { listAvailableModels, PRODUCTION_REGISTRY, resolveVoiceRoute } from '@otis/agent';
import type { ModelEntry, ThinkingChoice } from '@otis/agent';
import { buildTodayBrief, productionBriefKernel } from '../brief/index.js';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { requireWorkspaceScope } from './scope.js';

/**
 * GET /api/commands?surface=web|telegram
 *
 * The registry is surface-aware so the web picker never offers `/start`.
 */
export async function handleListCommands(request: Request, _env: Env, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const surface: CommandSurface = url.searchParams.get('surface') === 'telegram' ? 'telegram' : 'web';

  const body: CommandRegistryResponse = { surface, commands: listCommands(surface) };
  return jsonSuccess(body, 200, { 'x-request-id': requestId });
}

/**
 * GET /api/workspaces/:workspaceId/models?chat_id=
 *
 * Reports only handpicked registry entries, marks current/default selection,
 * and states voice support separately from native audio support.
 */
export async function handleListModels(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;

  const url = new URL(request.url);
  const chatId = url.searchParams.get('chat_id') ?? undefined;

  const platformKeys = extractPlatformKeys(env);
  const credentialStatuses = await workspaceCredentialStatuses(env.DB, workspaceId, platformKeys);
  const storedVoice = await getWorkspaceVoiceSettings(env.DB, workspaceId);
  const sttConfig = buildWorkspaceSttConfig(storedVoice, credentialStatuses.groq);
  const settings = await env.DB
    .prepare(`SELECT default_model FROM workspace_settings WHERE workspace_id = ?`)
    .bind(workspaceId)
    .first<{ default_model: string | null }>();
  const defaultKey = settings?.default_model ?? null;

  let currentKey: string | null = null;
  let chatThinkingOverride: { model_key: string; choice_id: string } | null = null;
  if (chatId) {
    const chat = await env.DB
      .prepare(`SELECT model_override, thinking_override_json FROM chats WHERE id = ? AND workspace_id = ?`)
      .bind(chatId, workspaceId)
      .first<{ model_override: string | null; thinking_override_json: string | null }>();
    if (!chat) return jsonError(404, 'not_found', 'Chat not found in this workspace.', requestId);
    currentKey = chat.model_override ?? null;
    if (chat.thinking_override_json) {
      try {
        chatThinkingOverride = JSON.parse(chat.thinking_override_json);
      } catch {
        chatThinkingOverride = null;
      }
    }
  }

  // Availability uses the exact resolver rules (approval, lifecycle, verified
  // text/tools/stream, credential health) so the picker never offers a model
  // the run path would reject.
  const usableKeys = new Set(
    listAvailableModels(PRODUCTION_REGISTRY, credentialStatuses).map((entry) => entry.commandKey),
  );
  const models: ModelOption[] = PRODUCTION_REGISTRY.entries.map((entry: ModelEntry) => {
    const isCurrent = (currentKey ?? defaultKey) === entry.commandKey;
    // Native audio is capability evidence only; effective voice availability
    // resolves through the exact route policy (verified native format or a
    // configured/verified Groq STT route for the actual container).
    const nativeAudio = entry.capabilities.audio === 'supported';
    const voiceAvailable = VOICE_FORMATS.some(
      (format) => resolveVoiceRoute({ model: entry, audioMimeOrExt: format, sttConfig }).route !== 'unavailable',
    );

    let thinking: ThinkingOptionDTO | undefined = undefined;
    if (entry.thinking) {
      const isBoundToThisModel = chatThinkingOverride?.model_key === entry.commandKey;
      const currentChoiceId = isBoundToThisModel ? (chatThinkingOverride?.choice_id ?? null) : null;
      const choices: ThinkingChoiceDTO[] = entry.thinking.choices.map((c) => ({
        id: c.id,
        label: c.label,
      }));
      let unavailabilityReason: string | null = null;
      if (entry.thinking.state === 'unverified') {
        unavailabilityReason = 'Thinking controls have not been verified for this model.';
      } else if (entry.thinking.state === 'unsupported') {
        unavailabilityReason = 'This model has no adjustable thinking control.';
      }

      thinking = {
        current_choice_id: currentChoiceId,
        effective_choice_id: currentChoiceId ?? 'default',
        is_default: currentChoiceId === null || currentChoiceId === 'default',
        state: entry.thinking.state,
        choices,
        ...(unavailabilityReason ? { unavailability_reason: unavailabilityReason } : {}),
      };
    }

    return {
      command_key: entry.commandKey,
      display_name: entry.displayName,
      provider: entry.provider,
      native_audio_supported: nativeAudio,
      voice_available: voiceAvailable,
      available: usableKeys.has(entry.commandKey),
      is_current: isCurrent,
      is_default: entry.commandKey === defaultKey,
      thinking,
    };
  });

  const body: ModelListResponse = {
    models,
    current_command_key: currentKey,
    default_command_key: defaultKey,
    ...(models.some((model) => model.available)
      ? {}
      : { unavailable_reason: 'No configured provider key is available in this workspace yet.' }),
  };

  return jsonSuccess(body, 200, { 'x-request-id': requestId });
}

export interface CommandExecutionContext {
  db: D1Database;
  workspaceId: string;
  userId: string;
  surface: CommandSurface;
  platformKeys?: PlatformKeys;
  /** Configured bot username for Telegram @suffix matching (without @).
   * Absent keeps the historical literal `@thisbot` fallback. */
  botUsername?: string;
}

export type CommandExecution =
  | { kind: 'reply'; text: string; effects: CommandEffect[] }
  | { kind: 'not_a_command' };

export type CommandEffect =
  | { type: 'set_chat_model'; chatId: string; commandKey: string | null }
  | { type: 'set_chat_thinking'; chatId: string; thinkingOverride: { model_key: string; choice_id: string } | null }
  | { type: 'set_active_workspace'; workspaceId: string }
  | { type: 'request_undo'; actionId: string | null; mode: 'from_here' | 'single' };

export function resolveModelAlias(input: string): string {
  const query = input.trim().toLowerCase();
  if (query === 'default') return 'default';

  // 1. Exact match on commandKey
  const exactCommandKey = PRODUCTION_REGISTRY.entries.find((e) => e.commandKey.toLowerCase() === query);
  if (exactCommandKey) return exactCommandKey.commandKey;

  // 2. Exact match on modelId
  const exactModelId = PRODUCTION_REGISTRY.entries.find((e) => e.modelId.toLowerCase() === query);
  if (exactModelId) return exactModelId.commandKey;

  // 3. Exact match on displayName
  const exactDisplayName = PRODUCTION_REGISTRY.entries.find((e) => e.displayName.toLowerCase() === query);
  if (exactDisplayName) return exactDisplayName.commandKey;

  // 4. Clean alphanumeric match (e.g. "gemini35", "mimo25", "muse12", "deepseek41")
  const cleaned = query.replace(/[^a-z0-9]/g, '');
  for (const entry of PRODUCTION_REGISTRY.entries) {
    const cleanCmd = entry.commandKey.replace(/[^a-z0-9]/g, '');
    const cleanModel = entry.modelId.replace(/[^a-z0-9]/g, '');
    const cleanDisplay = entry.displayName.replace(/[^a-z0-9]/g, '');
    if (cleanCmd === cleaned || cleanModel === cleaned || cleanDisplay === cleaned) {
      return entry.commandKey;
    }
  }

  // 5. Substring / partial match on commandKey, modelId, or displayName
  const matched = PRODUCTION_REGISTRY.entries.find((e) => {
    const cmd = e.commandKey.toLowerCase();
    const model = e.modelId.toLowerCase();
    const name = e.displayName.toLowerCase();
    return cmd.includes(query) || model.includes(query) || name.includes(query) || query.includes(cmd);
  });
  if (matched) return matched.commandKey;

  return input.trim();
}

/**
 * Executes a deterministic command turn and returns the reply text plus the
 * durable effects to apply. Command execution never calls a provider.
 */
export async function executeCommand(
  context: CommandExecutionContext,
  chat: Chat | null,
  text: string,
): Promise<CommandExecution> {
  const parsed = parseCommandText(text, context.surface, context.botUsername);
  if (parsed.kind === 'text') return { kind: 'not_a_command' };

  if (parsed.kind === 'unknown_command') {
    return {
      kind: 'reply',
      text: renderUnknownCommand(parsed.name, context.surface),
      effects: [],
    };
  }

  const definition = findCommand(parsed.name);
  if (!definition?.available) {
    return {
      kind: 'reply',
      text: `/${definition?.name ?? parsed.name} is not available yet.`,
      effects: [],
    };
  }

  switch (parsed.name) {
    case 'help':
      return { kind: 'reply', text: renderHelp(context.surface), effects: [] };

    case 'model': {
      if (parsed.args.length === 0) return { kind: 'reply', text: await renderModelList(context, chat), effects: [] };
      if (!chat) return { kind: 'reply', text: 'Use /model <key> or /model default in your own chat.', effects: [] };
      const rawArg = parsed.args.join(' ').trim();
      const key = rawArg.toLowerCase() === 'default' ? 'default' : resolveModelAlias(rawArg);
      const settings = await context.db
        .prepare(`SELECT default_model FROM workspace_settings WHERE workspace_id = ?`)
        .bind(context.workspaceId)
        .first<{ default_model: string | null }>();
      const defaultKey = settings?.default_model ?? null;
      const priorEffectiveModel = chat.model_override ?? defaultKey;
      const newEffectiveModel = key === 'default' ? defaultKey : key;
      const modelChanged = priorEffectiveModel !== newEffectiveModel;
      const hadThinkingOverride = Boolean(chat.thinking_override_json);
      const effects: CommandEffect[] = [];

      if (key === 'default') {
        effects.push({ type: 'set_chat_model', chatId: chat.id, commandKey: null });
        let text = 'This chat now follows the workspace model.';
        if (modelChanged && hadThinkingOverride) {
          effects.push({ type: 'set_chat_thinking', chatId: chat.id, thinkingOverride: null });
          text += ' Thinking effort was reset to Provider default.';
        }
        // Clearing the override is honest only with a usable landing state.
        // Never announce readiness when nothing can run.
        const landing = await describeUsableDefault(context);
        if (landing.usableKey) {
          text += ` The workspace model is ${landing.usableLabel}. ${await voiceSentenceFor(context, landing.usableKey)}`;
        } else {
          text += ` But ${landing.problem} Pick a working model with /model <key>:${landing.choices}`;
        }
        return { kind: 'reply', text, effects };
      }
      try {
        const entry = await validateWorkspaceDefaultModel(context.db, {
          workspaceId: context.workspaceId,
          actorUserId: context.userId,
          commandKey: key,
          platformKeys: context.platformKeys,
        });
        effects.push({ type: 'set_chat_model', chatId: chat.id, commandKey: key });
        let text = `This chat now uses ${entry.displayName}. ${await voiceSentenceFor(context, entry.commandKey)}`;
        if (modelChanged && hadThinkingOverride) {
          effects.push({ type: 'set_chat_thinking', chatId: chat.id, thinkingOverride: null });
          text += ' Thinking effort was reset to Provider default.';
        }
        return { kind: 'reply', text, effects };
      } catch {
        const landing = await describeUsableDefault(context);
        return { kind: 'reply', text: `That model is unavailable here.${landing.choices ? ` Working choices:${landing.choices}` : ' No usable model is configured yet — ask the workspace owner to connect a provider key.'}`, effects: [] };
      }
    }

    case 'thinking': {
      if (!chat) {
        return { kind: 'reply', text: 'Open a conversation first, then use /thinking.', effects: [] };
      }

      const settings = await context.db
        .prepare(`SELECT default_model FROM workspace_settings WHERE workspace_id = ?`)
        .bind(context.workspaceId)
        .first<{ default_model: string | null }>();
      const defaultKey = settings?.default_model ?? null;
      const effectiveKey = chat.model_override ?? defaultKey;
      const entry = PRODUCTION_REGISTRY.entries.find((e) => e.commandKey === effectiveKey);
      if (!entry) {
        return {
          kind: 'reply',
          text: `No active model is resolved for this chat. Select one first with /model.`,
          effects: [],
        };
      }

      const thinkingControl = entry.thinking;
      const supportState = thinkingControl?.state ?? 'unverified';
      let activeChoice: ThinkingChoice | null = null;
      if (chat.thinking_override && chat.thinking_override.model_key === entry.commandKey) {
        activeChoice = thinkingControl?.choices.find((c) => c.id === chat.thinking_override!.choice_id) ?? null;
      }

      if (parsed.args.length === 0) {
        if (supportState === 'unverified') {
          return {
            kind: 'reply',
            text: `Thinking controls have not been verified for ${entry.displayName}. This chat uses Provider default.`,
            effects: [],
          };
        }
        if (supportState === 'unsupported') {
          return {
            kind: 'reply',
            text: `${entry.displayName} has no adjustable thinking control. This chat uses Provider default.`,
            effects: [],
          };
        }
        const currentLabel = activeChoice ? activeChoice.label : 'Provider default';
        const choicesList = [
          ...(thinkingControl?.choices.map((c) => `- ${c.id}: ${c.label}`) ?? []),
          '- default: Provider default',
        ].join('\n');
        return {
          kind: 'reply',
          text: `${entry.displayName} thinking is currently set to ${currentLabel}.\nAvailable choices:\n${choicesList}\nUse /thinking <choice> or /thinking default.`,
          effects: [],
        };
      }

      const requested = parsed.args.join(' ').trim().toLowerCase();
      if (requested === 'default' || requested === 'provider default') {
        if (supportState === 'unsupported') {
          return {
            kind: 'reply',
            text: `${entry.displayName} has no adjustable thinking control. It uses Provider default.`,
            effects: [],
          };
        }
        if (supportState === 'unverified') {
          return {
            kind: 'reply',
            text: `Thinking controls have not been verified for ${entry.displayName}. It uses Provider default.`,
            effects: [],
          };
        }
        return {
          kind: 'reply',
          text: `Thinking level reset to Provider default for ${entry.displayName} in this chat.`,
          effects: [{ type: 'set_chat_thinking', chatId: chat.id, thinkingOverride: null }],
        };
      }

      if (supportState === 'unsupported') {
        return {
          kind: 'reply',
          text: `${entry.displayName} has no adjustable thinking control. This chat uses Provider default.`,
          effects: [],
        };
      }
      if (supportState === 'unverified') {
        return {
          kind: 'reply',
          text: `Thinking controls have not been verified for ${entry.displayName}. This chat uses Provider default.`,
          effects: [],
        };
      }

      const matchedChoice = thinkingControl?.choices.find(
        (c) =>
          c.id.toLowerCase() === requested ||
          c.label.toLowerCase() === requested ||
          (c.id === 'xhigh' && (requested === 'extra high' || requested === 'extra_high' || requested === 'extra-high')),
      );

      if (!matchedChoice) {
        const available = [
          ...(thinkingControl?.choices.map((c) => `${c.id} (${c.label})`) ?? []),
          'default (Provider default)',
        ].join(', ');
        return {
          kind: 'reply',
          text: `'${parsed.args.join(' ')}' is not a valid thinking choice for ${entry.displayName}. Available choices: ${available}.`,
          effects: [],
        };
      }

      return {
        kind: 'reply',
        text: `${matchedChoice.label} thinking set for ${entry.displayName}. It applies to your next message in this chat.`,
        effects: [
          {
            type: 'set_chat_thinking',
            chatId: chat.id,
            thinkingOverride: {
              model_key: entry.commandKey,
              choice_id: matchedChoice.id,
            },
          },
        ],
      };
    }

    case 'workspace': {
      if (!chat) {
        return { kind: 'reply', text: 'Open a conversation first, then use /workspace.', effects: [] };
      }
      if (parsed.args.length === 0) {
        const name =
          (
            await context.db
              .prepare(`SELECT name FROM workspaces WHERE id = ?`)
              .bind(context.workspaceId)
              .first<{ name: string }>()
          )?.name ?? 'this workspace';
        return { kind: 'reply', text: `You are in ${name}. Use /workspace <name> to switch this surface.`, effects: [] };
      }
      const requested = parsed.args.join(' ');
      const workspaces = (
        await context.db
          .prepare(
            `SELECT w.id, w.name FROM workspaces w
             JOIN workspace_users wu ON wu.workspace_id = w.id
             WHERE wu.user_id = ? ORDER BY w.name ASC`,
          )
          .bind(context.userId)
          .all<{ id: string; name: string }>()
      ).results || [];
      const match = workspaces.find(
        (workspace) =>
          workspace.name.toLowerCase() === requested.toLowerCase() || workspace.id === requested,
      );
      if (!match) {
        const names = workspaces.map((workspace) => workspace.name).join(', ') || 'none';
        return {
          kind: 'reply',
          text: `I don't have a workspace called ${requested}. You have: ${names}.`,
          effects: [],
        };
      }
      return {
        kind: 'reply',
        text:
          match.id === context.workspaceId
            ? `You are already in ${match.name}.`
            : `Switched to ${match.name}. Past messages stay where they were.`,
        effects: [{ type: 'set_active_workspace', workspaceId: match.id }],
      };
    }

    case 'undo': {
      const actionId = parsed.args[0] ?? null;
      return {
        kind: 'reply',
        text: actionId
          ? `Undoing ${actionId}.`
          : 'Undoing your most recent change from this conversation.',
        effects: [{ type: 'request_undo', actionId, mode: parsed.args[1] === 'single' ? 'single' : 'from_here' }],
      };
    }

    case 'today': {
      const timezoneRow = await context.db
        .prepare(`SELECT brief_timezone FROM member_settings WHERE workspace_id = ? AND user_id = ?`)
        .bind(context.workspaceId, context.userId)
        .first<{ brief_timezone: string | null }>();
      const zone = timezoneRow?.brief_timezone;
      if (!zone) {
        return {
          kind: 'reply',
          text: 'Choose your timezone in Settings so I can identify today’s due work. You do not need a scheduled brief.',
          effects: [],
        };
      }
      const nowIso = new Date().toISOString();
      const briefResult = await buildTodayBrief(context.db, productionBriefKernel, {
        workspaceId: context.workspaceId,
        userId: context.userId,
        nowIso,
        staleAfterDays: 14,
      });
      if (briefResult.status === 'skipped') {
        return { kind: 'reply', text: 'You are not a member of this workspace.', effects: [] };
      }
      return { kind: 'reply', text: briefResult.text || 'You have no due work right now.', effects: [] };
    }
    default:
      // Gated commands report their availability without calling a provider.
      return {
        kind: 'reply',
        text: `/${parsed.name} needs a workspace conversation to run in.`,
        effects: [],
      };
  }
}

/**
 * Usable voice route for a model key, from the exact resolver rules.
 * Native audio is per-entry evidence; a configured/verified Groq STT route
 * also makes voice available for a text-only model. Never a blanket
 * "text only" claim.
 */
async function voiceSentenceFor(context: CommandExecutionContext, commandKey: string | null): Promise<string> {
  const entry = PRODUCTION_REGISTRY.entries.find(candidate => candidate.commandKey === commandKey);
  if (!entry) return 'Voice notes are not available with this model yet.';
  const stored = await getWorkspaceVoiceSettings(context.db, context.workspaceId);
  const credential = await getCredentialMetadata(context.db, { workspaceId: context.workspaceId, provider: 'groq' });
  const sttConfig = buildWorkspaceSttConfig(stored, credential?.status ?? null);
  let nativePending = false;
  for (const format of VOICE_FORMATS) {
    const route = resolveVoiceRoute({ model: entry, audioMimeOrExt: format, sttConfig });
    if (route.route === 'native') return 'Voice notes can use native audio.';
    if (route.route === 'groq_stt') return 'Voice notes are transcribed with Groq Whisper.';
    if (route.reason === 'native_not_implemented') nativePending = true;
  }
  if (nativePending) {
    return 'This model has verified native audio, but Otis has not implemented native transcription yet; configure Groq STT to use voice notes.';
  }
  return 'Voice notes are not available with this model yet.';
}
/**
 * Usable workspace models under the exact resolver rules, plus a plain-language
 * account of the landing state for replies that change model selection.
 */
async function describeUsableDefault(context: CommandExecutionContext): Promise<{
  usableKey: string | null;
  usableLabel: string | null;
  problem: string;
  choices: string;
}> {
  const credentialStatuses = await workspaceCredentialStatuses(context.db, context.workspaceId, context.platformKeys);
  const usable = listAvailableModels(PRODUCTION_REGISTRY, credentialStatuses);
  const settings = await context.db
    .prepare(`SELECT default_model FROM workspace_settings WHERE workspace_id = ?`)
    .bind(context.workspaceId)
    .first<{ default_model: string | null }>();
  const defaultKey = settings?.default_model ?? null;
  const usableDefault = usable.find((entry) => entry.commandKey === defaultKey) ?? null;
  const choices = usable.length > 0
    ? `\n${usable.map((entry) => `- /model ${entry.commandKey} — ${entry.displayName}`).join('\n')}`
    : '';
  if (!defaultKey) {
    return {
      usableKey: null,
      usableLabel: null,
      problem: 'no workspace model is set yet.',
      choices,
    };
  }
  if (!usableDefault) {
    return {
      usableKey: null,
      usableLabel: null,
      problem: `the workspace model "${defaultKey}" is not usable here (missing key, retired, or unverified).`,
      choices,
    };
  }
  return {
    usableKey: usableDefault.commandKey,
    usableLabel: usableDefault.displayName,
    problem: '',
    choices,
  };
}

async function renderModelList(context: CommandExecutionContext, chat: Chat | null): Promise<string> {
  const credentialStatuses = await workspaceCredentialStatuses(context.db, context.workspaceId);
  const settings = await context.db
    .prepare(`SELECT default_model FROM workspace_settings WHERE workspace_id = ?`)
    .bind(context.workspaceId)
    .first<{ default_model: string | null }>();
  const defaultKey = settings?.default_model ?? null;

  const usableKeys = new Set(
    listAvailableModels(PRODUCTION_REGISTRY, credentialStatuses).map((entry) => entry.commandKey),
  );
  const lines: string[] = [];
  const available: string[] = [];

  for (const entry of PRODUCTION_REGISTRY.entries) {
    const usable = usableKeys.has(entry.commandKey);
    const marker = entry.commandKey === (chat?.model_override ?? defaultKey) ? ' (current)' : '';
    if (usable) {
      available.push(`${entry.commandKey}${marker}  ·  ${entry.displayName}`);
    } else {
      lines.push(`${entry.commandKey}  ·  ${entry.displayName} (not configured here)`);
    }
  }

  const header = chat?.model_override
    ? `This chat uses ${chat.model_override}.`
    : defaultKey
      ? `New chats in this workspace use ${defaultKey}.`
      : 'No default model is set for this workspace yet.';

  const body = available.length > 0 ? ['Available:', ...available.map((line) => `- ${line}`)] : lines;
  return [header, ...body, 'Use /model <key> to switch this chat, or /model default to follow the workspace.'].join(
    '\n',
  );
}

/** Both normal composer messages and the optional command shortcut use this path. */
export async function handleExecuteCommand(request: Request, env: Env, workspaceId: string, chatId: string, requestId: string): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;
  let body: { text?: unknown; client_message_id?: unknown; presentation?: unknown };
  try { body = await request.json(); } catch { return jsonError(400, 'bad_request', 'Invalid JSON body.', requestId); }
  if (body.presentation !== undefined && body.presentation !== 'control') return jsonError(422, 'validation_error', 'Invalid command presentation.', requestId);
  const presentation = body.presentation === 'control' ? 'control' as const : undefined;
  const validated = validateChatMessageRequest(body);
  if (!validated.valid) return jsonError(422, 'validation_error', validated.message, requestId);
  const text = validated.value.text!; const clientMessageId = validated.value.client_message_id;
  const chat = await getChat(env.DB, workspaceId, chatId);
  if (!chat) return jsonError(404, 'not_found', 'Chat not found in this workspace.', requestId);
  if (chat.author_user_id !== scope.user.id) return jsonError(403, 'forbidden', 'Only the chat author can send commands here.', requestId);
  const prior = await env.DB.prepare(`SELECT 1 FROM messages_in WHERE channel = 'web' AND external_id = ?`).bind(clientMessageId).first();
  if (prior) {
    try {
      const accepted = await acceptWebMessage(env.DB, { workspaceId, chatId, userId: scope.user.id, clientMessageId: clientMessageId, text: text, command: { reply: '', presentation } });
      const saved = await env.DB.prepare(`SELECT payload_json FROM run_activity WHERE run_id = ? AND type = 'answer_saved' ORDER BY cursor DESC LIMIT 1`).bind(accepted.run_id).first<{ payload_json: string }>();
      if (saved) return jsonSuccess({ ...accepted, ...JSON.parse(saved.payload_json), deduplicated: true }, request.url.includes('/commands') ? 200 : 202, { 'x-request-id': requestId });
    } catch { return jsonError(409, 'conflict', 'Message ID already used with different content or context.', requestId); }
  }
  const outcome = await executeCommand({ db: env.DB, workspaceId, userId: scope.user.id, surface: 'web', platformKeys: extractPlatformKeys(env) }, chat, text);
  if (outcome.kind === 'not_a_command') return jsonError(422, 'not_a_command', 'That text is not a command.', requestId);
  const command: {
    reply: string;
    presentation?: 'control';
    applied?: boolean;
    selectedWorkspaceId?: string;
    modelOverride?: string | null;
    thinkingOverride?: { model_key: string; choice_id: string } | null;
  } = { reply: outcome.text, presentation, applied: outcome.effects.length > 0 };
  if (presentation && /^\/(model|thinking|workspace)\s+\S/i.test(text) && !outcome.effects.length) return jsonError(422, 'command_rejected', outcome.text, requestId);
  for (const effect of outcome.effects) {
    if (effect.type === 'set_chat_model') command.modelOverride = effect.commandKey;
    if (effect.type === 'set_chat_thinking') command.thinkingOverride = effect.thinkingOverride;
    if (effect.type === 'set_active_workspace') command.selectedWorkspaceId = effect.workspaceId;
    if (effect.type === 'request_undo') {
      // The ledger owns previews, dependencies, and retry receipts. Recover the target
      // from the durable source if a response was lost before completing the turn.
      const priorSource = await env.DB.prepare(`SELECT json_extract(raw_payload, '$.undo_action_id') AS target FROM messages_in WHERE channel = 'web' AND external_id = ? AND workspace_id = ? AND user_id = ? AND chat_id = ?`).bind(clientMessageId, workspaceId, scope.user.id, chatId).first<{ target: string | null }>();
      const recent = await env.DB.prepare(`SELECT ar.action_id FROM action_receipts ar WHERE ar.workspace_id = ? AND ar.actor_user_id = ? AND ar.command_name <> 'undo' AND ar.result_status = 'applied' AND ar.source_message_id IN (SELECT id FROM messages_in WHERE chat_id = ?) AND EXISTS (SELECT 1 FROM events e WHERE e.workspace_id = ar.workspace_id AND e.action_id = ar.action_id AND e.kind <> 'revert' AND NOT EXISTS (SELECT 1 FROM events r WHERE r.workspace_id = e.workspace_id AND r.kind = 'revert' AND json_extract(r.payload_json, '$.target_event_id') = e.id)) ORDER BY ar.committed_revision DESC LIMIT 1`).bind(workspaceId, scope.user.id, chatId).first<{ action_id: string }>();
      const target = effect.actionId ?? priorSource?.target ?? recent?.action_id;
      if (!target) { command.reply = 'There is no reversible change in this conversation.'; continue; }
      const previewRequest = new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify({ mode: effect.mode }) });
      const previewResponse = await handleUndoPreview(previewRequest, env, workspaceId, target, requestId);
      if (!previewResponse.ok) return previewResponse;
      const preview = await previewResponse.json() as { preview: { expected_revision: number } };
      const commitUrl = new URL(request.url); commitUrl.searchParams.set('chat_id', chatId);
      const commit = await handleCommitUndo(new Request(commitUrl, { method: 'POST', headers: request.headers, body: JSON.stringify({ mode: effect.mode, client_operation_id: clientMessageId, expected_revision: preview.preview.expected_revision, command_text: text, presentation }) }), env, workspaceId, target, requestId);
      const result = await commit.json() as { status: string; summary: string };
      command.reply = result.summary;
      if (!commit.ok) return jsonSuccess(result, commit.status, { 'x-request-id': requestId });
    }
  }
  try {
    const accepted = await acceptWebMessage(env.DB, { workspaceId, chatId, userId: scope.user.id, clientMessageId: clientMessageId, text: text, command });
    const saved = await env.DB.prepare(`SELECT payload_json FROM run_activity WHERE run_id = ? AND type = 'answer_saved' ORDER BY cursor DESC LIMIT 1`).bind(accepted.run_id).first<{ payload_json: string }>();
    const completion = saved ? JSON.parse(saved.payload_json) as { reply: string; selected_workspace_id: string | null } : { reply: command.reply, selected_workspace_id: null };
    return jsonSuccess({ ...accepted, ...completion }, request.url.includes('/commands') ? 200 : 202, { 'x-request-id': requestId });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    return jsonError(name === 'ConflictError' ? 409 : name === 'ForbiddenError' ? 403 : name === 'NotFoundError' ? 404 : name === 'ValidationError' ? 422 : 500, name === 'ConflictError' ? 'conflict' : 'command_failed', 'The command could not be accepted. Retry with the same message ID.', requestId);
  }
}
