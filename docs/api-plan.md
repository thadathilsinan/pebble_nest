# Pebble API plan (v1)

The HTTP contract between the Pebble Flutter app (`../pebble_ui`) and this
service, with the product decisions it rests on.

**Source of truth.** The UI is the master specification. `lib/data/repository.dart`
in `pebble_ui` is an in-memory stand-in for this API, and each method on it maps
to an endpoint below. `pebble_ui/docs/Software Requirements.md` (the SRS) is
secondary: where it disagrees with the UI, the UI wins, except where §10 records a
decision that goes the other way.

**Conventions** follow `docs/adding-a-feature.md`:

- Every route sits under `/api/v1`.
- Success is `{ data }` and failure is `{ error: { code, message, details? } }`.
- `POST` returns 201, `DELETE` returns 204 with an empty body, and everything else
  returns 200.
- `PATCH` bodies carry `version`. A stale version gets a `409 STALE_VERSION` that
  carries the current state.
- Request bodies are strict. Ids are UUIDv7.
- Creates accept an optional `idempotencyKey`, scoped to the signed-in user.

---

## 1. Core model

| Term | Meaning on the wire |
|---|---|
| **Block series** | A block definition. A one-off block is a series of one. Carries `recurrence`. |
| **Block occurrence** | One series on one date. Addressed as `/blocks/{seriesId}/occurrences/{date}`, where `date` is the day the occurrence **starts**. |
| **Task** | One dated item, sitting either in a block occurrence (`blockSeriesId` + `date`) or on that date's general list (`blockSeriesId: null`). |
| **Task series** | Hidden behind tasks. Two kinds: a task that repeats **with its block**, and a general-list task that repeats **on its own**. |
| **Ledger** | What each closed day recorded: completed, incomplete (carried over), or missed. The dashboard counts it. |

**Time is local everywhere.** Blocks are stored as `date` + `startMin`/`endMin`,
where both are minutes from local midnight. `endMin <= startMin` means the block
crosses midnight. Reminders are stored as a local wall-clock time with no offset.
A 9:00 block and a 17:30 reminder stay at 9:00 and 17:30 wherever the user is. The
only real instants on the wire are `doneAt`, `createdAt` and `updatedAt`.

**Split of work between client and server:**

- **The server** expands recurrences and applies exceptions. It creates task-series
  occurrences as their dates are read, runs carry-over, and computes the review.
- **The client** does layout only: lanes for overlapping blocks, free-time spans,
  the now line and block status. Status is Upcoming, In progress or Completed from
  the phone's clock; the server stores only `skipped`. The Now screen's glance is
  also built on the client.

### Shared shapes

```jsonc
Recurrence = {
  "kind": "none" | "daily" | "weekly" | "monthly",
  "weekdays": [1..7],     // weekly; 1 = Monday … 7 = Sunday
  "monthDays": [1..31],   // monthly; a date past a short month's end falls on its last day (REC-02)
  "until": "YYYY-MM-DD" | null   // null = never ends
}

Task = {
  "id", "version",
  "title", "notes",
  "date": "YYYY-MM-DD",
  "blockSeriesId": uuid | null,            // null = general list
  "reminderAt": "YYYY-MM-DDTHH:mm" | null, // local, no offset
  "done": bool, "doneAt": ISO instant | null,
  "carryCount": int, "missed": bool,
  "repeat": {                               // null = one-off
    "mode": "withBlock" | "own",
    "recurrence": Recurrence | null        // set only when mode = "own"
  } | null
}

BlockOccurrence = {
  "seriesId", "seriesVersion", "date",
  "name", "startMin", "endMin",
  "alert", "skipped",
  "recurrence": Recurrence,
  "trace": string | null,          // the user's chosen fill pattern for this name
  "continuedFromPreviousDay": bool, // the tail of yesterday's midnight-crossing block
  "tasks": [Task], "openCount", "totalCount"
}
```

Tasks are returned in the order the UI shows them: open before done, then highest
`carryCount` first, then title A–Z.

---

## 2. Account (ACC)

Screens: sign-in, code entry, first run, You.

