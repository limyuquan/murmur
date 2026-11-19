/** Extension pages (popup, options) → service worker. */
import { browser } from 'wxt/browser';
import type { Op, Ops, Request, Response } from './protocol';

/** Runs `op` in the service worker. Throws with the worker's message when it fails. */
export async function call<K extends Op>(op: K, args: Ops[K][0]): Promise<Ops[K][1]> {
  const request: Request<K> = { target: 'background', op, args };
  const res = (await browser.runtime.sendMessage(request)) as Response<K> | undefined;
  if (!res) throw new Error('Earshot did not answer. Reload the extension and try again.');
  if (!res.ok) throw new Error(res.error.message);
  return res.result;
}
