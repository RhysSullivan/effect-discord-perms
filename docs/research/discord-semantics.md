# Discord platform semantics as testable hypotheses

This is phase-0 research for effect-discord-perms. Every statement here is a
**hypothesis** that the live matrix will confirm or refute. Docs are the
starting point. Live Discord is the source of truth (PROMPT.md). Nothing here
was checked against live Discord, and no request reached discord.com/api.

Date: 2026-11-01.

## 0. Sources and conventions

| Key | Source | Version |
|-----|--------|---------|
| P | `developers/topics/permissions.mdx` | discord-api-docs `9d2128bb` (2026-10-30) |
| CH | `developers/resources/channel.mdx` | same |
| MSG | `developers/resources/message.mdx` | same |
| TH | `developers/topics/threads.mdx` | same |
| G | `developers/resources/guild.mdx` | same |
| OPC | `developers/topics/opcodes-and-status-codes.mdx` | same |
| REF | `developers/reference.mdx` | same |
| GW | `developers/events/gateway.mdx` | same |
| GWE | `developers/events/gateway-events.mdx` | same |
| PRIV | `developers/gateway/you-might-not-need-a-privileged-intent.mdx` | same |
| IR | `developers/interactions/receiving-and-responding.mdx` | same |
| AC | `developers/interactions/application-commands.mdx` | same |
| CMP | `developers/components/reference.mdx` | same |
| POLL | `developers/resources/poll.mdx` | same |
| WH | `developers/resources/webhook.mdx` | same |
| EMO | `developers/resources/emoji.mdx` | same |
| RL | `developers/topics/rate-limits.mdx` | same |
| OAUTH | `developers/topics/oauth2.mdx` | same |
| CL yyyy-mm-dd | `developers/change-log.mdx`, entry with that date | same |
| OAS | `discord/discord-api-spec` `specs/openapi.json` (v10) | `4e75626a` (2026-10-29) |
| DAT | `discord-api-types` 0.38.57 in `node_modules` (enum values compiled, see Appendix A) | 0.38.57 |
| DFX | `dfx` 1.1.1 TypeScript source in `node_modules/dfx/src` | 1.1.1 |
| MEM | Recollection from prior experience. **UNVERIFIED.** Used only where the docs are silent and the matrix needs a prediction. | n/a |

The docs repo keeps its pages under `developers/**.mdx` at the repo root, not
under `docs/`. The published site is `https://docs.discord.com/developers/...`.
`https://discord.com/developers/docs/topics/permissions` redirects there with
HTTP 200. I spot-checked the published permissions page: it contains the same
sentences as the repo (timeouts, implicit permissions, the Nov 16 2026 warning,
PIN_MESSAGES, BYPASS_SLOWMODE). Discord's Time Out FAQ on support.discord.com
returned 403 to both curl and WebFetch, so none of its claims are used.

Each hypothesis has an id (`H-nnn`). Section 16 lists all of them with a
suggested live test. Tags in the test column:

- `[resolver-only]`: no safe live test exists. Examples: kicking or banning
  bots (forbidden), the owner, or limits too expensive to reach.
- `[human]`: needs a human (Rhys, phase 3 checklist).
- `[other-guild]`: needs a second guild, which the hard constraints forbid.
- `[offline]`: checked by compiling against local packages.

Scratch code is in `.scratch/discord-semantics/` (git-ignored). Appendix A
shows the compiled snippets and their output.

---

## 1. Time-sensitive platform changes (read first)

These changed recently or will change during the project. Several contradict
assumptions common in libraries.

1. **Channel obfuscation becomes mandatory on November 16, 2026**, which is
   15 days from now (CL 2026-08-12, P "Channel Visibility", CH "Obfuscated
   Channels").
   - **Gateway:** a channel the bot cannot view still arrives, but with
     `name: "___hidden___"` and the `CHANNEL_OBFUSCATED` flag (`1 << 17`).
     Its `permission_overwrites` are replaced by **a single fake overwrite
     that denies VIEW_CHANNEL to @everyone**. Only `id`, `type`, `position`
     and `parent_id` are reliable.
   - **HTTP:** `GET /guilds/{id}/channels` omits such channels entirely.
   - **Gaining access:** the bot receives a `CHANNEL_UPDATE` with the real
     data, plus one for the parent category if that was hidden too.
   - **Interactions:** interaction payloads are not obfuscated.
   - **Opting in early:** until Nov 16, bots opt in with Identify
     `capabilities: 1 << 15` or a dev-portal toggle. **dfx 1.1.1 does not send
     `capabilities`.** Its identify payload in DFX
     `DiscordGateway/Shard.ts` contains only `token`, `shard`, `intents` and
     `presence`. So the portal toggle is the only way to opt in early.
   - **Impact:** the resolver must treat an obfuscated channel as missing
     ViewChannel and must never evaluate its fake overwrites as real data. A
     truth table recorded before Nov 16 and one recorded after can differ for
     every scenario that denies ViewChannel. (H-160, H-161)
2. **New permission oracle endpoints (published 2026-10-30)** (CL 2026-10-30,
   CH, G, OAS):
   - `GET /channels/{c}/permissions/member/{u}` and
     `GET /channels/{c}/permissions/role/{r}`. Both take `?implicit=`, default
     `true`. Both require VIEW_CHANNEL, plus CONNECT for voice and stage
     channels. Threads use their parent's overwrites.
   - `GET /guilds/{g}/permissions/member/{u}` and
     `GET /guilds/{g}/permissions/role/{r}`.
   - Implicit masking covers **only** missing VIEW_CHANNEL and missing
     voice/stage CONNECT. It is **not applied when the target member is a bot**
     (CH).
   - Neither dfx 1.1.1 nor discord-api-types 0.38.57 knows these routes
     (`grep` finds no `permissions/member` in DFX `DiscordREST/Generated.ts`
     or in DAT `rest/v10`). OAS includes all four.
   - The harness can use them as a second oracle, computed by Discord, for
     the resolver's base and overwrite steps (H-240 to H-243).
3. **Permission splits are now enforced** (CL 2026-02-10, CL 2025-11-24,
   CL 2025-08-20).
   - **PIN_MESSAGES** (`1 << 51`) is required to pin and unpin. MANAGE_MESSAGES
     alone is no longer enough. The changelog gives two cutoff dates,
     2026-01-12 in CL 2025-08-20 and 2026-02-23 in CL 2026-02-10. Both have
     passed.
   - **BYPASS_SLOWMODE** (`1 << 52`) was split from MANAGE_MESSAGES,
     MANAGE_CHANNELS and MANAGE_THREADS. The changelog states that **bots are
     not affected by slowmode at all**. CH's `rate_limit_per_user` field says
     the same: "bots, as well as users with the permission BYPASS_SLOWMODE,
     are unaffected".
   - **CREATE_GUILD_EXPRESSIONS and CREATE_EVENTS** are now required for bots
     to create expressions and events.
4. **The context menu command limit is now 15 per type**, up from 5
   (CL 2026-03-03, AC).
5. **The default upload limit is now 20 MiB per file** (CL 2026-09-03, REF).
6. **Message forwarding requires readable content.** Forwarding a message the
   app cannot read fails with 160014 (CL 2026-04-14, MSG).
7. **Resolved channels in interactions include `app_permissions`**
   (CL 2026-07-16).

---

## 2. Permission computation

### 2.1 Documented algorithm (P "Permission Overwrites", pseudocode)

```
base(member):
  if member is guild owner: ALL
  p = @everyone.permissions | OR(role.permissions for role in member.roles)
  if p has ADMINISTRATOR: ALL
  return p

overwrites(base, member, channel):
  if base has ADMINISTRATOR: ALL
  p = base
  if @everyone overwrite: p = (p & ~ow.deny) | ow.allow
  allow = OR(role ow.allow for member's roles); deny = OR(role ow.deny ...)
  p = (p & ~deny) | allow
  if member overwrite: p = (p & ~ow.deny) | ow.allow
```

Hypotheses this produces:

- **Base permissions (H-001):** @everyone OR all of the member's role
  permissions.
- **Owner (H-002):** the guild owner gets ALL.
- **Administrator (H-003):** ADMINISTRATOR anywhere in the base gives ALL and
  bypasses every overwrite.
- **@everyone overwrite (H-005):** applied first, deny before allow.
- **Role overwrites (H-006):** aggregated, so a role allow beats a role deny
  regardless of role position. P gives the "#coolstuff" example.
- **Role over @everyone (H-007):** role overwrites beat the @everyone
  overwrite.
- **Member overwrite (H-008):** applied last, so it beats role overwrites.
- **Order and position (H-009, H-010):** neither the overwrite array order
  nor role positions matter.

Two hypotheses come from what the pseudocode leaves out:

- **H-004:** an ADMINISTRATOR bit inside a channel overwrite grants nothing,
  because ADMINISTRATOR is only tested on `base`. Whether the API accepts the
  bit at all is UNVERIFIED.
- **H-011:** an overwrite for a role the member does not have contributes
  nothing.

A literal transcription is in `.scratch/discord-semantics/src/resolver.ts`
(Appendix A.2). It type-checks under the project's strict tsconfig.

### 2.2 dfx's helper disagrees with the docs (verified by running it)

DFX `Helpers/permissions.ts` `forChannel` and `applyOverwrites` walk
`permission_overwrites` **in array order** and apply `(p & ~deny) | allow` for
each overwrite in turn. I ran dfx's `forChannel` against the transcription
(`bun .scratch/discord-semantics/src/compare.ts`):

```
role B allow listed before role A deny: documented=true dfx=false
member deny listed before @everyone allow: documented=false dfx=true
```

Reading the source shows more gaps:

- It has no owner check.
- `hasInGuild` checks whether **any of the member's roles** has the bit. It
  ignores @everyone and ADMINISTRATOR.
- It finds @everyone by `name === "@everyone"`, not by `id === guild_id`.
- It has no implicit-permission handling and no timeout handling.
- When the member has a `permissions` field (the interaction payload), it
  returns that field directly.

Conclusion: the project resolver must not reuse dfx's `forChannel`. H-006,
H-008 and H-009 are exactly where dfx and the docs disagree. The live matrix
should include overwrite orderings that separate them.

### 2.3 Fields that carry computed permissions

| Field | Includes overwrites? | Includes implicit? | Includes timeout? | Source |
|---|---|---|---|---|
| Interaction `app_permissions` | yes | **no** for the resolved-channel field: CH says it "does not include implicit permissions". IR says nothing for the top-level field. | open (H-026) | IR, CH, CL 2022-06-29 |
| Interaction `member.permissions` | yes ("total permissions of the member in the channel, including overwrites") | not stated | open | G "Guild Member Object" |
| Resolved channel `permissions` / `app_permissions` | yes | no | open | CH |
| `GET /users/@me/guilds` `permissions` | no ("excludes overwrites and implicit permissions") | no | no | G |
| `GET /channels/{c}/permissions/member/{u}` | yes | View/Connect masking only, on by default, **never for bot targets** | open (H-241) | CH |

In DMs, `app_permissions` includes `ATTACH_FILES | EMBED_LINKS |
MENTION_EVERYONE`, plus `USE_EXTERNAL_EMOJIS` in the bot's own DM (IR,
footnote ***). (H-230)

---

## 3. Implicit permissions (P "Implicit Permissions")

- **No VIEW_CHANNEL (H-012):** every other channel permission is ignored.
  The docs: "Though permissions like SEND_MESSAGES are not explicitly denied
  for the user, they are ignored."
- **No SEND_MESSAGES (H-013):** `MENTION_EVERYONE`, `SEND_TTS_MESSAGES`,
  `ATTACH_FILES` and `EMBED_LINKS` are implicitly denied.
  - The docs list exactly these four. They do **not** list
    USE_EXTERNAL_EMOJIS, USE_EXTERNAL_STICKERS, SEND_POLLS,
    SEND_VOICE_MESSAGES, ADD_REACTIONS, CREATE_*_THREADS or
    SEND_MESSAGES_IN_THREADS.
  - Open (H-014): does missing SEND_MESSAGES in the parent mask payload
    permissions inside its threads?
- **No CONNECT in voice or stage (H-015):** other permissions are implicitly
  denied, "such as MANAGE_CHANNELS".
  - Exception: a user already connected can still set the voice status with
    SET_VOICE_CHANNEL_STATUS (CL 2026-10-29).
  - The full masked set is undocumented. The voice-channel read endpoints
    require CONNECT (MSG "Get Channel Messages", "Get Channel Message"), which
    suggests the same rule covers voice text chat.
