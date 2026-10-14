import { canonicalActivityUrl } from './moodle-tasks'

export interface ExistingTask { pageId: string; source: string; key: string; url: string }
/** Reuse only sync-owned rows. Never guess by title/date or overwrite manual entries. */
export function findExistingTask(rows: ExistingTask[], key: string, url: string): ExistingTask | undefined {
  const canonical = canonicalActivityUrl(url)
  const candidates = rows.filter(r => r.source === 'JKU Sync' && (
    r.key === key || (canonical && canonicalActivityUrl(r.url) === canonical && !r.key.startsWith('moodle:'))
  ))
  if (candidates.length > 1) throw new Error('Multiple sync-owned rows match this Moodle activity; resolve duplicates before migration')
  return candidates[0]
}
