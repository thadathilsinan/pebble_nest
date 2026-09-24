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
| POST | `/auth/google` | `{ idToken }` | `Session` (200) | **Built.** See below. |
| POST | `/auth/apple` | `{ identityToken, authorizationCode, fullName?: { givenName?, familyName? } }` | `Session` (200) | **Built.** See below. |
| POST | `/auth/refresh` | `{ refreshToken }` | `Session` (200) | **Built.** Rotates the token and slides the session's expiry to 60 days from now. Presenting a token the session has already rotated away from revokes the whole device session, except for a **30-second grace window**: the token retired most recently rotates again, so a retry after a lost response doesn't sign the device out. Unknown, expired, revoked or reused tokens all get `401 TOKEN_INVALID`. `isNewAccount` is always `false`. |
| POST | `/auth/sign-out` | `{ refreshToken }` | 204 | **Built.** ACC-05. Ends the session the token is current for. Idempotent: an unknown, expired or already-rotated token is also 204. |
| GET | `/me` | — | `Profile` | **Built.** Reads the caller's session, because `signInMethod` belongs to the device. So a signed-out, revoked or expired session gets `401 TOKEN_INVALID` here right away, even though the guard still accepts its access token. |
| PATCH | `/me` | `{ version?, name?, weekStart?, timeFormat?, timeZone? }` | `Profile` | **Built.** `version` is required unless `timeZone` is the only field sent. The client sends its zone silently on every app open, and that write is last-write-wins and never a 409 (decision 17). A stale `version` otherwise gets `409 STALE_VERSION` with the current profile in `meta.current`. A patch that changes nothing returns 200 and leaves `version` alone. `name` is trimmed and at most 80 characters; blank or `null` clears it. `timeZone` must be an IANA name the server's `Intl` knows, not a raw offset like `+05:30`, and is stored as sent. Reads the session, like `GET /me`. |
| DELETE | `/me` | — | 204 | **Built.** ACC-06. An immediate hard delete in one transaction. Deleting the `users` row removes every device's session and retired tokens through the cascades, and the email's `email_sign_in_codes` row is deleted too, which resets its send rate limit. Needs a live session, like `GET /me`, so a signed-out device's still-valid access token gets `401 TOKEN_INVALID`. A retry after a lost response also gets 401, because the session went with the account (decision 18). There is no re-authentication: the client shows the confirmation. An account that signed in with Apple has its Apple grant revoked after the delete commits, best-effort: a failure is logged and the answer is still 204 (decision 34). |

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

- **The record fields** are built with `GET /review`, on every `Profile`
  (sign-in, refresh, `/me`). `firstRecordedDay` is the earliest block anchor,
  task date or ledger day. `hasAnyRecord` is whether any block or task exists,
  as the app computes it, so a deleted task's ledger days can set
  `firstRecordedDay` while `hasAnyRecord` is `false`.

- **Google sign-in (built):** `idToken` is the ID token Google Sign-In gives
  the app. Its shape is checked first: three base64url segments, at most 8 KB,
  or `400 VALIDATION_FAILED`. With `GOOGLE_CLIENT_IDS` unset the route answers
  `503 SERVICE_UNAVAILABLE` without checking the token; production refuses to
  start without it. The token needs an RS256 signature by a key in Google's
  published set, `iss` of `accounts.google.com` (either spelling), an `aud`
  that is one of our client IDs, an unexpired `exp`, and `email_verified`;
  anything else is `401 ID_TOKEN_INVALID`. If Google's keys can't be fetched
  and none cached fits, it is `503 SERVICE_UNAVAILABLE`. The account is found
  by the email alone (ACC-03), trimmed and lower-cased, so an account email
  sign-in opened is the same account; nothing of Google's `sub` is kept.
  Google's `name`, trimmed and cut to 80 characters, names a new account, and
  an existing one only while its name is null, bumping `version`; a name the
  user chose is never replaced. The session's `signInMethod` is `google`.
  There is no rate limit: every guess costs an attacker a token Google signed
  (decision 33).
- **Sign in with Apple (built):** iOS only for now. `identityToken` is checked
  like Google's ID token: the same shape rule, an RS256 signature by a key in
  Apple's published set, `iss` of `https://appleid.apple.com`, an `aud` that
  is one of `APPLE_CLIENT_IDS` (our bundle IDs), an unexpired `exp`, and
  `email_verified` (Apple sends it as a string or a boolean). A private-relay
  address is accepted as the account's email. Then `authorizationCode` is
  exchanged at Apple's token endpoint under the token's own `aud`, with a
  client secret signed by our Sign in with Apple key, before anything is
  written. A code Apple refuses (`invalid_grant`: used, expired, or not ours)
  is `401 ID_TOKEN_INVALID`, and a sign-in whose code can't be exchanged fails
  with 503, because the refresh token it yields is what account deletion
  revokes. That token is kept in `apple_grants`, one per account, replaced on
  each Apple sign-in. `fullName`'s parts are trimmed and joined with a space,
  and name the account only while it has none, as Google's name does; Apple
  sends the name on the first sign-in only, so the app passes it on whenever
  it has it. `code` is 1 to 1024 characters and each name part at most 200.
  With the Apple settings unset the route answers `503 SERVICE_UNAVAILABLE`
  before checking anything (decision 34).
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

**Built, both forms.** Each block carries its tasks, with `openCount` and
`totalCount`, and `generalList` holds the day's tasks in no block. Both are in
the order in §1. Repeating tasks' occurrences in the range (and the day
before it, for tails) are issued before the tasks are read (decision 35).

