/**
 * Loads Silero VAD in an extension page (the offscreen document): the model and ONNX Runtime's
 * WebAssembly ship in the extension, so this never downloads anything. The WebAssembly build is
 * the one the speech model workers use, so the extension carries it once.
 */

// ONNX Runtime's WebAssembly build, emitted into the extension by Vite: never the CDN default.
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import * as ort from 'onnxruntime-web/webgpu';
import modelUrl from '@/assets/silero-vad/silero_vad.onnx?url';
import { SileroVad } from './silero';

export async function loadSileroVad(): Promise<SileroVad> {
  ort.env.wasm.wasmPaths = {
    mjs: new URL(ortMjs, location.href).href,
    wasm: new URL(ortWasm, location.href).href,
  };
  ort.env.wasm.numThreads = 1;
  const response = await fetch(new URL(modelUrl, location.href));
  if (!response.ok) throw new Error(`Silero VAD's model is missing (${response.status}).`);
  return SileroVad.create(ort, new Uint8Array(await response.arrayBuffer()));
}
