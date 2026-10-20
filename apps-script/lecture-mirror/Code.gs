/** JKU lecture mirror. Runs in Google Apps Script, not the Bun/Moodle workflow. */
const MIRROR_ = Object.freeze({
  owner: 'jku-lecture-mirror-v1',
  targetName: 'JKU Lectures — Editable',
  fallbackTimeZone: 'Europe/Vienna',
  pastDays: 7,
  futureDays: 180,
  intervalMinutes: 30,
  missingGraceMs: 2 * 60 * 60 * 1000,
  maxWrites: 150,
  maxRuntimeMs: 250000,
});

/** Read-only discovery; calendar IDs stay in your Apps Script logs, not this repo. */
function listCalendars() {
  allPages_(function (pageToken) {
    return Calendar.CalendarList.list({ maxResults: 250, pageToken: pageToken });
  }).forEach(function (c) {
    console.log(JSON.stringify({ name: c.summary, id: c.id, role: c.accessRole }));
  });
}

/** Creates only a dedicated destination calendar; no events and no trigger. */
function setupMirror() {
  return withLock_(function () {
    const config = readConfig_();
    const source = validateSource_(config);
    if (config.targetId) {
      validateTarget_(config);
      console.log('Destination already configured; no changes.');
      return;
    }
    const target = Calendar.Calendars.insert({
      summary: MIRROR_.targetName,
      description: targetMarker_(config.sourceHash) + '\nEditable copies of JKU lectures. Descriptions and conferencing are yours.',
      timeZone: source.timeZone || MIRROR_.fallbackTimeZone,
    });
    PropertiesService.getScriptProperties().setProperty('TARGET_CALENDAR_ID', target.id);
    console.log('Created ' + MIRROR_.targetName + '. Next: previewMirror, then syncLectures. No trigger installed.');
  });
}

/** Read-only. Works before setupMirror as well, to preview the initial import. */
function previewMirror() {
  return withLock_(function () { return runMirror_(true, new Date()); });
}

/** Main handler: scheduled only after installTrigger is explicitly run. */
function syncLectures() {
  return withLock_(function () { return runMirror_(false, new Date()); });
}

function installTrigger() {
  const config = readConfig_();
  validateSource_(config);
  validateTarget_(config);
  removeTrigger();
  ScriptApp.newTrigger('syncLectures').timeBased().everyMinutes(MIRROR_.intervalMinutes).create();
  console.log('Installed one 30-minute trigger. Google subscription refresh delays still apply.');
}

/** Stops the mirror, without deleting calendars, events or other scripts' triggers. */
function removeTrigger() {
  ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'syncLectures';
  }).forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

function withLock_(callback) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('Another mirror run is active. Try again later.');
  try { return callback(); } finally { lock.releaseLock(); }
}

function readConfig_() {
  const p = PropertiesService.getScriptProperties();
  const sourceId = (p.getProperty('SOURCE_CALENDAR_ID') || '').trim();
  const targetId = (p.getProperty('TARGET_CALENDAR_ID') || '').trim();
  if (!sourceId) throw new Error('Set SOURCE_CALENDAR_ID in Project Settings > Script properties.');
  if (sourceId === targetId || sourceId === 'primary' || targetId === 'primary') {
    throw new Error('Source and target must be different, non-primary calendars.');
  }
  return { sourceId: sourceId, targetId: targetId, sourceHash: hash_(sourceId) };
}

function validateSource_(config) {
  const source = Calendar.CalendarList.get(config.sourceId);
  if (source.primary || source.accessRole === 'freeBusyReader' || source.accessRole === 'none') {
    throw new Error('Choose the JKU Lectures subscription with permission to read event details.');
  }
  return source;
}

function targetMarker_(sourceHash) { return MIRROR_.owner + '\nsource:' + sourceHash; }

function validateTarget_(config) {
  if (!config.targetId) throw new Error('Run setupMirror first to create the dedicated destination.');
  const entry = Calendar.CalendarList.get(config.targetId);
  const calendar = Calendar.Calendars.get(config.targetId);
  if (entry.primary || entry.accessRole !== 'owner' ||
      (calendar.description || '').indexOf(targetMarker_(config.sourceHash)) === -1) {
    throw new Error('Refusing to write: target is not the dedicated owned mirror for this source.');
  }
}

function allPages_(fetchPage) {
  const result = [];
  const tokens = new Set();
  let token;
  do {
    const page = fetchPage(token);
    if (!page || !Array.isArray(page.items || [])) throw new Error('Invalid Calendar API response.');
    result.push.apply(result, page.items || []);
    token = page.nextPageToken;
    if (token && tokens.has(token)) throw new Error('Calendar API pagination loop; aborting safely.');
    if (token) tokens.add(token);
  } while (token);
  return result;
}