- **Which days a series lands on** follows the app's `Recurrence.occursOn`
  (`src/calendar/recurrence.ts`): never before the anchor or after `until`, and
  the anchor itself only when the rule fits it (decision 20). A monthly day past
  the month's end falls on its last day (REC-02).
- **Midnight crossings (BLK-04):** day D also lists the tail of each block that
  started on D−1 with `endMin <= startMin` and `endMin > 0`, with
  `date = D−1` and `continuedFromPreviousDay: true`. A block ending exactly at
  midnight has no tail. A repeating block's last occurrence still has its tail
  on the day after `until`.
- **Order:** tails first, then by `startMin`, then name, then `seriesId`. Lanes
  are the client's job.
- **A tail holds its occurrence's tasks:** the tasks dated D−1 in that block, as
  the app shows them, so tasks are read from `from − 1`.
- **Range:** `from` and `to` are both included, at most 14 days; `to < from` or a
  longer span is `400 VALIDATION_FAILED`. One query reads the caller's series,
  one reads their tasks, and the days are expanded in memory.
- It does not read the session (decision 16).

## 4. Blocks (BLK, REC-04)

Screens: block slip, block sheet.

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/blocks` | `{ name, date, startMin, endMin, recurrence?, alert, idempotencyKey? }` | `BlockOccurrence` (201). **Built.** See below. |
| PATCH | `/blocks/{seriesId}/occurrences/{date}` | `{ version, scope?, name?, startMin?, endMin?, newDate?, recurrence?, alert? }` | `BlockOccurrence` (200). **Built.** See below. |
| DELETE | `/blocks/{seriesId}/occurrences/{date}` | `?scope=onlyThis\|series` | `{ movedTaskCount }` (200). **Built.** See below. |
| POST | `/blocks/{seriesId}/occurrences/{date}/skip` | — | `{ movedTaskCount }` (200). **Built.** See below. |
| DELETE | `/blocks/{seriesId}/occurrences/{date}/skip` | — | 204. **Built.** See below. |
| GET | `/block-names` | `?q=` | `{ items: [string] }`. **Built.** See below. |
| PUT | `/block-names/{name}/trace` | `{ trace }` | 204. **Built.** See below. |

- **Validation:** name is 1–60 characters after trimming. Length is at least 5
  minutes, otherwise `422 BLOCK_TOO_SHORT` (BLK-05). `endMin = startMin` is a full
  24 hours, which is also the most minute-of-day values can express, so there is
  no too-long case. Blocks may overlap (BLK-03). Any date is accepted, past
  included.
- **Create (built):** `recurrence` is optional, and leaving it out means `none`.
  `weekdays` is accepted only with `weekly`, `monthDays` only with `monthly`, and
  `until` only with a kind that repeats, on or after `date`. An empty or missing
  day list means `date`'s own weekday or day of the month, and the server stores
  and returns it filled in, so a returned `Recurrence` is always explicit.
  Duplicate days are dropped. A retry with the same `idempotencyKey` returns the
  block the first request created, with 201, whatever the retry's body says. The
  key is scoped to the user. The response is the **first occurrence on or after
  `date`**: `date` itself unless the rule skips it, so a weekly block of Mondays
  created on a Wednesday answers with the next Monday (decision 20). A repeat
  whose `until` comes before its first occurrence is
  `422 BLOCK_NO_OCCURRENCE`. The occurrence carries
  `tasks: []`, and the trace chosen for its name. It does not read the
  session (decision 16).
- **Edit scope** is `onlyThis` or `thisAndFuture`, and is ignored for a
  non-repeating block. `recurrence` is accepted only with `thisAndFuture`. Past
  occurrences never change.
- **Edit (built):** the body is strict, `version` is the
  series' `seriesVersion` and required, and `scope` defaults to `onlyThis`.
  `name`, `startMin`, `endMin` and `recurrence` follow create's rules; an
  absent field is left alone, and `newDate` equal to `date` is no move.
  Checked in this order: a bad id, date or body is
  `400 VALIDATION_FAILED`; the occurrence is found as skip finds it (`404`,
  `422 BLOCK_NOT_ON_DATE`); a stale `version` is `409 STALE_VERSION` with
  the occurrence in `meta.current`; then what the scope accepts, since that
  depends on whether the series repeats: `recurrence` with `onlyThis` on a
  repeating block, and `newDate` with `thisAndFuture` on any but its first
  occurrence, are `400 VALIDATION_FAILED`; then the values after the edit:
  `422 BLOCK_TOO_SHORT`, and for a new rule create's checks. A patch that
  changes nothing returns 200 and leaves `seriesVersion` alone; any real
  change bumps it, even one to a single occurrence (decision 30). The series
  row is locked for the write. A deleted account's token gets
  `401 TOKEN_INVALID`, because an edit reads the user's time zone. It does
  not read the session (decision 16).
  - **In place:** a block that doesn't repeat, whatever the scope, or the
    first occurrence of a repeating one with `thisAndFuture`, is the series
    itself, so the series changes, every occurrence with it. A new
    `recurrence` is anchored on the occurrence (an empty day list takes its
    day), may make a one-off block repeat, and answers with its first
    occurrence, as create does; an `until` before the date is
    `400 VALIDATION_FAILED`. Tasks in occurrences the new rule no longer
    has move to their own day's general list, as a deleted occurrence's do.
    `newDate` moves the anchor, and the rule must land on it or it is
    `422 BLOCK_NOT_ON_DATE`; the occurrence's tasks go with it (BLK-09),
    a done one taking its `completed` entry along, an open one landing on a
    closed day carrying on to today as `/move` carries it. Its skip and
    overrides go too, unless the new date has its own.
  - **`onlyThis`** on a repeating block overrides that occurrence alone:
    its `name`, `startMin`, `endMin` and `alert`, held in its
    `block_occurrence_exceptions` row. An override equal to the series is
    stored as null, so it follows later changes to the series. `GET /days`
    shows the overrides, on the midnight tail too, and whether there is a
    tail follows the occurrence's own times. The trace is the one for the
    occurrence's name. `GET /block-names` counts series names only.
  - **`onlyThis` with `newDate`** moves the occurrence out as a one-off
    block with a new `seriesId`: its own values, overrides included, with
    the patch applied. The occurrence is deleted from its series, bumping
    `seriesVersion`, so naming it again is `404`. Its tasks, open and done,
    go with it, as an in-place move takes them. A skip stays behind.
  - **`thisAndFuture` on a later occurrence** splits the series: it ends
    the day before, bumping `seriesVersion`, and a new series with a new
    `seriesId` starts on `date`, taking the series' own values with the
    patch applied, and `recurrence` if sent (anchored on `date`). Earlier
    occurrences never change. Occurrences from `date` on take their skips
    and overrides to the new series. Their tasks are relinked in place,
    without a carry, except those in occurrences the new rule doesn't have,
    which go to their day's general list. The answer is the new series'
    first occurrence. A patch that changes nothing doesn't split.
    Tasks repeating with the block carry on with the new series from `date`
    (decision 37).
- **Moving a block:** its tasks go with it (BLK-09). Moving one occurrence of a
  repeating block to another date makes it a one-off block, and its tasks become
  one-offs.
- **Delete scope** matches task delete (§5), and the user is asked when the
  block repeats:

  | Scope | Effect |
  |---|---|
  | `onlyThis` (the default) | Deletes this occurrence. |
  | `series` | Deletes the whole series from today onward and ends it, and the occurrence named too, even a past one. Other occurrences before today stay in the history (decision 29). |

  Tasks in a deleted occurrence, open and done, move to that day's general list
  (BLK-10). With `series`, copies of tasks that repeat with the block are removed
  for dates after today, and one-off tasks in future occurrences move to their own
  day's general list. The response returns 200 with a count, a stated exception to
  the 204 rule, because the UI shows "3 tasks moved to the general list".
- **Delete (built):** the 400, 404 and 422 checks are skip's, plus a
  `scope` other than `onlyThis` or `series` (the default is `onlyThis`) is
  `400 VALIDATION_FAILED`. A block that doesn't repeat is deleted outright
  whatever the scope. `onlyThis` on a repeating block marks the occurrence
  `deleted` in `block_occurrence_exceptions`. `series` sets `until` to the
  earlier of its own and yesterday, bumping `seriesVersion`, and marks a past
  named occurrence deleted; a series left with no occurrence before today is
  deleted outright instead. Every task in a deleted occurrence, open and done,
  moves to its own day's general list, each bumping its `version`, **and an
  open one on a closed day carries forward to today** as skip carries it.
  `movedTaskCount` counts them all. There is no `version` and the last write
  wins. The series row and the tasks are locked. **A deleted occurrence is
  gone:** `GET /days` leaves it out along with its midnight tail, and a retry,
  skip, un-skip, `POST /tasks` or `/tasks/{id}/move` naming it gets
  `404 NOT_FOUND`. A `series` retry naming today or later gets
  `422 BLOCK_NOT_ON_DATE` instead, since the series now ends before it. A
  deleted account's token gets `401 TOKEN_INVALID`, because delete reads the
  user's time zone. It does not read the session (decision 16). With
  `series`, tasks repeating with the block stop too: their open copies dated
  today or later are deleted before the move, done ones move as one-offs,
  and every task a delete moves splits off from its series (decision 37).
- **Skip:** open tasks move to the general list, and repeating ones split off as
  one-offs (BLK-07). Un-skipping restores the status; tasks already moved stay
  where they are (BLK-08).
- **Skip (built):** `date` is the day the occurrence starts. An id that isn't a
  UUID or a date that isn't `YYYY-MM-DD` is `400 VALIDATION_FAILED`; an unknown
  series, or someone else's, is `404 NOT_FOUND`; a date the series doesn't fall
  on is `422 BLOCK_NOT_ON_DATE`. The answer is 200, not 201: nothing is
  created. There is no `version` and the last write wins, as with
  `/tasks/{id}/done`, and skipping doesn't bump `seriesVersion`. The
  occurrence's open tasks move to that day's general list, each bumping its
  `version`; done tasks stay in the block. **An open task on a closed day
  carries forward at once**, as `/tasks/{id}/move` carries one (decision 26):
  to today's general list, `carryCount` up by the days passed, and an
  `incomplete` entry for each closed day from `date` to yesterday.
  `movedTaskCount` counts those too. Skipping again answers 200 with whatever
  arrived since, normally 0. The open tasks are locked, so two devices
  skipping at once move each task once. A deleted account's token gets
  `401 TOKEN_INVALID`, because skip reads the user's time zone.
- **Un-skip (built):** the same 400, 404 and 422 checks. It clears the
  exception row's `skipped`, keeping any override, so un-skipping an
  occurrence that isn't skipped
  is also 204. It reads no user row, so a deleted account's token gets 404.
  Neither reads the session (decision 16).
- **On the timeline**, a skipped occurrence has `skipped: true`, and so does
  its midnight tail on the next day.
- **`GET /block-names` (built):** names used before, most recently used first,
  at most 6 (BLK-02). One entry per name ignoring capitals and surrounding
  spaces, spelt as the most recently created block spelt it. "Recently used" is
  when the block series was created. `q` is trimmed and matched ignoring
  capitals **anywhere** in the name; the name `q` already is is left out, and a
  blank or absent `q` lists the most recent names, all as the app's
  `nameSuggestions` does. A `q` over 60 characters is `400 VALIDATION_FAILED`.
  Every series counts, ended ones included. The list is capped rather than
  cursor-paginated. It does not read the session (decision 16).
- **`PUT /block-names/{name}/trace` (built):** the fill pattern chosen by
  rerolling in the block slip. It is stored against the normalised name
  (trimmed, lower-cased), so every block with that name changes, past and
  future included, and `trace` on every `BlockOccurrence` carries it; `null`
  means the name's default. The name needn't belong to a block yet, since the
  slip rerolls before saving. The value is one of: `solid`, `ruled`,
  `verticalRuled`, `grid`, `stipple`, `dotted`, `dashed`, `checker`; `open`
  and anything else are `400 VALIDATION_FAILED`, as are a blank name or one
  over 60 characters. A name containing `/` is sent percent-encoded. Sending
  the name's default pattern clears the choice: the server computes it with the
  app's hash (decision 27). No `version`: last write wins. A deleted account's
  token gets `401 TOKEN_INVALID`. It does not read the session (decision 16).

## 5. Tasks (TSK, REC-05)

Screen: task slip.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/tasks` | `{ title, date, blockSeriesId?, notes?, reminderAt?, repeatWithBlock?, recurrence?, idempotencyKey? }` | `Task` (201). **Built.** See below. |
| PATCH | `/tasks/{id}` | `{ version, title?, notes?, reminderAt?, repeatWithBlock?, recurrence? }` | `Task` (200). **Built.** See below. |
| PATCH | `/tasks/{id}/done` | `{ done }` | `Task` (200). **Built.** See below. |
| POST | `/tasks/{id}/move` | `{ date, blockSeriesId }` | `Task` (200). **Built.** See below. |
| DELETE | `/tasks/{id}` | `?scope=onlyThis\|series` | 204. **Built.** See below. |

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

