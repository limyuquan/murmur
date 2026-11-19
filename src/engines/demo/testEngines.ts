/**
 * Engines that fail on purpose, for e2e tests of the session's failure paths (e2e builds only):
 * one whose load asks for a Chrome language pack, one whose load never finishes.
 */
import { speechAction } from '../chrome/setup';
import { EngineActionRequiredError } from '../errors';
import type { LoadOptions } from '../types';
import { EchoAsrEngine } from './echoAsr';
import { NEEDS_PACK_ASR_INFO, STALLED_ASR_INFO } from './info';

export class NeedsPackAsrEngine extends EchoAsrEngine {
  override readonly info = NEEDS_PACK_ASR_INFO;

  override async load(): Promise<void> {
    this.state = 'error';
    throw new EngineActionRequiredError([speechAction(['fr'])]);
  }
}

export class StalledAsrEngine extends EchoAsrEngine {
  override readonly info = STALLED_ASR_INFO;

  override load(options: LoadOptions = {}): Promise<void> {
    this.state = 'loading';
    options.onProgress?.({ stage: 'download', fraction: null });
    return new Promise((_, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
        once: true,
      });
    });
  }
}