function runMirror_(dryRun, now) {
  const started = Date.now();
  const config = readConfig_();
  validateSource_(config);
  if (config.targetId) validateTarget_(config);
  else if (!dryRun) throw new Error('Run setupMirror before writing events.');
  const window = {
    min: new Date(now.getTime() - MIRROR_.pastDays * 86400000),
    max: new Date(now.getTime() + MIRROR_.futureDays * 86400000),
  };
  // Fetch ALL source and destination pages before planning ANY writes.
  const sourceEvents = allPages_(function (token) {
    return Calendar.Events.list(config.sourceId, {
      timeMin: window.min.toISOString(), timeMax: window.max.toISOString(),
      singleEvents: true, showDeleted: false, maxResults: 2500,
      orderBy: 'startTime', pageToken: token,
    });
  }).filter(function (e) { return e.status !== 'cancelled'; });
  const targets = config.targetId ? allPages_(function (token) {
    return Calendar.Events.list(config.targetId, {
      privateExtendedProperty: 'jmOwner=' + MIRROR_.owner,
      showDeleted: false, maxResults: 2500, pageToken: token,
    });
  }).filter(function (e) {
    return e.status !== 'cancelled' && private_(e).jmSource === config.sourceHash;
  }) : [];
  if (!sourceEvents.length && targets.length) {
    throw new Error('Source window is empty. No changes made; refusing to infer mass cancellations.');
  }
  const plan = buildPlan_(sourceEvents, targets, config, window, now);
  const result = { preview: dryRun, sourceEvents: sourceEvents.length, planned: plan.length,
    creates: plan.filter(function (op) { return op.kind === 'insert'; }).length,
    applied: 0, manuallyDeletedSkipped: 0, pending: plan.length };
  if (!dryRun) {
    for (let i = 0; i < plan.length; i++) {
      if (result.applied + result.manuallyDeletedSkipped >= MIRROR_.maxWrites ||
          Date.now() - started >= MIRROR_.maxRuntimeMs) break;
      const op = plan[i];
      if (op.kind === 'patch') {
        Calendar.Events.patch(op.body, config.targetId, op.id, { sendUpdates: 'none' });
        result.applied++;
      } else {
        const written = insertSafely_(op.body, config);
        if (written) result.applied++;
        else result.manuallyDeletedSkipped++;
      }
      result.pending--;
    }
  }
  console.log(JSON.stringify(result));
  return result;
}

function buildPlan_(sources, targets, config, window, now) {
  const sourceByKey = new Map();
  const targetByKey = new Map();
  sources.forEach(function (e) {
    validateEvent_(e);
    const key = sourceKey_(e, config);
    if (sourceByKey.has(key)) throw new Error('Duplicate source occurrence identity; no writes made.');
    sourceByKey.set(key, e);
  });
  targets.forEach(function (e) {
    const key = private_(e).jmKey;
    if (!key || targetByKey.has(key)) throw new Error('Duplicate/invalid managed target identity; no writes made.');
    targetByKey.set(key, e);
  });
  const plan = [];
  sourceByKey.forEach(function (source, key) {
    const current = targetByKey.get(key);
    if (!current) plan.push({ kind: 'insert', body: newCopy_(source, config, key) });
    else addPatch_(plan, current, livePatch_(source, current, config, key));
  });
  targetByKey.forEach(function (current, key) {
    if (sourceByKey.has(key) || !sourceTimeInWindow_(private_(current), window)) return;
    const sourceId = private_(current).jmSourceEventId;
    if (!sourceId) throw new Error('Managed event has no source event ID; no writes made.');
    // A missing item in a bounded list may just have moved outside the window.
    // Verify its exact source ID before treating it as cancelled.
    const source = getSourceOrMissing_(config.sourceId, sourceId);
    if (source && source.status !== 'cancelled') {
      validateEvent_(source);
      if (sourceKey_(source, config) !== key) throw new Error('Source identity changed unexpectedly; aborting safely.');
      addPatch_(plan, current, livePatch_(source, current, config, key));
    } else {
      addPatch_(plan, current, missingPatch_(current, now));
    }
  });
  return plan;
}

function addPatch_(plan, current, body) {
  if (Object.keys(body).length) plan.push({ kind: 'patch', id: current.id, body: body });
}

function private_(event) { return (event.extendedProperties || {}).private || {}; }

function hash_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (n) { return ('0' + ((n + 256) % 256).toString(16)).slice(-2); }).join('');
}

function timeKey_(time) {
  if (!time) return '';
  return time.date || (time.dateTime ? new Date(time.dateTime).toISOString() : '');
}

function sourceKey_(event, config) {
  // originalStartTime identifies a recurrence occurrence even when it is rescheduled.
  return hash_(config.sourceHash + '\n' + (event.iCalUID || event.id) + '\n' + timeKey_(event.originalStartTime));
}

function validateEvent_(event) {
  if (!event.id || (!event.iCalUID && !event.id)) throw new Error('Source event missing identity.');
  const start = timeKey_(event.start), end = timeKey_(event.end);
  if (!start || !end || Boolean(event.start.date) !== Boolean(event.end.date) ||
      !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end)) {
    throw new Error('Source event has invalid dates; no writes made.');
  }
}

