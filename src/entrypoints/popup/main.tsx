import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { call } from '@/messaging/client';
import { loadSettings } from '@/settings/settings';
import { Popup } from './Popup';
import '@/styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

// `popup.html?tab=<id>` shows that tab (tests); otherwise the active tab.
const param = new URLSearchParams(location.search).get('tab');

// Read everything first, then render once: no loading state to flash.
(param
  ? Promise.resolve(Number(param))
  : browser.tabs.query({ active: true, currentWindow: true }).then(([t]) => t?.id ?? -1)
)
  .then((tabId) => Promise.all([call('view', { tabId }), loadSettings()]))
  .then(
    ([view, settings]) =>
      createRoot(root).render(
        <StrictMode>
          <Popup initial={view} settings={settings} />
        </StrictMode>,
      ),
    (err: Error) => {
      root.textContent = err.message;
      root.className = 'popup-error';
    },
  );
