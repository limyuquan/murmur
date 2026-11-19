/**
 * The engine registry: every engine Earshot can use, by id, as a factory with static info. Info
 * is readable without loading anything (settings UI, profile resolution); `create()` may
 * dynamic-import the engine's code so heavy runtimes load only when chosen.
 */
import type {
  AsrEngine,
  AsrEngineInfo,
  EngineKind,
  TranslationEngine,
  TranslationEngineInfo,
} from './types';

export interface EngineFactory<E extends AsrEngine | TranslationEngine> {
  readonly info: E['info'];
  create(): Promise<E>;
}

export type AsrFactory = EngineFactory<AsrEngine>;
export type TranslationFactory = EngineFactory<TranslationEngine>;

export class EngineRegistry {
  private readonly asr = new Map<string, AsrFactory>();
  private readonly translation = new Map<string, TranslationFactory>();

  registerAsr(factory: AsrFactory): this {
    this.add(this.asr, 'asr', factory);
    return this;
  }

  registerTranslation(factory: TranslationFactory): this {
    this.add(this.translation, 'translation', factory);
    return this;
  }

  /** Every ASR engine's info, in registration order. */
  asrEngines(): AsrEngineInfo[] {
    return [...this.asr.values()].map((f) => f.info);
  }

  translationEngines(): TranslationEngineInfo[] {
    return [...this.translation.values()].map((f) => f.info);
  }

  hasAsr(id: string): boolean {
    return this.asr.has(id);
  }

  hasTranslation(id: string): boolean {
    return this.translation.has(id);
  }

  asrInfo(id: string): AsrEngineInfo | undefined {
    return this.asr.get(id)?.info;
  }

  translationInfo(id: string): TranslationEngineInfo | undefined {
    return this.translation.get(id)?.info;
  }

  createAsr(id: string): Promise<AsrEngine> {
    return this.create(this.asr, 'asr', id);
  }

  createTranslation(id: string): Promise<TranslationEngine> {
    return this.create(this.translation, 'translation', id);
  }

  private add<F extends AsrFactory | TranslationFactory>(
    map: Map<string, F>,
    kind: EngineKind,
    factory: F,
  ): void {
    const { id } = factory.info;
    if (factory.info.kind !== kind) {
      throw new Error(`Engine ${id} is a ${factory.info.kind} engine, not ${kind}`);
    }
    if (map.has(id)) throw new Error(`Engine ${id} is already registered`);
    map.set(id, factory);
  }

  private async create<E extends AsrEngine | TranslationEngine>(
    map: Map<string, EngineFactory<E>>,
    kind: EngineKind,
    id: string,
  ): Promise<E> {
    const factory = map.get(id);
    if (!factory) throw new Error(`No ${kind} engine called ${id}`);
    const engine = await factory.create();
    if (engine.info.id !== id) throw new Error(`Engine factory ${id} made ${engine.info.id}`);
    return engine;
  }
}
