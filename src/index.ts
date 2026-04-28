// src/index.ts
import { getAuthedContext } from './auth'
import { fetchAssignments } from './jku'
import { loadSubjectMap, upsertAssignment } from './notion'

const dryRun = process.argv.includes('--dry-run')

console.log(dryRun ? '🧪 DRY RUN — no Notion writes\n' : '🚀 Live run\n')

const ctx = await getAuthedContext()
const assignments = await fetchAssignments(ctx)
await ctx.close()
console.log(`📚 Found ${assignments.length} assignments`)

console.log('🔗 Loading Subject map from Notion...')
const subjects = await loadSubjectMap()
console.log(`   Mapped ${subjects.size} course numbers\n`)

let created = 0, updated = 0, unmatched = 0

for (const a of assignments) {
	const subject = subjects.get(a.courseNr)
	const subjectLabel = subject ? `→ ${subject.name}` : '⚠️ no subject match'
	console.log(`• ${a.title}  (${a.courseNr}) ${subjectLabel}`)
	if (!subject) unmatched++

	const result = await upsertAssignment(a, subjects, dryRun)
	if (result === 'created') created++
	if (result === 'updated') updated++
}

console.log(`\n✅ Done — created: ${created}, updated: ${updated}, unmatched subjects: ${unmatched}`)