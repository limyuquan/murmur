/** Toolbar badge: shows which tab has subtitles on. */
import { browser } from 'wxt/browser';
import type { SessionStatus } from '@/messaging/protocol';

export async function showBadge(
  status: SessionStatus,
  previousTabId: number | null,
): Promise<void> {
  const tabId = status.state === 'idle' ? null : status.tabId;
  if (previousTabId !== null && previousTabId !== tabId) {
    await browser.action.setBadgeText({ tabId: previousTabId, text: '' }).catch(() => {});
  }
  if (tabId === null) return;
  const text =
    status.state === 'running'
      ? 'ON'
      : status.state === 'error'
        ? '!'
        : status.state === 'idle'
          ? ''
          : '…';
  const color = status.state === 'error' ? '#b3261e' : '#1d1d1f';
  // The tab may be gone already.
  await browser.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  await browser.action.setBadgeText({ tabId, text }).catch(() => {});
}