| Method | Path | Body / query | Response | Notes |
|---|---|---|---|---|
| POST | `/auth/email/code` | `{ email }` | 204 | **Built.** Sends a 6-digit code that expires after 10 minutes. A new code replaces the old one and resets its attempts. Rate-limited per email: one send per 30 seconds and five per hour, otherwise `429 TOO_MANY_REQUESTS` with `meta.retryAfterSeconds`. Answers the same whether or not an account exists. Also used for "Send another code". |
| POST | `/auth/email/verify` | `{ email, code }` | `Session` (200) | **Built.** Checked in this order: no code on file, or expired, or already used → `410 CODE_EXPIRED`; 5 wrong attempts already → `429 CODE_ATTEMPTS_EXHAUSTED`, even for the right code; wrong code → `400 CODE_INVALID` with `meta.attemptsLeft` (0 on the fifth miss). A code that isn't six digits is `400 VALIDATION_FAILED` and doesn't use up an attempt. |
| POST | `/auth/google` | `{ idToken }` | `Session` | |
| POST | `/auth/apple` | `{ identityToken, authorizationCode, fullName? }` | `Session` | Apple sends the name only on first sign-in, so store it then. Keep the Apple refresh token; account deletion revokes it. |
| POST | `/auth/refresh` | `{ refreshToken }` | `Session` (200) | **Built.** Rotates the token and slides the session's expiry to 60 days from now. Presenting a token the session has already rotated away from revokes the whole device session, except for a **30-second grace window**: the token retired most recently rotates again, so a retry after a lost response doesn't sign the device out. Unknown, expired, revoked or reused tokens all get `401 TOKEN_INVALID`. `isNewAccount` is always `false`. |
| POST | `/auth/sign-out` | `{ refreshToken }` | 204 | **Built.** ACC-05. Ends the session the token is current for. Idempotent: an unknown, expired or already-rotated token is also 204. |
| GET | `/me` | — | `Profile` | **Built.** Reads the caller's session, because `signInMethod` belongs to the device. So a signed-out, revoked or expired session gets `401 TOKEN_INVALID` here right away, even though the guard still accepts its access token. |
| PATCH | `/me` | `{ version, name?, weekStart?, timeFormat?, timeZone? }` | `Profile` | The client sends `timeZone` silently on every app open. |
| DELETE | `/me` | — | 204 | ACC-06. Immediate hard delete of all data, plus Sign in with Apple token revocation. The client shows the confirmation. |

```jsonc
Session = { "accessToken", "accessTokenExpiresAt", "refreshToken", "isNewAccount": bool, "profile": Profile }
Profile = {
  "id", "version",
  "email",
  "name": string | null,               // optional; the UI shows the email when it is null
  "signInMethod": "google" | "apple" | "email",
  "weekStart": "monday" | "sunday",    // default monday
  "timeFormat": "system" | "h24" | "h12", // default system
  "timeZone": IANA string,             // hidden in the UI
  "firstRecordedDay": "YYYY-MM-DD" | null, // lower limit of the Review range picker
  "hasAnyRecord": bool                 // drives the Now screen's empty state
}
```

- **Auth model:** a short-lived access JWT (about 15 minutes) sent as `Bearer`,
  plus a long-lived, rotating, opaque refresh token for each device.
- **Every route outside `/auth/*` and `/health/*` needs the access token.** A
  missing, malformed, expired or forged one gets `401 TOKEN_INVALID`. The client
  handles any 401 from a protected route by refreshing once and retrying, and
  signs in again if the refresh fails too. The guard does not check the session,
  so after sign-out an access token keeps working for up to 15 minutes on routes
  that don't read the session themselves.
- **`isNewAccount: true`** tells the client to show the first-run screen, which
  then calls `PATCH /me { weekStart }`. **No name is asked for.** Google and Apple
  fill it in when they can.
- **ACC-03:** the same verified email opens the same account whichever method is
  used. An Apple private-relay address won't match the other methods. Emails are
  trimmed and lower-cased before anything else happens.
- **Error values the client acts on** travel in `error.meta`, e.g.
  `{ "error": { "code": "CODE_INVALID", "message": "…", "meta": { "attemptsLeft": 3 } } }`.

## 3. Timeline (TML)

Screens: Day, date picker, Now screen data.

| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/days/{date}` | — | `Day` |
| GET | `/days` | `from`, `to` (at most 14 days) | `{ items: [Day] }` |

```jsonc
Day = {
  "date": "YYYY-MM-DD",
  "blocks": [BlockOccurrence], // includes yesterday's midnight-crossing tails (BLK-04)
  "generalList": [Task]
}
```

The range form serves swipe prefetch and the Now screen (today + tomorrow).

## 4. Blocks (BLK, REC-04)

Screens: block slip, block sheet.

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/blocks` | `{ name, date, startMin, endMin, recurrence?, alert, idempotencyKey? }` | `BlockOccurrence` |
| PATCH | `/blocks/{seriesId}/occurrences/{date}` | `{ version, scope, name?, startMin?, endMin?, newDate?, recurrence?, alert? }` | `BlockOccurrence` |
| DELETE | `/blocks/{seriesId}/occurrences/{date}` | `?scope=onlyThis\|series` | `{ movedTaskCount }` (200) |
| POST | `/blocks/{seriesId}/occurrences/{date}/skip` | — | `{ movedTaskCount }` |
| DELETE | `/blocks/{seriesId}/occurrences/{date}/skip` | — | 204 |
| GET | `/block-names` | `?q=` | `{ items: [string] }` |
| PUT | `/block-names/{name}/trace` | `{ trace }` | 204 |

- **Validation:** name is 1–60 characters after trimming. Length is at least 5
  minutes and at most 24 hours (BLK-05). Blocks may overlap (BLK-03).
- **Edit scope** is `onlyThis` or `thisAndFuture`, and is ignored for a
  non-repeating block. `recurrence` is accepted only with `thisAndFuture`. Past
  occurrences never change.
- **Moving a block:** its tasks go with it (BLK-09). Moving one occurrence of a
  repeating block to another date makes it a one-off block, and its tasks become
  one-offs.
- **Delete scope** matches task delete (§5), and the user is asked when the
  block repeats:

  | Scope | Effect |
  |---|---|
  | `onlyThis` (the default) | Deletes this occurrence. |
  | `series` | Deletes the whole series from today onward and ends it. Occurrences before today stay in the history. |

  Tasks in a deleted occurrence, open and done, move to that day's general list
  (BLK-10). With `series`, copies of tasks that repeat with the block are removed
  for dates after today, and one-off tasks in future occurrences move to their own
  day's general list. The response returns 200 with a count, a stated exception to
  the 204 rule, because the UI shows "3 tasks moved to the general list".
- **Skip:** open tasks move to the general list, and repeating ones split off as
  one-offs (BLK-07). Un-skipping restores the status; tasks already moved stay
  where they are (BLK-08).
- **`GET /block-names`:** names used before, matched ignoring case and surrounding
  spaces, most recently used first, at most 6 (BLK-02).
- **`PUT /block-names/{name}/trace`:** the fill pattern chosen by rerolling in the
  block slip. It is stored against the normalised name, so every block with that
  name changes, past and future included. The value is one of: `solid`, `ruled`,
  `verticalRuled`, `grid`, `stipple`, `dotted`, `dashed`, `checker`. Sending the
  name's default pattern clears the choice.

## 5. Tasks (TSK, REC-05)

Screen: task slip.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/tasks` | `{ title, date, blockSeriesId?, notes?, reminderAt?, repeatWithBlock?, recurrence?, idempotencyKey? }` | `Task` |
| PATCH | `/tasks/{id}` | `{ version, title?, notes?, reminderAt?, repeatWithBlock?, recurrence? }` | `Task` |
| PATCH | `/tasks/{id}/done` | `{ done }` | `Task` |
| POST | `/tasks/{id}/move` | `{ date, blockSeriesId }` | `Task` |
| DELETE | `/tasks/{id}` | `?scope=onlyThis\|series` | 204 |

**Repeat rules:**

- A task **in a block** can only repeat with that block (`repeatWithBlock`, which
  needs a repeating block). It has no recurrence of its own.
- A task **on the general list** can repeat on its own (`recurrence`, the same
  shape as a block's).
- The server rejects `repeatWithBlock` on a general-list task, and `recurrence` on
  a task in a block.

**Editing a repeating task:**

| Field | Applies to |
|---|---|
| `done` | this occurrence only |
| `notes` | **every occurrence, past ones included** |
| `title`, `reminderAt` | this occurrence and all future ones |
| `repeatWithBlock: false` / `recurrence: {kind: "none"}` | stops the series after this occurrence; open copies already created for later dates are removed |

For reminders, the series stores the time of day, and each occurrence gets that
time on its own date.

**Moving** (TSK-03) between blocks, to the general list, or to another date. A
repeating occurrence that moves splits off as a one-off, and the series carries
on where it was.

**Done** (TSK-04): the server stamps `doneAt` and writes the day's completed entry
in the ledger. Marking the task not done removes that entry. **If the task's date
is a day that has already closed, it is carried forward right away** (§7).

**Delete:**

| Scope | Effect |
|---|---|
| `onlyThis` (the default) | Deletes this occurrence. It never comes back. |
| `series` | Deletes every occurrence from today onward and ends the series. Occurrences before today stay in the history, so the dashboard is unchanged. |

**Creating** a task works for any date, past included. A task created on a day
that has already closed is carried forward right away.

## 6. Notifications (NTF)

Notifications are scheduled locally on the phone, so there is no push API.

| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/notifications/schedule` | `from`, `to` (at most 7 days) | `{ blockAlerts: [...], taskReminders: [...] }` |

