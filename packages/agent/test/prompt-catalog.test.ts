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
});
