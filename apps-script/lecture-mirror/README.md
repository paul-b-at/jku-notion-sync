# Editable JKU lecture mirror

Standalone **Google Apps Script**, stored in this repository but independent of the Bun/Playwright Moodle → Notion job. It reads the existing JKU subscription in Google Calendar and maintains a second calendar you own. Show that calendar in Notion Calendar, then add meeting links to the copied events.

**Nothing runs until you install it and authorize it in your Google account.** The GitHub workflow added here runs mocked tests only; it does not sync calendars.

## Ownership and behavior

| Field / behavior | Rule |
| --- | --- |
| Lecture title, start/end, room | JKU owns these. Updates overwrite edits to these fields in the copy. |
| Description / meeting link / personal notes | Copied from JKU **once**, then yours. Never overwritten on updates. Paste your Zoom/Teams/etc. link here. |
| Conferencing, reminders, event color | Yours; never patched by the sync. Source attendees and conferencing are not copied. |
| Recurrences | Each lecture occurrence becomes its own editable event. No recurring target series; links are per occurrence. |
| New events | Private events in a dedicated secondary calendar; no attendees or invitations. |
| Source cancellations | Confirm the source event is gone/cancelled, then require at least two observations and a 2-hour grace. Mark the copy `[Cancelled at source]` and free rather than deleting notes/links. Restore automatically if the source returns. |
| Google-reported manual deletion | If Google reports that the deterministic event ID was deleted, skip it instead of creating a different replacement ID. This is not a permanent exclusion list; restore from Trash to re-enable a retained deleted event. |
| Source calendar | Read-only to this code. Never moved, edited, invited to, or deleted from. |

The scheduled trigger polls **every 30 minutes**. It is not an instant change subscription. It reads Google's cached version of JKU's feed, so Google's feed-refresh delay still applies. Sync window: **7 days back / 180 days ahead**. Old events outside that window are retained, not pruned. A previously synced lecture moved outside the window is checked by its exact source ID before cancellation is considered.

Matching uses the source `iCalUID` plus a recurring occurrence's `originalStartTime`, falling back to the Google event ID. A stable UID keeps your link attached when a lecture moves. If JKU republishes an event under a **different UID**, there is no guaranteed way to know it is the same lecture: a new copy can appear. The old copy is not deleted, so its notes remain recoverable.

## Install in Google Apps Script

Use the **Google account containing the read-only Lectures subscription**. An iCloud calendar with the same name is not the source.

