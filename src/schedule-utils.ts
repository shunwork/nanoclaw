import { CronExpressionParser } from 'cron-parser';

/**
 * Compute the next run time for a scheduled task.
 * Returns ISO string on success, or null if the schedule type doesn't recur (e.g. completed 'once').
 * Throws on invalid schedule values.
 */
export function computeNextRun(
  scheduleType: 'cron' | 'interval' | 'once',
  scheduleValue: string,
  timezone: string,
): string | null {
  if (scheduleType === 'cron') {
    const interval = CronExpressionParser.parse(scheduleValue, { tz: timezone });
    return interval.next().toISOString();
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms <= 0) {
      throw new Error(`Invalid interval value: ${scheduleValue}`);
    }
    return new Date(Date.now() + ms).toISOString();
  }

  if (scheduleType === 'once') {
    const scheduled = new Date(scheduleValue);
    if (isNaN(scheduled.getTime())) {
      throw new Error(`Invalid timestamp: ${scheduleValue}`);
    }
    return scheduled.toISOString();
  }

  return null;
}
