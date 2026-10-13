import type { BrowserContext } from 'playwright'
import { MoodleSession, currentSemester, courseNumbers, normalizeCourseNumber, selectSemesterCourses, type MoodleCourse, type MoodleEvent } from './moodle'
import type { JkuAssignment } from './jku'

export function canonicalActivityUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (u.origin !== 'https://moodle.jku.at' || !/^\/mod\/[a-z]+\/view\.php$/.test(u.pathname)) return null
    const id = u.searchParams.get('id')
    if (!id || !/^\d+$/.test(id)) return null
    return `${u.origin}${u.pathname}?id=${id}`
  } catch { return null }
}

export function eventToTask(e: MoodleEvent, course: MoodleCourse): JkuAssignment | null {
  if (!['assign', 'quiz', 'checkmark', 'feedback', 'lesson', 'workshop'].includes(e.modulename)) return null
  // Open times and Zoom sessions are not deadlines. Never invent a close time for an undated quiz.
  if (!['due', 'close', 'submissionend', 'assessmentend'].includes(e.eventtype)) return null
  const url = canonicalActivityUrl(e.url ?? e.action?.url ?? '')
  if (!url || !Number.isFinite(e.timestart) || e.timestart <= 0) return null
  const cmid = new URL(url).searchParams.get('id')!
  const title = e.activityname || e.name.replace(/^Submit\s+/i, '').replace(/\s+(?:is due|ist fällig\.?|closes|schließt)$/i, '')
  return {
    // Preserve myJKU's existing course-module ID for assignment deduplication.
    id: e.modulename === 'assign' ? cmid : `moodle:${e.modulename}:${cmid}:${e.eventtype}`,
    title, courseName: course.fullname, courseNr: courseNumbers(course)[0] ?? '',
    courseNumbers: courseNumbers(course), semester: course.shortname.match(/\d{4}[WS]/i)?.[0]?.toUpperCase(),
    dueAt: new Date((e.timestart + (e.timeduration ?? 0)) * 1000).toISOString(),
    moodleUrl: url, description: '',
  }
}

/** Complete calendar supplements the action feed (completed/closed items can disappear from the latter). */
export async function fetchMoodleTasksFromSession(session: MoodleSession, now = new Date()): Promise<JkuAssignment[]> {
  const semester = currentSemester(now)
  const courses = selectSemesterCourses(await session.courses(), semester)
  const byId = new Map(courses.map(c => [c.id, c]))
  const from = Math.floor(now.getTime() / 1000) - 30 * 86400
  const toDate = new Date(now); toDate.setUTCMonth(toDate.getUTCMonth() + 4)
  const to = Math.floor(toDate.getTime() / 1000)
  const events = new Map((await session.actionEvents(from, to)).map(e => [e.id, e]))
  // Scan the previous month through the end of the four-month window. Pagination is not needed in month views.
  const start = new Date(from * 1000), finish = new Date(to * 1000)
  let year = start.getUTCFullYear(), month = start.getUTCMonth() + 1
  while (year < finish.getUTCFullYear() || (year === finish.getUTCFullYear() && month <= finish.getUTCMonth() + 1)) {
    for (const course of courses) for (const e of await session.monthlyEvents(course.id, year, month)) events.set(e.id, e)
    if (++month > 12) { month = 1; year++ }
  }
  const tasks = new Map<string, JkuAssignment>()
  for (const e of events.values()) {
    const course = byId.get(e.course?.id ?? 0)
    if (!course) continue
    const deadline = e.timestart + (e.timeduration ?? 0)
    if (deadline < from || deadline > to) continue
    const task = eventToTask(e, course)
    if (task) tasks.set(task.id, task)
  }
  console.log(`[moodle] ${courses.length} current courses; ${tasks.size} deadline tasks (Zoom/open events excluded)`)
  return [...tasks.values()].sort((a, b) => a.dueAt.localeCompare(b.dueAt))
}

export async function fetchMoodleTasks(ctx: BrowserContext): Promise<JkuAssignment[]> {
  const session = await MoodleSession.open(ctx)
  try { return await fetchMoodleTasksFromSession(session) }
  finally { await session.page.close() }
}

export function taskCourseNumbers(a: JkuAssignment): string[] {
  return (a.courseNumbers ?? [a.courseNr]).map(normalizeCourseNumber)
}
