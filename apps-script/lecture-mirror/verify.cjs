// Deliberately not named *.test.*: these isolated Apps Script tests do not enter Bun's suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const code = fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const NOW = '2026-10-21T10:00:00Z';
const lecture = (id = 'lecture-1', extra = {}) => ({
  id, iCalUID: id + '@jku.at', status: 'confirmed', summary: 'Algorithms VO',
  start: { dateTime: '2026-10-22T09:00:00+02:00', timeZone: 'Europe/Vienna' },
  end: { dateTime: '2026-10-22T10:30:00+02:00', timeZone: 'Europe/Vienna' },
  location: 'HS 1', description: 'Original JKU details', ...extra,
});
function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key];
    else if (typeof value === 'object' && value && !Array.isArray(value)) {
      if (!target[key]) target[key] = {};
      merge(target[key], value);
    } else target[key] = clone(value);
  }
  return target;
}
function harness(options = {}) {
  const state = { sources: clone(options.sources || [lecture()]), targets: clone(options.targets || []),
    writes: [], reads: [], logs: [], properties: { SOURCE_CALENDAR_ID: 'source', TARGET_CALENDAR_ID: 'target', ...options.properties },
    sourceGet: {}, listError: null, getError: null, createdCalendars: 0, triggers: [], lockReleased: false };
  const error = (code, message) => Object.assign(new Error(message), { code });
  const ctx = vm.createContext({
    console: { log: (...v) => state.logs.push(v.join(' ')) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_, text) => Array.from(crypto.createHash('sha256').update(text).digest()) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => state.properties[k] || null,
      setProperty: (k, v) => { state.properties[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => { state.lockReleased = true; } }) },
    ScriptApp: { getProjectTriggers: () => state.triggers,
      deleteTrigger: t => { state.triggers = state.triggers.filter(x => x !== t); },
      newTrigger: handler => ({ timeBased() { return this; }, everyMinutes(n) { this.minutes = n; return this; },
        create() { state.triggers.push({ getHandlerFunction: () => handler, minutes: this.minutes }); } }) },
    Calendar: {
      CalendarList: { get: id => ({ id, summary: id, accessRole: id === 'source' ? 'reader' : 'owner',
        primary: id === 'primary', timeZone: 'Europe/Vienna' }), list: () => ({ items: [] }) },
      Calendars: { get: () => ({ description: 'jku-lecture-mirror-v1\nsource:' + crypto.createHash('sha256').update('source').digest('hex') }),
        insert: body => { state.createdCalendars++; state.createdCalendar = clone(body); return { id: 'target' }; } },
      Events: {
        list: (id, opts) => {
          state.reads.push({ id, opts: clone(opts) });
          if (state.listError) throw state.listError;
          if (id === 'source') return { items: clone(state.sources) };
          return { items: clone(state.targets.filter(e => e.status !== 'cancelled' &&
            e.extendedProperties?.private?.jmOwner === 'jku-lecture-mirror-v1')) };
        },
        get: (id, eventId) => {
          if (state.getError) throw state.getError;
          const found = id === 'source' ? (state.sourceGet[eventId] || state.sources.find(e => e.id === eventId)) : state.targets.find(e => e.id === eventId);
          if (!found) throw error(404, 'Not Found');
          return clone(found);
        },
        insert: (body, id, opts) => {
          assert.equal(id, 'target'); assert.equal(opts.sendUpdates, 'none');
          if (state.targets.some(e => e.id === body.id)) throw error(409, 'Already exists');
          state.writes.push({ kind: 'insert', body: clone(body) });
          const created = clone({ ...body, status: 'confirmed' }); state.targets.push(created); return created;
        },
        patch: (body, id, eventId, opts) => {
          assert.equal(id, 'target'); assert.equal(opts.sendUpdates, 'none');
          state.writes.push({ kind: 'patch', id: eventId, body: clone(body) });
          const target = state.targets.find(e => e.id === eventId);
          if (!target) throw error(404, 'Not Found');
          return merge(target, clone(body));
        },
      },
    },
  });
  vm.runInContext(code, ctx);
  return { state, ctx, run: (time = NOW, preview = false) => clone(ctx.runMirror_(preview, new Date(time))) };
}

