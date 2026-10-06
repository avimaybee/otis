import { describe, expect, it } from 'vitest';
import { renderSystemPrompt } from '../src/prompt.js';

describe('model catalog prompt section', () => {
  it('names available models with per-model efforts and marks the current selection', () => {
    const prompt = renderSystemPrompt({
      workspaceName: 'Kerning',
      availableModels: [
        { name: 'Gemini 3.5 Flash-Lite', current: true, efforts: ['Minimal', 'Low'], currentEffort: 'Low' },
        { name: 'Muse Spark 1.3 Contributor', current: false, efforts: ['Minimal', 'Extra high'] },
        { name: 'DeepSeek V4.1 Flash', current: false, efforts: [] },
      ],
    });
    expect(prompt).toContain('Available Models');
    expect(prompt).toContain('- Gemini 3.5 Flash-Lite [current, current effort: Low] (effort: Minimal/Low)');
    expect(prompt).toContain('- Muse Spark 1.3 Contributor (effort: Minimal/Extra high)');
    expect(prompt).toContain('- DeepSeek V4.1 Flash (effort: provider default)');
    expect(prompt).toContain('never invent others');
  });

  it('omits the section when no catalog is supplied', () => {
    expect(renderSystemPrompt({ workspaceName: 'Kerning' })).not.toContain('Available Models');
    expect(renderSystemPrompt({ workspaceName: 'Kerning', availableModels: [] })).not.toContain('Available Models');
  });

  it('renders per-model modality truth in plain words when supplied', () => {
    const prompt = renderSystemPrompt({
      workspaceName: 'Kerning',
      availableModels: [
        {
          name: 'Gemini 3.5 Flash-Lite',
          current: true,
          efforts: [],
          modalities: { images: 'unverified', voiceNotes: 'supported' },
        },
        {
          name: 'DeepSeek V4.1 Flash',
          current: false,
          efforts: [],
          modalities: { images: 'unverified', voiceNotes: 'unsupported' },
        },
      ],
    });
    expect(prompt).toContain('- Gemini 3.5 Flash-Lite [current] (effort: provider default; images: untested; voice notes: yes)');
    expect(prompt).toContain('- DeepSeek V4.1 Flash (effort: provider default; images: untested; voice notes: no)');
  });

  it('keeps the legacy line shape when modalities are absent', () => {
    const prompt = renderSystemPrompt({
      workspaceName: 'Kerning',
      availableModels: [{ name: 'MiMo V2.5', current: false, efforts: [] }],
    });
    expect(prompt).toContain('- MiMo V2.5 (effort: provider default)');
    expect(prompt).not.toContain('images:');
  });

  it('states its own senses in the stable instructions', () => {
    const prompt = renderSystemPrompt({ workspaceName: 'Kerning' });
    expect(prompt).toContain('Your senses:');
    expect(prompt).toContain('up to four per message');
  });

  it('names no business in the stable instructions; the workspace comes from context', () => {
    const prompt = renderSystemPrompt({ workspaceName: 'Kerning' });
    const stable = prompt.split('--- Current Workspace Context ---')[0]!;
    expect(stable).not.toContain('Kerning');
    expect(stable).toContain('workspace name in your context');
    expect(prompt).toContain('Workspace: Kerning');
  });
});
