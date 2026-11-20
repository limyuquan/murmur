/** Small shared controls for the extension pages. Native elements underneath, for keyboard and
 * screen-reader behaviour that just works; src/styles/app.css draws them. */
import { type ReactNode, type SelectHTMLAttributes, useId } from 'react';

export function Switch({
  checked,
  onChange,
  label,
  labelledBy,
  disabled,
  large,
  testId,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  /** Accessible name when there's no visible label to point at. */
  label?: string;
  labelledBy?: string;
  disabled?: boolean;
  large?: boolean;
  testId?: string | undefined;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      className={large ? 'switch switch-lg' : 'switch'}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      data-testid={testId}
    />
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Accessible name when the label is terse ("S"). */
  title?: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  testId,
}: {
  value: T | null;
  options: readonly SegmentOption<T>[];
  onChange(next: T): void;
  label: string;
  disabled?: boolean;
  testId?: string;
}) {
  const name = useId();
  return (
    <div className="segmented" role="radiogroup" aria-label={label} data-testid={testId}>
      {options.map((o) => (
        <label key={o.value} title={o.title}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={disabled}
            aria-label={o.title}
            onChange={() => onChange(o.value)}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/** A checkbox: the native input, drawn as a pastel box with an inked check. */
export function Checkbox({
  checked,
  onChange,
  testId,
  describedBy,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  testId?: string;
  describedBy?: string;
}) {
  return (
    <span className="box">
      <input
        type="checkbox"
        className="native"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
        aria-describedby={describedBy}
      />
      <span className="check" aria-hidden="true">
        <Icon name="check" size={12} stroke={3} />
      </span>
    </span>
  );
}

/** A native select with the system's chevron. */
export function Select({
  large,
  block,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { large?: boolean; block?: boolean }) {
  return (
    <span className={block ? 'select-wrap block' : 'select-wrap'}>
      <select {...props} className={large ? 'input input-lg' : 'input'} />
      <Icon name="chevron" />
    </span>
  );
}

/** Statuses, each with its colour family (src/styles/tokens.css). */
export type Tone = 'off' | 'listening' | 'translating' | 'behind' | 'error' | 'success';

export function ProgressBar({
  value,
  label,
  tone,
}: {
  /** 0–1, or null when unknown. */
  value: number | null;
  label: string;
  /** Sky while downloading (the default), mint while checking a download. */
  tone?: Tone;
}) {
  const pct = value === null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      data-indeterminate={pct === null}
      data-tone={tone ?? 'translating'}
    >
      <span style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

/** A 1–3 level meter with its value in words for screen readers. */
export function Meter({ level, text }: { level: 1 | 2 | 3; text: string }) {
  return (
    <span className="row g2">
      <span className="meter" aria-hidden="true">
        {[1, 2, 3].map((i) => (
          <i key={i} data-on={i <= level} />
        ))}
      </span>
      <span className="t-label">{text}</span>
    </span>
  );
}

/** A small status line: a glyph and words in the tone's text colour. */
export function State({
  tone,
  icon,
  children,
  testId,
}: {
  tone?: Tone;
  icon?: IconName;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <span className="state" data-tone={tone} data-testid={testId}>
      {icon && <Icon name={icon} />}
      <span>{children}</span>
    </span>
  );
}

/** A one-line note on a page, tinted by its tone, with a glyph. */
export function Notice({
  tone,
  icon = 'info',
  children,
  testId,
}: {
  tone: Tone;
  icon?: IconName;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <p className="notice" data-tone={tone} data-testid={testId}>
      <Icon name={icon} />
      <span>{children}</span>
    </p>
  );
}

/** The keys of a shortcut ("Alt+Shift+S"), each in a key cap. */
export function Keys({ shortcut }: { shortcut: string }) {
  const keys = shortcut.split('+').filter(Boolean);
  return (
    <span className="keys">
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
    </span>
  );
}

const ICONS = {
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  download: 'M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14',
  upload: 'M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 19h14',
  close: 'M6 6l12 12M18 6L6 18',
  trash: 'M5 7h14M10 7V5h4v2m-7 0l1 12h8l1-12',
  arrow: 'M5 12h14m-5-5l5 5-5 5',
  back: 'M19 12H5m5-5l-5 5 5 5',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  chip: 'M8 8h8v8H8zM4 10h2m-2 4h2m12-4h2m-2 4h2M10 4v2m4-2v2m-4 12v2m4-2v2',
  wave: 'M4 11v2m4-5v8m4-11v14m4-10v6m4-4v2',
  globe:
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-9 9h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z',
  keyboard: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M7 14h10',
  chevron: 'M7 10l5 5 5-5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-14v5l3 2',
  alert: 'M12 8v5m0 3.5v.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  info: 'M12 11v5m0-8.5v.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  off: 'M12 4v8M7.5 7a7 7 0 1 0 9 0',
  swap: 'M4 8h13m0 0l-3.5-3.5M17 8l-3.5 3.5M20 16H7m0 0l3.5-3.5M7 16l3.5 3.5',
  lines: 'M5 7h14M5 12h14M5 17h8',
  subtitles: 'M5 6h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm2 8h4m2 0h4',
  book: 'M5 5.5A1.5 1.5 0 0 1 6.5 4H19v14H6.5A1.5 1.5 0 0 0 5 19.5v-14Zm0 14A1.5 1.5 0 0 0 6.5 21H19',
  ahead: 'M5 6l7 6-7 6V6Zm8 0l7 6-7 6V6Z',
  reload: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4',
  layers: 'M12 3l8 4.5-8 4.5-8-4.5L12 3Zm-8 9l8 4.5 8-4.5M4 16.5L12 21l8-4.5',
  play: 'M8 5l11 7-11 7V5Z',
  stop: 'M7 7h10v10H7z',
  plus: 'M12 5v14M5 12h14',
  external: 'M14 5h5v5m0-5l-8 8M10 5H5v14h14v-5',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 16,
  stroke = 1.75,
}: {
  name: IconName;
  size?: number;
  stroke?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

/** The Murmur mark (assets/icon.svg), drawn inline. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true" focusable="false">
      <rect width="128" height="128" rx="30" style={{ fill: 'var(--logo-tile)' }} />
      <path
        d="M30 74V54a17 17 0 0 1 34 0v20m0-20a17 17 0 0 1 34 0v20"
        fill="none"
        style={{ stroke: 'var(--logo-glyph)' }}
        strokeWidth="13"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="24" y="88" width="80" height="13" rx="6.5" style={{ fill: 'var(--logo-bar)' }} />
    </svg>
  );
}
