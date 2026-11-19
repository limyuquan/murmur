/**
 * Static info for the demo engines, apart from their code so the registry can list them without
 * loading them (and so `create()`'s dynamic import really splits).
 */
import type { AsrEngineInfo, TranslationEngineInfo } from '../types';

export const ECHO_ASR_INFO: AsrEngineInfo = {
  kind: 'asr',
  id: 'demo-echo',
  label: 'Demo (no speech recognition)',
  description: 'Shows when sound was heard instead of words. For trying Earshot without a model.',
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
