import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { configureVoiceUpload, createWorkerVoiceAdapter } from './api/voice.js';
import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/geist-mono';
import './globals.css';
import './index.css';
import './components/ui/controls.css';

// The production voice adapter targets the authenticated Worker media routes.
// The mic still appears only when the server reports an effective voice route
// for the current model, so an unsupported exact format fails closed.
configureVoiceUpload(createWorkerVoiceAdapter());

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found');
}

const root = createRoot(container);
root.render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
