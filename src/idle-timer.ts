import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';

export interface IdleTimer {
  reset: () => void;
  clear: () => void;
}

/**
 * Create an idle timer that closes the container stdin after a timeout.
 */
export function createIdleTimer(
  queue: GroupQueue,
  chatJid: string,
  timeoutMs: number,
  context?: string,
): IdleTimer {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const reset = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      logger.debug({ chatJid, context }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, timeoutMs);
  };

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return { reset, clear };
}
