/** What the popup says about the session, pure: a tone, a title, a detail and maybe a fix. */
import type { ProfileChoice } from '@/engines/profiles';
import type { TabView } from '@/messaging/protocol';
import { formatSize } from '@/models/types';
import type { Tone } from '@/ui/components';
import { listNames } from '@/ui/languages';

export type FixAction =
  | { kind: 'retry'; label: string }
  | { kind: 'settings'; label: string; section?: string }
  | { kind: 'profile'; label: string; profile: ProfileChoice };

export interface StatusLine {
  tone: Tone;
  title: string;
  detail?: string;
  /** 0–1 progress, or null for an indeterminate bar; absent for none. */
  progress?: number | null;
  action?: FixAction;
}

/** Silence this long without any sound means the tab plays nothing we can hear. */
export const NO_SOUND_MS = 8000;

export function isOn(view: TabView): boolean {
  return view.thisTab && view.status.state !== 'error' && view.status.state !== 'idle';
}

export function describeStatus(view: TabView): StatusLine {
  const s = view.status;
  if (s.state === 'idle') {
    if (!view.models.ready && !view.models.simulated) {
      return {
        tone: 'off',
        title: 'Off',
        detail: `The models for this setting aren't downloaded yet (${formatSize(view.models.missingMB)}).`,
        action: { kind: 'settings', label: 'Download', section: 'models' },
      };
    }
    return { tone: 'off', title: 'Off' };
  }
  if (!view.thisTab) {
    return {
      tone: 'off',
      title: 'On in another tab',
      detail: 'Turning it on here stops it there.',
    };
  }
  switch (s.state) {
    case 'starting':
      return { tone: 'busy', title: 'Starting…', progress: null };
    case 'loading':
      return { tone: 'busy', title: `${s.detail}…`, progress: s.progress };
    case 'error':
      return describeError(s.code, s.message, view.profile);
    case 'running':
      return describeRunning(view, s.heard, s.activity);
  }
}

function describeRunning(
  view: TabView,
  heard: boolean,
  a: Extract<TabView['status'], { state: 'running' }>['activity'],
): StatusLine {
  if (a && !a.soundEver && a.silentMs >= NO_SOUND_MS) {
    return {
      tone: 'warn',
      title: 'No sound from this tab',
      detail:
        'Is the video playing and unmuted? Protected videos (DRM) are silent to extensions, so there is nothing to transcribe.',
    };
  }
  if (a?.behind) {
    const late = a.delayMs !== null ? ` Subtitles are ${Math.round(a.delayMs / 1000)} s late.` : '';
    return {
      tone: 'warn',
      title: 'Falling behind',
      detail: `This device can't keep up with the current models.${late}`,
      ...(view.profile !== 'light' && {
        action: { kind: 'profile', label: 'Use Light models', profile: 'light' } as const,
      }),
    };
  }
  if (a && a.unsupported.length > 0) {
    return {
      tone: 'warn',
      title: `Can't translate ${listNames(a.unsupported)}`,
      detail: 'The current models don’t cover it. Other lines are still translated.',
      action: { kind: 'settings', label: 'Models', section: 'models' },
    };
  }
  if (!heard || !a) {
    return { tone: 'ok', title: 'Listening', detail: 'No speech heard yet.' };
  }
  const title =
    a.stage === 'transcribing'
      ? 'Transcribing'
      : a.stage === 'translating'
        ? 'Translating'
        : 'Listening';
  const detail =
    a.silentMs >= NO_SOUND_MS
      ? 'No sound right now.'
      : a.delayMs !== null
        ? `About ${(a.delayMs / 1000).toFixed(1)} s behind the speech.`
        : undefined;
  return detail ? { tone: 'ok', title, detail } : { tone: 'ok', title };
}

function describeError(
  code: string | undefined,
  message: string,
  profile: ProfileChoice,
): StatusLine {
  switch (code) {
    case 'page':
      return {
        tone: 'error',
        title: "Can't run on this page",
        detail:
          'Browser pages and the Chrome Web Store can’t be captured. Try a page with a video.',
      };
    case 'access':
      return {
        tone: 'error',
        title: 'Chrome needs a click on this tab',
        detail: message,
        action: { kind: 'retry', label: 'Try again' },
      };
    case 'busy':
      return {
        tone: 'error',
        title: 'This tab is already being captured',
        detail: 'Stop the other recording or extension, then try again.',
        action: { kind: 'retry', label: 'Try again' },
      };
    case 'companion':
      return {
        tone: 'error',
        title: 'The companion app isn’t running',
        detail: 'Start it, or use models that run in the browser.',
        action:
          profile !== 'balanced'
            ? { kind: 'profile', label: 'Use Balanced', profile: 'balanced' }
            : { kind: 'retry', label: 'Try again' },
      };
    case 'model':
      return {
        tone: 'error',
        title: 'A model didn’t load',
        detail: message,
        action: { kind: 'settings', label: 'Models', section: 'models' },
      };
    default:
      return {
        tone: 'error',
        title: 'Something went wrong',
        detail: message,
        action: { kind: 'retry', label: 'Try again' },
      };
  }
}
