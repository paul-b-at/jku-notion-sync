// src/notion.ts
import { Client, isFullPage } from '@notionhq/client'
import type { JkuAssignment } from './jku'

const notion = new Client({ auth: Bun.env.NOTION_TOKEN })

const DEADLINES_DB = Bun.env.NOTION_DEADLINES_DB!
const SUBJECTS_DB = Bun.env.NOTION_SUBJECTS_DB!

/** Map of normalized course number → Notion Subject page info */
export type SubjectMap = Map<string, { id: string; name: string }>

/** Strip dots, dashes, whitespace so "366.594" === "366594" */
function normalizeCourseNr(s: string | undefined | null): string | null {
	if (!s) return null
	const cleaned = s.replace(/[.\s-]/g, '')
	return cleaned.length > 0 ? cleaned : null
}

export async function loadSubjectMap(): Promise<SubjectMap> {
	const map: SubjectMap = new Map()
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

			if (vlNr) map.set(vlNr, { id: page.id, name })
			if (ueNr) map.set(ueNr, { id: page.id, name })
		}

		cursor = res.has_more ? res.next_cursor ?? undefined : undefined
	} while (cursor)

	return map
}

export async function upsertAssignment(
	a: JkuAssignment,
	subjects: SubjectMap,
	dryRun: boolean,
): Promise<'created' | 'updated'> {
	const existing = await notion.databases.query({
		database_id: DEADLINES_DB,
		filter: { property: 'JKU ID', rich_text: { equals: a.id } },
	})

	const subject = subjects.get(normalizeCourseNr(a.courseNr) ?? '')
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
		await notion.pages.update({
			page_id: existing.results[0].id,
			properties,
		})
		return 'updated'
	}
}