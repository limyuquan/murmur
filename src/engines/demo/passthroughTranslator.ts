/**
 * Demo translator: no model. Returns the source text tagged with the target language, streamed in
 * two steps (half, then all) so the overlay's partial-translation path gets exercised too.
 */
import type {
  EngineState,
  TranslationChunk,
  TranslationEngine,
  TranslationRequest,
} from '../types';
import { PASSTHROUGH_INFO } from './info';

export class PassthroughTranslationEngine implements TranslationEngine {
  readonly info = PASSTHROUGH_INFO;
  state: EngineState = 'unloaded';

  async load(): Promise<void> {
    this.state = 'ready';
  }

  async unload(): Promise<void> {
    this.state = 'unloaded';
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationChunk> {
    if (request.source.kind !== 'text') throw new Error('The demo translator takes text only');
    const full = `[${request.target}] ${request.source.text}`;
    const words = full.split(' ');
    const half = words.slice(0, Math.ceil(words.length / 2)).join(' ');
    if (half !== full) {
      yield { text: half, final: false };
      await Promise.resolve();
    }
    if (request.signal.aborted) return;
    yield { text: full, final: true };
  }
}
