/** The service worker's dispatcher for popup/options requests. */
import type { Op, Ops } from '@/messaging/protocol';
import { engineLabels, getStatus, plannedEngines, startSession, stopSession } from './session';

export async function dispatch<K extends Op>(op: K, args: Ops[K][0]): Promise<Ops[K][1]> {
  const handlers: { [P in Op]: (a: Ops[P][0]) => Promise<Ops[P][1]> } = {
    async view({ tabId }) {
      const status = await getStatus();
      const engines = await plannedEngines();
      return {
        tabId,
        status,
        thisTab: status.state !== 'idle' && status.tabId === tabId,
        engines: { ...engineLabels(engines), notes: engines.notes },
      };
    },
    start: ({ tabId }) => startSession(tabId),
    stop: () => stopSession(),
  };
  const handler = handlers[op] as ((a: Ops[K][0]) => Promise<Ops[K][1]>) | undefined;
  if (!handler) throw new Error(`Unknown operation: ${String(op)}`);
  return handler(args);
}