- **Other cases (H-016):** the docs admit the list is incomplete ("There may
  be other cases"). Each case the matrix finds goes into LOG.md.
- **Discord's own masking (H-017):** `implicit=true` on the role endpoint
  covers **only** VIEW_CHANNEL and voice/stage CONNECT, not the four bits
  under SEND_MESSAGES (CH query-param description).
  - So the SEND_MESSAGES rule, if it is real, is enforced by the action
    endpoints and not by the permission endpoints.
  - The matrix can measure Discord's exact mask by calling
    `GET /channels/{c}/permissions/role/{r}?implicit=true|false` for a role
    denied VIEW_CHANNEL or CONNECT.
- **Category visibility (H-018):** a category "is viewable if any of their
  child channels are viewable" (P "Channel Visibility", CH). This governs
  obfuscation and `GET /guilds/{id}/channels`.

---

## 4. Timeouts

- **H-020:** a timed-out member keeps only `VIEW_CHANNEL` and
  `READ_MESSAGE_HISTORY` (P "Permissions For Timed Out Members"). The
  MODERATE_MEMBERS description says timeouts prevent "sending or reacting to
  messages in chat and threads, and from speaking in voice and stage
  channels".
- **H-021:** owners and ADMINISTRATOR holders are exempt (P). Setting
  `communication_disabled_until` on an admin or the owner "will throw a 403
  error" (G "Modify Guild Member").
- **H-022:** bots can be timed out. This is **not documented**, but the
  matrix depends on it: PROMPT.md lists "member state: normal, timed out" for
  the subject. UNVERIFIED.
- **H-023:** a timed-out bot that sends gets **50013** with HTTP 403. There is
  no special code: no OPC code names timeouts.
  - If this holds, `CommunicationDisabled` must be attributed from cached
    member state (`communication_disabled_until > now`) during the 50013
    recompute, not from the error code.
  - MEM, UNVERIFIED.
- **H-024:** a timed-out bot cannot add reactions (50013).
- **H-025:** a timeout can be set at most 28 days ahead (G). Expect 50035
  beyond that.
- **H-026:** open: do `app_permissions` and the new permission endpoints
  reflect the timeout mask? Not documented.
- **H-027:** open: can a timed-out bot still answer interactions? Interaction
  responses do not need SEND_MESSAGES (§14). `[human]`
- **H-028:** a timeout requires MODERATE_MEMBERS (G).
  - Whether the role hierarchy applies to timeouts is **not documented**: P's
    hierarchy list names only kick, ban and nickname.
  - MEM says it does. UNVERIFIED.
- **H-029:** the timeout mask is applied after overwrites. A member overwrite
  that allows SEND_MESSAGES does not let a timed-out member send.

---

## 5. Threads

Sources: P "Inherited Permissions (Threads)", TH, CH.

**Inheritance and access**

- **H-030:** a thread's permissions are the parent channel's, computed with
  the parent's overwrites. The new endpoint says the same: "Threads use their
  parent channel's overwrites".
- **H-031:** SEND_MESSAGES does nothing in threads. SEND_MESSAGES_IN_THREADS
  (SMIT) is required (P, TH warning).
  - Test both directions: SEND allowed with SMIT denied fails, and SEND
    denied with SMIT allowed succeeds.
  - Forum and media posts are the exception: creating a post needs **only
    SEND_MESSAGES** (CH "Start Thread in Forum or Media Channel":
    "CREATE_PUBLIC_THREADS is ignored"; TH "Forums").
- **H-032:** VIEW_CHANNEL on the parent is required to see any thread, even
  for a member who was added or mentioned (P).
- **H-033:** a private thread is visible only to its members and to holders
  of MANAGE_THREADS (CH channel types, TH). Which error a non-member without
  MANAGE_THREADS gets (50001 or 10003) is undocumented.
- **H-047:** MANAGE_THREADS lets the holder view all private threads (P bit
  description).
- **H-048:** a member who loses access to the parent keeps thread membership
  but stops receiving events (TH "Losing Access to Channels").

**Sending, locked and archived state**

- **H-034:** sending a message auto-joins the sender to the thread (CH example
  thread channel).
- **H-035:** sending in an archived, unlocked thread unarchives it (CH; TH:
  "unless the thread has been locked by a moderator").
- **H-036:** in a locked thread, a member without MANAGE_THREADS "won't be
  able to create or update messages" or change the title or tags (TH "Locked
  Threads", CL 2023-02-10).
  - Expected code: **160005** "Thread is locked" (OPC).
  - With MANAGE_THREADS, the same actions succeed.
- **H-037:** in an archived thread, editing messages, adding reactions,
  joining and using application commands fail, while deleting messages works
  (TH).
  - Expected code: **50083** (OPC: "editing a message or adding a user to the
    thread").

**Unarchiving: the docs conflict**

- **H-038:** for setting `archived:false`:
  - CH "Modify Channel (Thread)": when `locked` is also false, it "only
    [requires] the SEND_MESSAGES permission".
  - TH "Editing & Deleting Threads": it "only requires the current user has
    already been added to the thread".
- **H-039:** for unarchiving a locked thread:
  - CH thread metadata: "only users with MANAGE_THREADS can unarchive it".
  - TH: "the user must have created the thread or have MANAGE_THREADS".

**Creating threads**

- **H-040:** starting a public thread from a message requires
  CREATE_PUBLIC_THREADS. The endpoint text in CH names no permission. The bit
  description in P does ("creating public and announcement threads").
- **H-041:** private threads require CREATE_PRIVATE_THREADS and exist only in
  GUILD_TEXT (TH). Trying in an announcement channel fails with an
  undocumented code.
- **H-042:** `POST /channels/{id}/threads` without `type` creates a
  **PRIVATE_THREAD** (CH footnote). The library must always send `type`.
- **H-043:** a thread started from a message gets the message's id. A second
  thread on the same message fails with **160004** (CH, OPC).
- **H-044:** in a forum or media channel with `REQUIRE_TAG`, a post without
  `applied_tags` fails with **40067**. If no tags can be set by
  non-moderators, the code is 40066 (OPC, CH flags).

**Managing threads**

- **H-045:** deleting a thread requires MANAGE_THREADS (CH, TH). Changing
  name, archived or auto_archive_duration requires MANAGE_THREADS or being
  the creator. Changing rate_limit_per_user or locked requires MANAGE_THREADS
  (TH).
- **H-046:** adding a member requires "the ability to send messages in the
  thread" and an unarchived thread. Removing a member requires MANAGE_THREADS
  or being the creator of the private thread. Join and leave require an
  unarchived thread (CH).

---

## 6. Newer and split permission bits

- **H-050:** pinning and unpinning require PIN_MESSAGES. MANAGE_MESSAGES
  alone fails (§1.3; MSG "Pin Message").
- **H-051:** a channel holds at most 250 pins (**30003**, OPC).
  `[resolver-only]`, because reaching the limit costs too much.
- **H-052:** pinning a message from another channel fails with **50019**
  (OPC). Pinning a system message probably fails with **50021** (UNVERIFIED).
- **H-053:** bots ignore slowmode, so a bot without BYPASS_SLOWMODE never gets
  20016 (CH `rate_limit_per_user`, CL 2026-02-10). If this holds, the PROMPT's
  `SlowmodeActive` tag never fires for bot sends. It might still matter for
  other users, or for 20028 channel write limits (§8).
- **H-054:** `rate_limit_per_user` applies to "Text, Voice, Stage, Forum,
  Media", **not Announcement** (CH "Modify Channel" table; G "Create Guild
  Channel").
- **H-055:** SEND_POLLS is required to send a poll (P). The failure code is
  undocumented; the guess is 50013.
- **H-056:** SEND_VOICE_MESSAGES is required for `IS_VOICE_MESSAGE` (P). The
  failure may be **50173** "You cannot send voice messages in this channel"
  rather than 50013 (OPC).
- **H-057:** USE_EXTERNAL_APPS only affects user-installed apps that are not
  also installed in the server. Without it, their responses become ephemeral
  (P). It is never required for a server-installed bot.
- **H-058:** creating emoji or stickers needs CREATE_GUILD_EXPRESSIONS, and
  creating events needs CREATE_EVENTS (CL 2026-02-10).
- **H-059 `[offline]`:** discord-api-types 0.38.57 matches every documented
  bit (Appendix A.1).
  - Bit 47 is unassigned.
  - `ManageEmojisAndStickers` is a deprecated alias equal to
    `ManageGuildExpressions` (`1 << 30`). Generated error classes must
    de-duplicate it.
  - PIN_MESSAGES does **not** carry the 2FA asterisk in P's table. These do:
    MANAGE_MESSAGES, MANAGE_THREADS, MANAGE_CHANNELS, MANAGE_ROLES, KICK, BAN
    and ADMINISTRATOR.

---

## 7. Role hierarchy (P "Permission Hierarchy", G)

A member's highest role is the one with the greatest `position`. @everyone is
position 0, and ties are broken by id (P role object).

- **H-060:** a bot can assign only roles positioned below its own highest
  role. Otherwise it gets 50013.
- **H-061:** assigning a role does not depend on the target member's own
  highest role, only on the role's position. Not stated outright in the docs.
  UNVERIFIED.
- **H-062:** a bot can edit only roles below its highest role, and can grant
  only permissions it has itself.
- **H-063:** a bot can reorder only roles below its highest role.
- **H-064:** a bot can kick, ban and set nicknames only for members whose
  highest role is strictly lower than its own. An equal position fails.
  - Only the expected-failure kick and ban cases may run live. Successful
    kicks and bans stay `[resolver-only]` (PROMPT hard constraint).
  - The nickname cases can run live in both directions.
- **H-065:** the owner cannot be kicked, banned, renamed or timed out by a
  bot. `[resolver-only]`: the owner is Rhys, and he must not be touched.
- **H-066:** timeouts follow the same hierarchy as kicks (see H-028).
  UNVERIFIED.
- **H-067:** an ADMINISTRATOR target blocks timeouts (403, documented). It
  does **not** block nickname, kick or ban when the hierarchy allows them.
  Not documented, UNVERIFIED. Only the nickname case is safe to test live.
- **H-068:** managed roles (bot integration roles, the booster role) cannot be
  assigned or removed through the API. The error code is UNVERIFIED (MEM:
  50013).
- **H-069:** a bot changing its own nickname needs CHANGE_NICKNAME, with no
  hierarchy check (G "Modify Current Member").
- **H-070:** editing overwrites requires MANAGE_ROLES. The bot can allow or
  deny only permissions it has "in the guild or parent channel", unless it has
  a MANAGE_ROLES overwrite in that channel (CH "Edit Channel Permissions",
  "Modify Channel").
- **H-071:** only guild administrators can set MANAGE_ROLES in overwrites when
  creating a channel (G "Create Guild Channel").
- **H-072:** in a guild with `mfa_level = 1`, the starred permissions require
  the **bot owner's** account to have 2FA, or the request fails with
  **60003** (OAUTH "Two-Factor Authentication Requirement", OPC). The harness
  should record Perms Lab's `mfa_level` in the truth-table header.
- **H-073 (harness note):** the subject bot got a **managed role** when it
  joined. That role's position counts in every hierarchy comparison, so the
  harness must place test roles relative to it on purpose.

---

## 8. Error codes and HTTP statuses

### 8.1 Status mapping

OPC lists the codes without HTTP statuses. OAS maps every error to a generic
`4XX` with `ErrorResponse`. Statuses are documented only in these places:

- 400 for invalid Modify Channel parameters (CH).
- 400 for Components V2 conflicts (MSG, WH).
- 400 for bulk delete with messages older than two weeks or duplicate ids
  (MSG).
- "Bad Request" for broken embed limits (MSG "Embed Limits").
- 403 for timing out an admin or the owner (G).
- 400 for mute or deafen on a member who is not in voice (G).
- 429 for rate limits, with an optional `code` field (RL).

Everything else in the table below is **MEM and UNVERIFIED**. The matrix
should record `(http status, json code)` pairs, and the error schema should
key on both (H-082).

| Code | Meaning (OPC) | Expected status | Library tag candidate | Notes |
|---|---|---|---|---|
| 10003 / 10008 / 10007 / 10011 / 10014 / 10062 | Unknown channel / message / member / role / emoji / interaction | 404 (MEM) | `Unknown*`, `InteractionExpired` (10062) | 10062 also arrives when the 3 s deadline was missed (IR) |
| 20016 | Slowmode rate limit | 429 with `code` (MEM) | `SlowmodeActive` | Bots should never see it (H-053) |
| 20022 | Announcement edit rate limit | 429? | transient | |
| 20028 | Channel write rate limit | 429 with `code` (MEM) | transient | |
| 30003 / 30010 / 30015 / 30032 / 30034 / 30046 / 30047 / 30048 | Limits: pins, reactions, attachments, commands, daily command creates, edits of old messages, pinned threads, tags | 400 (MEM); 30034 and 30046 may be 429 | `*LimitReached` | |
| 40033 | Already crossposted | 400 (MEM) | state | |
| 40058 | Cannot send a message in a forum channel | 400 (MEM) | should be a compile error | |
| 40060 | Interaction already acknowledged | 400 (MEM) | state machine | |
| 40066 / 40067 | No tags available / tag required | 400 (MEM) | payload | |
| 40094 | Follow-up limit | 400 (MEM) | | Only for user-install-only interactions (IR) |
| 50001 | Missing access | 403 (MEM) | `MissingViewChannel` or unattributed | H-080 |
| 50003 | Action on a DM channel | 403? | compile error | |
| 50005 | Edit another user's message | 403 (MEM) | compile error | |
| 50006 | Empty message | 400 (MEM) | compile error | |
| 50007 | Cannot send messages to this user | 403 (MEM) | state | Bot-to-bot DMs (H-158) |
| 50008 | Non-text channel | 400 (MEM) | compile error | |
| 50013 | Missing permissions | 403 (MEM) | recompute, then `Missing*` or `PermissionDeniedUnattributed` | H-081 |
| 50016 | Bulk delete count out of range | 400 | payload | |
| 50019 / 50021 | Pin across channels / action on a system message | 400 (MEM) | state | |
| 50024 | Action not allowed on this channel type | 400 or 403 (MEM) | compile error | |
| 50034 | Message too old to bulk delete | 400 (doc) | `MessagesTooOld` | |
| 50035 | Invalid form body | 400 | `ContentTooLong`, `EmbedTooLarge`, ... from the inner tree | H-084 |
| 50074 | Cannot delete a channel required by Community | 400? | state | `#rules`, `#mod-updates` |
| 50083 | Archived thread | 400 (MEM) | `ThreadArchived` | |
| 50159 / 50160 / 50161 / 50162 / 50173 | Voice message rules | 400 (MEM) | payload | |
| 50600 | No permission to send this sticker | 403? | payload | |
| 60003 | 2FA required | 403 (MEM) | state | H-072 |
| 160002 / 160009 | Reply or reference without READ_MESSAGE_HISTORY | 400 or 403 (MEM) | `MissingReadMessageHistory` | Has its own code, so no recompute is needed |
| 160004 | Thread already exists for this message | 400 | state | |
| 160005 | Thread locked | 400 or 403 (MEM) | `ThreadLocked` | |
| 160006 / 160007 | Active thread limits | 400 | state | |
| 160014 | Forwarding a message whose content is unreadable | 400? | state | |
| 200000 / 200001 / 240000 | AutoMod or harmful-link block | 400? | state | |
| 520002 / 520003 | Poll in an invalid channel type / poll edit | 400 | compile error | |

- **H-080:** without VIEW_CHANNEL a bot gets **50001**. With VIEW_CHANNEL but
  without the action permission it gets **50013** (MEM). PROMPT's attribution
  design ("most fundamental first") depends on this split.
- **H-081:** a 50013 body never names the missing permission. It is
  `{"message": "Missing Permissions", "code": 50013}` with no `errors` tree
  (the OPC example shape). Attribution therefore needs the recompute.
- **H-083:** 50006 is returned when none of `content`, `embeds`,
  `sticker_ids`, `components`, files, `poll` or `shared_client_theme` is
  present, or when all of them are empty. Whether whitespace-only content
  counts as empty is UNVERIFIED.
- **H-087:** unknown ids return the 10xxx codes above.

### 8.2 Error body shape (REF "Error Messages", OAS `ErrorResponse`)

```json
{ "code": 50035, "message": "Invalid Form Body",
  "errors": { "embeds": { "0": { "title": { "_errors": [ { "code": "BASE_TYPE_MAX_LENGTH", "message": "..." } ] } } } } }
```

- **H-084:** the inner `_errors[].code` values are **strings** such as
  `BASE_TYPE_REQUIRED` and `APPLICATION_COMMAND_TOO_LARGE`. Every REF example
  shows strings.
  - OAS declares `Error.code` as an integer, and DFX `Generated.ts` copies
    that (`readonly code: number` in `interface Error`, which `InnerErrors`
    uses). So dfx's static type is probably wrong for inner errors.
  - Appendix A.3 decodes `string | number` and flattens the tree into
    `(path, code, message)` leaves. `ContentTooLong` and `EmbedTooLarge`
    need exactly that.
  - The exact inner code strings per limit (`BASE_TYPE_MAX_LENGTH`,
    `BASE_TYPE_BAD_LENGTH`, ...) must be recorded live.
- **H-093:** rate limits return HTTP 429 with `retry_after`, `global` and
  sometimes `code` (RL). 429s with `X-RateLimit-Scope: shared` do not count
  against the invalid-request budget.
- **H-094:** the invalid-request limit is **10,000 per 10 minutes per IP**,
  counting 401, 403 and 429 responses (RL). A permission matrix provokes 403s
  on purpose. A few hundred per run is far below the limit, but the runner
  should count them.

---

## 9. Silent degradation candidates

"Silent" means the HTTP call succeeds (2xx) but some requested effect is
dropped. How to read the result back:

- **The create response.** The body of `POST /channels/{id}/messages` is the
  created message. It includes `mention_everyone`, `mentions`,
  `mention_roles`, `tts`, `flags`, `embeds`, `sticker_items` and
  `message_reference`. The bot always sees content in its own messages (GW
  "Message Content Intent": "Content in messages that an app sends").
- **Link unfurls** arrive later, in a `MESSAGE_UPDATE` (MEM). (H-245)
- **Harness reads.** PROMPT lists only Server Members for the harness, so it
  may lack MESSAGE_CONTENT. In that case its REST reads of the subject's
  messages return empty `content`, `embeds`, `attachments` and `components`
  (MSG warning, GW "HTTP Restrictions"). Fields without content (`mention_*`,
  `tts`, `flags`, `type`, `message_reference`, `sticker_items`) are not
  affected (H-243).

| Id | Candidate | Source | Detect by reading back |
|---|---|---|---|
| H-100 | `@everyone` or `@here` in content without MENTION_EVERYONE: the message sends but pings nobody | MSG "Allowed Mentions Object" | `mention_everyone === false` in the response |
| H-101 | A role that is not mentionable, mentioned without MENTION_EVERYONE: the message sends but members get no notification | MSG | The role id is missing from `mention_roles`. Whether `mention_roles` is the field that changes is UNVERIFIED. |
| H-102 | `tts: true` without SEND_TTS_MESSAGES: sent as a normal message | MEM, UNVERIFIED. MSG only says the permission is required. | `tts === false`. It may be a 50013 error instead. |
| H-103 | Rich `embeds` without EMBED_LINKS | MEM, UNVERIFIED either way | Either 50013, or 2xx with `embeds.length === 0`. Link previews are dropped silently in any case (P bit description). |
| H-104 | An external custom emoji `<:n:id>` without USE_EXTERNAL_EMOJIS: rewritten to `:n:` | MEM, UNVERIFIED | `content` differs from what was sent. `[other-guild]` for a real external emoji. App emojis are exempt (EMO). |
| H-105 | Unsupported flags on edit are ignored | MSG "Edit Message": "currently ignored without error" | `flags` lacks the bit |
| H-106 | Flags not allowed on create (`EPHEMERAL`, `URGENT`, ...): ignored, or rejected with 50035 | MSG lists the allowed flags; behavior for the rest is undocumented | `flags` in the response, or the error |
| H-107 | GET messages or pins without READ_MESSAGE_HISTORY: 200 with an empty list | MSG: "no messages will be returned", "no pins will be returned" | Empty list even though messages exist. Reads must report this as a typed `degraded` value with `MissingReadMessageHistory`, not as an empty success. |
| H-108 | Without the MESSAGE_CONTENT intent, content fields are empty and `poll` is omitted | MSG, GW | Empty strings and arrays |
| H-109 | `message_reference.fail_if_not_exists: false` with a missing target: sent as a plain message | MSG reference structure | No `message_reference`; `type` is 0, not 19 |
| H-110 | Ids in `allowed_mentions.users` or `.roles` that are not in the content are ignored | MSG | They are absent from `mentions` |
| H-111 | An edit without `allowed_mentions` parses mentions again with the **default** allowances, not the original ones | MSG "Edit Message" | `mentions`, `mention_roles` and `mention_everyone` change. Whether an edit actually pings is UNVERIFIED. The library must always resend explicit `allowed_mentions` on edit. |
| H-112 | `enforce_nonce` with a reused nonce returns the earlier message and creates nothing | MSG, CL 2024-02-12 | Same `id` as the earlier message |
| H-113 | In a CV2 message, attachments that no component references are not shown | CMP intro | Only visible in the client. Whether the API still lists them is UNVERIFIED. |
| H-114 | Discord strips "certain characters" from content | MSG warning | `content` differs |
| H-115 | Leading and trailing whitespace in embed fields is trimmed | MSG "Embed Limits" | Field values differ |
| H-116 | Embeds are deduplicated by URL; only the first is shown | MSG "Embed Limits" | Only visible in the client. Whether the API drops them is UNVERIFIED. |
| H-117 | The ephemeral flag on the first follow-up after a deferred response is ignored | IR "Create Followup Message" | `flags` keep the ephemeral state set by the defer |
| H-118 | Interaction responses ignore SEND_MESSAGES. Only MENTION_EVERYONE, SEND_TTS_MESSAGES and USE_EXTERNAL_EMOJIS are computed from the bot's permissions | CL 2022-06-29 | `[human]`, phase 3 |

---

## 10. Message payload rules

### 10.1 Content and size

- **H-120:** content is limited to 2000 characters (MSG create and edit, the
  forum message params, WH).
  - **OAS says `content.maxLength: 4000`** for `MessageCreateRequest` and
    `MessageEditRequestPartial`, probably the Nitro limit.
  - Hypothesis: a bot sending 2001 characters gets 50035.
- **H-121:** open: is "characters" counted in code points or in UTF-16 code
  units?
  - Test: send 2000 astral characters (2 UTF-16 units each). If they are
    accepted, the limit counts code points.
  - The library's `ContentTooLong` check must use the same unit.
  - The command-name check in Appendix A.4 counts code points, because JS
    `{1,32}` with the `u` flag does.
- **H-122:** a message needs at least one of `content`, `embeds`,
  `sticker_ids`, `components`, `files[n]`, `poll` or `shared_client_theme`. A
  forward needs only `message_reference` (MSG footnote *).
  - PROMPT.md's list ("content, embeds, files, sticker or poll") **omits
    `components`**. According to MSG, a legacy message containing only an
    action row is valid.
  - Forum posts (CH) and webhooks (WH) have their own versions of this list.
- **H-123:** embed limits (MSG "Embed Limits"; OAS `RichEmbed*` gives the
  same per-field values but not the 6000 total). Breaking any of them returns
  "Bad Request".
  - At most 10 embeds.
  - title 256, description 4096, fields 25, field name 256, field value 1024,
    footer text 2048, author name 256.
  - title, description, field names and values, footer text and author names
    together may not exceed 6000 across all embeds.
  - More than 25 fields has been an error since 2023-12-19. Before that, the
    extra fields were dropped (CL 2023-12-19).
- **H-124:** other limits:
  - `sticker_ids`: at most 3 (MSG, OAS).
  - Attachments: at most 10 (OAS `maxItems: 10`; OPC 30015).
  - File size: 20 MiB per file by default (REF). Whole request: at most
    25 MiB (MSG).
  - `nonce`: at most 25 characters (MSG).
  - `allowed_mentions.users` and `.roles`: at most 100 each (MSG, OAS).
- **H-145:** `enforce_nonce` deduplicates per author "in the past few minutes"
  (MSG).

### 10.2 Components V2

- **H-125:** with `IS_COMPONENTS_V2` (`1 << 15`, DAT 32768), sending
  `content`, `embeds`, `sticker_ids`, `poll` or `shared_client_theme` fails
  with 400 (MSG footnote **, CMP intro).
  - **Conflict:** WH says that `files[n]` with CV2 also fails. CMP says
    attachments "must be exposed through components", and the File and Media
    Gallery components point at uploaded attachments.
  - Hypothesis: Create Message accepts files with CV2. Webhooks and
    interactions need a separate test.
- **H-126:** the CV2 flag cannot be removed once set. An edit that sets it
  must null `content` and `poll` and empty `embeds` and `sticker_ids`, or it
  gets 400 (MSG "Edit Message" footnote, WH).
- **H-127:** component counts:
  - A CV2 message holds at most 40 components in total, nested ones included
    (CMP, CL 2025-04-29, OAS `components.maxItems: 40`).
  - A legacy message holds at most 5 top-level action rows (CMP "Legacy").
  - A section holds 1 to 3 text displays and one accessory (CMP).
  - The often-quoted limit of 4000 characters across all text displays is
    **not in the docs**. UNVERIFIED.

### 10.3 Component layout

- **H-128:** an action row holds 1 to 5 buttons, or exactly one select (CMP
  "Action Row"; OAS `minItems: 1, maxItems: 5`). Mixing them gives 50035.
- **H-129:** button field rules (CMP "Button"):
  - Styles 1 to 4 must have `custom_id`, and no `url` or `sku_id`.
  - Link buttons (style 5) must have `url`, and no `custom_id`.
  - Premium buttons (style 6) must have `sku_id`, and none of `custom_id`,
    `label`, `url` or `emoji`.
- **H-130:** `custom_id` is 1 to 100 characters and must be unique within the
  message (CMP "Custom ID", OAS).
- **H-131:** other limits (CMP, OAS):
  - Button label at most 80; button url at most 512.
  - Select options 1 to 25; option label, value and description at most 100
    each; placeholder at most 150.
  - `min_values` 0 to 25; `max_values` 1 to 25.
  - `disabled` inside a modal is an error.

### 10.4 Flags by context

**H-132:**

| Context | Allowed flags | Source |
|---|---|---|
| Create Message | SUPPRESS_EMBEDS, SUPPRESS_NOTIFICATIONS, IS_VOICE_MESSAGE, IS_COMPONENTS_V2 | MSG |
| Edit Message | SUPPRESS_EMBEDS (set and unset), IS_COMPONENTS_V2 (set only). Other users can edit only flags, and need MANAGE_MESSAGES. | MSG |
| First message of a forum or media post | SUPPRESS_EMBEDS, SUPPRESS_NOTIFICATIONS | CH |
| Interaction callback (type 4 or 7) | SUPPRESS_EMBEDS, **EPHEMERAL**, IS_COMPONENTS_V2, IS_VOICE_MESSAGE, **SUPPRESS_NOTIFICATIONS** | IR |
| Interaction callback type 5 (deferred) | **only EPHEMERAL**. A CV2 response needs Edit Original afterwards. | IR footnote |
| Follow-up (Execute Webhook) | EPHEMERAL and IS_COMPONENTS_V2 are named for follow-ups. Plain webhooks allow SUPPRESS_EMBEDS, SUPPRESS_NOTIFICATIONS and IS_COMPONENTS_V2. | IR, WH |
| Edit of a webhook or interaction message | SUPPRESS_EMBEDS, IS_COMPONENTS_V2 | WH |

PROMPT.md says "`SuppressNotifications` only on create". According to the
docs it is also valid on interaction initial responses, follow-ups and webhook
executions, but not on edits. The type rule should be "any request that
creates a new message". (Decision needed.)

### 10.5 allowed_mentions and replies

- **H-133:** `allowed_mentions` defaults (MSG):
  - Regular messages parse `["users", "roles", "everyone"]`.
  - Interactions and webhooks parse `["users"]` only.
  - `parse` and an explicit `users` or `roles` list for the same type are
    mutually exclusive. Sending both gives 50035.
  - The library can meet PROMPT's "ping nobody by default" only by always
    sending `{ parse: [] }`, on edits too (H-111).
- **H-134:** `replied_user` defaults to false (MSG). Open: if
  `allowed_mentions` is left out entirely, does a reply ping its author?
  Detect this through `mentions` in the response.
- **H-135:** a reply needs READ_MESSAGE_HISTORY, or it fails with
  **160002**.
  - The referenced message must exist and must not be a system message (MSG
    "Limitations").
  - With `fail_if_not_exists` at its default of true, a missing target is an
    error. The code is UNVERIFIED (MEM: 50035 on `message_reference`).
- **H-136:** a reply that references a message in another channel fails.
  UNVERIFIED code. MSG says a reply's `channel_id` equals the referenced
  message's.
- **H-137:** a forward needs `type: 1`, `message_id` and `channel_id`, plus
  VIEW_CHANNEL on the source and readable content (160014).
  - Allowed source types: DEFAULT, REPLY, CHAT_INPUT_COMMAND and
    CONTEXT_MENU_COMMAND.
  - Not allowed: messages with a poll, a call or an activity.
  - Snapshots nest at most one level deep (MSG).

### 10.6 Other message operations

**Stickers**

- **H-138:** `sticker_ids` take "stickers in the server" (MSG). External
  stickers need USE_EXTERNAL_STICKERS (`[other-guild]` for the failing case).
  An invalid sticker gives 50081, and a sticker the bot may not send gives
  50600 (OPC).

**Polls**

- **H-139:** poll limits (POLL, OAS):
  - 1 to 10 answers. Question text at most 300 characters, answer text at
    most 55.
  - `duration` 1 to 768 hours. POLL says "up to 32 days", which equals OAS's
    768.
  - A poll message cannot be edited (520003).
  - A poll in the wrong channel type gives 520002. Which types are wrong is
    undocumented.
  - A bot can end only its own polls. Apps cannot vote.

**Voice messages**

- **H-140:** a voice message has exactly one `audio/*` attachment with
  `duration_secs` and `waveform`, and no content (MSG "Voice Messages", OPC).
  - Extra content gives 50159.
  - More than one attachment gives 50160.
  - Missing metadata gives 50161.
  - Voice messages cannot be edited (50162).

**Crosspost**

- **H-141:** crossposting works only in announcement channels.
  - The bot's own messages need SEND_MESSAGES. Other people's messages also
    need MANAGE_MESSAGES (MSG).
  - Crossposting the same message twice gives 40033.
  - Crossposting outside an announcement channel gives an undocumented code
    (MEM: 50024).
  - MEM, UNVERIFIED: there is a crosspost rate limit of about 10 per channel
    per hour.

**Bulk delete**

- **H-142:** bulk delete (MSG, OPC):
  - Works only in guild channels and needs MANAGE_MESSAGES.
  - Takes 2 to 100 ids, otherwise 50016. Missing or invalid ids still count
    toward the limits.
  - Any id older than 14 days gives 400 with 50034. Duplicate ids give 400.
  - Live-test idea: a **fabricated snowflake with a timestamp older than
    14 days** probably triggers 50034 without needing a real old message,
    because unknown ids still count. UNVERIFIED.

**Edit, delete and reactions**

- **H-143:** only the author can edit `content`, `embeds` and `components`.
  Other users can edit only `flags`, and need MANAGE_MESSAGES. Editing another
  user's content gives 50005 (MSG, OPC).
- **H-144:** reactions (MSG "Create Reaction", OPC):
  - Every reaction needs READ_MESSAGE_HISTORY.
  - ADD_REACTIONS is needed only when nobody has reacted with that emoji yet.
  - A message holds at most 20 distinct reactions (30010).
  - The emoji must be URL-encoded, otherwise 10014.
  - Deleting another user's reaction needs MANAGE_MESSAGES.
- **H-146:** setting `SUPPRESS_EMBEDS` on the bot's own message needs no
  permission. UNVERIFIED.
- **H-147:** deleting its own message never needs MANAGE_MESSAGES (MSG). It
  may still need VIEW_CHANNEL. UNVERIFIED.
- **H-148:** edits of messages older than one hour are rate-limited (30046),
  and so are announcement edits (20022) (OPC).

---

## 11. Channel kinds and supported operations

Kinds come from CH "Channel Types" (DAT values verified in Appendix A.1). Each
cell is a hypothesis to confirm, with its source.

| Kind (type) | send | crosspost | threads | pins | bulk delete | slowmode | channel edit | notes |
|---|---|---|---|---|---|---|---|---|
| GUILD_TEXT (0) | yes, SEND_MESSAGES | no (H-141) | public from a message or standalone; private (H-041) | yes, PIN_MESSAGES | yes | yes | MANAGE_CHANNELS | |
| GUILD_ANNOUNCEMENT (5) | yes | **yes** | ANNOUNCEMENT_THREAD only, no private (TH) | yes | yes | **no** (H-054) | yes; text and announcement convert only with the NEWS feature (CH) | |
| GUILD_VOICE (2) text chat | probably VIEW + CONNECT + SEND (H-152); reading needs CONNECT (MSG) | no | not documented (MEM: no) | not documented; PIN_MESSAGES is listed as "T" only | MEM: yes | yes | needs CONNECT, otherwise the implicit rule masks MANAGE_CHANNELS (H-015) | |
| GUILD_STAGE_VOICE (13) text chat | like voice (H-153) | no | MEM: no | open | open | yes | like voice | |
| GUILD_CATEGORY (4) | **no**: 50008 or 50024 (H-151) | no | no | no | no | no | yes; child channels can be synced (P "Permission Syncing") | |
| GUILD_FORUM (15) / GUILD_MEDIA (16) | **no**: 40058 (H-150). Posts are created with `POST /channels/{id}/threads` plus `message` | no | posts are PUBLIC_THREADs | inside posts | inside posts | `rate_limit_per_user` limits post creation; `default_thread_rate_limit_per_user` is copied to new posts (TH) | yes; `available_tags` at most 20, `applied_tags` at most 5 (CH) | posts can be pinned with the PINNED flag, max 1 pinned post (MEM), 30047 |
| PUBLIC_THREAD (11) / ANNOUNCEMENT_THREAD (10) / PRIVATE_THREAD (12) | SEND_MESSAGES_IN_THREADS | no | no nesting | yes (H-050) | yes | yes, per thread | thread fields (§5) | archived and locked state (§5) |
| DM (1) | yes if there is a mutual guild and the recipient accepts DMs; **bot to bot fails** with 50007 (MEM, H-158) | no | no | MEM: yes | no, guild only (MSG) | n/a | no | deleting someone else's message gives 50003. No permissions apply, except `app_permissions` in interactions |
| GROUP_DM (3) | bots can join only through `gdm.join` | | | | | | | out of scope |
| GUILD_DIRECTORY (14) | hubs only | | | | | | | out of scope |

Related hypotheses:

- **H-154:** announcement channels have no private threads.
- **H-155:** private threads exist only in GUILD_TEXT.
- **H-156:** converting between text and announcement needs the NEWS feature.
  Community servers have it (MEM).
- **H-157:** `#rules` and `#mod-updates` cannot be deleted (50074, CH). The
  harness must never try.
- **H-159:** pinning in voice text chat is open.

Channel field limits (CH):

- name 1 to 100 characters
- topic 0 to 1024 characters (0 to 4096 for forum and media)
- `rate_limit_per_user` 0 to 21600 seconds
- bitrate at least 8000, with a maximum that depends on the boost tier
- `user_limit` up to 99 for voice and up to 10,000 for stage

MEM, UNVERIFIED and important for pacing the matrix: renaming a channel or
changing its topic is limited to about 2 per 10 minutes per channel. The
runner should avoid repeated `PATCH` of `name` or `topic` on the same channel
(H-162).

---

## 12. Gateway intents (GW "Gateway Intents", GWE)

Intent bits were verified against DAT (Appendix A.1).

| Intent | Events | Notes |
|---|---|---|
| GUILDS (1) | GUILD_CREATE, GUILD_UPDATE, GUILD_DELETE, GUILD_ROLE_*, CHANNEL_*, CHANNEL_PINS_UPDATE, THREAD_*, THREAD_LIST_SYNC, THREAD_MEMBER(S)_UPDATE, STAGE_INSTANCE_*, VOICE_CHANNEL_STATUS_UPDATE, VOICE_CHANNEL_START_TIME_UPDATE | the cache depends on this intent |
| GUILD_MEMBERS (2), privileged | GUILD_MEMBER_ADD, GUILD_MEMBER_UPDATE, GUILD_MEMBER_REMOVE, THREAD_MEMBERS_UPDATE for other users | a GUILD_MEMBER_UPDATE about the bot itself arrives without it (H-175) |
| GUILD_MODERATION (4) | GUILD_AUDIT_LOG_ENTRY_CREATE, GUILD_BAN_* | |
| GUILD_EXPRESSIONS (8) | emoji, sticker and soundboard events | |
| GUILD_INTEGRATIONS (16), GUILD_WEBHOOKS (32), GUILD_INVITES (64) | | |
| GUILD_VOICE_STATES (128) | VOICE_STATE_UPDATE, VOICE_CHANNEL_EFFECT_SEND | needed to know whether the bot is connected (the implicit CONNECT exception) |
| GUILD_PRESENCES (256), privileged | PRESENCE_UPDATE | also shapes `members` and `presences` in GUILD_CREATE (H-177) |
| GUILD_MESSAGES (512) | MESSAGE_CREATE, MESSAGE_UPDATE, MESSAGE_DELETE and MESSAGE_DELETE_BULK in guilds | |
| GUILD_MESSAGE_REACTIONS (1024), GUILD_MESSAGE_TYPING (2048) | | |
| DIRECT_MESSAGES (4096) | MESSAGE_CREATE, MESSAGE_UPDATE, MESSAGE_DELETE and CHANNEL_PINS_UPDATE in DMs (no DELETE_BULK) | ephemeral messages arrive through this intent, without `guild_id` or `member` (GWE "Messages") (H-178) |
| DIRECT_MESSAGE_REACTIONS (8192), DIRECT_MESSAGE_TYPING (16384) | | |
| MESSAGE_CONTENT (32768), privileged | no events; controls fields | see below |
| GUILD_SCHEDULED_EVENTS (65536), AUTO_MODERATION_CONFIGURATION (1<<20), AUTO_MODERATION_EXECUTION (1<<21) | | `content` and `matched_content` in AutoMod executions need MESSAGE_CONTENT (H-181) |
| GUILD_MESSAGE_POLLS (1<<24), DIRECT_MESSAGE_POLLS (1<<25) | MESSAGE_POLL_VOTE_* | |

Events with no intent are always delivered: READY, INTERACTION_CREATE, and
any other event the list does not name (GW: "Any events not listed ... will
always be sent"). (H-179)

**Identify failures**

- **H-170:** identifying with a privileged intent that is not enabled in the
  portal closes the connection with **4014**. Invalid bits close it with
  **4013**. Neither code should be retried (GW, OPC).
  - Safe live test: the harness, which has only Server Members according to
    PROMPT, identifies with GUILD_PRESENCES and should get 4014.

**Message events and content**

- **H-171:** guild message events need GUILD_MESSAGES. DM message events need
  DIRECT_MESSAGES.
- **H-172:** without MESSAGE_CONTENT, `content`, `embeds`, `attachments` and
  `components` are empty, and `poll` is omitted (MSG, GW). The exceptions,
  where content is still filled:
  - messages the app sends;
  - DMs with the app;
  - messages that mention the app;
  - the target message of a message context-menu command (GW);
  - **replies to the app's non-interaction messages, when the replier has
    "ping on reply" enabled** (PRIV; not in GW).

  PROMPT.md lists only DMs, mentions and own messages. The type of
  `message.content` needs the reply and context-menu cases as well.
- **H-173:** REST access to content follows the **portal** toggle and is
  independent of the Identify `intents` (GW "HTTP Restrictions"). A bot with
  the portal toggle on that does not send the intent bit at Identify gets
  content over REST but not in gateway events. The type design therefore has
  two separate dimensions: the gateway intent and the portal setting.
- **H-174:** a mention of the bot's **managed role** does not count as a
  mention for the content exception. UNVERIFIED.

**Member and thread events**

- **H-176:** THREAD_MEMBERS_UPDATE includes other users only with
  GUILD_MEMBERS (GW "Caveats", TH).
- **H-177:** without GUILD_PRESENCES, or in guilds over 75k members,
  GUILD_CREATE contains only the bot and members in voice (GWE "Guild
  Create", "Request Guild Members").
- **H-180:** reaction, typing and poll-vote events follow their own intents.
- **H-182:** REST `List Thread Members` and `List Guild Members` need
  GUILD_MEMBERS enabled in the portal (CH warning, GW).

**Testing the content exceptions live (H-172)**

- The subject identifies **without** bit 15.
- The target bot posts plain messages, messages that mention the subject, and
  replies to the subject's messages with `allowed_mentions.replied_user:
  true`.
- The DM case needs a human, because bots cannot DM bots (H-158) and Rhys must
  not be DMed. `[human]`
- For the REST variant (H-173), use the harness if it lacks MESSAGE_CONTENT in
  the portal (confirm in the portal), or another app with the toggle off.

---

## 13. Application command validation and limits

Sources: AC, OAS.

**Names and descriptions**

- **H-190:** CHAT_INPUT command and option names must match
  `^[-_ʼ\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$` with the unicode flag,
  and must use the lowercase form of every letter that has one.
  - Appendix A.4 compiles the regex and runs samples.
  - `Ping`, `ÉMOJI` and `İ` pass the regex but fail the lowercase rule.
  - `with space`, `dot.name`, `emoji😀`, the empty string and a 33-character
    name fail the regex.
  - TypeScript's `Lowercase<>` intrinsic applies the same `toLowerCase`
    semantics, so the rule can be checked on literal types.
- **H-191:** names are 1 to 32 characters (AC; OAS `minLength 1, maxLength
  32`).
- **H-192:** USER and MESSAGE command names may use mixed case and spaces.
  Their `description` must be the empty string, and they take no `options`
  (AC structure footnote).
- **H-193:** a CHAT_INPUT description is 1 to 100 characters, and so is an
  option description (AC, OAS).

**Options**

- **H-194:** required options must come before optional ones (AC warning).
- **H-195:** at most 25 options per level and at most 25 choices (AC, OAS).
- **H-196:** subcommand nesting (AC "Subcommands and Subcommand Groups"):
  - Valid: subcommands; groups that contain subcommands; groups and
    subcommands mixed at the top level.
  - Invalid: a group inside a group; a group inside a subcommand.
- **H-197:** subcommands cannot be mixed with other options at the same level.
  AC does not say this. UNVERIFIED. AC does say that a command with
  subcommands cannot be invoked by its base name.
- **H-198:** option names must be unique within an options array (AC
  footnote).
- **H-199:** `autocomplete: true` together with `choices` is rejected (AC
  footnote).
- **H-200:** a choice `name` is 1 to 100 characters. A string choice `value`
  is "up to 100 characters" in AC but **`maxLength: 6000`** in OAS. Conflict.
- **H-201:** `min_length` is 0 to 6000 and `max_length` is 1 to 6000.
  INTEGER values lie within ±(2^53−1) and NUMBER values within ±2^53 (AC).

**Size and localization**

- **H-202:** each command may have at most 8000 characters in total across
  names, descriptions and values, including options and choices. Only the
  longest localization of each field counts. Exceeding it gives 50035 with
  `APPLICATION_COMMAND_TOO_LARGE` (AC, REF example).
- **H-203:** localizations (AC "Localization"):
  - Keys must come from the REF "Locales" list.
  - Values follow the same rules as the base field.
  - A localized option name must differ from every other default option name
    and from other option names in the same locale.
  - Values equal to the default are ignored.

**Limits and registration**

- **H-204:** per scope (global, or each guild): 100 CHAT_INPUT, 15 USER,
  15 MESSAGE, and 1 PRIMARY_ENTRY_POINT (global only). One more gives 30032
  (AC, CL 2026-03-03).
- **H-205:** at most **200 command creates per day per guild** (30034).
  - A bulk overwrite counts only commands that are new (AC).
  - Open: do rejected creates (50035) count? Not documented, and it decides
    the budget for a matrix of invalid registrations.
  - Plan: run every negative test against **one guild command name**, so any
    request that is accepted is an update (`200`), not a create.
- **H-206:** `POST` is an upsert. It returns `201` for a new name and `200`
  for an existing one (AC "Create Global Application Command").
- **H-207:** a bulk-overwrite `PUT` replaces commands of every type (AC).
- **H-208:** guild commands update instantly (AC).
- **H-209:** `contexts` and `integration_types` apply only to global commands
  (AC). Whether guild commands reject or ignore them is open.
- **H-210:** per AC, `required` is valid on every option type except
  SUB_COMMAND and SUB_COMMAND_GROUP. Whether Discord ignores or rejects it on
  those types is open.

Editing `default_member_permissions` overrides requires a Bearer token, not a
bot token (AC "Permissions"). Out of scope.

---

## 14. Interaction lifecycle

Phase 3 is mostly `[human]`.

- **H-220:** the initial response must arrive within **3 seconds**, or the
  token is invalidated (IR). A late callback probably gets **10062** with HTTP
  404 (MEM).
- **H-221:** the token stays valid for **15 minutes** for follow-ups and edits
  (IR). The code returned after that is UNVERIFIED (MEM: 50027 or 10015).
- **H-222:** a second initial callback gives **40060** (OPC).
- **H-223:** MODAL (9) is not available for MODAL_SUBMIT or PING interactions
  (IR footnote **). That it can only be the initial response follows from
  callbacks happening once.
- **H-224:** a modal's `custom_id` is 1 to 100 characters and its `title` at
  most 45. IR says it holds "between 1 and 5" components, but OAS says
  **`maxItems: 40`**. Conflict. Text inputs inside action rows are deprecated
  in favor of Label (CMP).
- **H-225:** autocomplete takes only a type 8 response, with at most 25
  choices (IR). It cannot be deferred (MEM). Options may be partial, and
  required options may be missing (AC "Autocomplete").
- **H-226:** DEFERRED_UPDATE_MESSAGE (6) and UPDATE_MESSAGE (7) are valid only
  for component and modal-submit interactions (IR footnote *).
- **H-227:** a deferred response (5) allows only the EPHEMERAL flag. A CV2
  response must come through Edit Original (IR).
- **H-228:** the first follow-up after a deferred response edits the loading
  message instead of posting a new one. This behavior is deprecated, and the
  ephemeral state cannot change (IR).
- **H-229:** interaction responses do not need SEND_MESSAGES or VIEW_CHANNEL
  in the channel.
  - Since 2022-08-03, MENTION_EVERYONE, SEND_TTS_MESSAGES and
    USE_EXTERNAL_EMOJIS follow the bot's channel permissions (CL 2022-06-29).
  - Follow-ups and edits "follow a bot user's permissions" (CL 2023-11-01).
    That leaves open whether follow-ups need SEND_MESSAGES.
  - `[human]`
- **H-230:** for `app_permissions` in DMs, see §2.3.
- **H-231:** the limit of 5 follow-ups (40094) applies only to interactions
  whose `authorizing_integration_owners` contains only USER_INSTALL (IR).
- **H-232:** interaction endpoints are not bound by the global rate limit
  (IR, RL).

---

## 15. Oracle and harness notes

- **H-240:** `GET /channels/{c}/permissions/member/{subject}?implicit=false`
  equals the documented base and overwrite computation for the subject.
  - The harness can call it after every setup step, both to wait out eventual
    consistency (REF "Consistency") and as a second oracle beside the
    resolver.
  - dfx 1.1.1 has no method for it, so the call must go through dfx's
    underlying HTTP client or a thin addition. Record that in LOG.md if it
    happens.
- **H-241:** open: does that endpoint apply the timeout mask (H-026), and does
  it return ALL for admins and the owner?
- **H-242:** `GET /guilds/{g}/permissions/member/{u}` returns @everyone OR the
  member's role permissions.
- **H-243:** a harness without MESSAGE_CONTENT reads empty content fields over
  REST, while the fields without content stay present (§9).
- **H-244:** the Create Message response already reflects server-side
  processing (`mention_everyone`, `mentions`, `mention_roles`, `tts`, `flags`,
  and which `embeds` were kept). H-100 to H-102 need no second read.
- **H-245:** link previews arrive later through MESSAGE_UPDATE, so checking
  for degradation from missing EMBED_LINKS on links needs a wait.

**Eventual consistency.** REF "Consistency" says the API is eventually
consistent, and gateway events may arrive 0 to N times. A permission change
made by the harness may not apply to the subject's very next request. The
runner should wait until the oracle endpoint (H-240) shows the new state
before running steps (b) and (c). Otherwise two runs may produce different
tables.

**Hard constraints that limit testing** (PROMPT.md):

- successful kicks and bans: `[resolver-only]`;
- anything aimed at the owner: `[resolver-only]`;
- external emoji and stickers: `[other-guild]`;
- DMs from humans and all interactions: `[human]`.

---

## 16. Hypothesis table

"Source" uses the keys from §0. In the test column, H is the harness, S the
subject and T the target.

| Id | Statement | Source | Suggested live test |
|---|---|---|---|
| H-001 | Guild base permissions = @everyone.permissions OR all of the member's roles | P pseudocode | H gives S role R1 {ADD_REACTIONS}; @everyone has {VIEW, SEND, RMH}. S reacts in a fresh channel: success. Compare with `GET /guilds/{g}/permissions/member/{S}`. |
| H-002 | The guild owner has ALL | P | `[resolver-only]`. A read-only `GET /guilds/{g}/permissions/member/{owner}` should return ALL (no ping, no DM). |
| H-003 | ADMINISTRATOR in the base gives ALL and bypasses every overwrite, including member overwrites | P, G | S gets a role with ADMINISTRATOR plus a member overwrite denying VIEW and SEND. S sends: success. |
| H-004 | An ADMINISTRATOR bit inside a channel overwrite grants nothing, or the API rejects it | P pseudocode (ADMINISTRATOR is only checked on base) | H PUTs an overwrite with allow=ADMINISTRATOR for S's role on a channel where S lacks SEND. Record the PUT result and whether S can send. |
| H-005 | The @everyone overwrite applies before role overwrites, deny before allow | P | @everyone overwrite denies SEND, no role overwrite: S fails with 50013. @everyone overwrite allows SEND while the base lacks it: S succeeds. |
| H-006 | Role overwrites aggregate: an allow beats a deny across roles, whatever the role positions | P ("#coolstuff") | S has roles A (deny SEND) and B (allow SEND), in both position orders and both overwrite array orders. S sends: success every time. dfx's helper predicts failure for one of the orders. |
| H-007 | A role overwrite beats the @everyone overwrite | P | @everyone deny SEND plus role allow SEND: success. @everyone allow plus role deny: 50013. |
| H-008 | The member overwrite is applied last | P | Role allows SEND, member overwrite denies it: 50013. Role denies, member allows: success. Repeat with the member overwrite first in the array. |
| H-009 | Overwrite array order does not matter | P | The same scenarios with `permission_overwrites` reordered give identical outcomes. |
| H-010 | Role positions do not matter for overwrites | P | Swap the positions of A and B in H-006. Same outcome. |
| H-011 | An overwrite for a role the member does not have is ignored | P | Deny SEND for a role S does not have. S sends: success. |
| H-012 | Without VIEW_CHANNEL every channel permission is ignored | P "Implicit" | Member overwrite denies VIEW and allows SEND, EMBED and ATTACH. S sends: 50001 expected (H-080). |
| H-013 | Without SEND_MESSAGES, MENTION_EVERYONE, SEND_TTS_MESSAGES, ATTACH_FILES and EMBED_LINKS are implicitly denied | P "Implicit" | Mostly unobservable for a bot, because it cannot send at all. Check whether an interaction response with embeds works in such a channel `[human]`, and check `?implicit=true` on the role endpoint (H-017). |
| H-014 | Missing SEND_MESSAGES in the parent does not mask payload permissions inside its threads | P (the rule talks about channels), TH | Parent denies SEND and allows SMIT and EMBED. S sends an embed in a thread: success. |
| H-015 | Without CONNECT, voice and stage permissions such as MANAGE_CHANNELS are implicitly denied; a connected user can still set the voice status | P, CL 2026-10-29 | Voice channel where S is allowed MANAGE_CHANNELS and denied CONNECT. S renames it with PATCH: expect 50013 or 50001. |
| H-016 | Other, undocumented implicit rules exist | P ("may be other cases") | Every mismatch between (a) and (c) involving an explicitly granted bit is recorded in LOG.md. |
| H-017 | Discord's `implicit=true` masking covers only missing VIEW_CHANNEL and voice/stage CONNECT, not the SEND_MESSAGES group | CH new endpoints | `GET /channels/{c}/permissions/role/{r}?implicit=true` and `false` for roles denied VIEW, CONNECT or SEND. Diff the bitfields. |
| H-018 | A category is viewable when any of its children is | P, CH | Deny VIEW on the category and allow it on one child. S sees the category in GET guild channels (after Nov 16) and in the gateway without the obfuscation flag. |
| H-020 | A timed-out member keeps only VIEW_CHANNEL and READ_MESSAGE_HISTORY | P | H times out S. S sends (fails), reacts (fails) and GETs messages (succeeds). |
| H-021 | Admins and the owner are exempt; timing out an admin gives 403 | P, G | Give T ADMINISTRATOR temporarily. S, with MODERATE_MEMBERS and above T in the hierarchy, times T out: 403 expected. |
| H-022 | Bots can be timed out | not documented | H sets `communication_disabled_until` on S. GET member shows it, and S's send fails. |
| H-023 | A timed-out bot that sends gets 50013 / 403, with no special code | OPC (no timeout code), MEM | A timed-out S sends. Record the code. |
| H-024 | A timed-out bot cannot add reactions | P bit text | A timed-out S PUTs a reaction: 50013. |
| H-025 | A timeout more than 28 days ahead is rejected | G | H sets a timeout 29 days ahead on T: 50035. |
| H-026 | Open: `app_permissions` and the permission endpoints reflect the timeout mask | not documented | Compare `GET .../permissions/member/{S}` before and after the timeout. Interactions: `[human]`. |
| H-027 | Open: a timed-out bot can still answer interactions | not documented | `[human]`, phase 3 checklist |
| H-028 | A timeout needs MODERATE_MEMBERS; open whether the hierarchy applies | G, P (not listed) | S with MODERATE_MEMBERS and its highest role at or below T's tries to time T out. |
| H-029 | The timeout mask is applied after overwrites | P | A timed-out S with a member overwrite allowing SEND still fails to send. |
| H-030 | Threads use their parent's overwrites | P, TH, CH | The parent's overwrite denies ADD_REACTIONS to S. S adds a new reaction in the thread: 50013. |
| H-031 | Threads need SEND_MESSAGES_IN_THREADS; SEND_MESSAGES does nothing there | P, TH | (SEND allowed, SMIT denied): 50013. (SEND denied, SMIT allowed): success. Test in public, private and announcement threads. |
| H-032 | VIEW_CHANNEL on the parent is needed even by thread members | P | Add S to a thread, then deny VIEW on the parent. S sends: 50001. |
| H-033 | A private thread is invisible to non-members without MANAGE_THREADS | CH, TH | S is not a member and lacks MANAGE_THREADS. It GETs the channel and sends. Record the code (50001 or 10003). |
| H-034 | Sending a message auto-joins the sender to the thread | CH | S sends in a public thread it has not joined. `GET thread-members/{S}` returns 200. |
| H-035 | Sending in an archived, unlocked thread unarchives it | CH, TH | H archives the thread. S sends: success, and `thread_metadata.archived` becomes false. |
| H-036 | In a locked thread without MANAGE_THREADS, sending and editing fail with 160005; with it they succeed | TH, CL 2023-02-10, OPC | H locks an active thread. S sends and edits its own message, with and without MANAGE_THREADS. |
| H-037 | In an archived thread, edits and reactions fail with 50083 while deletes succeed | TH, OPC | H archives without locking. S edits its own message (PATCH does not unarchive), reacts, and deletes. |
| H-038 | Conflict: unarchiving needs SEND_MESSAGES (CH) or thread membership (TH) | CH vs TH | S as a non-member with SEND, and as a member without SEND, PATCHes `archived:false`. |
| H-039 | Conflict: a locked thread can be unarchived only with MANAGE_THREADS (CH) or also by its creator (TH) | CH vs TH | S creates a thread; H locks and archives it; S tries to unarchive it without MANAGE_THREADS. |
| H-040 | Starting a thread from a message needs CREATE_PUBLIC_THREADS | P bit text | S POSTs `messages/{id}/threads` with and without CREATE_PUBLIC_THREADS. |
| H-041 | Private threads need CREATE_PRIVATE_THREADS and work only in GUILD_TEXT | P, TH | S creates a private thread in a text channel (with and without the bit) and in an announcement channel (expect an error and record the code). |
| H-042 | Leaving out `type` creates a PRIVATE_THREAD | CH footnote | S POSTs `/channels/{text}/threads` without `type`. The response has type 12. |
| H-043 | A thread started from message M has id M; a second one fails with 160004 | CH, OPC | Start two threads on the same message. |
| H-044 | A forum with REQUIRE_TAG rejects posts without tags (40067) | CH, OPC | H sets REQUIRE_TAG. S posts without `applied_tags`. |
| H-045 | Deleting a thread needs MANAGE_THREADS; name and archive changes need MANAGE_THREADS or creator; slowmode and locked need MANAGE_THREADS | CH, TH | S as creator and as non-creator, with and without MANAGE_THREADS, changes each field. |
| H-046 | Adding a thread member needs the ability to send there and an unarchived thread; removing needs MANAGE_THREADS or the private thread's creator | CH | S adds T to a thread (with and without SMIT, and when archived), then removes T. |
| H-047 | MANAGE_THREADS lets the holder view all private threads | P | S has MANAGE_THREADS and is not a member. GET on the private thread succeeds. |
| H-048 | Losing access to the parent keeps the membership | TH | Deny VIEW to S on the parent. `GET thread-members/{S}` through H still returns 200. |
| H-050 | Pinning and unpinning need PIN_MESSAGES; MANAGE_MESSAGES alone fails | MSG, CL 2026-02-10 | S with only MANAGE_MESSAGES pins: 50013. With PIN_MESSAGES: success. Same for unpin. |
| H-051 | At most 250 pins per channel (30003) | OPC | `[resolver-only]` (cost) |
| H-052 | Pinning a message from another channel fails with 50019; a system message fails with 50021 | OPC | Pin channel A's message M through channel B. Pin a system message (a thread-created or pin notice). |
| H-053 | Bots ignore slowmode, so they never get 20016 | CH, CL 2026-02-10 | Channel slowmode 21600; S without BYPASS_SLOWMODE sends twice in a row: both succeed. |
| H-054 | Announcement channels have no slowmode | CH, G field table | H PATCHes `rate_limit_per_user` on an announcement channel. Record the response and read the value back. |
| H-055 | SEND_POLLS is required for polls (code undocumented) | P | S sends a poll with and without SEND_POLLS. Record the code. |
| H-056 | SEND_VOICE_MESSAGES is required for voice messages; the failure may be 50173 | P, OPC | S sends a valid voice message (ogg with waveform) with and without the bit. |
| H-057 | USE_EXTERNAL_APPS never affects a server-installed bot | P | S without USE_EXTERNAL_APPS answers an interaction publicly `[human]`. Resolver: never required. |
| H-058 | Creating expressions and events needs CREATE_*; MANAGE_* alone is not enough | CL 2026-02-10 | Outside phase 1. Optional: S tries to create an emoji with only MANAGE_GUILD_EXPRESSIONS. |
| H-059 | discord-api-types bits equal the docs; bit 47 is unused; ManageEmojisAndStickers is an alias | DAT, P | `[offline]`, done (Appendix A.1) |
| H-060 | A bot can assign only roles below its own highest role | P | S (MANAGE_ROLES) assigns R_below (success), R_equal (S's own top role) and R_above (50013) to T. |
| H-061 | Role assignment does not depend on the target's own rank | not documented | T ranks above S. S assigns R_below to T. |
| H-062 | A bot can edit only roles below its top role, and grant only permissions it has | P | S edits R_below (success) and R_above (50013). S grants KICK_MEMBERS to R_below without having it (50013). |
| H-063 | A bot can reorder only roles below its top role | P | S PATCHes role positions to move R_below above its own top role: fails. |
| H-064 | Kick, ban and nickname need the target's top role to be strictly lower | P | Nickname on T in three ranks (lower, equal, higher). Kick and ban only in the equal and higher cases, where failure is expected. |
| H-065 | A bot can never act on the owner | P (implied), G | `[resolver-only]` |
| H-066 | Timeouts follow the same hierarchy as kicks | not documented | The three ranks from H-064, timing T out (and lifting it afterwards). |
| H-067 | An admin target blocks timeouts (403) but not nicknames when it ranks lower | G, P | T has ADMINISTRATOR and ranks below S. S sets T's nickname (expect success) and times T out (expect 403). |
| H-068 | Managed roles cannot be assigned or removed through the API | MEM | S (and H) try to add T's managed role to S. Record the code. |
| H-069 | The bot's own nickname needs CHANGE_NICKNAME and no hierarchy | G | S PATCHes the nick on `members/@me` with and without CHANGE_NICKNAME. |
| H-070 | Editing overwrites needs MANAGE_ROLES and can only grant bits the bot has, unless it has a MANAGE_ROLES overwrite in the channel | CH | S with guild-level MANAGE_ROLES sets an overwrite allowing a bit S lacks: 50013. Repeat with S holding a MANAGE_ROLES overwrite in the channel. |
| H-071 | Only admins can set MANAGE_ROLES overwrites when creating a channel | G | S with MANAGE_CHANNELS and MANAGE_ROLES creates a channel with a MANAGE_ROLES overwrite: fails. Clean up. |
| H-072 | With `mfa_level=1`, the starred permissions need the owner's 2FA, otherwise 60003 | OAUTH, OPC, G | H records the guild's `mfa_level` in the truth-table header. Run the test only if it is 1. |
| H-073 | The subject's managed role counts in its hierarchy | P | Read S's roles, place test roles relative to the managed role, and assert the H-060 and H-064 outcomes. |
| H-080 | Without VIEW a bot gets 50001; with VIEW but without the action permission it gets 50013 | MEM | Send with VIEW denied, then with VIEW allowed and SEND denied. Record both codes and statuses. |
| H-081 | A 50013 body never names the missing permission | OPC | Inspect the raw body of every 50013 in the matrix: no `errors` field. |
| H-082 | (status, code) pairs match the table in §8.1 | OPC (codes only), MEM (statuses) | Record status and code for every error scenario. The truth table stores both. |
| H-083 | An empty message gives 50006 / 400, and whitespace-only content counts as empty | MSG, OPC | POST `{}`, `{content:""}`, `{content:"   "}` and `{embeds:[]}`. |
| H-084 | Inner `_errors[].code` values in 50035 are strings | REF (OAS and DFX say integer) | Trigger content of 2001 characters, an embed title of 257 and 26 fields. Decode with A.3 and assert `typeof code === "string"`. |
| H-085 | Using a channel of the wrong type gives 50024 (crosspost in a text channel, bulk delete in a DM, ...) | OPC, MEM | Crosspost in a text channel. Record the code. |
| H-086 | Sending to a category gives 50008; to a forum, 40058 | OPC, MEM | S POSTs messages to a category and to a forum. |
| H-087 | Unknown ids give the 10xxx codes with 404 | OPC, MEM | GET and PATCH a deleted message, a deleted channel and a role that does not exist. |
| H-088 | Editing another user's content gives 50005 | MSG, OPC | S edits the content of H's message. |
| H-089 | Deleting another user's message without MANAGE_MESSAGES gives 50013 | MSG | S deletes H's message with and without MANAGE_MESSAGES. |
| H-091 | Replying without READ_MESSAGE_HISTORY gives 160002 | MSG, OPC | S replies with RMH denied. |
| H-092 | Bulk delete: 1 or 101 ids give 50016; ids older than 14 days give 50034 / 400; a fabricated old snowflake triggers 50034 | MSG, OPC | S (MANAGE_MESSAGES) sends [1 id], [101 ids], and [a fresh id plus a fabricated 15-day-old snowflake]. |
| H-093 | Rate limits come as 429 with `retry_after`, sometimes with `code` | RL | Observe 429s passively. Never provoke them. |
| H-094 | Invalid-request budget: 10,000 401/403/429 responses per 10 minutes | RL | The runner counts 403s per run and asserts the count stays far below the limit. |
| H-096 | A bot cannot DM another bot (50007) | MEM | S opens a DM with T (`POST /users/@me/channels`) and sends: 50007. |
| H-100 | @everyone without MENTION_EVERYONE sends with `mention_everyone:false` | MSG | S sends "@everyone test" with `parse:["everyone"]`, with and without the permission, and reads the response. Use a channel only bots can see, so Rhys is not pinged (H denies VIEW to @everyone and allows the bots). |
| H-101 | Mentioning a non-mentionable role without MENTION_EVERYONE notifies nobody | MSG | Role R (not mentionable, members: T), mentioned with `allowed_mentions.roles:[R]`. Inspect `mention_roles`. |
| H-102 | `tts:true` without SEND_TTS_MESSAGES sends with `tts:false` (or gives 50013) | MEM | S sends `tts:true` with and without the bit, and reads `tts`. |
| H-103 | Rich embeds without EMBED_LINKS give 50013 or are dropped | MEM | S sends a rich embed with and without EMBED_LINKS; read the status and `embeds.length`. For content with a URL, wait for MESSAGE_UPDATE. |
| H-104 | An external emoji without USE_EXTERNAL_EMOJIS is rewritten | MEM | `[other-guild]` for a real external emoji. Probe with an app emoji (exempt, EMO) and with a made-up id, and record any content diff. |
| H-105 | Unsupported flags on edit are ignored | MSG | S edits its own message with flags=SUPPRESS_NOTIFICATIONS and reads the response flags. |
| H-106 | Flags not allowed on create are ignored or rejected | MSG | S creates with flags=EPHEMERAL, then URGENT. Record the outcome and the flags. |
| H-107 | GET messages and pins without READ_MESSAGE_HISTORY return 200 with an empty list | MSG | S GETs messages and pins with RMH denied, in a channel that has messages. |
| H-108 | Without MESSAGE_CONTENT the content fields are empty | MSG, GW | See H-172 and H-173. |
| H-109 | `fail_if_not_exists:false` with a missing target sends a plain message | MSG | S replies to a deleted message id with false (plain message), and with the default (error: record the code). |
| H-110 | Ids in `allowed_mentions` that are not in the content are ignored | MSG | S sends `<@T>` with `users:[T, H]`. `mentions` contains only T. |
| H-111 | An edit without `allowed_mentions` parses mentions again with the defaults | MSG | S sends "<@T>" with `parse:[]`: `mentions` is empty. It edits to "<@T> !" without `allowed_mentions`: `mentions` contains T. |
| H-112 | `enforce_nonce` deduplicates | MSG | The same nonce twice returns the same id. |
| H-113 | CV2 attachments that no component references are not shown | CMP | Only visible in the client. Record whether `attachments` in the API lists them. |
| H-114 | Discord strips some characters from content | MSG | Send control characters and an RTL override, then diff the response content. |
| H-115 | Whitespace in embed fields is trimmed | MSG | Embed title "  x  " comes back as "x". Check whether the trimmed length is what counts toward limits. |
| H-116 | Embeds with the same URL are deduplicated | MSG | Two embeds with the same `url`. Count the embeds in the response. |
| H-117 | The first follow-up after a deferred response ignores the ephemeral flag | IR | `[human]` |
| H-118 | Interaction responses ignore SEND_MESSAGES; three bits follow the bot's permissions | CL 2022-06-29 | `[human]` |
| H-120 | Bot content is limited to 2000 characters, despite OAS's 4000 | MSG, WH vs OAS | S sends 2000 characters (success) and 2001 (50035; record the inner code). |
| H-121 | Open: limits count code points rather than UTF-16 units | not documented | S sends 2000 "😀" (4000 UTF-16 units). If accepted, Discord counts code points. Also try 1001 "😀". |
| H-122 | A message with only `components` (a legacy action row) is valid; a forward needs only `message_reference` | MSG | S sends `{components:[row with a button]}`: success. |
| H-123 | Embed field limits and the 6000 total | MSG, OAS | One request per limit, each one over: title 257, description 4097, 26 fields, field value 1025, 6001 in total across 2 embeds, 11 embeds. |
| H-124 | 3 stickers, 10 attachments, 20 MiB per file, nonce at most 25 characters | MSG, OAS, REF | 11 tiny files (expect 30015 or 50035); a nonce of 26 characters. File size: `[resolver-only]` (bandwidth). |
| H-125 | CV2 with content, embeds, stickers or poll gives 400; files are allowed on Create Message | MSG, CMP vs WH | S sends CV2 with content (400), and CV2 with a file referenced by a File component (success expected). |
| H-126 | The CV2 flag cannot be removed; setting it by edit needs the old fields nulled | MSG | S edits a CV2 message with flags=0 (the flag stays, or error). S edits a legacy message to CV2 without nulling content (400). |
| H-127 | CV2 allows 40 components in total; legacy allows 5 action rows | CMP, OAS | 41 nested components fail and 40 succeed. Legacy with 6 action rows fails. |
| H-128 | An action row holds 1 to 5 buttons or one select | CMP, OAS | 6 buttons, a button with a select, two selects, and an empty row each give 50035. |
| H-129 | Field rules for link and premium buttons | CMP | A link button with `custom_id`, a premium button with `label`, and a primary button with `url` each fail. |
| H-130 | `custom_id` is 1 to 100 characters and unique per message | CMP, OAS | 101 characters fails; duplicate ids fail; 100 characters succeeds. |
| H-131 | Button label 80, url 512, select options 25, placeholder 150 | CMP, OAS | One request per limit, each one over. |
| H-132 | Allowed flags per context (table in §10.4) | MSG, IR, WH, CH | Create and edit variants live; interaction variants `[human]`. |
| H-133 | `allowed_mentions` defaults; `parse` plus a list for the same type gives 50035; at most 100 ids | MSG, OAS | `{parse:["users"], users:[T]}` gives 50035. A message with no `allowed_mentions` and `<@T>` lists T in `mentions`. |
| H-134 | Open: whether a reply with no `allowed_mentions` pings its author | MSG | S replies to T's message without `allowed_mentions`. Is T in `mentions`? |
| H-135 | A reply needs RMH and an existing target that is not a system message; the default `fail_if_not_exists` errors | MSG | Covered by H-091 and H-109, plus a reply to a system message (record the code). |
| H-136 | A reply to a message in another channel fails | MSG | S replies in channel B with `message_reference` {channel A, message M}. |
| H-137 | A forward needs VIEW on the source and readable content (160014) | MSG, CL 2026-04-14 | S forwards T's message from a channel where S lacks VIEW (fails), and forwards a poll (fails). |
| H-138 | Guild stickers work; external stickers need USE_EXTERNAL_STICKERS; invalid gives 50081 | MSG, OPC | H creates a guild sticker. S sends it (success) and sends an id that does not exist (50081). External: `[other-guild]`. |
| H-139 | Poll limits; poll messages cannot be edited (520003) | POLL, OPC, OAS | 11 answers, an answer of 56 characters, and duration 769 each fail. Editing a poll message's content gives 520003. |
| H-140 | Voice message structure rules (50159 to 50162) | MSG, OPC | Voice message with content (50159), with two files (50160), without a waveform (50161), and an edit (50162). |
| H-141 | Crossposting works only in announcement channels; others' messages need MANAGE_MESSAGES; a second crosspost gives 40033 | MSG, OPC | Crosspost S's own message (success), H's message without MANAGE_MESSAGES (50013), the same message again (40033), and a message in a text channel (record the code). |
| H-142 | Bulk delete rules | MSG | See H-092, plus a bulk delete in the DM from H-096 (expect an error). |
| H-143 | Other users can edit only flags, and need MANAGE_MESSAGES | MSG | S PATCHes the flags of H's message to SUPPRESS_EMBEDS, with and without MANAGE_MESSAGES. |
| H-144 | Reactions always need RMH, need ADD_REACTIONS for a new emoji, and max out at 20 distinct | MSG, OPC | S reacts with RMH denied (fails). Without ADD_REACTIONS: an existing emoji succeeds and a new one fails. A 21st distinct emoji gives 30010. |
| H-145 | Nonce deduplication window | MSG | Covered by H-112. |
| H-146 | SUPPRESS_EMBEDS on its own message needs no permission | MEM | S without EMBED_LINKS or MANAGE_MESSAGES creates and edits its own message with SUPPRESS_EMBEDS. |
| H-147 | Deleting its own message needs no MANAGE_MESSAGES; VIEW may be required | MSG, MEM | S deletes its own message with VIEW denied. Record the outcome. |
| H-148 | Edits of messages older than one hour are rate-limited (30046) | OPC | Passive only |
| H-150 | Forum and media channels reject direct messages with 40058 | OPC | S POSTs a message to a forum. |
| H-151 | Categories reject messages | OPC, MEM | S POSTs a message to a category. Record the code. |
| H-152 | Sending in voice text chat needs VIEW, CONNECT and SEND | MSG (reading needs CONNECT), P implicit | Voice channel where S is allowed SEND and denied CONNECT. S sends. |
| H-153 | Stage text chat behaves like voice | P, MEM | H-152 on a stage channel. |
| H-154 | Announcement channels have no private threads | TH | Covered by H-041. |
| H-155 | Private threads exist only in GUILD_TEXT | TH | Covered by H-041. |
| H-156 | Converting between text and announcement needs the NEWS feature | CH | H PATCHes `type` from 0 to 5 and back (Community gives NEWS). Record the outcome. |
| H-157 | Channels required by Community cannot be deleted (50074) | CH, OPC | `[resolver-only]`. Never attempt it on `#rules` or `#mod-updates`. |
| H-158 | DMs: no bot-to-bot DMs, no bulk delete, and deleting someone else's message gives 50003 | MSG, OPC, MEM | Covered by H-096. The other cases: `[human]`. |
| H-159 | Open: pins in voice text chat | P ("T" only) | S pins a message in voice text chat with PIN_MESSAGES. |
| H-160 | After 2026-11-16, hidden channels arrive obfuscated over the gateway (flag 1<<17, fake overwrite) and are missing from GET guild channels | CL 2026-08-12, CH, P | Before Nov 16, turn on the portal toggle for S, deny VIEW on a channel, and inspect GUILD_CREATE and CHANNEL_UPDATE. After Nov 16, repeat without the toggle. |
| H-161 | Gaining VIEW triggers a CHANNEL_UPDATE with the real data, also for a hidden parent category | CH | Same setup: grant VIEW and watch the events. |
| H-162 | Channel name and topic edits are limited to about 2 per 10 minutes per channel | MEM | Passive: record the 429 and the bucket on the third rename in a run. Do not provoke it. |
| H-170 | A privileged intent that is not enabled gives close code 4014; invalid bits give 4013 | GW, OPC | H identifies with GUILD_PRESENCES (4014), and with bit 1<<30 (4013, only if safe). |
| H-171 | Guild message events need GUILD_MESSAGES; DM events need DIRECT_MESSAGES | GW | S identifies without GUILD_MESSAGES. T posts; S receives no MESSAGE_CREATE within N seconds. |
| H-172 | Without bit 15, content is filled only for own messages, DMs, mentions, the context-menu target, and ping-on replies to the bot | GW, PRIV | S identifies without bit 15. T posts plain text (empty), `<@S>` (filled), and replies to S's message with `replied_user:true` (filled) and `false` (empty?). S's own message is filled. DM: `[human]`. |
| H-173 | REST content follows the portal toggle, not the Identify intents | GW "HTTP Restrictions" | S identifies without bit 15 and GETs T's message over REST: content filled (portal on). H (portal off?) GETs the same message: empty. |
| H-174 | A mention of the bot's managed role does not count as a mention | MEM | T posts `<@&S_managed_role>`. S, without bit 15, checks the content. |
| H-175 | A GUILD_MEMBER_UPDATE about the bot itself arrives without GUILD_MEMBERS | GW "Caveats" | H changes S's roles while S is identified without bit 1. S receives the event. |
| H-176 | THREAD_MEMBERS_UPDATE includes other users only with GUILD_MEMBERS | GW, GWE | H adds T to a thread S is in, with and without bit 1 on S. |
| H-177 | Without GUILD_PRESENCES, GUILD_CREATE holds a limited member list | GWE | Count the `members` in S's GUILD_CREATE (no presences intent). |
| H-178 | Ephemeral messages arrive through DIRECT_MESSAGES, without `guild_id` | GWE | `[human]` |
| H-179 | READY and INTERACTION_CREATE do not depend on intents | GW | S identifies with `intents: 0` and still gets READY. Interactions: `[human]`. |
| H-180 | Reaction, typing and poll events follow their own intents | GW | S without GUILD_MESSAGE_REACTIONS: T reacts and no event arrives. |
| H-181 | Content in AutoMod executions needs MESSAGE_CONTENT | GWE | Optional; needs an AutoMod rule. |
| H-182 | List Thread Members needs GUILD_MEMBERS enabled in the portal | CH | H (portal has members) lists thread members: success. An app without the toggle: `[resolver-only]`. |
| H-190 | CHAT_INPUT names: the regex plus lowercase | AC | Register "Ping", "with space" and "dot.name" (each 50035), and "ping" and "émoji" (success). Use one guild command name to save budget. |
| H-191 | Names are 1 to 32 characters | AC, OAS | A 33-character name and "" (each 50035). |
| H-192 | USER and MESSAGE names allow case and spaces; their description must be "" | AC | USER command "High Five" (success). USER with a description (record the outcome). |
| H-193 | Descriptions are 1 to 100 characters | AC, OAS | CHAT_INPUT with description "" and with 101 characters (each 50035). |
| H-194 | Required options come before optional ones | AC | [optional, required] gives 50035. |
| H-195 | At most 25 options and 25 choices | AC, OAS | 26 options fail; 26 choices fail. |
| H-196 | Nesting is group then subcommand only | AC | A group in a group and a group in a subcommand each fail. A group and a subcommand mixed at the top level succeed. |
| H-197 | Subcommands cannot be mixed with plain options at one level | MEM | [SUB_COMMAND, STRING] at the top level (expect failure). |
| H-198 | Option names are unique within an array | AC | Two options named "x" fail. |
| H-199 | `autocomplete` with `choices` is rejected | AC | A STRING option with both fails. |
| H-200 | Conflict: a string choice value is limited to 100 (AC) or 6000 (OAS) characters | AC vs OAS | A choice value of 101 characters. |
| H-201 | Ranges for `min_length` and `max_length`; integer bounds | AC, OAS | max_length 6001 fails; a min_value beyond 2^53 (record the outcome). |
| H-202 | At most 8000 characters per command | AC, REF | 25 options with 100-character descriptions plus choices, totalling more than 8000: APPLICATION_COMMAND_TOO_LARGE. |
| H-203 | Localization key and uniqueness rules | AC | Key "en" (not a valid locale) fails; localized name "Ping" fails; a duplicate localized option name fails. |
| H-204 | 100 CHAT_INPUT, 15 USER and 15 MESSAGE per scope (30032) | AC, CL 2026-03-03 | `[resolver-only]` for CHAT_INPUT (about 100 creates). USER: 16 through a bulk PUT (counts as creates, so budget it). |
| H-205 | 200 creates per day per guild (30034); open whether rejected creates count | AC, OPC | Track the count. Fetch the commands before and after the negative suite to infer it. |
| H-206 | POST is an upsert: 201 for new, 200 for existing | AC | POST "probe" twice: 201, then 200. |
| H-207 | A bulk PUT replaces commands of every type | AC | PUT [] removes the USER command from H-192. |
| H-208 | Guild commands update instantly | AC | After the PUT, GET returns the new definition immediately. |
| H-209 | Guild commands reject or ignore `contexts` and `integration_types` | AC | POST a guild command with `contexts:[1]`. Record the outcome and read it back. |
| H-210 | `required` on a subcommand is rejected or ignored | AC | A SUB_COMMAND with `required:true`. |
| H-220 | Missing the 3 s deadline invalidates the token (10062 afterwards) | IR | `[human]` |
| H-221 | The token lasts 15 minutes for follow-ups | IR | `[human]` |
| H-222 | A second callback gives 40060 | IR, OPC | `[human]` |
| H-223 | No modal in response to a modal submit | IR | `[human]` |
| H-224 | Conflict: a modal holds at most 5 (IR) or 40 (OAS) components | IR vs OAS | `[human]` |
| H-225 | Autocomplete takes only type 8, at most 25 choices, and no defer | IR | `[human]` |
| H-226 | UPDATE_MESSAGE and DEFERRED_UPDATE_MESSAGE only for components and modal submits | IR | `[human]` |
| H-227 | A deferred response allows only EPHEMERAL; CV2 needs an edit | IR | `[human]` |
| H-228 | The first follow-up after a deferred response edits the original | IR | `[human]` |
| H-229 | Responses need neither SEND nor VIEW; three bits follow the bot's overwrites | CL 2022-06-29, CL 2023-11-01 | `[human]` |
| H-230 | In DMs, `app_permissions` = ATTACH, EMBED and MENTION_EVERYONE (+ EXTERNAL_EMOJIS in the bot's DM) | IR | `[human]` |
| H-231 | The 5-follow-up limit applies only to user-install-only interactions | IR | `[human]` |
| H-232 | Interaction endpoints are outside the global rate limit | IR, RL | n/a |
| H-240 | GET channel member permissions (`implicit=false`) equals the documented computation | CH, OAS | Call it after each setup and compare with resolver step (a). Every scenario. |
| H-241 | Open: that endpoint reflects timeouts, admins and the owner | CH | Covered by H-026 and H-002. |
| H-242 | GET guild member permissions = @everyone OR roles | G | Compare with the resolver's `basePermissions`. |
| H-243 | A harness without MESSAGE_CONTENT reads empty content but full `mention_*`, `tts` and `flags` | MSG, GW | H GETs S's message that has an embed and a mention. |
| H-244 | The Create Message response reflects server-side processing | MSG | For H-100 to H-102, compare the POST response with a later GET. |
| H-245 | Link previews arrive later through MESSAGE_UPDATE | MEM | S sends a URL and waits up to 10 s for a MESSAGE_UPDATE with embeds. |

---

## 17. Conflicts between sources

1. Content limit: 2000 characters (MSG, WH) versus `maxLength: 4000` (OAS).
   (H-120)
2. Choice string value: 100 characters (AC) versus 6000 (OAS). (H-200)
3. Modal components: 1 to 5 (IR) versus 1 to 40 (OAS). (H-224)
4. Inner error codes: strings (REF examples) versus integers (OAS, DFX).
   (H-084)
5. Unarchiving a thread: SEND_MESSAGES (CH) versus thread membership (TH).
   (H-038)
6. Unarchiving a locked thread: MANAGE_THREADS only (CH) versus creator too
   (TH). (H-039)
7. CV2 with files: allowed on Create Message (implied by CMP) versus files
   forbidden on webhooks (WH). (H-125)
8. PIN_MESSAGES enforcement date: 2026-01-12 (CL 2025-08-20) versus
   2026-02-23 (CL 2026-02-10). Both have passed.
9. PROMPT's list of required message contents versus MSG: PROMPT leaves out
   `components`, `shared_client_theme` and the forward exception. (H-122)
10. PROMPT's "SuppressNotifications only on create" versus IR and WH, which
    also allow it on interaction responses, follow-ups and webhooks. (H-132)
11. PROMPT's message content exceptions versus GW and PRIV, which add
    context-menu targets and ping-on replies. (H-172)
12. PROMPT's `SlowmodeActive` versus CH and the changelog: bots are not
    affected by slowmode. (H-053)
13. dfx `forChannel` versus the algorithm in P: dfx applies overwrites in
    array order and does not handle the owner (§2.2, verified by running it).

---

## Appendix A. Compiled snippets

All files are in `.scratch/discord-semantics/src/`. They type-check with
`node_modules/.bin/tsc -p .scratch/discord-semantics/tsconfig.json`, which
copies the project's strict options (`strict`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax`), with exit code 0. They run
under Bun 1.4.4.

### A.1 `enums.ts`: discord-api-types values checked against the docs

Type-level `Eq<\`${Enum.Member}\`, "n">` checks, all passing under tsc:

- MessageFlags (4, 64, 4096, 8192, 32768)
- ChannelType (0 to 16)
- ChannelFlags (RequireTag 16, ChannelObfuscated 131072)
- GatewayCapabilityBits.ChannelObfuscation (32768)
- OverwriteType
- GatewayIntentBits (including MessageContent 32768 and the poll intents
  1<<24 and 1<<25)
- GatewayCloseCodes (4013, 4014)
- ComponentType, ButtonStyle and ApplicationCommandOptionType
- InteractionType and InteractionResponseType
- 40 RESTJSONErrorCodes values from §8.1

Permission bits are typed as `bigint` in DAT, so a runtime loop checks them:

```ts
export const checkPermissionBits = (): ReadonlyArray<string> => {
  const problems: Array<string> = []
  for (const [name, shift] of Object.entries(expectedPermissionBits)) {
    const actual = PermissionFlagsBits[name as keyof typeof PermissionFlagsBits]
    if (actual !== 1n << shift) problems.push(`${name}: expected 1n << ${shift}n, got ${String(actual)}`)
  }
  // ManageEmojisAndStickers is a deprecated alias of ManageGuildExpressions (1 << 30).
  const documented = new Set([...Object.keys(expectedPermissionBits), "ManageEmojisAndStickers"])
  for (const name of Object.keys(PermissionFlagsBits)) {
    if (!documented.has(name)) problems.push(`extra flag in discord-api-types: ${name}`)
  }
  return problems
}
```

Output: `permission bit problems: none`. `PermissionFlagsBits.ManageEmojisAndStickers === PermissionFlagsBits.ManageGuildExpressions`
is `true`.

Some DAT enum names differ from the OPC wording:

- `TagRequiredToCreateAForumPostInThisChannel` (40067)
- `ThreadAlreadyCreatedForMessage` (160004)
- 20028 has two names: `ChannelWriteRateLimit` and `ChannelSendRateLimit`

### A.2 `resolver.ts`: a literal transcription of the documented algorithm

```ts
export const basePermissions = (guild: Guild, member: Member): bigint => {
  if (member.userId === guild.ownerId) return ALL // H-002
  let permissions = guild.roles.get(guild.id)?.permissions ?? 0n // @everyone
  for (const roleId of member.roleIds) {
    permissions |= guild.roles.get(roleId)?.permissions ?? 0n
  }
  if ((permissions & P.Administrator) === P.Administrator) return ALL // H-003
  return permissions
}

export const applyOverwrites = (guild: Guild, member: Member, channel: Channel, base: bigint): bigint => {
  if ((base & P.Administrator) === P.Administrator) return ALL
  let permissions = base
  const everyone = channel.overwrites.find(o => o.type === 0 && o.id === guild.id)
  if (everyone) {
    permissions &= ~everyone.deny
    permissions |= everyone.allow
  }
  let allow = 0n
  let deny = 0n
  for (const roleId of member.roleIds) {
    const o = channel.overwrites.find(x => x.type === 0 && x.id === roleId)
    if (o) {
      allow |= o.allow
      deny |= o.deny
    }
  }
  permissions &= ~deny
  permissions |= allow
  const own = channel.overwrites.find(o => o.type === 1 && o.id === member.userId)
  if (own) {
    permissions &= ~own.deny
    permissions |= own.allow
  }
  return permissions
}

const TEXT_CHILDREN_OF_SEND = P.MentionEveryone | P.SendTTSMessages | P.AttachFiles | P.EmbedLinks
export const applyImplicit = (channel: Channel, permissions: bigint): bigint => {
  if ((permissions & P.Administrator) === P.Administrator) return permissions
  if ((permissions & P.ViewChannel) === 0n) return 0n // H-012
  let out = permissions
  if (channel.kind !== "thread" && (out & P.SendMessages) === 0n) out &= ~TEXT_CHILDREN_OF_SEND // H-013
  if ((channel.kind === "voice" || channel.kind === "stage") && (out & P.Connect) === 0n) {
    out &= ~P.ManageChannels // H-015: the docs name only MANAGE_CHANNELS
  }
  return out
}

export const applyTimeout = (guild: Guild, member: Member, permissions: bigint, now: number): bigint => {
  const timedOut = member.timedOutUntil !== null && member.timedOutUntil > now
  if (!timedOut) return permissions
  if (member.userId === guild.ownerId) return permissions
  if ((permissions & P.Administrator) === P.Administrator) return permissions
  return permissions & (P.ViewChannel | P.ReadMessageHistory) // H-020
}
```

The open questions are in `applyImplicit` (H-013 to H-017) and in whether
`applyTimeout` runs before or after implicit masking (H-029). This is research
scaffolding. The library resolver should come from the truth table, not from
this file.

### A.3 `errorBody.ts`: decoding the 50035 tree with Effect v4 Schema

```ts
const FieldErrorSchema = Schema.Struct({
  code: Schema.Union([Schema.String, Schema.Number]),
  message: Schema.String,
})

const ErrorTreeSchema: Schema.Codec<ErrorTree> = Schema.Record(
  Schema.String,
  Schema.Union([
    Schema.Array(FieldErrorSchema),
    Schema.suspend((): Schema.Codec<ErrorTree> => ErrorTreeSchema),
  ]),
)

export const DiscordErrorBody = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  errors: Schema.optionalKey(ErrorTreeSchema),
})
```

Output for the three REF examples and a bare 50013:

```
50035 [{"path":["activities","0","platform"],"code":"BASE_TYPE_CHOICES",...},{"path":["activities","0","type"],"code":"BASE_TYPE_CHOICES",...}]
50035 [{"path":["access_token"],"code":"BASE_TYPE_REQUIRED","message":"This field is required"}]
50035 [{"path":[],"code":"APPLICATION_COMMAND_TOO_LARGE","message":"Command exceeds maximum size (8000)"}]
50013 (no errors tree)
```

### A.4 `commandName.ts`: the documented CHAT_INPUT name rule

```ts
export const CHAT_INPUT_NAME = /^[-_ʼ\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u
export const isValidChatInputName = (name: string): boolean =>
  CHAT_INPUT_NAME.test(name) && name === name.toLowerCase()
```

Sample results (regex / valid):

| Name | regex | valid |
|---|---|---|
| `ping` | t | t |
| `role-add` | t | t |
| `Ping` | t | f |
| `with space` | f | f |
| `""` | f | f |
| 32 × `a` | t | t |
| 33 × `a` | f | f |
| `émoji` | t | t |
| `ÉMOJI` | t | f |
| `日本語` | t | t |
| `ß` | t | t |
| `İ` | t | f |
| `नमस्ते` | t | t |
| `สวัสดี` | t | t |
| `xʼy` | t | t |
| `emoji😀` | f | f |
| `dot.name` | f | f |

### A.5 `compare.ts`: dfx `forChannel` against the documented algorithm

```
permission bit problems: none
role B allow listed before role A deny: documented=true dfx=false
member deny listed before @everyone allow: documented=false dfx=true
```
