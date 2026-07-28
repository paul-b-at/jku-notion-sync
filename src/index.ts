// src/index.ts
import { getAuthedContext } from './auth'
import { fetchAssignments } from './jku'
import { fetchExams } from './exams'
import {
	loadSubjectMap,
	normalizeCourseNr,
	resolveSubjectForExam,
	upsertAssignment,
} from './notion'
import { pruneCancelledExams, upsertExam } from './notionExams'

const dryRun = process.argv.includes('--dry-run')
const debug = process.argv.includes('--debug')

console.log(dryRun ? '🧪 DRY RUN — no Notion writes\n' : '🚀 Live run\n')

if (!Bun.env.NOTION_EXAMS_DB) {
	throw new Error(
		'NOTION_EXAMS_DB is not set — add your Notion Exams database ID (32-char hex from the database URL) to .env',
	)
}

console.log('🔗 Loading Subject map from Notion...')
const subjects = await loadSubjectMap()
console.log(`   Mapped ${subjects.byCourseNr.size} course numbers\n`)

const ctx = await getAuthedContext()
const assignments = await fetchAssignments(ctx)
console.log(`📚 Found ${assignments.length} assignments`)

let created = 0,
	updated = 0,
	unmatched = 0

for (const a of assignments) {
	const subject = subjects.byCourseNr.get(normalizeCourseNr(a.courseNr) ?? '')
	const subjectLabel = subject ? `→ ${subject.name}` : '⚠️ no subject match'
	console.log(`• ${a.title}  (${a.courseNr}) ${subjectLabel}`)
	if (!subject) unmatched++

	const result = await upsertAssignment(a, subjects, dryRun)
	if (result === 'created') created++
	if (result === 'updated') updated++
}

const exams = await fetchExams(ctx, { debug })
await ctx.close()

console.log(`\n📅 Found ${exams.length} upcoming exams`)

let examCreated = 0,
	examUpdated = 0,
	examUnmatched = 0

for (const e of exams) {
	const resolved = resolveSubjectForExam(e, subjects)
	const subjectLabel = resolved ? `→ ${resolved.name}` : '⚠️ no subject match'
	console.log(`• ${e.courseName}  ${subjectLabel}`)
	if (!resolved) examUnmatched++

	const result = await upsertExam(e, subjects, dryRun)
	if (result === 'created') examCreated++
	if (result === 'updated') examUpdated++
}

const pruned = await pruneCancelledExams(
	new Set(exams.map(e => e.id)),
	dryRun,
)

console.log(
	`\n✅ Done — assignments: created ${created}, updated ${updated}, unmatched subjects: ${unmatched}`,
)
console.log(
	`   exams: created ${examCreated}, updated ${examUpdated}, unmatched subjects: ${examUnmatched}, pruned: ${pruned}${dryRun ? ' (dry-run)' : ''}`,
)
console.log(`✅ ${assignments.length} assignments, ${exams.length} exams synced`)
