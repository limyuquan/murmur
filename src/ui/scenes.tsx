/**
 * Two drawn video frames for the subtitle preview and the welcome page: a dim interior and a
 * bright shore. They stand for a video, so their colours are the picture's, not the UI's tokens.
 */
import { useId } from 'react';

export type SceneKind = 'dark' | 'bright';

export function Scene({ kind }: { kind: SceneKind }) {
  const id = useId().replace(/:/g, '');
  const ref = (name: string) => `${id}-${name}`;
  return (
    <svg
      className="scene"
      viewBox="0 0 960 540"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      {kind === 'dark' ? (
        <>
          <defs>
            <radialGradient id={ref('bg')} cx="72%" cy="22%" r="85%">
              <stop offset="0" stopColor="#4a5a86" />
              <stop offset=".45" stopColor="#1e2540" />
              <stop offset="1" stopColor="#0b0d18" />
            </radialGradient>
            <radialGradient id={ref('lamp')} cx="50%" cy="50%" r="50%">
              <stop offset="0" stopColor="#ffd9a0" stopOpacity=".9" />
              <stop offset="1" stopColor="#ffd9a0" stopOpacity="0" />
            </radialGradient>
            <filter id={ref('blur')}>
              <feGaussianBlur stdDeviation="9" />
            </filter>
          </defs>
          <rect width="960" height="540" fill={`url(#${ref('bg')})`} />
          <g filter={`url(#${ref('blur')})`} opacity=".8">
            <circle cx="150" cy="150" r="34" fill="#f2b56b" />
            <circle cx="250" cy="96" r="20" fill="#e77f8f" />
            <circle cx="78" cy="250" r="24" fill="#8fb7ee" />
            <circle cx="820" cy="300" r="30" fill="#f2b56b" opacity=".6" />
            <circle cx="900" cy="190" r="16" fill="#9fe0c3" />
            <circle cx="330" cy="200" r="14" fill="#c9b8ff" />
          </g>
          <circle cx="690" cy="120" r="170" fill={`url(#${ref('lamp')})`} opacity=".35" />
          <path
            d="M0 540V400c70-12 130-8 190 6 40-70 96-110 160-110 78 0 128 52 150 132 60-20 140-24 210-6 50-40 120-52 250-30v148Z"
            fill="#090b14"
            opacity=".88"
          />
          <path
            d="M392 540c-6-92 20-150 70-176-30-26-40-70-20-106 22-40 84-48 116-14 28 30 28 82-2 112 56 22 92 82 92 184Z"
            fill="#05060c"
            opacity=".9"
          />
        </>
      ) : (
        <>
          <defs>
            <linearGradient id={ref('sky')} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#9fd0ff" />
              <stop offset=".55" stopColor="#e6f3ff" />
              <stop offset="1" stopColor="#fff6e6" />
            </linearGradient>
            <linearGradient id={ref('sand')} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fbeed3" />
              <stop offset="1" stopColor="#f1dcb2" />
            </linearGradient>
          </defs>
          <rect width="960" height="540" fill={`url(#${ref('sky')})`} />
          <circle cx="770" cy="110" r="64" fill="#fffbe9" />
          <circle cx="770" cy="110" r="110" fill="#fffbe9" opacity=".35" />
          <g fill="#fff" opacity=".95">
            <ellipse cx="190" cy="120" rx="110" ry="30" />
            <ellipse cx="260" cy="100" rx="70" ry="28" />
            <ellipse cx="560" cy="170" rx="90" ry="22" />
            <ellipse cx="610" cy="156" rx="50" ry="20" />
          </g>
          <path d="M0 330c120-40 240-46 360-18s240 20 360-6 180-22 240-8v62H0Z" fill="#8ec7dc" />
          <path d="M0 352c160-18 300-10 440 6s330 10 520-14v40H0Z" fill="#bfe3ec" />
          <path d="M0 372c200 10 420 16 960-6v174H0Z" fill={`url(#${ref('sand')})`} />
          <g fill="#fff" opacity=".9">
            <path d="M60 380c120 10 260 12 380 4-120 18-260 16-380-4Z" />
            <path d="M520 388c120 4 260 0 400-12-130 26-270 30-400 12Z" />
          </g>
          <path d="M120 540c10-70 60-104 130-104s130 40 150 104Z" fill="#f7e7c4" />
          <path d="M640 540c0-52 60-86 150-86s170 30 170 86Z" fill="#fff3d8" />
          <path d="M700 470V340" stroke="#e9728a" strokeWidth="7" strokeLinecap="round" />
          <path d="M610 344c22-56 158-56 180 0Z" fill="#f29aab" />
          <path d="M655 344c8-40 82-40 90 0Z" fill="#fde2e7" />
        </>
      )}
    </svg>
  );
}
