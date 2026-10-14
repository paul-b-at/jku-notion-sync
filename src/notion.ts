// src/notion.ts
import { Client, isFullPage } from '@notionhq/client'
import type { JkuAssignment } from './jku'
import { taskCourseNumbers, canonicalActivityUrl } from './moodle-tasks'
import { findExistingTask, type ExistingTask } from './task-migration'

const notion = new Client({ auth: Bun.env.NOTION_TOKEN })

const DEADLINES_DB = Bun.env.NOTION_DEADLINES_DB!
const SUBJECTS_DB = Bun.env.NOTION_SUBJECTS_DB!

/** Map of normalized course number → Notion Subject page info */
export type SubjectMap = Map<string, { id: string; name: string }>

/** Course nr + normalized subject name lookups for assignments and exams. */
export type SubjectContext = {
	byCourseNr: SubjectMap
	bySemesterCourseNr: SubjectMap
	/** Lowercased trimmed name → subject; last DB row wins on duplicate names. */
	byNormalizedName: Map<string, { id: string; name: string }>
}

/** Strip dots, dashes, whitespace so "366.594" === "366594" */
export function normalizeCourseNr(s: string | undefined | null): string | null {
	if (!s) return null
	const cleaned = s.replace(/[.\s-]/g, '')
	return cleaned.length > 0 ? cleaned : null
}

function normalizeSubjectName(s: string): string {
	return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Prefer course number from JKU; fall back to exact Notion subject name match (normalized). */
export function resolveSubjectForExam(
	exam: { courseName: string; courseNr?: string | null },
	ctx: SubjectContext,
): { id: string; name: string } | undefined {
	const n = normalizeCourseNr(exam.courseNr)
	if (n) {
		const byNr = ctx.byCourseNr.get(n)
		if (byNr) return byNr
	}
	const key = normalizeSubjectName(exam.courseName)
	if (!key) return undefined
	return ctx.byNormalizedName.get(key)
}

export async function loadSubjectMap(): Promise<SubjectContext> {
	const byCourseNr: SubjectMap = new Map()
	const bySemesterCourseNr: SubjectMap = new Map()
	const byNormalizedName = new Map<string, { id: string; name: string }>()
	let cursor: string | undefined

	do {
		const res = await notion.databases.query({
			database_id: SUBJECTS_DB,
			start_cursor: cursor,
		})

		for (const page of res.results) {
			if (!isFullPage(page)) continue
			const props = page.properties as any
			const name = props['Name']?.title?.[0]?.plain_text ?? '(unnamed)'
			const vlNr = normalizeCourseNr(props['Course Number']?.rich_text?.[0]?.plain_text)
			const ueNr = normalizeCourseNr(props['UE Course Number']?.rich_text?.[0]?.plain_text)

			const semester = props['Semester']?.select?.name?.match(/\d{4}[WS]/i)?.[0]?.toUpperCase()
			for (const nr of [vlNr, ueNr]) if (nr && semester) {
				const key = `${semester}:${nr.toUpperCase()}`
				if (bySemesterCourseNr.has(key)) throw new Error(`Ambiguous Subject mapping for ${key}`)
				bySemesterCourseNr.set(key, { id: page.id, name })
			}
			if (vlNr) byCourseNr.set(vlNr, { id: page.id, name })
			if (ueNr) byCourseNr.set(ueNr, { id: page.id, name })

			const nk = normalizeSubjectName(name)
			if (nk) byNormalizedName.set(nk, { id: page.id, name })
		}

		cursor = res.has_more ? res.next_cursor ?? undefined : undefined
	} while (cursor)

	return { byCourseNr, bySemesterCourseNr, byNormalizedName }
}

export function resolveSubjectForTask(a: JkuAssignment, subjects: SubjectContext): { id: string; name: string } | undefined {
  const matches = new Map<string, { id: string; name: string }>()
  for (const nr of taskCourseNumbers(a)) {
    const subject = a.semester
      ? subjects.bySemesterCourseNr.get(`${a.semester}:${nr}`)
      : subjects.byCourseNr.get(nr)
    if (subject) matches.set(subject.id, subject)
  }
  if (matches.size > 1) throw new Error('Moodle task maps to multiple Subjects; refusing to guess')
  return [...matches.values()][0]
}

/** Snapshot sync-owned rows once, then keep the index current during the run. */
let deadlineRows: ExistingTask[] | undefined
async function loadDeadlineRows(): Promise<ExistingTask[]> {
  if (deadlineRows) return deadlineRows
  const rows: ExistingTask[] = []
  let cursor: string | undefined
  do {
    const r = await notion.databases.query({ database_id: DEADLINES_DB, start_cursor: cursor,
      filter: { property: 'Source', select: { equals: 'JKU Sync' } } })
    for (const page of r.results) {
      if (!isFullPage(page)) continue
      const p = page.properties as any
      rows.push({ pageId: page.id, source: p.Source?.select?.name ?? '',
        key: (p['JKU ID']?.rich_text ?? []).map((x: any) => x.plain_text ?? x.text?.content ?? '').join(''),
        url: p['Moodle Link']?.url ?? '' })
    }
    cursor = r.has_more ? r.next_cursor ?? undefined : undefined
  } while (cursor)
  deadlineRows = rows
  return rows
}

export async function upsertAssignment(
  a: JkuAssignment, subjects: SubjectContext, dryRun: boolean,
): Promise<'created' | 'updated'> {
  const rows = await loadDeadlineRows()
  const existing = findExistingTask(rows, a.id, a.moodleUrl)
  const subject = resolveSubjectForTask(a, subjects)
  // Status, Assignee, page content and reminders are not touched.
  const properties: any = {
    Name: { title: [{ text: { content: a.title } }] },
    'JKU ID': { rich_text: [{ text: { content: a.id } }] },
    'Due Date': { date: { start: a.dueAt } },
    'Moodle Link': { url: canonicalActivityUrl(a.moodleUrl) ?? a.moodleUrl },
    'Last Synced': { date: { start: new Date().toISOString() } },
    Source: { select: { name: 'JKU Sync' } },
  }
  if (subject) properties.Subject = { relation: [{ id: subject.id }] }
  if (existing) {
    if (!dryRun) await notion.pages.update({ page_id: existing.pageId, properties })
    existing.key = a.id; existing.url = a.moodleUrl
    return 'updated'
  }
  if (dryRun) return 'created'
  const page = await notion.pages.create({ parent: { database_id: DEADLINES_DB }, properties })
  rows.push({ pageId: page.id, source: 'JKU Sync', key: a.id, url: a.moodleUrl })
  return 'created'
}
