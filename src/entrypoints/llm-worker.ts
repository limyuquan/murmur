import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { startLlmWorker } from '@/engines/llm/worker';

/**
 * The LLM translation model's worker (engines/llm/worker.ts), started by its engine in the
 * offscreen document with `new Worker('/llm-worker.js')`. Built as a plain (classic) script, which
 * LiteRT-LM needs: it loads its WebAssembly glue with `importScripts()`.
 */
export default defineUnlistedScript(() => {
  startLlmWorker();
});