1. Open [Google Apps Script](https://script.google.com/home/start), create a project, and name it **JKU Lecture Mirror**.
2. Replace `Code.gs` with the contents of [`Code.gs`](./Code.gs).
3. In **Project Settings**, turn on **Show appsscript.json manifest file in editor**. Return to the editor and replace `appsscript.json` with [`appsscript.json`](./appsscript.json). Save. This enables the advanced **Google Calendar API v3** service.
   - The default Apps Script Cloud project enables the API when its advanced service is added. If you attached a separate standard Google Cloud project, enable **Google Calendar API** there as well.
4. Select **listCalendars** in the function dropdown and click **Run**. Authorize the project in the intended Google account. In your execution log, locate **Lectures** with role **reader** (the subscribed calendar usually has an ID ending in `@import.calendar.google.com`). These IDs are account configuration, not source-code values to commit.
5. Under **Project Settings → Script properties**, add:

   | Property | Value |
   | --- | --- |
   | `SOURCE_CALENDAR_ID` | The exact calendar ID from step 4 |

   Leave `TARGET_CALENDAR_ID` unset. The script creates a safe destination and stores this property itself.
6. Run **previewMirror**. This first preview is read-only and can run before a target exists. Inspect the source event count. If it is zero unexpectedly, stop and verify the source.
7. Run **setupMirror**. This creates **JKU Lectures — Editable** only; it does not copy events or install a trigger.
8. Run **previewMirror** again, then **syncLectures**. Check the result in Google Calendar. A large initial import is limited to 150 writes per run; if `pending` is positive, run `syncLectures` again until it reaches zero.
9. Add a real meeting URL to a copied lecture's **description** in Google Calendar or Notion Calendar. Run **syncLectures** again and confirm the URL remains.
10. In Notion Calendar, show **JKU Lectures — Editable** under the Google account. If it is not listed yet, refresh the app/calendar list. Only after inspecting the copy, hide the original **Lectures** calendar in Notion Calendar to avoid duplicates. **Do not unsubscribe from it**: the script still reads it.
11. Run **installTrigger** once. It installs a 30-minute timer; rerunning it replaces only this project's `syncLectures` triggers. Inspect Apps Script **Triggers** and **Executions** to confirm successful scheduled runs.

Authorization uses explicit limited scopes: read accessible calendars, create/manage calendars made by **this app**, and manage its own time trigger. It does **not** request unrestricted write access to all your existing calendar events, Google Drive, Gmail, Notion, or JKU credentials. Google may request these project scopes during the first preview too; preview itself still performs no mutations. Source/destination checks additionally reject primary calendars, source=target, unowned targets, and targets missing this mirror's marker.

Notion Calendar detects supported meeting URLs in event descriptions. The script preserves an existing conferencing field too; it does not create a new meeting or overwrite your lecturer's join URL with your own meeting room.

## Controls

| Function | Purpose |
| --- | --- |
| `listCalendars` | Read-only: log Google calendar names/IDs/roles in your own Apps Script execution log. |
| `previewMirror` | Read-only: compute the plan and log counts. No events, properties, calendar creation or trigger changes. |
| `setupMirror` | Create a dedicated destination once; never imports events or starts a timer. |
| `syncLectures` | Apply the current plan, capped at 150 operations / approximately 250 seconds per run. |
| `installTrigger` | Validate configuration; install exactly one 30-minute mirror trigger. |
| `removeTrigger` | Stop this mirror's timer, preserving calendars, events and unrelated triggers. |

To change cadence or horizon, edit the constants at the top of `Code.gs`. Valid `everyMinutes` values in Apps Script are 1, 5, 10, 15 and 30. Rerun `installTrigger` after changing cadence. Do not put a JKU password, ICS subscription URL, Google token or account-specific calendar ID in this repository.

## Safety and limitations

- Every source/destination list page and every missing-event check is read before any planned write. Failed reads abort that run; permission, quota and server errors are not treated as cancellations.
- An unexpectedly empty source window with existing managed copies aborts without changes. A semester with no upcoming events can therefore show a harmless execution error instead of marking everything cancelled.
- Only events carrying this script's private ownership metadata are managed. Unrelated events in the destination are left alone.
- Writes update individual copies with `sendUpdates: none`. Descriptions, conference data, attendees, reminders and colors are excluded from update patches.
- Deterministic destination IDs prevent duplicate copies after interrupted runs. Recurring exceptions use their original occurrence time, not their newly rescheduled time, for identity.
- A script lock prevents concurrent runs in the same Apps Script project. Keep **one** installed project for this mirror; multiple projects need separate destinations.
- API errors, account authorization expiry and Apps Script quotas can interrupt a batch. Inspect Executions and rerun; later runs reconcile idempotently. There is no claim of real-time delivery or guaranteed uptime.
- To stop: run `removeTrigger`. Existing links and copies stay. To uninstall fully, remove the Apps Script project/access; remove the dedicated destination calendar only if you no longer need its links/notes.

## Local verification

No npm install, Bun runtime changes, Google credentials or live calendar writes are required:

```sh
node --check < apps-script/lecture-mirror/Code.gs
node --test apps-script/lecture-mirror/verify.cjs
```

The harness uses Node's built-in test/VM modules to mock Apps Script's globals. Its filename intentionally avoids the existing Bun test-discovery patterns. `.github/workflows/calendar-mirror-check.yml` runs these checks independently; the Moodle sync workflow and dependencies are untouched.

Mocks cover idempotency, links/conferencing preservation, reschedules, recurrence identities, UID-stable API-ID changes, all-day conversions, preview safety, calendar guards, source failures/empty feeds, cancellation grace/restoration, moved-outside-window lectures, manual deletion, pagination, batching and trigger isolation. A real Google authorization and pilot sync are still required before calling the integration live-tested.

## References

- [Advanced Calendar service in Apps Script](https://developers.google.com/apps-script/advanced/calendar)
- [Calendar API recurrence identities](https://developers.google.com/workspace/calendar/api/guides/recurringevents)
- [Private extended properties](https://developers.google.com/workspace/calendar/api/guides/extended-properties)
- [Calendar API secondary-calendar creation and scopes](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert)
- [Calendar API patch behavior and scopes](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)
- [Apps Script installable triggers](https://developers.google.com/apps-script/guides/triggers/installable)
- [Notion Calendar calendar management](https://www.notion.com/help/manage-your-calendars-and-events)
- [Notion Calendar conferencing links](https://www.notion.com/help/notion-calendar-connections)
