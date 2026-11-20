/** What the popup says about the session, pure: a tone, a title, a detail and maybe a fix. */
import type { ProfileChoice } from '@/engines/profiles';
import type { SetupAction } from '@/engines/types';
import type { TabView } from '@/messaging/protocol';
import { type DownloadProgress, formatSize } from '@/models/types';
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

/** ` 42%` after a line with a progress bar, or nothing while the bar has no value. */
function percent(fraction: number | null | undefined): string {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return '';
  return ` ${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

export function describeStatus(view: TabView): StatusLine {
  const s = view.status;
  if (s.state === 'idle') {
    if (!view.models.ready) {
      return {
        tone: 'off',
        title: 'Off',
        detail: `The models for this setting aren’t downloaded yet (${formatSize(view.models.missingMB)}).`,
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
      return { tone: 'busy', title: `${s.detail}…${percent(s.progress)}`, progress: s.progress };
    case 'error':
      return describeError(s.code, s.message, (s.missingModels ?? []).length > 0);
    case 'running':
      return withNote(
        describeRunning(view, s.heard, s.activity, s.setup, s.problems),
        [s.fitNote, s.translationNote].filter(Boolean).join(' ') || undefined,
      );
  }
}

/**
 * A running session's line, with its notes (smaller models to fit the graphics memory, another
 * translator) after what it says, when all is well.
 */
function withNote(line: StatusLine, note: string | undefined): StatusLine {
  if (!note || line.tone !== 'ok') return line;
  return { ...line, detail: line.detail ? `${line.detail} ${note}` : note };
}

function describeRunning(
  view: TabView,
  heard: boolean,
  a: Extract<TabView['status'], { state: 'running' }>['activity'],
  setup?: readonly SetupAction[],
  problems?: readonly string[],
): StatusLine {
  if (problems && problems.length > 0) {
    return {
      tone: 'warn',
      title: 'Speech recognition stopped working',
      detail: `${problems.join(' ')} Turn subtitles off and on to try again.`,
    };
  }
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
    const why =
      a.rtf !== null && a.rtf > 1
        ? `Speech recognition takes ${a.rtf.toFixed(1)} s for each second of speech on this device.`
        : a.queue >= 3
          ? `${a.queue} lines are waiting for their translation.`
          : a.backlogMs >= 4000
            ? `${Math.round(a.backlogMs / 1000)} s of speech is waiting for speech recognition.`
            : 'This device can’t keep up with the current models.';
    return {
      tone: 'warn',
      title: 'Falling behind',
      detail: `${why}${late}`,
      ...(view.profile !== 'light' && {
        action: { kind: 'profile', label: 'Use Light models', profile: 'light' } as const,
      }),
    };
  }
  if (setup && setup.length > 0) {
    return {
      tone: 'warn',
      title: 'Some lines need a download',
      detail: 'Chrome needs a language pack to translate them. Other lines are still translated.',
    };
  }
  if (a && a.unsupported.length > 0) {
    return {
      tone: 'warn',
      title: `Can’t translate ${listNames(a.unsupported)}`,
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
  notDownloaded = false,
): StatusLine {
  switch (code) {
    case 'page':
      return {
        tone: 'error',
        title: 'Can’t run on this page',
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
    case 'navigated':
      return {
        tone: 'warn',
        title: 'Subtitles stopped',
        detail: message,
        action: { kind: 'retry', label: 'Turn on again' },
      };
    case 'setup':
      return {
        tone: 'warn',
        title: 'Chrome needs to download a language pack',
        detail: 'Chrome downloads it once and keeps it. Subtitles start when it’s done.',
      };
    case 'model':
      return {
        tone: 'error',
        title: notDownloaded ? 'The model isn’t downloaded' : 'A model didn’t load',
        detail: message,
        action: notDownloaded
          ? { kind: 'settings', label: 'Download', section: 'models' }
          : { kind: 'settings', label: 'Models', section: 'models' },
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

/** Where the offered download of a better translation model is. */
export type BetterState =
  | { state: 'offer' }
  | { state: 'downloading'; fraction: number | null }
  | { state: 'done' }
  | { state: 'error'; message: string };

export interface BetterLine {
  text: string;
  /** The button's label (it starts the download), when there is one. */
  button?: string;
  /** 0–1, or null for an indeterminate bar; absent for none. */
  progress?: number | null;
}

/** The offer of a translation model the session runs without (Chrome's translator stands in). */
export function describeBetter(
  better: NonNullable<TabView['models']['better']>,
  state: BetterState,
): BetterLine {
  switch (state.state) {
    case 'offer':
      return {
        text: `Better translations: download ${better.label} (${formatSize(better.sizeMB)})`,
        button: 'Download',
      };
    case 'downloading':
      return {
        text: `Downloading ${better.label}…${percent(state.fraction)}`,
        progress: state.fraction,
      };
    case 'done':
      return { text: `${better.label} is downloaded. It translates from the next start.` };
    case 'error':
      return {
        text: `${better.label} didn’t download: ${state.message}`,
        button: 'Try again',
      };
  }
}

/**
 * The offered download's state from the download progress (`DOWNLOADS_KEY`): `previous` is the
 * state before, so a download that drops out of the progress has finished.
 */
export function betterState(
  better: NonNullable<TabView['models']['better']>,
  progress: DownloadProgress,
  previous: BetterState,
): BetterState {
  const entries = better.ids.map((id) => progress[id]);
  const failed = entries.find((e) => e?.state === 'error');
  if (failed?.state === 'error') return { state: 'error', message: failed.message };
  if (entries.some((e) => e)) {
    const received = entries.reduce(
      (n, e) => n + (e?.state === 'downloading' ? e.receivedMB : 0),
      0,
    );
    const fraction = received > 0 ? Math.min(1, received / better.sizeMB) : null;
    return { state: 'downloading', fraction };
  }
  return previous.state === 'downloading' ? { state: 'done' } : previous;
}