test('initial import uses dedicated target, private events and no attendees/notifications', () => {
  const h = harness({ sources: [lecture('a', { attendees: [{ email: 'lecturer@jku.at' }], conferenceData: { test: true } })] });
  const result = h.run();
  assert.equal(result.creates, 1); assert.equal(result.applied, 1);
  const copied = h.state.targets[0];
  assert.equal(copied.summary, 'Algorithms VO'); assert.equal(copied.visibility, 'private');
  assert.match(copied.description, /Meeting link \/ personal notes/);
  assert.equal(copied.attendees, undefined); assert.equal(copied.conferenceData, undefined);
  assert.match(copied.id, /^jm[0-9a-f]{64}$/);
});
test('unchanged reruns are idempotent', () => {
  const h = harness(); h.run(); h.state.writes = [];
  assert.equal(h.run().planned, 0); assert.equal(h.state.writes.length, 0);
});
test('schedule updates preserve manual meeting links and conferencing/reminders/colors', () => {
  const h = harness(); h.run();
  const target = h.state.targets[0];
  target.description = 'Join: https://zoom.us/j/123\nPrivate notes';
  target.conferenceData = { entryPoints: [{ uri: 'https://zoom.us/j/123' }] };
  target.colorId = '9'; target.reminders = { useDefault: false };
  h.state.sources[0].summary = 'Algorithms VO — changed';
  h.state.sources[0].location = 'HS 2';
  h.state.sources[0].description = 'New source description must not replace personal links';
  h.state.sources[0].start.dateTime = '2026-10-22T11:00:00+02:00';
  h.state.sources[0].end.dateTime = '2026-10-22T12:30:00+02:00';
  h.state.writes = []; h.run();
  assert.equal(target.summary, 'Algorithms VO — changed'); assert.equal(target.location, 'HS 2');
  assert.equal(target.start.dateTime, '2026-10-22T11:00:00+02:00');
  assert.equal(target.description, 'Join: https://zoom.us/j/123\nPrivate notes');
  assert.equal(target.conferenceData.entryPoints[0].uri, 'https://zoom.us/j/123');
  const patch = h.state.writes[0].body;
  for (const field of ['description', 'conferenceData', 'attendees', 'reminders', 'colorId']) assert.equal(field in patch, false);
});
test('description-only source changes leave manual description alone', () => {
  const h = harness(); h.run(); h.state.sources[0].description = 'changed';
  assert.equal(h.run().planned, 0);
});
test('recurring instances get distinct keys, and moved exceptions keep their key', () => {
  const a = lecture('series_1', { iCalUID: 'series@jku.at', originalStartTime: { dateTime: '2026-10-22T09:00:00+02:00' } });
  const b = lecture('series_2', { iCalUID: 'series@jku.at', originalStartTime: { dateTime: '2026-10-29T09:00:00+01:00' } });
  const h = harness({ sources: [a, b] }); h.run(); assert.equal(h.state.targets.length, 2);
  const oldId = h.state.targets[0].id;
  h.state.sources[0].start.dateTime = '2026-10-23T09:00:00+02:00';
  h.state.sources[0].end.dateTime = '2026-10-23T10:30:00+02:00';
  h.run(); assert.equal(h.state.targets.length, 2); assert.equal(h.state.targets[0].id, oldId);
});
test('source API ID changes preserve copy when iCalUID is stable', () => {
  const h = harness(); h.run(); const id = h.state.targets[0].id;
  h.state.targets[0].description = 'meeting link'; h.state.sources[0].id = 'new-api-id'; h.run();
  assert.equal(h.state.targets.length, 1); assert.equal(h.state.targets[0].id, id);
  assert.equal(h.state.targets[0].description, 'meeting link');
  assert.equal(h.state.targets[0].extendedProperties.private.jmSourceEventId, 'new-api-id');
});
test('all-day exclusive end dates survive; timed/all-day conversion clears incompatible fields', () => {
  const h = harness(); h.run();
  h.state.sources[0].start = { date: '2026-10-22' }; h.state.sources[0].end = { date: '2026-10-23' }; h.run();
  assert.deepEqual(h.state.targets[0].start, { date: '2026-10-22' });
  assert.deepEqual(h.state.targets[0].end, { date: '2026-10-23' });
  Object.assign(h.state.sources[0], { start: lecture().start, end: lecture().end }); h.run();
  assert.equal(h.state.targets[0].start.date, undefined);
  assert.equal(h.state.targets[0].start.dateTime, lecture().start.dateTime);
});
test('preview before setup makes no calendar, event, property or trigger writes', () => {
  const h = harness({ properties: { TARGET_CALENDAR_ID: '' } }); const before = clone(h.state.properties);
  assert.equal(h.run(NOW, true).creates, 1);
  assert.equal(h.state.writes.length, 0); assert.equal(h.state.createdCalendars, 0);
  assert.deepEqual(h.state.properties, before); assert.equal(h.state.triggers.length, 0);
});
test('empty source fails closed and preserves existing events/notes', () => {
  const h = harness(); h.run(); h.state.sources = []; h.state.writes = [];
  assert.throws(() => h.run(), /empty/); assert.equal(h.state.writes.length, 0);
});
test('events moved outside window are fetched by source ID, not marked cancelled', () => {
  const h = harness({ sources: [lecture('a'), lecture('b')] }); h.run();
  const moved = clone(h.state.sources[0]); moved.start.dateTime = '2027-12-01T09:00:00+01:00'; moved.end.dateTime = '2027-12-01T10:30:00+01:00';
  h.state.sourceGet.a = moved; h.state.sources = [h.state.sources[1]]; h.run();
  assert.equal(h.state.targets[0].start.dateTime, moved.start.dateTime);
  assert.equal(h.state.targets[0].extendedProperties.private.jmCancelled, '0');
});
test('confirmed missing lectures require two observations and 2h; notes remain, no deletion', () => {
  const h = harness({ sources: [lecture('a'), lecture('b')] }); h.run();
  const target = h.state.targets[0]; target.description = 'https://zoom.us/j/123';
  h.state.sources = [h.state.sources[1]]; h.run();
  assert.equal(target.extendedProperties.private.jmMissCount, '1'); assert.equal(target.extendedProperties.private.jmCancelled, '0');
  h.run('2026-10-21T10:30:00Z'); assert.equal(target.extendedProperties.private.jmCancelled, '0');
  h.run('2026-10-21T12:01:00Z');
  assert.match(target.summary, /^\[Cancelled at source\]/); assert.equal(target.transparency, 'transparent');
  assert.equal(target.description, 'https://zoom.us/j/123'); assert.equal(h.state.targets.length, 2);
  h.state.sources.push(lecture('a')); h.run('2026-10-21T12:30:00Z');
  assert.equal(target.summary, 'Algorithms VO'); assert.equal(target.transparency, 'opaque');
  assert.equal(target.extendedProperties.private.jmMissCount, '0'); assert.equal(target.description, 'https://zoom.us/j/123');
});
test('source permission/network failures are not interpreted as cancellations', () => {
  const h = harness({ sources: [lecture('a'), lecture('b')] }); h.run();
  h.state.sources = [h.state.sources[1]]; h.state.getError = Object.assign(new Error('Rate limit'), { code: 429 }); h.state.writes = [];
  assert.throws(() => h.run(), /Rate limit/); assert.equal(h.state.writes.length, 0);
});
test('failed source pagination produces zero writes', () => {
  const h = harness(); h.ctx.Calendar.Events.list = (_, opts) => {
    if (!opts.pageToken) return { items: [lecture()], nextPageToken: 'next' };
    throw new Error('Network down');
  };
  assert.throws(() => h.run(), /Network down/); assert.equal(h.state.writes.length, 0);
});
test('duplicate source identities abort before writes', () => {
  const h = harness({ sources: [lecture('a'), lecture('a')] });
  assert.throws(() => h.run(), /Duplicate source/); assert.equal(h.state.writes.length, 0);
});
test('primary, same-calendar, unmarked and unowned target protections', () => {
  for (const props of [{ TARGET_CALENDAR_ID: 'source' }, { TARGET_CALENDAR_ID: 'primary' }, { SOURCE_CALENDAR_ID: 'primary' }]) {
    const h = harness({ properties: props }); assert.throws(() => h.run(), /different, non-primary/); assert.equal(h.state.writes.length, 0);
  }
  const h = harness(); h.ctx.Calendar.Calendars.get = () => ({ description: 'personal calendar' });
  assert.throws(() => h.run(), /dedicated owned mirror/); assert.equal(h.state.writes.length, 0);
  const g = harness(); g.ctx.Calendar.CalendarList.get = () => ({ accessRole: 'writer' });
  assert.throws(() => g.run(), /dedicated owned mirror/); assert.equal(g.state.writes.length, 0);
});
test('unmanaged destination events are never patched', () => {
  const other = { ...lecture('manual'), description: 'Private appointment' };
  const h = harness({ targets: [other] }); h.run(); assert.deepEqual(h.state.targets[0], other);
});
test('manual deletion is respected without generating another event ID', () => {
  const h = harness(); h.run(); h.state.targets[0].status = 'cancelled'; h.state.writes = [];
  const result = h.run(); assert.equal(result.manuallyDeletedSkipped, 1);
  assert.equal(h.state.targets.length, 1); assert.equal(h.state.writes.length, 0);
});
test('pagination collects all pages and rejects repeated tokens', () => {
  const h = harness();
  assert.equal(h.ctx.allPages_(token => token ? { items: [2] } : { items: [1], nextPageToken: 'p' }).length, 2);
  assert.throws(() => h.ctx.allPages_(() => ({ items: [], nextPageToken: 'same' })), /pagination loop/);
});
test('writes are capped and subsequent runs resume without duplicates', () => {
  const h = harness({ sources: Array.from({ length: 160 }, (_, i) => lecture('event-' + i)) });
  assert.equal(h.run().pending, 10); assert.equal(h.state.targets.length, 150);
  assert.equal(h.run().pending, 0); assert.equal(h.state.targets.length, 160);
});
test('setup is idempotent; does not import events or schedule runs', () => {
  const h = harness({ properties: { TARGET_CALENDAR_ID: '' } }); h.ctx.setupMirror(); h.ctx.setupMirror();
  assert.equal(h.state.createdCalendars, 1); assert.equal(h.state.properties.TARGET_CALENDAR_ID, 'target');
  assert.equal(h.state.writes.length, 0); assert.equal(h.state.triggers.length, 0);
});
test('trigger installation leaves one mirror trigger and preserves unrelated triggers', () => {
  const h = harness(); const other = { getHandlerFunction: () => 'somethingElse' }; h.state.triggers.push(other);
  h.ctx.installTrigger(); h.ctx.installTrigger();
  assert.equal(h.state.triggers.length, 2); assert.equal(h.state.triggers.includes(other), true);
  assert.equal(h.state.triggers.find(t => t.getHandlerFunction() === 'syncLectures').minutes, 30);
  h.ctx.removeTrigger(); assert.deepEqual(h.state.triggers, [other]);
});
test('locks are released even when a preview fails', () => {
  const h = harness({ properties: { SOURCE_CALENDAR_ID: '' } });
  assert.throws(() => h.ctx.previewMirror()); assert.equal(h.state.lockReleased, true);
});
test('manifest enables Calendar v3 and does not request Drive, Gmail or Notion scopes', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'appsscript.json'), 'utf8'));
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.equal(manifest.dependencies.enabledAdvancedServices[0].serviceId, 'calendar');
  assert.equal(manifest.oauthScopes.some(s => /drive|gmail|notion/.test(s)), false);
});
