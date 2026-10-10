/** @vitest-environment happy-dom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../src/components/Composer.js';

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.restoreAllMocks());

async function mount(element: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => root.render(element));
  return {
    host,
    unmount: async () => {
      await React.act(async () => root.unmount());
      host.remove();
    },
  };
}

async function fill(input: HTMLTextAreaElement, value: string) {
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Composer Document Attachments & Long Paste Conversion (R18)', () => {
  it('exposes Attach dropdown with Photos and Files when both are enabled', async () => {
    const view = await mount(
      <Composer
        commands={[]}
        running={false}
        onSend={vi.fn()}
        images={{
          available: true,
          workspaceId: 'ws_1',
          chatId: 'chat_1',
          onEnsureChat: async () => 'chat_1',
          upload: async () => ({ mediaId: 'img_1', format: 'image/png' as const }),
        }}
        documents={{
          available: true,
          workspaceId: 'ws_1',
          chatId: 'chat_1',
          onEnsureChat: async () => 'chat_1',
          upload: async () => ({ mediaId: 'doc_1', format: 'application/pdf' as const, filename: 'test.pdf' }),
        }}
      />
    );

    const attachBtn = view.host.querySelector('[aria-label="Attach"]');
    expect(attachBtn).toBeTruthy();
    expect(attachBtn?.getAttribute('aria-haspopup')).toBe('menu');

    await view.unmount();
  });

  it('renders document attachment chips with filename and remove action', async () => {
    const removeFn = vi.fn();
    const docFile = new File(['test pdf content'], 'proposal.pdf', { type: 'application/pdf' });

    const view = await mount(
      <Composer
        commands={[]}
        running={false}
        onSend={vi.fn()}
        documents={{
          available: true,
          workspaceId: 'ws_1',
          chatId: 'chat_1',
          onEnsureChat: async () => 'chat_1',
          upload: async () => ({ mediaId: 'doc_prop', format: 'application/pdf' as const, filename: 'proposal.pdf' }),
          controller: {
            attachments: [
              {
                id: 'doc_att_1',
                file: docFile,
                name: 'proposal.pdf',
                size: docFile.size,
                status: 'ready',
              },
            ],
            addFiles: vi.fn(),
            remove: removeFn,
            clear: vi.fn(),
          },
        }}
      />
    );

    expect(view.host.textContent).toContain('proposal.pdf');
    const removeBtn = view.host.querySelector('[aria-label="Remove document"]');
    expect(removeBtn).toBeTruthy();

    await React.act(async () => {
      (removeBtn as HTMLElement).click();
    });
    expect(removeFn).toHaveBeenCalledWith('doc_att_1');

    await view.unmount();
  });

  it('automatically converts oversized paste (>16,000 chars) into Pasted text.txt with quiet announcement', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const view = await mount(
      <Composer
        commands={[]}
        running={false}
        onSend={onSend}
        documents={{
          available: true,
          workspaceId: 'ws_1',
          chatId: 'chat_1',
          onEnsureChat: async () => 'chat_1',
          upload: async () => ({ mediaId: 'doc_pasted', format: 'text/plain' as const, filename: 'Pasted text.txt' }),
        }}
      />
    );

    const textarea = view.host.querySelector('textarea')!;
    // Set initial prompt instructions
    await fill(textarea, 'Please review this background: ');

    // Generate >16,000 chars of pasted content
    const oversizedClipboard = 'A'.repeat(16050);

    // Simulate paste event
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        getData: (format: string) => (format === 'text/plain' ? oversizedClipboard : ''),
      },
    });

    await React.act(async () => {
      textarea.dispatchEvent(pasteEvent);
    });

    // 1. Textarea keeps the surrounding instructions
    expect(textarea.value).toBe('Please review this background: ');

    // 2. Chip is displayed for Pasted text.txt
    expect(view.host.textContent).toContain('Pasted text.txt');

    // 3. Quiet announcement is rendered
    expect(view.host.textContent).toContain('Long text attached as a file. You can add instructions and send.');

    // 4. Undo paste conversion button is visible
    const undoBtn = view.host.querySelector('[aria-label="Undo paste conversion"]');
    expect(undoBtn).toBeTruthy();

    await view.unmount();
  });

  it('reverts paste conversion and restores draft upon clicking Undo paste conversion', async () => {
    const view = await mount(
      <Composer
        commands={[]}
        running={false}
        onSend={vi.fn()}
        documents={{
          available: true,
          workspaceId: 'ws_1',
          chatId: 'chat_1',
          onEnsureChat: async () => 'chat_1',
          upload: async () => ({ mediaId: 'doc_pasted', format: 'text/plain' as const, filename: 'Pasted text.txt' }),
        }}
      />
    );

    const textarea = view.host.querySelector('textarea')!;
    await fill(textarea, 'Prefix: ');

    const oversizedClipboard = 'B'.repeat(16100);
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        getData: (format: string) => (format === 'text/plain' ? oversizedClipboard : ''),
      },
    });

    await React.act(async () => {
      textarea.dispatchEvent(pasteEvent);
    });

    expect(view.host.textContent).toContain('Pasted text.txt');

    const undoBtn = view.host.querySelector('[aria-label="Undo paste conversion"]') as HTMLElement;
    expect(undoBtn).toBeTruthy();

    // Click undo
    await React.act(async () => {
      undoBtn.click();
    });

    // Restores original draft prefix + pasted text
    expect(textarea.value).toBe('Prefix: ' + oversizedClipboard);
    // Attachment is removed
    expect(view.host.textContent).not.toContain('Pasted text.txt');

    await view.unmount();
  });

  it('offers "Attach long text" recovery button when draft exceeds 16,000 characters', async () => {
    const view = await mount(
      <Composer
        commands={[]}
        running={false}
        onSend={vi.fn()}
        documents={{
          available: true,
          workspaceId: 'ws_1',
          chatId: 'chat_1',
          onEnsureChat: async () => 'chat_1',
          upload: async () => ({ mediaId: 'doc_pasted', format: 'text/plain' as const, filename: 'Pasted text.txt' }),
        }}
      />
    );

    const textarea = view.host.querySelector('textarea')!;
    // Fill with >16,000 characters (e.g. from restored draft or long editing)
    const longText = 'Hunor meeting prep '.repeat(1000); // 19,000 chars
    await fill(textarea, longText);

    // Look for "Attach long text" button
    const attachLongTextBtn = Array.from(view.host.querySelectorAll('button')).find(
      b => b.textContent?.includes('Attach long text')
    );
    expect(attachLongTextBtn).toBeTruthy();

    // Click "Attach long text"
    await React.act(async () => {
      attachLongTextBtn!.click();
    });

    // Draft is converted to attachment
    expect(view.host.textContent).toContain('Pasted text.txt');
    expect(textarea.value).toBe('');
    expect(view.host.textContent).toContain('Long text attached as a file.');

    await view.unmount();
  });

  it('submits a document-only message with documentMediaIds and isPastedText flag', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const uploadFn = vi.fn().mockResolvedValue({
      mediaId: 'doc_uploaded_123',
      format: 'text/plain',
      filename: 'Pasted text.txt',
    });

    const view = await mount(
      <Composer
        commands={[]}
        running={false}
        onSend={onSend}
        documents={{
          available: true,
          workspaceId: 'ws_1',
          chatId: 'chat_1',
          onEnsureChat: async () => 'chat_1',
          upload: uploadFn,
        }}
      />
    );

    const textarea = view.host.querySelector('textarea')!;
    const oversizedClipboard = 'C'.repeat(16200);
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        getData: (format: string) => (format === 'text/plain' ? oversizedClipboard : ''),
      },
    });

    await React.act(async () => {
      textarea.dispatchEvent(pasteEvent);
    });

    // Document is attached, textarea is empty
    expect(textarea.value).toBe('');
    expect(view.host.textContent).toContain('Pasted text.txt');

    // Submit the message
    const sendBtn = view.host.querySelector('[aria-label="Send"]') as HTMLElement;
    expect(sendBtn).toBeTruthy();

    await React.act(async () => {
      sendBtn.click();
    });

    // Verifies upload was called
    expect(uploadFn).toHaveBeenCalled();

    // Verifies onSend was called with empty text and document options
    expect(onSend).toHaveBeenCalledWith(
      '',
      undefined,
      {
        documentMediaIds: ['doc_uploaded_123'],
        isPastedText: true,
      }
    );

    await view.unmount();
  });
});
