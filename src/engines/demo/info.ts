/**
 * Static info for the demo engines, apart from their code so the registry can list them without
 * loading them (and so `create()`'s dynamic import really splits).
 */
import type { AsrEngineInfo, TranslationEngineInfo } from '../types';

export const ECHO_ASR_INFO: AsrEngineInfo = {
  kind: 'asr',
  id: 'demo-echo',
  label: 'Demo (no speech recognition)',
  description: 'Shows when sound was heard instead of words. For trying Murmur without a model.',
  runtime: 'demo',
  requirements: { backends: ['none'] },
  languages: 'any',
  streaming: true,
  detectsLanguage: false,
  codeSwitching: false,
  license: 'MIT',
};

export const PASSTHROUGH_INFO: TranslationEngineInfo = {
  kind: 'translation',
  id: 'demo-passthrough',
  label: 'Demo (no translation)',
  description: 'Repeats the recognised text, marked with the target language.',
  runtime: 'demo',
  requirements: { backends: ['none'] },
  inputs: ['text'],
  sources: 'any',
  targets: 'any',
  streaming: true,
  usesContext: false,
  license: 'MIT',
};

/** e2e builds: an ASR engine whose load needs a Chrome language pack first (a click). */
export const NEEDS_PACK_ASR_INFO: AsrEngineInfo = {
  ...ECHO_ASR_INFO,
  id: 'demo-needs-pack',
  label: 'Demo (needs a language pack)',
  description: 'Fails to load until a language pack is downloaded. For tests.',
};

/** e2e builds: an ASR engine whose load never finishes, until it is cancelled. */
export const STALLED_ASR_INFO: AsrEngineInfo = {
  ...ECHO_ASR_INFO,
  id: 'demo-stalled',
  label: 'Demo (never loads)',
  description: 'Loads until the session stops. For tests.',
};