**Create (built):**

- `title` is trimmed, 1–200 characters (TSK-01). `notes` is at most 10,000
  characters and defaults to `''`. `reminderAt` is `YYYY-MM-DDTHH:mm` with no
  offset and needn't fall on `date`; it is stored as a date plus minutes, like a
  block's start. Unknown fields are `400 VALIDATION_FAILED`.
- `blockSeriesId` names an occurrence by its series and `date`, the day it
  starts. An unknown series, or someone else's, is `404 NOT_FOUND`. A series
  that doesn't fall on `date` is `422 BLOCK_NOT_ON_DATE`.
- `repeatWithBlock: true` on a general-list task or with a block that doesn't
  repeat, and a repeating `recurrence` on a task in a block, are
  `422 REPEAT_NOT_ALLOWED`. `repeatWithBlock: false` and
  `recurrence: {kind: "none"}` are one-offs.
- **A repeat that fits starts a task series** (decision 35), anchored on
  `date`, which is its first occurrence even when its own rule doesn't land
  there. `recurrence` is stored with explicit days, as a block's is
  (decision 19), and an `until` before `date` is `400 VALIDATION_FAILED`.
  The reminder repeats as the same time of day, the same number of days after
  each occurrence's date.
- **Closed days** (decision 22): a `date` before today in the user's time zone,
  or UTC if none has been reported, is closed. The task is created on today's
  general list with `carryCount` equal to the days passed, and each closed day
  from `date` to yesterday gets an `incomplete` ledger entry. A repeating task
  stops carrying on the day before its series' next occurrence, if that is
  before today: it stays there, `missed`, with a `missed` entry for that day
  (REC-06). So a daily task put on a closed day is missed on its own day, in
  its block. The series' other closed-day occurrences are not settled here;
  they are issued open when read (decision 35). The response
  shows where the task ended up; a `date` different from the one sent means it
  was carried. The ledger survives the task's deletion, keeping its title.
