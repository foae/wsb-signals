/**
 * Worker logger — pino (structured JSON), per v2-plan.md §3.
 *
 * Pretty-printing is dev-only (LOG_PRETTY=1); production emits raw JSON lines for a log scraper.
 */
import { pino } from 'pino'

const pretty = process.env.LOG_PRETTY === '1'

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(pretty
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard', ignore: 'pid,hostname' } } }
    : {}),
})

export type Logger = typeof log
