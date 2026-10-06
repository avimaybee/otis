/**
 * Slice 2 provider image ingestion: scripted image bytes reach each
 * adapter's wire body in the documented shape, and invalid or disallowed
 * payloads are rejected before any spend (zero recorded requests).
 * All wire shapes are mocked protocol evidence, never live capability.
 */

import { describe, expect, it } from 'vitest';
import { GeminiInteractionsAdapter } from '../src/providers/gemini.js';
import { OpenCodeGoAdapter } from '../src/providers/opencode-go.js';
import { PRODUCTION_REGISTRY, createRegistry } from '../src/providers/registry.js';
import { ProviderErrorException } from '../src/providers/types.js';
import { baseInput, errorResponse, geminiModel, goChatModel, goResponsesModel, mockFetch } from './helpers.js';

const IMAGES = [
  { data: 'AAA', mimeType: 'image/png' },
  { data: 'BBB', mimeType: 'image/jpeg' },
];

function imageTurn(model: ReturnType<typeof geminiModel>) {
  return baseInput(model, {
    messages: [{ role: 'user', text: 'What is in these?', images: IMAGES }],
  });
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const event of iterable) void event;
}

describe('provider image ingestion (Slice 2)', () => {
  it('maps images to documented Gemini Interactions image parts', async () => {
    const fetchFn = mockFetch(() => errorResponse(500, { error: 'synthetic' }));
    const adapter = new GeminiInteractionsAdapter({ fetchFn, apiKey: 'test-gemini-key' });
    await drain(adapter.streamTurn(imageTurn(geminiModel())));

    expect(fetchFn.requests).toHaveLength(1);
    const body = fetchFn.requests[0]!.body as Record<string, unknown>;
    const blocks = body['input'] as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: 'user_input',
      content: [
        { type: 'image', mime_type: 'image/png', data: 'AAA' },
        { type: 'image', mime_type: 'image/jpeg', data: 'BBB' },
        { type: 'text', text: 'What is in these?' },
      ],
    });
  });

  it('maps images to chat image_url parts with data URLs', async () => {
    const fetchFn = mockFetch(() => errorResponse(500, { error: 'synthetic' }));
    const adapter = new OpenCodeGoAdapter({
      fetchFn,
      apiKey: 'test-go-key',
      endpointFamily: 'go-chat-completions',
    });
    await drain(adapter.streamTurn(imageTurn(goChatModel())));

    expect(fetchFn.requests).toHaveLength(1);
    const body = fetchFn.requests[0]!.body as { messages: Array<Record<string, unknown>> };
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } },
          { type: 'text', text: 'What is in these?' },
        ],
      },
    ]);
  });

  it('maps images to Responses input_image parts with data URLs', async () => {
    const fetchFn = mockFetch(() => errorResponse(500, { error: 'synthetic' }));
    const adapter = new OpenCodeGoAdapter({
      fetchFn,
      apiKey: 'test-go-key',
      endpointFamily: 'go-responses',
    });
    await drain(adapter.streamTurn(imageTurn(goResponsesModel())));

    expect(fetchFn.requests).toHaveLength(1);
    const body = fetchFn.requests[0]!.body as Record<string, unknown>;
    const items = body['input'] as Array<Record<string, unknown>>;
    const userMessage = items.find((item) => item['role'] === 'user') as Record<string, unknown>;
    expect(userMessage['content']).toEqual([
      { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,BBB' },
      { type: 'input_text', text: 'What is in these?' },
    ]);
  });

  it.each([
    ['gemini', 'gemini-interactions' as const, geminiModel()],
    ['go-chat', 'go-chat-completions' as const, goChatModel()],
    ['go-responses', 'go-responses' as const, goResponsesModel()],
  ])('%s rejects over-limit, unverified-container, and disallowed-model images before spend', async (label, family, model) => {
    const makeAdapter = (fetchFn: ReturnType<typeof mockFetch>) =>
      label === 'gemini'
        ? new GeminiInteractionsAdapter({ fetchFn, apiKey: 'k' })
        : new OpenCodeGoAdapter({ fetchFn, apiKey: 'k', endpointFamily: family });
    // Over the per-message bound.
    const tooMany = mockFetch(() => errorResponse(500, {}));
    const five = Array.from({ length: 5 }, (_, i) => ({ data: `D${i}`, mimeType: 'image/png' }));
    await expect(drain(makeAdapter(tooMany).streamTurn(baseInput(model, {
      messages: [{ role: 'user', text: 'x', images: five }],
    })))).rejects.toMatchObject({ name: 'ProviderErrorException', detail: { code: 'invalid_request' } });
    expect(tooMany.requests).toHaveLength(0);

    // Unverified container.
    const badMime = mockFetch(() => errorResponse(500, {}));
    await expect(drain(makeAdapter(badMime).streamTurn(baseInput(model, {
      messages: [{ role: 'user', text: 'x', images: [{ data: 'AAA', mimeType: 'image/bmp' }] }],
    })))).rejects.toMatchObject({ detail: { code: 'invalid_request' } });
    expect(badMime.requests).toHaveLength(0);

    // Registry-marked unable model.
    const blocked = mockFetch(() => errorResponse(500, {}));
    const blockedModel = { ...model, vision: 'unsupported' as const };
    await expect(drain(makeAdapter(blocked).streamTurn(baseInput(blockedModel, {
      messages: [{ role: 'user', text: 'x', images: [{ data: 'AAA', mimeType: 'image/png' }] }],
    })))).rejects.toMatchObject({ detail: { code: 'unsupported_capability' } });
    expect(blocked.requests).toHaveLength(0);

    // The gate only fires when images are present: text still sends.
    const textOnly = mockFetch(() => errorResponse(500, { error: 'synthetic' }));
    await drain(makeAdapter(textOnly).streamTurn(baseInput(blockedModel, {
      messages: [{ role: 'user', text: 'plain text' }],
    })));
    expect(textOnly.requests).toHaveLength(1);
  });

  it('keeps every production model vision-unverified until a live image probe runs', () => {
    expect(PRODUCTION_REGISTRY.entries.length).toBeGreaterThan(0);
    for (const entry of PRODUCTION_REGISTRY.entries) {
      expect(entry.capabilities.vision).toBe('unverified');
    }
    const custom = createRegistry([
      {
        commandKey: 'fixture-vision',
        displayName: 'Fixture',
        provider: 'gemini',
        modelId: 'fixture-vision',
        endpointFamily: 'gemini-interactions',
        endpointUrl: 'https://example.test/v1beta/interactions',
        approved: true,
        lifecycle: 'active',
        capabilities: {
          text: 'supported',
          tools: 'supported',
          stream: 'supported',
          thoughtSummary: 'unverified',
          audio: 'unverified',
          vision: 'supported',
        },
        trainingUse: 'fixture',
        dataRetention: 'fixture',
        evidenceRef: null,
        verifiedAt: null,
      },
    ]);
    expect(custom.entries[0]!.capabilities.vision).toBe('supported');
  });

  it('throws ProviderErrorException (never a raw error) for image validation', async () => {
    const fetchFn = mockFetch(() => errorResponse(500, {}));
    const adapter = new GeminiInteractionsAdapter({ fetchFn, apiKey: 'k' });
    const five = Array.from({ length: 5 }, (_, i) => ({ data: `D${i}`, mimeType: 'image/png' }));
    await expect(drain(adapter.streamTurn(baseInput(geminiModel(), {
      messages: [{ role: 'user', text: 'x', images: five }],
    })))).rejects.toBeInstanceOf(ProviderErrorException);
  });
});
