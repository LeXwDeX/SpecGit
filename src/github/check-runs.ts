import type { CheckRunInfo } from './port.js';

/** Truth-attempt ordering shared by acceptance and automated delivery. */
export function isLaterCheckRun(a: CheckRunInfo, b: CheckRunInfo): boolean {
  const keyA = a.startedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(a.startedAt);
  const keyB = b.startedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(b.startedAt);
  const timeA = Number.isNaN(keyA) ? Number.NEGATIVE_INFINITY : keyA;
  const timeB = Number.isNaN(keyB) ? Number.NEGATIVE_INFINITY : keyB;
  if (timeA !== timeB) return timeA > timeB;
  return a.id > b.id;
}
