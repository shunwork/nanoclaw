/**
 * Shared logging for agent-runner modules.
 */

export function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}
