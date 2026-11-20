/**
 * What this browser lacks of the APIs Murmur's models use, in plain words: Chrome's on-device
 * speech recognition (Chrome 139+), its translator (138+), WebGPU, and the WebAssembly features
 * the translation model's runtime needs (137+). Other Chromium browsers often lack the first two.
 */
import { canPinOnDevice, speechRecognition, translatorApi } from '@/engines/chrome/api';

export interface BrowserGap {
  api: 'speech' | 'translator' | 'webgpu' | 'wasm';
  text: string;
}

export function browserGaps(scope: typeof globalThis = globalThis): BrowserGap[] {
  const gaps: BrowserGap[] = [];
  const speech = speechRecognition();
  if (!speech || !canPinOnDevice(speech)) {
    gaps.push({
      api: 'speech',
      text: 'This browser has no on-device speech recognition (Chrome 139 or newer has it), so Light uses Whisper base, a small download, instead.',
    });
  }
  if (!translatorApi()) {
    gaps.push({
      api: 'translator',
      text: 'This browser has no built-in translator (Chrome 138 or newer has it), so Light can’t translate here, and lines the translation model is late on aren’t translated.',
    });
  }
  if (!(scope.navigator as { gpu?: unknown } | undefined)?.gpu) {
    gaps.push({
      api: 'webgpu',
      text: 'This browser has no WebGPU, so Balanced and Best can’t run their models on the graphics card.',
    });
  } else if (!('Suspending' in (scope.WebAssembly ?? {}))) {
    gaps.push({
      api: 'wasm',
      text: 'The translation model needs Chrome 137 or newer; Chrome’s translator translates instead.',
    });
  }
  return gaps;
}
