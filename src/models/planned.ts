/**
 * Models each profile will download once real engines are in, with honest sizes. Shown (and
 * their downloads simulated) while a profile resolves to engines that declare no models. When an
 * engine with `models` is added to a profile, its own models replace these.
 */
import type { ProfileId } from '@/engines/profiles';
import type { ModelInfo } from './types';

const planned = (
  id: string,
  label: string,
  role: ModelInfo['role'],
  sizeMB: number,
  runtime: ModelInfo['runtime'] = 'browser',
): ModelInfo => ({ id, label, role, sizeMB, runtime, simulated: true });

export const PLANNED_MODELS: Record<ProfileId, readonly ModelInfo[]> = {
  light: [
    planned('planned-speech-small', 'Speech recognition, small', 'speech', 250),
    planned('planned-translation-small', 'Translation, small', 'translation', 300),
  ],
  balanced: [
    planned('planned-speech-medium', 'Speech recognition, medium', 'speech', 1000),
    planned('planned-translation-medium', 'Translation, medium', 'translation', 1400),
  ],
  best: [
    planned('planned-speech-large', 'Speech recognition, large', 'speech', 1900),
    planned('planned-translation-large', 'Translation, large', 'translation', 3200),
  ],
};
