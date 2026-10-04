import type { Preview } from '@storybook/react-vite';
import '@fontsource-variable/inter';
import '../src/globals.css';
import '../src/index.css';
import '../src/components/ui/controls.css';
import './storybook.css';

/**
 * 008A Storybook preview. Synthetic data only: no workspace content,
 * credentials, provider calls or authentication. Every story renders the
 * production component with fixture props.
 */
document.documentElement.classList.add('dark');

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    backgrounds: {
      default: 'canvas',
      values: [{ name: 'canvas', value: '#181818' }],
    },
    a11y: {
      config: {
        rules: [
          { id: 'color-contrast', enabled: true },
          { id: 'label', enabled: true },
        ],
      },
    },
  },
};

export default preview;
