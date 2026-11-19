/** Small shared controls for the extension pages. Native elements underneath, for keyboard and
 * screen-reader behaviour that just works. */
import { type ReactNode, useId } from 'react';

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
  testId?: string;
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

export function ProgressBar({
  value,
  label,
}: {
  /** 0–1, or null when unknown. */
  value: number | null;
  label: string;
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
    >
      <span style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

/** A 1–3 level meter with its value in words for screen readers. */
export function Meter({ level, text }: { level: 1 | 2 | 3; text: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="meter" aria-hidden="true">
        {[1, 2, 3].map((i) => (
          <i key={i} data-on={i <= level} />
        ))}
      </span>
      <span>{text}</span>
    </span>
  );
}

export type Tone = 'off' | 'ok' | 'busy' | 'warn' | 'error';

export function Dot({ tone }: { tone: Tone }) {
  return <span className="dot" data-tone={tone} aria-hidden="true" />;
}

const ICONS = {
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  download: 'M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14',
  close: 'M6 6l12 12M18 6L6 18',
  trash: 'M5 7h14M10 7V5h4v2m-7 0l1 12h8l1-12',
  arrow: 'M5 12h14m-5-5l5 5-5 5',
  back: 'M19 12H5m5-5l-5 5 5 5',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  chip: 'M8 8h8v8H8zM4 10h2m-2 4h2m12-4h2m-2 4h2M10 4v2m4-2v2m-4 12v2m4-2v2',
  speech: 'M4 12h2m3-4v8m3-11v14m3-10v6m3-3h2',
  globe:
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-9 9h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z',
  keyboard: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M7 14h10',
  external: 'M14 5h5v5m0-5l-8 8M10 5H5v14h14v-5',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
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
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true" focusable="false">
      <rect width="128" height="128" rx="28" fill="#1d1d1f" />
      <rect
        x="1"
        y="1"
        width="126"
        height="126"
        rx="27"
        fill="none"
        stroke="rgb(255 255 255 / 0.14)"
        strokeWidth="2"
      />
      <path
        d="M44 30a26 26 0 0 1 40 0M54 44a12 12 0 0 1 20 0"
        fill="none"
        stroke="#5fd394"
        strokeWidth="8"
        strokeLinecap="round"
      />
      <rect x="34" y="68" width="60" height="14" rx="7" fill="#fcfcfb" opacity="0.7" />
      <rect x="20" y="90" width="88" height="18" rx="9" fill="#fcfcfb" />
    </svg>
  );
}
