import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { loadSettings } from '@/settings/settings';
import { Options } from './Options';
import '@/styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

loadSettings().then(
  (settings) =>
    createRoot(root).render(
      <StrictMode>
        <Options initial={settings} />
      </StrictMode>,
    ),
  (err: Error) => {
    root.textContent = err.message;
  },
);