- A retry with the same `idempotencyKey` returns the original with 201 and
  writes no ledger entries of its own (decision 19). A deleted account's token
  gets `401 TOKEN_INVALID`. It does not read the session (decision 16).

**Done (built):**

- `{ done }` only, strict, with no `version`: it sets an absolute value, so the
  last write wins and a retry is harmless (decision 24). A real change bumps
  `version`, so another device's stale `PATCH /tasks/{id}` gets its 409.
  Sending the value the task already has returns it unchanged, `version` and
  `doneAt` included.
- Done stamps `doneAt` with the database's clock and records the task
  `completed` on the day it sits on, replacing anything that day held for it.
  Open again clears `doneAt` and removes that day's entry. This happens on the
  write, for today and future days too, as the app does.
- Reopened on a closed day, the task carries forward as a closed-day create
  does: to today's general list, `carryCount` up by the days passed, and an
  `incomplete` entry for each closed day from its date to yesterday.
- The task row is locked for the write, so two devices ticking at once write
  one entry. An id that isn't a UUID is `400 VALIDATION_FAILED`; an unknown
  task, or someone else's, is `404 NOT_FOUND`. A deleted account's token gets
  `401 TOKEN_INVALID`. It does not read the session (decision 16).
- A missed task can be ticked: `completed` replaces its `missed` entry.
  Reopened, it is missed again where it is, with its `missed` entry back,
  since its day has already been settled. A repeating task reopened on a
  closed day settles as a closed-day create does, by its series (REC-06).

