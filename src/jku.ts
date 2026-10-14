// src/jku.ts
import type { BrowserContext } from 'playwright'
import { DateTime } from 'luxon'

export type JkuAssignment = {
	id: string
	title: string
	courseName: string
	courseNr: string
	courseNumbers?: string[]
	semester?: string
	dueAt: string          // ISO 8601 with timezone
	moodleUrl: string
	description: string
}

// Raw shape from the JKU API (only the fields we use)
type JkuRawEvent = {
	id: string
	courseClassVariantTitle: string
	courseClassVariantTitleMoodle: string
	begin: string                  // local Vienna time, no offset
	eventType: string              // "DUE" for assignment due dates
	groupType: string              // "ASSIGN" for assignments
	moodleUrl: string
	courseNr: string
	courseSubtitle?: string
}

const JKU_BASE = 'https://my.jku.at'

export async function fetchAssignments(ctx: BrowserContext): Promise<JkuAssignment[]> {
	const fromDate = DateTime.now().setZone('Europe/Vienna').toISODate()
	const toDate = DateTime.now().setZone('Europe/Vienna').plus({ months: 4 }).toISODate()

	const url = `${JKU_BASE}/api2/calendar/cockpit/moodle/calendar?fromDate=${fromDate}&toDate=${toDate}`

	const page = await ctx.newPage()
	const res = await page.goto(url)
	if (!res?.ok()) throw new Error(`JKU API returned ${res?.status()}`)

	const raw = (await res.json()) as JkuRawEvent[]
	await page.close()

	return raw
		.filter(e => e.eventType === 'DUE' && e.groupType === 'ASSIGN')
		.map(e => ({
			id: e.id,
			title: cleanTitle(e.courseClassVariantTitleMoodle),
			courseName: e.courseClassVariantTitle,
			courseNr: e.courseNr,
			dueAt: DateTime
				.fromISO(e.begin, { zone: 'Europe/Vienna' })
				.toUTC()
				.toISO()!,
			moodleUrl: e.moodleUrl,
			description: e.courseSubtitle ?? '',
		}))
}

/**
 * Strips boilerplate Moodle wording so titles look clean in Notion.
 * "Submit homework assignment 6 (27 points) is due" → "Homework assignment 6 (27 points)"
 */
function cleanTitle(raw: string): string {
	return raw
		.replace(/^Submit\s+/i, '')
		.replace(/\s+is due$/i, '')
		.replace(/^./, c => c.toUpperCase())
		.trim()
}