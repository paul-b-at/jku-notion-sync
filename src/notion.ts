// src/notion.ts
import { Client, isFullPage } from '@notionhq/client'
import type { JkuAssignment } from './jku'

const notion = new Client({ auth: Bun.env.NOTION_TOKEN })

const DEADLINES_DB = Bun.env.NOTION_DEADLINES_DB!
const SUBJECTS_DB = Bun.env.NOTION_SUBJECTS_DB!

/** Map of normalized course number → Notion Subject page info */
export type SubjectMap = Map<string, { id: string; name: string }>

/** Course nr + normalized subject name lookups for assignments and exams. */
export type SubjectContext = {
	byCourseNr: SubjectMap
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

			if (vlNr) byCourseNr.set(vlNr, { id: page.id, name })
			if (ueNr) byCourseNr.set(ueNr, { id: page.id, name })

			const nk = normalizeSubjectName(name)
			if (nk) byNormalizedName.set(nk, { id: page.id, name })
		}

		cursor = res.has_more ? res.next_cursor ?? undefined : undefined
	} while (cursor)

	return { byCourseNr, byNormalizedName }
}

export async function upsertAssignment(
	a: JkuAssignment,
	subjects: SubjectContext,
	dryRun: boolean,
): Promise<'created' | 'updated'> {
	const existing = await notion.databases.query({
		database_id: DEADLINES_DB,
		filter: { property: 'JKU ID', rich_text: { equals: a.id } },
	})

	const subject = subjects.byCourseNr.get(normalizeCourseNr(a.courseNr) ?? '')
	const properties: any = {
		'Name': { title: [{ text: { content: a.title } }] },
		'JKU ID': { rich_text: [{ text: { content: a.id } }] },
		'Due Date': { date: { start: a.dueAt } },
		'Moodle Link': { url: a.moodleUrl },
		'Last Synced': { date: { start: new Date().toISOString() } },
		'Source': { select: { name: 'JKU Sync' } },
	}
	if (subject) {
		properties['Subject'] = { relation: [{ id: subject.id }] }
	}

	if (existing.results.length === 0) {
		if (dryRun) return 'created'
		await notion.pages.create({
			parent: { database_id: DEADLINES_DB },
			properties,
		})
		return 'created'
	} else {
		if (dryRun) return 'updated'
		const page = existing.results[0]
		if (!page) return 'updated'
		await notion.pages.update({
			page_id: page.id,
			properties,
		})
		return 'updated'
	}
}