**Edit (built):**

- Strict body. `version` is required. `title`, `notes` and `reminderAt` follow
  create's rules. An absent field is left alone, and `reminderAt: null` clears
  the reminder. `date` and `blockSeriesId` are `400 VALIDATION_FAILED`: moving
  a task is `/move`'s job, and done is `/done`'s. An edit never moves or
  carries a task, not even a task sitting on a closed day.
- A stale `version` is `409 STALE_VERSION` with the task in `meta.current`.
  A patch that changes nothing returns 200 and leaves `version` alone. The
  version check comes before the repeat checks.
- The repeat fields follow create's rules, and restating the repeat the task
  already has changes nothing. A repeat that doesn't fit is
  `422 REPEAT_NOT_ALLOWED`: judged by where a one-off sits, and by its
  series' kind for an occurrence (`repeatWithBlock: true` on one repeating on
  its own, or a repeating `recurrence` on one repeating with its block).
  Turning a repeat on starts a series from the task on its date, as create
  does.
- **On an occurrence of a repeating task** (decision 36): a new title or
  reminder goes to the series and to its open occurrences dated after this
  one, each bumping its `version`; done ones keep theirs. A reminder keeps
  its time of day and its distance in days from each occurrence's date.
  Notes go to the series and every occurrence, past ones included.
  `repeatWithBlock: false` or `recurrence: {kind: "none"}` stops the series
  here: this occurrence becomes a one-off, open occurrences already issued
  for later dates are deleted, and done ones stay as one-offs. A different
  `recurrence` on one repeating on its own stops the old series the same way
  and starts a new one from this occurrence; notes sent in the same save
  still reach the old series' occurrences. An `until` before the task's date
  is `400 VALIDATION_FAILED`.
- **A new title renames every ledger entry the task has** (decision 25). This
  happens in the same transaction, with the task row locked, so two devices
  editing at the same `version` get one 200 and one 409.
- The task row is locked, then its series row, in that order.
- An id that isn't a UUID is `400 VALIDATION_FAILED`. An unknown task, or
  someone else's, is `404 NOT_FOUND`. There is no user read, so a deleted
  account's token gets 404 too, not the 401 that create and `/done` give. It
  does not read the session (decision 16).

**Move (built):**

- Strict body with both fields required. `blockSeriesId: null` is the date's
  general list. There is no `version`: a place is an absolute value, so the
  last write wins, as with `/done` (decision 26). A real move bumps `version`,
  so the slip's follow-up `PATCH` uses the version the move returned. Moving a
  task to where it already is returns it unchanged.
- The block follows create's rules: an unknown series, or someone else's, is
  `404 NOT_FOUND`, and one that doesn't fall on `date` is
  `422 BLOCK_NOT_ON_DATE`. An unknown task, or someone else's, is also `404`.
- **An occurrence of a repeating task that moves splits off as a one-off**
  (`repeat: null`). Its series carries on and never issues that date again.
- **A done task takes its `completed` entry with it** to the day it now sits
  on, replacing whatever that day held for it. It stays on a closed day it is
  moved to.
- **An open task moved onto a closed day carries forward at once**, as a
  closed-day create does: to today's general list, `carryCount` up by the days
  passed, and an `incomplete` entry for each closed day from `date` to
  yesterday. A day that already has an entry for the task, because it carried
  through it before, keeps that entry. `carryCount` still counts the carry
  again.
- The row is locked for the write. A deleted account's token gets
  `401 TOKEN_INVALID`, because the move reads the user's time zone. It does not
  read the session (decision 16).

**Delete (built):**

- `scope` must be `onlyThis` or `series`, and it defaults to `onlyThis`. A
  one-off has no series, so either scope deletes just the task, as the app
  does. `onlyThis` on an occurrence deletes it, and its date is never issued
  again.
- `series` on an occurrence deletes it wherever it is, and every occurrence
  of its series dated today or later, done or open, then ends the series
  yesterday. Earlier occurrences stay, with their `repeat`. A series that
  began today or later is deleted outright. `series` reads the user's time
  zone, so a deleted account's token gets `401 TOKEN_INVALID` there.
- The ledger keeps the task's entries, with `task_id` set to null and the title
  kept, so the dashboard doesn't change. A retry after a lost response is
  `404 NOT_FOUND`, and so is someone else's task. There is no user read, so a
  deleted account's token gets 404, as with `PATCH /tasks/{id}`. It does not
  read the session (decision 16).

## 6. Notifications (NTF)

Notifications are scheduled locally on the phone, so there is no push API.

| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/notifications/schedule` | `from`, `to` (at most 7 days) | `{ blockAlerts: [...], taskReminders: [...] }`. **Built.** See below. |

```jsonc
blockAlerts:   [{ "seriesId", "date", "name", "startAt": "YYYY-MM-DDTHH:mm", "openTaskCount" }] // skipped blocks excluded
taskReminders: [{ "taskId", "title", "remindAt": "YYYY-MM-DDTHH:mm" }]                          // open tasks only
```

The phone calls this on every app open and reschedules a rolling 7-day window
(NTF-04). Notification permission (asked / allowed) is state on the device and
is never sent to the server.

**Built** (decision 31):

- `from` and `to` are both included, at most 7 days, validated as `GET /days`
  validates its range: `to < from` or a longer span is `400 VALIDATION_FAILED`.
- **Block alerts** are the occurrences that **start** in the range, laid out
  as `GET /days` lays them out, so repeats, skips, deletions and an
  occurrence's own `alert` and times all apply. A midnight tail has no alert
  of its own. `openTaskCount` is the occurrence's `openCount`. Ordered by
  `startAt`, then name, then `seriesId`.
- **Task reminders** are the open tasks whose **reminder's own date** falls in
  the range, whatever date the task sits on, read through the partial index
  `idx_tasks_user_id_reminder_date`. Done and missed tasks are left out.
  Ordered by `remindAt`, then title, then `taskId`.
- Times already past today are included; the phone drops them when it
  schedules. A task carried forward keeps its old `reminderAt`, so a reminder
  on a past date is not scheduled again.
- **Repeating task reminders** (NTF-03): before the reminders are read, each
  series with a reminder issues the occurrences whose reminder falls in the
  range, even when the occurrence's own date doesn't (a reminder the evening
  before), so every reminder is a real task with an id (decision 37).
- It reads neither the session (decision 16) nor the user row, so a deleted
  account's token gets empty lists, as with `GET /days`.

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
| GET | `/review` | `from`, `to` (no cap) | `Review`. **Built.** See below. |

```jsonc
Review = {
  "from", "to",
  "completed", "incomplete",   // incomplete includes carried over and missed (DSH-02)
  "completionRate": number | null, // null when nothing was recorded (DSH-03)
  "byName": [{ "name", "minutes", "trace" }], // DSH-04, largest first
  "skippedMinutes",
  "coveredMinutes",
  "split": { "elapsedMinutes", "blockedMinutes", "skippedMinutes" }, // each minute counted once
  "mostCarried": [Task]        // top 5, DSH-05
}
```

Durations are whole minutes; the client divides by 60 to show hours. `name`
is the first spelling the period met, and `trace` is the chosen trace, or
`null` for the name's default, as on `BlockOccurrence`.

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

**Built.** Decision 32 records the rulings.

- **Range:** `from` and `to` are both included, with no cap; only `to < from`
  is `400 VALIDATION_FAILED`. Blocks are laid out only from `firstRecordedDay`
  to today (`DaysService.listBlocks`, which reads no task), so a request
  reaching back to 1900 costs no more than the account's age.
  `split.elapsedMinutes` still counts every passed minute of the range.
- **Now** is the user's local date and minute in their time zone (UTC before
  the device reports one), so the route reads the user: a deleted account's
  token gets `401 TOKEN_INVALID`. It does not read the session.
- **Split:** per day, the union of the blocks that happened is blocked, and
  the union of all blocks minus that is skipped. Each minute counts once.
- **Ledger:** one `count(*) FILTER` over `task_ledger_entries` by
  `idx_task_ledger_entries_user_id_day`. A deleted task's days still count.
- **`mostCarried`:** only tasks with `carryCount > 0`, as in the app. Ties go by
  title (lower-cased, by code unit), then id.

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
| 17 | `PATCH /me` with only `timeZone` needs no `version` and is last-write-wins, because it's a fact the device reports, not an edit. A `409 STALE_VERSION` carries the current resource in `error.meta.current`, the one object-valued `meta` key. A write that changes nothing doesn't bump `version`. |
| 18 | `DELETE /me` needs a live session, so a revoked device's access token can't delete the account. A retry after the account is gone gets `401 TOKEN_INVALID` rather than 204. The email's sign-in code row is deleted too. No re-authentication is required. Every user-owned table cascades from `users`, so the delete stays a single statement plus the email-keyed cleanup. |
| 19 | Idempotent creates use `INSERT … ON CONFLICT (user_id, idempotency_key) DO NOTHING` and then a select. A retry, even a concurrent one, gets the original with 201, and its body is not compared with the original's. The loser of a race waits for the winner's commit, so there is no in-progress case. A recurrence is stored with explicit days: the server fills in an empty `weekdays`/`monthDays` from the anchor date. |
| 20 | A series' anchor (the `date` it was created with) is an occurrence only if the recurrence lands on it, as in the app. `POST /blocks` returns the first real occurrence, and refuses with `422 BLOCK_NO_OCCURRENCE` a series that would have none. |
| 21 | `GET /days` expands recurrences in memory from one query per request, and the range form ships with the single-day form. A block's midnight tail is listed on the following day with its start `date`. |
| 22 | Until the day-end job keeps a record of the last day it closed, a day is closed once it is before today in the user's time zone (UTC before the device reports one). Closed-day carry is computed on the write: the task lands on today's general list, and the ledger gets one `incomplete` row per day it passed through, written with `generate_series`, so even a date decades back is one statement. |
| 23 | `POST /tasks` shipped with one-offs only. A repeat the rules allow answers `501 NOT_IMPLEMENTED`, not `REPEAT_NOT_ALLOWED`, so that code keeps one meaning: the repeat doesn't fit where the task sits. Superseded by decision 35: the 501 is gone. |
| 24 | `PATCH /tasks/{id}/done` carries no `version` and is last-write-wins, since `done` is an absolute value. The `completed` ledger entry is written on the tick itself, not when the day closes, matching the app. Reopening on a closed day carries the task at once (decision 2). |
| 25 | Renaming a task renames its ledger entries too, past days included, so the history shows the task's current title. This departs from the app, which keeps the title each entry was written with. `PATCH /tasks/{id}` reads no user row, so a deleted account's token gets 404 there. |
| 26 | `POST /tasks/{id}/move` carries no `version` and is last-write-wins, like `/done`. A done task's `completed` entry moves with it. An open task moved onto a closed day carries forward at once (decision 2). A closed day that already recorded the task keeps its entry (`ON CONFLICT DO NOTHING`), and `carryCount` counts the carry again. `DELETE /tasks/{id}` ignores `scope` for a one-off, as the app does, and gets 404 on a retry. |
| 27 | Block-name traces live in `block_name_traces`, keyed by the name trimmed and lower-cased in JavaScript, with no `version`. The server ports the app's default-trace hash (32-bit FNV-1a over UTF-16 code units, modulo the app's 9 traces; `src/block-names/block-name.ts`), so choosing the default deletes the row, as the app's `chooseTraceForName` does. A name whose default is `open` keeps any choice once made, as in the app. `PUT` is kept over the `PATCH` that adding-a-feature §4.4 prefers, since each request replaces the whole resource. JavaScript and Dart lower-case a few characters differently; that is accepted. `GET /block-names` counts every series, ended ones included. |
| 28 | A per-occurrence change lives in `block_occurrence_exceptions`, one row per series and start date, keyed `(block_series_id, date)`, which holds `skipped`, `deleted` and an occurrence's overrides. Un-skipping clears `skipped` and keeps the row. Skip and un-skip are their own module (`src/block-occurrences/`), since skipping moves tasks and `TasksModule` already imports `BlocksModule`. `POST …/skip` answers 200, since it is an action rather than a create. Skipping a closed day's occurrence carries its open tasks to today, as `/move` does (decision 26), rather than leaving them on the closed day as the app would. |
| 29 | Deleting a block occurrence marks it `deleted` in `block_occurrence_exceptions`, for good. `scope=series` deletes every occurrence from today on **and the occurrence named, even a past one**, so the block the user tapped always goes; this departs from the app, which ends the series the day before the named occurrence. A deleted occurrence's open tasks on a closed day carry forward to today, as skip's do (decision 28). A deleted occurrence is `404 NOT_FOUND` wherever it is named, while a date the rule never lands on stays `422 BLOCK_NOT_ON_DATE`. A series with nothing left before today is deleted rather than ended. |
| 30 | `PATCH /blocks/{seriesId}/occurrences/{date}` checks the series' one `version`, and an `onlyThis` override bumps it, so another device's edit to a different occurrence of the same series gets a 409 and refetches; there is no version per occurrence. Editing the first occurrence with `thisAndFuture` edits the series in place, as the app does. Tasks in occurrences a new rule drops move to their own day's general list (BLK-10) rather than being orphaned as in the app. Moving the first occurrence to a date its rule doesn't land on is `422 BLOCK_NOT_ON_DATE`, not a re-derived rule. `newDate` with `thisAndFuture` past the first occurrence is `400`. A block moved onto a closed day carries its open tasks to today (decision 26). |
| 31 | `GET /notifications/schedule` builds block alerts from `DaysService.list`, so an alert follows everything the Day screen shows, and reads task reminders by the reminder's own date through a partial index on open tasks. It returns the whole window, times already past included, and leaves dropping those to the phone, so the server needs no notion of "now" here. A midnight tail has no alert. Missed tasks are left out. |
| 32 | `GET /review` has no range cap, since the UI's custom range reaches back to `firstRecordedDay`. It lays blocks out only from `firstRecordedDay` to today, which leaves the result unchanged, because an occurrence moved on its own becomes a one-off series anchored on its new date. Durations are whole minutes on the wire rather than float hours. `mostCarried` ranks only tasks carried at least once, as the app does. `Profile.firstRecordedDay` and `hasAnyRecord` are real from this slice on, on every `Profile` the API returns. |
| 33 | `POST /auth/google` links by the verified email only: no identities table, and Google's `sub` isn't stored, so a Google account whose email changes opens a new Pebble account, as an email change would with email sign-in. Google's name fills `users.name` only while it is null. A token Google didn't issue for us, or one with an unverified email, is `401 ID_TOKEN_INVALID`, apart from `TOKEN_INVALID` because the client's next step is to try Google again, not to sign in again; Apple will use it too. `GOOGLE_CLIENT_IDS` is optional outside production, and the route is a 503 without it. Tokens are checked with `jsonwebtoken` against Google's JWKS, fetched with Node's `fetch` and cached for its `max-age`; `jose` 6 is ESM-only and Jest here runs CommonJS. A `kid` the cache lacks refetches at most once in 5 minutes, since the sender chooses the `kid`. |
| 34 | `POST /auth/apple` links by the verified email only, as Google does (decision 33), and shares its verifier (`src/auth/id-tokens/`). The authorization code must be exchanged for a sign-in to succeed, so every Apple account has a refresh token to revoke. That token is stored as Apple sent it in `apple_grants`, not encrypted: revoking needs the token itself, and without our Apple private key it can only revoke the grant or mint Apple ID tokens for our app. `DELETE /me` revokes it after the delete commits, and the answer doesn't depend on the revoke: a failed revoke is logged, and the account stays deleted, so deletion never depends on Apple being up. iOS only: no Services ID, so no web or Android flow and no `redirect_uri`. No `nonce` check, as with Google. Apple's server-to-server notifications (a user revoking the app from their Apple ID settings) are not handled. The four `APPLE_` settings are all-or-none, the private key is checked to be a P-256 PEM at boot, and production refuses to start without them. |
| 35 | Task series live in `task_series`, with each occurrence a row in `tasks` (`task_series_id`). Occurrences are **issued as their dates are read**: `GET /days` writes any occurrence in its range not yet issued, closed days included, before reading the tasks. `task_series_issued_dates` holds one row per series and date, and its key makes issuing idempotent and race-safe (one `INSERT … ON CONFLICT DO NOTHING` feeding the task insert), so an occurrence that is moved, split off or deleted never comes back. A closed day's issued occurrence stays open for the day-end job to settle. A repeating task created on a closed day is settled itself (carried, or missed by REC-06: on the day before its series' next occurrence), but its series' other closed-day occurrences are not issued and settled on the spot as the app does; they appear open when those days are read. A series in a block lands on the block's occurrences that aren't deleted, skipped ones included, as in the app. Reopening a missed task leaves it missed. |
| 36 | Editing an occurrence of a repeating task follows the app: title and reminder reach the series and its later **open** occurrences, notes reach every occurrence, and turning the repeat off stops the series at this occurrence and deletes its later open copies, keeping done ones as one-offs. A changed own rule ends the old series here and starts a new one from this occurrence, with the done later copies' dates marked issued so they aren't doubled. `/move` splits an occurrence off as a one-off. `DELETE ?scope=series` deletes the named occurrence and every one from today on, and ends the series yesterday, or deletes it if it began today or later. The task row is locked before its series row. `PATCH` with the `Recurrence` exactly as it came back (`monthDays: []` on a weekly one) is still `400`, as for blocks. |
| 37 | Tasks repeating with a block follow it, as in the app. A split ends each such series the day before and starts a copy on the new block from the split date, knowing the dates it already issued; one begun on or after that date moves across whole. A head move re-anchors the series anchored there. A block that stops repeating deletes its task series, making their tasks one-offs. Deleting a block from today on ends its task series yesterday and deletes their open copies from today on. Every task that skip, delete, a dropped occurrence or a move-one moves splits off as a one-off. An occurrence a block edit returns has its tasks issued first. `/notifications/schedule` issues each series over the dates its reminders in the window belong to. The block series is locked, then its tasks, then their task series, matching the task routes' task-then-series order. |

## 11. Error codes to add

Append these to `src/core/http/error-code.ts`:

| Code | Status | When |
|---|---|---|
| `STALE_VERSION` | 409 | A `PATCH` carried an old `version`. The current resource is in `error.meta.current`. **Added** (`PATCH /me`). |
| `CODE_INVALID` | 400 | Wrong sign-in code. `error.meta.attemptsLeft`. **Added.** |
| `CODE_EXPIRED` | 410 | The sign-in code is more than 10 minutes old, already used, or was never sent. **Added.** |
| `CODE_ATTEMPTS_EXHAUSTED` | 429 | 5 wrong attempts. The user must request a new code. **Added.** |
| `TOKEN_INVALID` | 401 | The access token or refresh token is bad, expired, revoked or reused. **Added** (refresh, auth guard). |
| `BLOCK_TOO_SHORT` | 422 | BLK-05. **Added** (`POST /blocks`). `BLOCK_TOO_LONG` was dropped: minute-of-day start and end can't describe more than 24 hours. |
| `BLOCK_NO_OCCURRENCE` | 422 | A repeating block whose `until` comes before the first day its rule lands on. **Added** (`POST /blocks`, decision 20). |
| `REPEAT_NOT_ALLOWED` | 422 | `repeatWithBlock` on a general-list task or with a block that doesn't repeat, or `recurrence` on a task in a block. **Added** (`POST /tasks`). |
| `BLOCK_NOT_ON_DATE` | 422 | A task put in a block on a date the block doesn't fall on. **Added** (`POST /tasks`). |
| `ID_TOKEN_INVALID` | 401 | A Google or Apple ID token with a bad signature, another app's audience, the wrong issuer, an expired `exp`, or an unverified email; or an Apple authorization code Apple refuses. **Added** (`POST /auth/google`, `POST /auth/apple`). |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | A retried create whose original request hasn't finished yet. **Not needed so far:** a create that inserts in one statement never exposes an unfinished original (decision 19). Add it only for a create that holds its insert open inside a longer transaction. |

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
- scheduling local notifications from `/notifications/schedule`, dropping
  times already past
- passing Sign in with Apple's `authorizationCode`, and `fullName` whenever
  Apple provides it, to `POST /auth/apple`
- reading `/review` durations as minutes (`minutes`, `skippedMinutes`,
  `coveredMinutes`) and dividing by 60 for display

## 13. Still to set up (not blocking)

- A transactional email provider for sign-in codes. Until then `MAILER=log` writes
  codes to the log, and the service refuses to start with it in production.
- Google OAuth client IDs for iOS, Android and web, set as `GOOGLE_CLIENT_IDS`.
  Until then `POST /auth/google` answers 503.
- Apple: the bundle ID(s), Team ID, and a Sign in with Apple key's ID and `.p8`
  file, set as `APPLE_CLIENT_IDS`, `APPLE_TEAM_ID`, `APPLE_KEY_ID` and
  `APPLE_PRIVATE_KEY`. Until then `POST /auth/apple` answers 503. A Services ID
  and its `redirect_uri` are needed only if Android or web gets Apple sign-in.
- The day-end job runner, one run per user's local midnight, safe with several
  instances running at once.
