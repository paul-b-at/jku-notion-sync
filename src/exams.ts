// src/exams.ts
import type { BrowserContext } from 'playwright'
import { DateTime } from 'luxon'

export type JkuExam = {
	id: string
	courseName: string
	date: string
	link: string
	/** When JKU sends a course number, prefer Subject mapping via course nr (same as assignments). */
	courseNr?: string
}

const EXAMS_URL = 'https://my.jku.at/api2/exam/course?selected=CURRENT'

function asRecord(v: unknown): Record<string, unknown> | null {
	return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** Every object that appears as an element of any array anywhere in the JSON tree (JKU nests lists deeply). */
function collectRowsFromNestedArrays(node: unknown, acc: unknown[] = []): unknown[] {
	if (Array.isArray(node)) {
		for (const el of node) {
			const r = asRecord(el)
			if (r) acc.push(r)
			collectRowsFromNestedArrays(el, acc)
		}
	} else if (asRecord(node)) {
		for (const v of Object.values(node as Record<string, unknown>)) collectRowsFromNestedArrays(v, acc)
	}
	return acc
}

function unwrapArray(data: unknown): unknown[] {
	if (Array.isArray(data)) return data
	const o = asRecord(data)
	if (!o) return []
	const keys = [
		'data',
		'items',
		'exams',
		'content',
		'results',
		'registrations',
		'courses',
		'courseExamRegistrations',
		'examRegistrations',
	]
	for (const k of keys) {
		const inner = o[k]
		if (Array.isArray(inner)) return inner
	}
	return []
}

/** Merge sibling fields into one flat record so we can map `course.title` alongside root `id`. */
function flattenExamishRecord(raw: Record<string, unknown>): Record<string, unknown> {
	const nestedKeys = ['course', 'courseDto', 'courseClassVariant', 'lecture', 'lv', 'exam', 'examDto', 'appointment']
	let merged = { ...raw }
	for (const k of nestedKeys) {
		const n = asRecord(merged[k])
		if (!n) continue
		const next = { ...merged }
		for (const [nk, nv] of Object.entries(n)) {
			if (next[nk] === undefined) next[nk] = nv
		}
		merged = next
	}
	return merged
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
	for (const k of keys) {
		const v = obj[k]
		if (v === undefined || v === null) continue
		if (typeof v === 'string' && v.length > 0) return v
		if (typeof v === 'number' && Number.isFinite(v)) return String(Math.trunc(v))
	}
	return undefined
}

/** ISO-like string from object or unix ms / seconds. */
function pickDateRaw(obj: Record<string, unknown>): string | undefined {
	const strKeys = [
		'examDateBegin',
		'examDateEnd',
		'examDate',
		'date',
		'begin',
		'start',
		'examBegin',
		'dateTime',
		'appointmentDate',
		'examAppointment',
		'from',
		'startDate',
		'examBeginDate',
		'timeSlotBegin',
		'beginDate',
	]
	for (const k of strKeys) {
		const s = pickString(obj, [k])
		if (s) return s
	}
	const numKeys = [
		'examDate',
		'date',
		'begin',
		'start',
		'examBegin',
		'startDate',
		'from',
		'timestamp',
		'time',
	]
	for (const k of numKeys) {
		const v = obj[k]
		if (typeof v !== 'number' || !Number.isFinite(v)) continue
		const ms = v > 1e12 ? v : v * 1000
		return new Date(ms).toISOString()
	}
	return undefined
}

/** JKU sends Vienna wall time without `Z`; align with calendar parsing in `jku.ts`. */
function hasExplicitZoneOffset(isoLike: string): boolean {
	const s = isoLike.trim()
	return /(?:Z|[+-]\d{2}:\d{2})$/.test(s) || /[+-]\d{4}$/.test(s)
}

/** Prefer explicit offsets; else interpret naive ISO as Europe/Vienna local. */
function parseExamInstant(raw: string): DateTime {
	const s = raw.trim()

	if (!hasExplicitZoneOffset(s)) {
		const vienna = DateTime.fromISO(s, { zone: 'Europe/Vienna' })
		if (vienna.isValid) return vienna
	}

	let dt = DateTime.fromISO(s)
	if (dt.isValid) return dt.setZone('Europe/Vienna')

	dt = DateTime.fromISO(s, { zone: 'Europe/Vienna' })
	if (dt.isValid) return dt

	dt = DateTime.fromSQL(s, { zone: 'Europe/Vienna' })
	if (dt.isValid) return dt

	for (const fmt of ['dd.MM.yyyy HH:mm', 'dd.MM.yyyy', 'yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd']) {
		dt = DateTime.fromFormat(s, fmt, { zone: 'Europe/Vienna' })
		if (dt.isValid) return dt
	}

	return DateTime.invalid('unparseable')
}

function mapRawToExam(raw: unknown): Omit<JkuExam, 'date'> & { date: string } | null {
	const base = asRecord(raw)
	if (!base) return null

	const e = flattenExamishRecord(base)

	const id = pickString(e, [
		'id',
		'examId',
		'registrationId',
		'examRegistrationId',
		'courseExamRegistrationId',
		'registration_id',
		'examAppointmentId',
		'appointmentId',
	])
	let resolvedId = id
	if (!resolvedId) {
		const cnrEarly = pickString(e, [
			'courseNr',
			'courseNumber',
			'courseNo',
			'lvNr',
			'lectureNr',
			'courseClassVariantNr',
			'catalogNumber',
		])
		const dRawEarly = pickDateRaw(e)
		if (cnrEarly && dRawEarly) resolvedId = `synthetic:${cnrEarly}:${dRawEarly}`
	}
	if (!resolvedId) return null

	const courseName = pickString(e, [
		'courseName',
		'courseClassVariantTitle',
		'courseClassVariantTitleMoodle',
		'courseTitle',
		'lectureTitle',
		'title',
		'name',
		'subjectTitle',
		'description',
		'examTitle',
	])
	if (!courseName) return null

	const dateRaw = pickDateRaw(e)
	if (!dateRaw) return null

	const link = pickString(e, ['url', 'link', 'moodleUrl', 'examUrl', 'href', 'detailUrl']) ?? ''

	const courseNr = pickString(e, [
		'courseNr',
		'courseNumber',
		'courseNo',
		'lvNr',
		'lectureNr',
		'courseClassVariantNr',
		'catalogNumber',
	])

	return {
		id: resolvedId,
		courseName,
		date: dateRaw,
		link,
		...(courseNr ? { courseNr } : {}),
	}
}

export async function fetchExams(
	ctx: BrowserContext,
	opts: { debug?: boolean } = {},
): Promise<JkuExam[]> {
	const page = await ctx.newPage()
	const res = await page.goto(EXAMS_URL)
	if (!res?.ok()) throw new Error(`JKU exams API returned ${res?.status()}`)

	const json: unknown = await res.json()
	await page.close()

	if (opts.debug) {
		await Bun.write('debug-exams.json', JSON.stringify(json, null, 2))
	}

	const top = unwrapArray(json)
	const deep = collectRowsFromNestedArrays(json, [])
	const rowSet = new Map<string, Record<string, unknown>>()
	for (const r of [...top, ...deep]) {
		const rec = asRecord(r)
		if (!rec) continue
		const flat = flattenExamishRecord(rec)
		rowSet.set(JSON.stringify(flat), flat)
	}
	const rows = [...rowSet.values()]

	const nowVienna = DateTime.now().setZone('Europe/Vienna')
	const exams: JkuExam[] = []
	let skippedUnmapped = 0
	let skippedBadDate = 0
	let skippedPast = 0

	for (const row of rows) {
		const mapped = mapRawToExam(row)
		if (!mapped) {
			skippedUnmapped++
			continue
		}

		const dt = parseExamInstant(mapped.date)
		if (!dt.isValid) {
			skippedBadDate++
			continue
		}

		const instant = dt.setZone('Europe/Vienna')
		if (instant <= nowVienna) {
			skippedPast++
			continue
		}

		exams.push({
			...mapped,
			date: instant.toUTC().toISO()!,
		})
	}

	const deduped = dedupeById(exams)

	if (deduped.length === 0 && rows.length > 0) {
		console.warn(
			`⚠️  Exam API returned ${rows.length} candidate object(s), but none became upcoming exams. ` +
				`Unmapped/unrecognized: ${skippedUnmapped}, bad date: ${skippedBadDate}, in the past: ${skippedPast}. ` +
				`Run with --debug and inspect debug-exams.json.`,
		)
	} else if (deduped.length === 0 && rows.length === 0) {
		console.warn(
			'⚠️  Exam API yielded no object rows (wrong shape or empty list). Run with --debug and inspect debug-exams.json.',
		)
	}

	return deduped
}

function dedupeById(exams: JkuExam[]): JkuExam[] {
	const byId = new Map<string, JkuExam>()
	for (const e of exams) byId.set(e.id, e)
	return [...byId.values()]
}