```jsonc
blockAlerts:   [{ "seriesId", "date", "name", "startAt": "YYYY-MM-DDTHH:mm", "openTaskCount" }] // skipped blocks excluded
taskReminders: [{ "taskId", "title", "remindAt": "YYYY-MM-DDTHH:mm" }]                          // open tasks only
```

The phone calls this on every app open and reschedules a rolling 7-day window
(NTF-04). Notification permission (asked / allowed) is state on the device and
is never sent to the server.

## 7. Recurrence and carry-over (REC, TSK-06/07/08)

There are no endpoints of their own. This section describes the server behaviour
the rest of the API relies on.

**The day-end job.** It runs at each user's local midnight, in the **last time zone
the device reported**. It keeps a record of the last day it closed for each user,
so a day skipped or repeated by travel is closed exactly once. It runs on the
server, whether or not the app was opened (TSK-08).

For each unfinished task on the closing day:

| Task | Outcome |
|---|---|
| One-off | Moves to the next day's general list, `carryCount + 1`, and the ledger records it incomplete for the closing day (TSK-06). A task ignored for several days does this once per day (TSK-07). |
| Repeats with its block | Carries over if the block's next occurrence is more than a day away, otherwise it is recorded as missed. Tasks in a daily block therefore never carry (REC-06). |
| Repeats on its own (general list) | The same rule, using the task's own recurrence: carries over if its next occurrence is more than a day away, otherwise it is recorded as missed. Daily tasks therefore never carry. |

When a new occurrence arrives, any carried copy of the same series that is still
open is recorded as missed and removed, so there is never more than one open copy
(REC-07).

**Closed-day writes carry forward right away.** A task created on, or marked not
done on, a day that has already closed gets the same treatment immediately. It
moves to today, and each day it passes through is recorded.

## 8. Dashboard (DSH)

Screen: Review.

| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/review` | `from`, `to` | `Review` |

```jsonc
Review = {
  "from", "to",
  "completed", "incomplete",   // incomplete includes carried over and missed (DSH-02)
  "completionRate": number | null, // null when nothing was recorded (DSH-03)
  "byName": [{ "name", "hours", "trace" }], // DSH-04, largest first
  "skippedHours",
  "coveredHours",
  "split": { "elapsedMinutes", "blockedMinutes", "skippedMinutes" }, // each minute counted once
  "mostCarried": [Task]        // top 5, DSH-05
}
```

- **DSH-04, time per block name:**
  - totals are by name, ignoring capitals and spaces
  - overlapping blocks each count their full hours
  - a midnight-crossing block's hours are split across the two days
  - skipped hours are reported separately
  - today counts only elapsed time, using the user's time zone
  - future days count nothing
- **Periods:** the client chooses `from`/`to`, aligning weeks to `weekStart`
  (DSH-06).
- **Most carried-over follows the SRS rule, not the UI's current rule.** A task
  counts if it was **active in the period**: it had an incomplete or missed ledger
  entry on any day of the period, or it currently sits on a day in the period.
  A task carried all through a past week therefore shows in that week, even though
  it now sits on today. Ranked by `carryCount`, top 5.

## 9. Now screen

There is no dedicated endpoint. The client builds the glance (current block, next
block, reminders, carried tasks, general list, time left today) from
`GET /days?from=today&to=tomorrow`, plus `hasAnyRecord` from `/me`, using the same
logic as the UI's current `glance()`. Add `GET /now` later only if the second
request turns out to be slow.

## 10. Decisions log

| # | Decision |
|---|---|
| 1 | Tasks in a block repeat with the block. General-list tasks repeat on their own. |
| 2 | A task created on, or un-ticked on, a closed day is carried forward right away. |
| 3 | Deleting a repeating task **or block** offers "only this one" or "the whole series". "The whole series" removes today's and future occurrences; past ones stay. Editing a block still offers "only this one" / "this and all future ones". |
| 4 | Most carried-over uses the SRS rule ("active in the period"). |
| 5 | Done is per occurrence. Notes apply to every occurrence, past included. Title and reminder apply to this occurrence and future ones. |
| 6 | Local time everywhere: dates + minutes, reminders with no offset. |
| 7 | Carry-over runs at midnight in the last time zone the device reported. |
| 8 | Account deletion is an immediate hard delete, plus Apple token revocation. |
| 9 | Auth uses a short-lived access JWT plus a rotating refresh token for each device. |
| 10 | Name is optional and not collected at sign-up. The UI shows the email when it is empty. |
| 11 | Time format is stored in the profile and syncs across devices. |
| 12 | Block status is computed on the client. The server stores only `skipped`. |
| 13 | The UI is the master spec. The SRS applies only where this log says so (#4). |
| 14 | A general-list task that repeats on its own uses the REC-06 rule: carried over if its next occurrence is more than a day away, otherwise recorded as missed. |
| 15 | Refresh-token reuse is detected against every token a session has retired (`session_refresh_tokens`), not only the last one. The token retired most recently stays usable for 30 seconds, for retries. Session expiry slides on each refresh. |
| 16 | The auth guard is stateless: it checks the access token's signature and expiry, not the session. A revoked session's access token works for up to 15 minutes, except on endpoints that read the session (`GET /me`). Every bad access token is `401 TOKEN_INVALID`. There is no separate expired code. |

## 11. Error codes to add

Append these to `src/http/error-code.ts`:

| Code | Status | When |
|---|---|---|
| `STALE_VERSION` | 409 | A `PATCH` carried an old `version`. The response body includes the current state. |
| `CODE_INVALID` | 400 | Wrong sign-in code. `error.meta.attemptsLeft`. **Added.** |
| `CODE_EXPIRED` | 410 | The sign-in code is more than 10 minutes old, already used, or was never sent. **Added.** |
| `CODE_ATTEMPTS_EXHAUSTED` | 429 | 5 wrong attempts. The user must request a new code. **Added.** |
| `TOKEN_INVALID` | 401 | The access token or refresh token is bad, expired, revoked or reused. **Added** (refresh, auth guard). |
| `BLOCK_TOO_SHORT` / `BLOCK_TOO_LONG` | 422 | BLK-05 |
| `REPEAT_NOT_ALLOWED` | 422 | `repeatWithBlock` on a general-list task, or `recurrence` on a task in a block. |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | A retried create whose original request hasn't finished yet. |

## 12. Changes needed in the Flutter app

These decisions add behaviour the UI doesn't have yet:

- a repeat editor on the task slip for general-list tasks
- a delete-scope prompt ("only this one" / "the whole series") for repeating tasks,
  and the same two choices replacing "this and all future ones" when deleting a
  repeating block
- notes that apply to every occurrence (they're per occurrence today)
- an optional name, with the Profile header showing the email when it's empty
- carrying a task forward when it's un-ticked on a closed day
- replacing `PebbleRepository` with a REST client, token storage, and sending the
  time zone on app open
- scheduling local notifications from `/notifications/schedule`

## 13. Still to set up (not blocking)

- A transactional email provider for sign-in codes. Until then `MAILER=log` writes
  codes to the log, and the service refuses to start with it in production.
- Google OAuth client IDs for iOS, Android and web.
- Apple: Service ID / bundle ID, Team ID, and a Key ID with its private key. These
  are needed for sign-in, the code exchange and token revocation.
- The day-end job runner, one run per user's local midnight, safe with several
  instances running at once.
