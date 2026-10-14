import { test, expect } from 'bun:test'
import { eventToTask, canonicalActivityUrl, fetchMoodleTasksFromSession } from '../src/moodle-tasks'
import { findExistingTask } from '../src/task-migration'
import { resolveSubjectForTask } from '../src/notion'
const course = { id: 44253, fullname: '357.260/531940/531942, Math III', shortname: '2026W357260/531940/531942' }
const event = { id: 1746046, name: 'Sheet_1 is due', activityname: 'Sheet_1', modulename: 'assign', eventtype: 'due', timestart: 1791954000, timesort: 1, url: 'https://moodle.jku.at/mod/assign/view.php?id=13858012&action=editsubmission', course }
test('existing myJKU ID survives migration, deadline uses timestart not timesort', () => {
  const t = eventToTask(event, course)!
  expect(t.id).toBe('13858012')
  expect(t.dueAt).toBe('2026-10-14T05:00:00.000Z')
  expect(t.title).toBe('Sheet_1')
  expect(t.moodleUrl).toBe('https://moodle.jku.at/mod/assign/view.php?id=13858012')
})
test('quiz opening is not mistaken for a deadline; closing is imported', () => {
  expect(eventToTask({ ...event, modulename: 'quiz', eventtype: 'open' }, course)).toBeNull()
  expect(eventToTask({ ...event, modulename: 'quiz', eventtype: 'close' }, course)!.id).toBe('moodle:quiz:13858012:close')
})
test('Crosses included; all feedback/survey forms and meetings excluded', () => {
  expect(eventToTask({ ...event, modulename: 'checkmark' }, course)).not.toBeNull()
  expect(eventToTask({ ...event, modulename: 'feedback', eventtype: 'close' }, course)).toBeNull()
  expect(eventToTask({ ...event, modulename: 'survey', eventtype: 'close' }, course)).toBeNull()
  expect(eventToTask({ ...event, modulename: 'questionnaire', eventtype: 'due' }, course)).toBeNull()
  expect(eventToTask({ ...event, modulename: 'zoom', eventtype: 'zoom' }, course)).toBeNull()
})
test('invalid or off-site activity URLs cannot become task links', () => {
  expect(canonicalActivityUrl('https://evil.test/mod/assign/view.php?id=1')).toBeNull()
  expect(eventToTask({ ...event, url: 'not a URL' }, course)).toBeNull()
})
test('migration finds sync-owned canonical activity link and preserves manual rows', () => {
  const rows = [
    { pageId: 'manual', key: '13858012', source: 'Manual', url: event.url },
    { pageId: 'sync', key: 'old-jku-id', source: 'JKU Sync', url: event.url },
  ]
  expect(findExistingTask(rows, '13858012', event.url)?.pageId).toBe('sync')
  expect(findExistingTask([rows[0]!], '13858012', event.url)).toBeUndefined()
})
test('duplicate migrations fail loudly and distinct deadline types remain separate', () => {
  const row = { pageId: 'a', key: '13858012', source: 'JKU Sync', url: event.url }
  expect(() => findExistingTask([row, { ...row, pageId: 'b' }], '13858012', event.url)).toThrow('Multiple')
  expect(findExistingTask([{ ...row, key: 'moodle:quiz:13858012:close' }], 'moodle:quiz:13858012:due', event.url)).toBeUndefined()
})
test('semester-specific grouped mapping selects one Subject without old-term collision', () => {
  const subject = { id: 'math', name: 'Math III' }
  const ctx = { byCourseNr: new Map([['357260', { id: 'old', name: 'Old' }]]), bySemesterCourseNr: new Map([['2026W:357260', subject], ['2026W:531942', subject]]), byNormalizedName: new Map() }
  expect(resolveSubjectForTask(eventToTask(event, course)!, ctx)).toEqual(subject)
})
test('monthly calendar supplements absent action events; no deletion/completion inference', async () => {
  const fake = { courses: async () => [course], actionEvents: async () => [], monthlyEvents: async () => [event] }
  const tasks = await fetchMoodleTasksFromSession(fake as any, new Date('2026-10-13T13:00:00Z'))
  expect(tasks.length).toBe(1)
  expect(tasks[0]!.id).toBe('13858012')
})

test('survey and sheet-feedback events are filtered from both action and monthly feeds', async () => {
  const survey = { ...event, id: event.id + 1, modulename: 'survey', eventtype: 'close', activityname: 'Course survey' }
  const feedback = { ...event, id: event.id + 2, modulename: 'feedback', eventtype: 'close', activityname: 'Sheet_1_Feedback' }
  const fake = { courses: async () => [course], actionEvents: async () => [survey, feedback], monthlyEvents: async () => [event, survey, feedback] }
  const tasks = await fetchMoodleTasksFromSession(fake as any, new Date('2026-10-13T13:00:00Z'))
  expect(tasks.map(t => t.id)).toEqual(['13858012'])
})
