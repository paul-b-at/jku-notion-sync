// src/notionExams.ts
import { Client, isFullPage } from '@notionhq/client'
import { DateTime } from 'luxon'
import type { JkuExam } from './exams'
import { resolveSubjectForExam, type SubjectContext } from './notion'

const notion = new Client({ auth: Bun.env.NOTION_TOKEN })

function examsDatabaseId(): string {
	const id = Bun.env.NOTION_EXAMS_DB
	if (!id) throw new Error('NOTION_EXAMS_DB is not set (Exams data source id)')
	return id
}

export async function upsertExam(
	e: JkuExam,
	subjects: SubjectContext,
	dryRun: boolean,
): Promise<'created' | 'updated'> {
	const existing = await notion.databases.query({
		database_id: examsDatabaseId(),
		filter: { property: 'JKU ID', rich_text: { equals: e.id } },
	})

	const subject = resolveSubjectForExam(e, subjects)

	const properties: Record<string, unknown> = {
		Name: { title: [{ text: { content: e.courseName } }] },
		'JKU ID': { rich_text: [{ text: { content: e.id } }] },
		Date: { date: { start: e.date } },
		'Last Synced': { date: { start: new Date().toISOString() } },
		Source: { select: { name: 'JKU Sync' } },
	}

	if (e.link) properties['JKU Link'] = { url: e.link }
	if (subject) properties['Subject'] = { relation: [{ id: subject.id }] }

	if (existing.results.length === 0) {
		if (dryRun) return 'created'
		await notion.pages.create({
			parent: { database_id: examsDatabaseId() },
			properties: properties as any,
		})
		return 'created'
	} else {
		if (dryRun) return 'updated'
		const page = existing.results[0]
		if (!page) return 'updated'
		await notion.pages.update({
			page_id: page.id,
			properties: properties as any,
		})
		return 'updated'
	}
}

function readJkuId(page: { properties?: Record<string, unknown> }): string | undefined {
	const prop = page.properties?.['JKU ID'] as any
	const t = prop?.rich_text?.[0]?.plain_text
	return typeof t === 'string' && t.length > 0 ? t : undefined
}

/**
 * Archive future-dated JKU Sync rows whose JKU ID is not in seenIds.
 * Does not touch manual rows or past exams.
 */
export async function pruneCancelledExams(seenIds: Set<string>, dryRun: boolean): Promise<number> {
	const nowISO = DateTime.now().setZone('Europe/Vienna').toISO()!
	let archived = 0
	let cursor: string | undefined

	do {
		const { results, has_more, next_cursor } = await notion.databases.query({
			database_id: examsDatabaseId(),
			start_cursor: cursor,
			filter: {
				and: [
					{ property: 'Source', select: { equals: 'JKU Sync' } },
					{ property: 'Date', date: { after: nowISO } },
				],
			},
		})

		for (const row of results) {
			if (!isFullPage(row)) continue
			const jkuId = readJkuId(row)
			if (!jkuId || seenIds.has(jkuId)) continue
			if (!dryRun) {
				await notion.pages.update({ page_id: row.id, archived: true })
			}
			archived++
		}

		cursor = has_more ? next_cursor ?? undefined : undefined
	} while (cursor)

	return archived
}