function copyTime_(time) {
  if (time.date) return { date: time.date };
  const copy = { dateTime: time.dateTime };
  if (time.timeZone) copy.timeZone = time.timeZone;
  return copy;
}

function patchTime_(time) {
  // PATCH must explicitly clear the mutually exclusive date/dateTime fields.
  return time.date ? { date: time.date, dateTime: null, timeZone: null } :
    { date: null, dateTime: time.dateTime, timeZone: time.timeZone || null };
}

function metadata_(source, config, key) {
  return { jmOwner: MIRROR_.owner, jmSource: config.sourceHash, jmKey: key,
    jmSourceEventId: source.id, jmSourceStart: timeKey_(source.start), jmSourceEnd: timeKey_(source.end),
    jmMissCount: '0', jmMissingSince: '', jmCancelled: '0' };
}

function newCopy_(source, config, key) {
  return { id: 'jm' + key, summary: source.summary || '(Untitled lecture)',
    start: copyTime_(source.start), end: copyTime_(source.end), location: source.location || '',
    description: (source.description ? source.description + '\n\n' : '') + 'Meeting link / personal notes:\n',
    transparency: source.transparency || 'opaque', visibility: 'private',
    extendedProperties: { private: metadata_(source, config, key) } };
}

function livePatch_(source, current, config, key) {
  const patch = {};
  if ((current.summary || '') !== (source.summary || '(Untitled lecture)')) patch.summary = source.summary || '(Untitled lecture)';
  if ((current.location || '') !== (source.location || '')) patch.location = source.location || '';
  if (timeKey_(current.start) !== timeKey_(source.start) || timeKey_(current.end) !== timeKey_(source.end) ||
      Boolean(current.start.date) !== Boolean(source.start.date)) {
    patch.start = patchTime_(source.start); patch.end = patchTime_(source.end);
  }
  const desired = metadata_(source, config, key);
  const old = private_(current);
  if (Object.keys(desired).some(function (k) { return old[k] !== desired[k]; })) {
    patch.extendedProperties = { private: Object.assign({}, old, desired) };
  }
  if (old.jmCancelled === '1') patch.transparency = source.transparency || 'opaque';
  // Deliberately NEVER patch description, conferenceData, attendees, reminders or color.
  return patch;
}

function sourceTimeInWindow_(p, window) {
  return Date.parse(p.jmSourceEnd) > window.min.getTime() && Date.parse(p.jmSourceStart) < window.max.getTime();
}

function missingPatch_(current, now) {
  const old = private_(current);
  const since = old.jmMissingSince || now.toISOString();
  const count = Math.min(2, (Number(old.jmMissCount) || 0) + 1);
  const cancelled = count >= 2 && now.getTime() - Date.parse(since) >= MIRROR_.missingGraceMs;
  const desired = Object.assign({}, old, { jmMissCount: String(count), jmMissingSince: since,
    jmCancelled: cancelled ? '1' : (old.jmCancelled || '0') });
  const patch = {};
  if (JSON.stringify(old) !== JSON.stringify(desired)) patch.extendedProperties = { private: desired };
  if (cancelled && old.jmCancelled !== '1') {
    patch.summary = '[Cancelled at source] ' + (current.summary || '(Untitled lecture)');
    patch.transparency = 'transparent';
  }
  return patch;
}

function isMissingError_(error) {
  return Number(error.code) === 404 || Number(error.code) === 410 ||
    /\b(404|410)\b|not\s?found|resource has been deleted|\bgone\b/i.test(String(error.message || error));
}

function getSourceOrMissing_(calendarId, eventId) {
  try { return Calendar.Events.get(calendarId, eventId); }
  catch (error) { if (isMissingError_(error)) return null; throw error; }
}

function insertSafely_(body, config) {
  try { Calendar.Events.insert(body, config.targetId, { sendUpdates: 'none' }); return true; }
  catch (error) {
    if (!(Number(error.code) === 409 || /\b409\b|already exists|duplicate/i.test(String(error.message || error)))) throw error;
    const existing = getSourceOrMissing_(config.targetId, body.id);
    // Respect an intentional manual deletion. Never silently recreate it under a new ID.
    if (!existing || existing.status === 'cancelled') return false;
    const p = private_(existing);
    if (p.jmOwner !== MIRROR_.owner || p.jmSource !== config.sourceHash || p.jmKey !== body.extendedProperties.private.jmKey) {
      throw new Error('Event ID conflict with an unmanaged event; refusing to overwrite.');
    }
    // Recover safely from a partial/interrupted earlier insert; preserve user-owned fields.
    const patch = {};
    ['summary', 'location'].forEach(function (k) { patch[k] = body[k]; });
    patch.start = patchTime_(body.start); patch.end = patchTime_(body.end);
    patch.extendedProperties = { private: Object.assign({}, p, body.extendedProperties.private) };
    Calendar.Events.patch(patch, config.targetId, body.id, { sendUpdates: 'none' });
    return true;
  }
}
