import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  ALL_AGENT_TOOLS, MUTATING_TOOL_NAMES, OpenCodeGoAdapter, GeminiInteractionsAdapter, PRODUCTION_REGISTRY,
  PROMPT_VERSION, SCHEMA_VERSION, renderSystemPrompt,
  type ProviderEvent, type TurnInput,
} from '../../packages/agent/src/index.js';

// Two cases maximum; held-out cases permit one actual read handoff each (four requests total).
// Synthetic data only. Not part of pnpm test; never executes business mutations.
it('checks capability honesty and general tables through the configured production adapter', async () => {
  expect(process.env.OTIS_LIVE_CAPABILITIES).toBe('1');
  const entry = PRODUCTION_REGISTRY.entries.find((model) => model.commandKey === (process.env.OTIS_LIVE_MODEL ?? 'mimo-25'))!;
  if (!entry) throw new Error('Choose a registered model.');
  const keyName = entry.provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENCODE_API_KEY';
  const line = readFileSync('.dev.vars', 'utf8').split(/\r?\n/).find((item) => item.startsWith(`${keyName}=`));
  const apiKey = line?.slice(keyName.length + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
  if (!apiKey) throw new Error('The designated local provider credential is unavailable.');
  const validationErrors: { status: number; message: string }[] = [];
  const probeFetch: typeof fetch = async (url, options) => {
    const response = await fetch(url, options);
    if (response.status === 400) {
      const text = await response.clone().text();
      let body: { error?: { message?: string } | string; message?: string } | null = null;
      try { body = JSON.parse(text) as typeof body; } catch { /* Non-JSON validation errors are bounded and redacted below. */ }
      const message = body?.message ?? (typeof body?.error === 'string' ? body.error : body?.error?.message) ?? text;
      validationErrors.push({ status: response.status, message: message.replaceAll(apiKey, '[redacted]').replace(/AIza[\w-]+/g, '[redacted]').slice(0, 600) });
    }
    return response;
  };
  const adapter = entry.endpointFamily === 'gemini-interactions'
    ? new GeminiInteractionsAdapter({ fetchFn: probeFetch, apiKey })
    : new OpenCodeGoAdapter({ fetchFn: probeFetch, apiKey, endpointFamily: entry.endpointFamily });
  const model = { commandKey: entry.commandKey, provider: entry.provider, modelId: entry.modelId, endpointFamily: entry.endpointFamily, endpointUrl: entry.endpointUrl };
  const rows = [
    { name: 'Copper', location: 'Cluj', status: 'open', price: '€40', detail: 'Farsi only' },
    { name: 'Willow', location: 'Timisoara', status: 'waiting', price: null, detail: 'Call after 16:00' },
    { name: 'Maple', location: null, status: 'disputed', price: '€60', detail: null },
    { name: 'Birch', location: 'Iasi', status: 'complete', price: '€20', detail: 'Pickup' },
    { name: 'Cedar', location: 'Sibiu', status: 'open', price: '€50', detail: 'Delivery' },
  ];
  const sources = [
    { id: 'promise', chat_id: 'sales-september', author_name: 'Nora', author_user_id: 'nora', text: 'I promised Bluebird a revised quote by 10 September. We did not agree a discount.', recorded_at: '2026-09-04T09:00:00Z', channel: 'web', sequence: 1, context: [] },
    { id: 'negation', chat_id: 'stock-september', author_name: 'Owen', author_user_id: 'owen', text: 'We have not promised Friday delivery to Bluebird; awaiting stock confirmation.', recorded_at: '2026-09-12T09:00:00Z', channel: 'web', sequence: 2, context: [] },
    { id: 'suggestion', chat_id: 'sales-september', author_name: 'Otis', author_user_id: null, text: 'Draft suggestion: offer a 20% discount if approved.', recorded_at: '2026-09-15T09:00:00Z', channel: 'web', sequence: 3, context: [] },
  ];
  const toolRound = (name: string, args: Record<string, unknown>, data: unknown, id: string): TurnInput['messages'] => [
    { role: 'assistant', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] },
    { role: 'tool', toolCallId: id, name, text: JSON.stringify({ status: 'applied', action_id: id, data }) },
  ];
  const page = (items: unknown[], total = items.length) => ({ items, total, has_more: total > items.length, next_cursor: total > items.length ? 'synthetic-next' : null, availability: 'available' });
  const currentQuote = { interaction_id: 'quote', head_event_id: 'quote-correction', entity_id: 'cedar', entity_name: 'Cedar Works', kind: 'quote', revision: 2, occurred_at: '2026-09-20T09:00:00Z', sequence: 3, payload: { amount: 50000, currency: 'EUR', role: 'offered' }, actor_kind: 'member', actor_user_id: 'nora', actor_name: 'Nora', channel: 'web', source_message_id: 'correction-source', recorded_at: '2026-09-21T09:00:00Z', provenance: 'stated', original_actor_user_id: 'owen', original_actor_name: 'Owen', original_source_message_id: 'quote-source', original_recorded_at: '2026-09-20T09:00:00Z' };
  const expectedQuote = { ...currentQuote, interaction_id: 'budget', head_event_id: 'budget', revision: 1, payload: { amount: 90000, currency: 'EUR', role: 'expected' }, actor_user_id: 'owen', actor_name: 'Owen', source_message_id: 'budget-source', recorded_at: '2026-09-20T09:00:00Z' };
  const heldout: { id: string; text: string; history: TurnInput['messages'] }[] = [
    {
      id: 'R41-cross-chat-promises',
      text: 'What did we promise Bluebird in any chat last month? Use the retrieved sources, identify who said what, and be clear about search coverage. No changes.',
      history: [
        ...toolRound('search_workspace_history', { query: 'Bluebird', from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z', mode: 'chronological' }, { version: 1, items: sources.map((source) => ({ message_id: source.id, inbound_message_id: null, chat_id: source.chat_id, chat_title: source.chat_id, author_user_id: source.author_user_id, author_name: source.author_name, source_kind: source.author_user_id ? 'member' : 'otis', recorded_at: source.recorded_at, sequence: source.sequence, excerpt: source.text, source_available: true })), total: 8, has_more: true, next_cursor: 'synthetic-next', coverage: { mode: 'chronological', bounded: true, index_complete: false } }, 'search'),
        ...sources.flatMap((source) => toolRound('read_source', { source_id: source.id }, source, 'read-' + source.id)),
      ],
    },
    {
      id: 'R36-current-quotes-and-attribution',
      text: 'Using the retrieved Cedar file, compare the current offered quote, expected budget and ownership. Who recorded and corrected the quote? State any coverage limits. No changes.',
      history: toolRound('query', { resource: 'entity_file', entity_id: 'cedar' }, {
        version: 1, entity: { id: 'cedar', name: 'Cedar Works', kind: 'lead', status: 'warm', assigned_user_id: null, assigned_name: null, aliases: [], merged_from: [] }, as_of_business_revision: 5,
        facts: page([{ field: 'assigned_to', origin_entity_id: 'cedar', value: null, state: 'disputed', revision: 2, candidate_event_ids: ['owner-nora', 'owner-owen'], source: { event_id: 'owner-owen', message_id: 'owner-source', actor_user_id: 'owen', actor_name: 'Owen', recorded_at: '2026-09-22T09:00:00Z', channel: 'web' } }]),
        quotes: page([currentQuote, expectedQuote]), timeline: page([currentQuote, expectedQuote], 5), notes: page([], 3), tasks: page([]), contacts: page([]), drafts: page([]), memory: page([]), attachments: page([]), reminders: page([]), last_contact: '2026-09-24T09:00:00Z', coverage: { bounded: true, partial_sections: ['timeline', 'notes'], unavailable_sections: [] },
      }, 'file'),
    },
  ];
  const selectedSet = process.env.OTIS_LIVE_SET ?? 'baseline';
  expect(['baseline', 'heldout']).toContain(selectedSet);
  const baseline = [
    { id: 'R45-capabilities', text: "If you could ask for capabilities in this harness, what would help you do this job better? I'm the developer. Base your answer on your actual available tools; this is a capability discussion." },
    { id: 'general-table-coverage', text: `Present this saved inventory lookup in a comprehensive readable table with useful columns and special details. Work from this supplied page and disclose its coverage; do not fetch or modify records. Unknown cells stay unknown. ${JSON.stringify({ rows, total: 12, has_more: true })}` },
  ];
  const cases = (selectedSet === 'heldout' ? heldout : baseline).filter((scenario) => !process.env.OTIS_LIVE_CASE || scenario.id === process.env.OTIS_LIVE_CASE);
  expect(cases.length).toBeGreaterThan(0);
  expect(cases.length).toBeLessThanOrEqual(2);
  const results = await Promise.all(cases.map(async (scenario) => {
    const started = performance.now();
    let firstText: number | null = null;
    const events: ProviderEvent[] = [];
    const rounds: { round: number; total_ms: number }[] = [];
    const history = 'history' in scenario ? scenario.history : [];
    const selectedContext = scenario.id.startsWith('R36')
      ? '\nSelected client context: Cedar Works, entity_id cedar.'
      : '\nAlready matched workspace source IDs: promise, negation, suggestion. Search coverage: three of eight matches in September 2026, more matches remain and historical indexing is incomplete.';
    const input: TurnInput = {
      model, sessionId: `capability-${scenario.id}`, workspaceId: 'synthetic', chatId: scenario.id,
      runId: scenario.id, requestId: scenario.id,
      messages: [{ role: 'system', text: renderSystemPrompt({ workspaceName: 'Synthetic fixture', actingMemberName: 'Test member', currentTimezone: 'UTC', currentDateIso: '2026-10-09T08:00:00Z' }) }, { role: 'user', text: scenario.text + (selectedSet === 'heldout' ? selectedContext : '') }],
      pendingToolResults: [], previousContinuation: null,
      tools: selectedSet === 'heldout' ? ALL_AGENT_TOOLS.filter(tool => tool.name === (scenario.id.startsWith('R36') ? 'query' : 'read_source')) : ALL_AGENT_TOOLS,
      maxOutputTokens: 1800, timeoutMs: 45_000,
      ...(entry.provider === 'gemini' ? { thinking: { kind: 'gemini_level' as const, level: 'minimal' as const } } : {}),
    };
    for (let round = 0; round < (selectedSet === 'heldout' ? 2 : 1); round++) {
      const roundStarted = performance.now();
      const roundEvents: ProviderEvent[] = [];
      for await (const event of adapter.streamTurn(input)) {
        if (event.type === 'text_delta' && firstText === null) firstText = performance.now() - started;
        // Continuations stay in RAM; no thoughts/signatures are saved in the report.
        if (event.type !== 'provider_thought_summary') { events.push(event); roundEvents.push(event); }
      }
      rounds.push({ round: round + 1, total_ms: performance.now() - roundStarted });
      const terminal = roundEvents.find(event => event.type === 'finish');
      if (terminal?.type !== 'finish' || terminal.reason !== 'tool_handoff') break;
      const calls = roundEvents.filter((event): event is Extract<ProviderEvent, { type: 'tool_call_end' }> => event.type === 'tool_call_end');
      input.pendingToolResults = calls.map(call => {
        expect(MUTATING_TOOL_NAMES.has(call.name)).toBe(false);
        const args = call.args as Record<string, unknown>;
        const fixture = history.find(message => message.role === 'tool' && message.name === call.name && (
          call.name === 'query' ? args.resource === 'entity_file' && args.entity_id === 'cedar' : JSON.parse(message.text!).data.id === args.source_id
        ));
        if (!fixture) throw new Error('The read requested data outside the synthetic fixture.');
        return { callId: call.callId, name: call.name, arguments: args, resultText: fixture.text! };
      });
      input.messages.push({ role: 'assistant', toolCalls: calls.map(call => ({ id: call.callId, name: call.name, arguments: JSON.stringify(call.args) })) },
        ...input.pendingToolResults.map(result => ({ role: 'tool' as const, toolCallId: result.callId, name: result.name, text: result.resultText })));
      input.previousContinuation = terminal.continuation;
    }
    return {
      id: scenario.id, fixture: { request: scenario.text, history }, rounds, first_text_ms: firstText, total_ms: performance.now() - started,
      text: events.filter((e): e is Extract<ProviderEvent, { type: 'text_delta' }> => e.type === 'text_delta').map((e) => e.text).join(''),
      tool_calls: events.filter((e) => e.type === 'tool_call_end'),
      usage: events.filter((e) => e.type === 'usage'),
      errors: events.filter((e) => e.type === 'error'),
      finish: events.filter((e) => e.type === 'finish').map((e) => ({ reason: e.reason })),
    };
  }));
  writeFileSync(selectedSet === 'heldout' ? 'plans/qa/2026-10-09-capabilities-live-heldout.json' : 'plans/qa/2026-10-09-capabilities-live.json', JSON.stringify({
    checked_at: new Date().toISOString(), model: entry.modelId, endpoint: entry.endpointFamily,
    prompt_version: PROMPT_VERSION, schema_version: SCHEMA_VERSION, requests: results.reduce((sum, result) => sum + result.rounds.length, 0),
    limitation: 'Provider/prompt checks with supplied synthetic records; not a complete live Worker or physical-device journey.', validation_errors: validationErrors, results,
  }, null, 2));
  for (const result of results) {
    expect(result.errors, result.id).toEqual([]);
    expect(result.finish.at(-1), result.id).toEqual({ reason: 'success' });
    expect(result.tool_calls.filter((e) => e.type === 'tool_call_end' && MUTATING_TOOL_NAMES.has(e.name)), result.id).toEqual([]);
    expect(result.text.length, result.id).toBeGreaterThan(80);
  }
  const table = results.find((result) => result.id === 'general-table-coverage')?.text;
  if (table) {
    for (const row of rows) expect(table).toContain(row.name);
    expect(table).toContain('|');
    expect(table).toMatch(/12/);
    expect(table).toMatch(/Farsi/i);
    expect(table).not.toMatch(/page\s*\d+\s*of\s*\d+/i);
  }
});
