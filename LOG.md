# LOG

The running record of the build: what Rhys needs to do, what live Discord showed where it differed from the
docs, where we wrapped or adapted dfx, and where the implementation deviated from `docs/DESIGN.md`. Each
milestone appends its entries.

`bun run rules` reads two things from this file: every escalated rule's `Q-<n>` must have a line under
"Waiting for Rhys", and every rule that is not pure-typing must be mentioned by its `R-` id somewhere here.

## Waiting for Rhys

- **GuildMedia channels (decision, not blocking).** Perms Lab cannot have a media channel: creating one
  (`POST /guilds/{guild.id}/channels`, type 16) answers 400 50024 "Cannot execute action on this channel type",
  even with a minimal body `{name, type}` (M2). Provisioning records `lab-media` as unavailable in
  `.lab-state.json` and every media scenario will record `setup-unsupported: kind-not-available` (§5.10).
  If Rhys wants the media kind verified live, the server would need media channels enabled by Discord (they are
  not offered to this guild today); otherwise the media rows stay resolver-only. Everything else proceeds.

## Live findings

Where live Discord differed from the docs, each citing its H-id.

- **M2, H-240 (oracle): available.** `GET /channels/{c}/permissions/member/{u}?implicit=false` answered 200 for
  all ten lab channels and threads (the subject: no flags, as expected with an empty `@everyone` and no roles).
  A positive control, the target in `lab-text`, returned exactly `lab-target`'s overwrite allow (AddReactions,
  ViewChannel, SendMessages, ReadMessageHistory, SendMessagesInThreads). H-241 (timeouts) is still open.
- **M2, H-072: Perms Lab is `mfa_level = 0`.** `TwoFactorRequired` stays a documented, resolver-only tag (§8 item 16).
- **M2, D35: the harness application has the Message Content flag** (`GatewayMessageContent` or its
  `...Limited` flag in `getMyApplication().flags`), so the harness's REST reads see message content.
- **M2, H-073 refuted for Perms Lab: neither the subject nor the target has a managed role.** The guild's only
  managed role is the harness's (`Perms Harness`, Administrator). The two bots joined with no permissions, and
  Discord created no managed role for either (consistent with invites that request no permissions). "Both managed roles' positions": none
  exist; the subject's rank comes only from the lab roles a scenario assigns, and by default the target
  (`lab-target`, position 3) outranks the subject (no roles). Provisioning would place them directly below
  `lab-low` if they ever appear.
- **M2: roles created through the API all get position 1, and nothing is renumbered.** After creating the ten lab
  roles, every role but `@everyone` (including `Perms Harness`) was at position 1, ordered only by the ID
  tie-break. Provisioning therefore requires distinct positions, not just the right tie-broken order.
- **M2: a role-position PATCH that moves lab roles above the harness's numeric position fails with 400 50013**
  (status 400, where 50013 usually comes with 403), even though the harness ranked highest by tie-break. The same PATCH
  that also moves the harness's own top role above the block succeeds, and Discord applies the positions as
  sent: `Perms Harness` 11, then `lab-high` 10 down to `lab-unmentionable` 1.
- **M2: GuildMedia (16) cannot be created in Perms Lab** (400 50024, see "Waiting for Rhys").
- **M2: adding the target to a thread posts a system message nobody can delete.** Reset's first single delete of a
  harness message in `lab-public-thread` answered 403 50021 "Cannot execute action on a system message": the
  RECIPIENT_ADD (type 1) notice the harness's `PUT .../thread-members/{target}` posted. message.mdx lists types
  1-5 and 21 as not deletable; reset now leaves exactly those.
- **M2: `@everyone` had Discord's default permissions** (CreateInstantInvite, AddReactions, View, Send, ...) before the
  first reset, as the brief said; the first reset's only write set them to none.
- **M2 (observation for H-022 and H-241, recorded properly by the M3/M4 timeout rows): a bot member can be given a
  timeout.** The harness's `PATCH /guilds/{g}/members/{target}` with `communication_disabled_until` about ten
  minutes ahead was accepted (in the M2 verifier's reset self-test and again in the one below), the verifier's
  member read-back showed it, and reset cleared it. Not checked yet: that the timed-out bot's own sends fail (the H-022 test
  in discord-semantics.md), and whether the oracle masks a timed-out member (H-241). `Observed.botsCanBeTimedOut`
  stays `true`.
- **M2: a forum post's starter message can be pinned**, and reset unpins it (it keeps the message), as
  §5.7 step 6 requires.
- **M2 (for M4's pins catalog, H-050/H-052): a message in a stage channel's chat cannot be pinned.** In the M2
  verifier's dirt run, the harness (Administrator) pinning its own message in `lab-stage`
  (`PUT /channels/{lab-stage}/pins/{msg}`, same channel) got 400 50019 "This message cannot be pinned in this
  channel". discord-semantics.md H-052 expects 50019 only for a message from another channel. Not re-run in
  M2 (the reset self-test leaves stage pins out because of it). M4 decides whether stage pin rows expect 50019
  or stage leaves the pins channel dimension, with the reason here (DESIGN §5.9 notes it).
- **M2: a thread's slowmode can be set, and restored in the same PATCH that unarchives and unlocks it.** The
  reset self-test set `rate_limit_per_user: 5` on `lab-public-thread` before archiving and locking it; reset's
  single `PATCH /channels/{thread}` with `rate_limit_per_user: 0, archived: false, locked: false` was accepted,
  and the read-back showed slowmode 0, unarchived and unlocked.

M3, the send catalog (103 rows; the rows behind each finding are in the M3 milestone notes and the subset truth
table). Findings marked **M4** are the mismatches M3 leaves for M4's fixes:

- **M3, H-241 (oracle and timeouts): the permission endpoint applies the timeout mask.** For a timed-out subject,
  `GET /channels/{c}/permissions/member/{subject}?implicit=false` reports every granted flag but ViewChannel and
  ReadMessageHistory as missing (for example `send/text/mention-everyone/everyone/none/absent/timed-out`: the
  oracle's missing set is MentionEveryone and SendMessages, though `@everyone` grants SendMessages). The ten
  timed-out rows whose required flags include a granted one the timeout removes are `resolver-vs-oracle`
  mismatches. **M4**: §8 item 9's
  `OracleScope.includesTimeout` (compare the oracle with the timeout mask applied).
- **M3, H-080 refined: in a thread, a missing SendMessagesInThreads answers 403 50001, not 50013**, in public,
  private, announcement and archived threads and forum posts (`send/targeted/thread-send-without-smit`,
  `send/forum-post/*/base/*`, ...). Outside threads a missing SendMessages answers 50013 as H-080 says
  (`send/text/file/role-overwrite-allow/base/member-overwrite-deny/normal`). **M4**: `level-vs-raw` on these rows;
  `Observed.codeForLevel` (or the row's level) must say that SMIT is a 50001 flag.
- **M3, H-036: a send in a locked thread by a subject without ManageThreads that is not a member of the
  thread answers 403 50001, not 160005** (`send/locked-thread/plain/everyone/none/absent/normal`,
  `send/targeted/archived-locked-thread`, `send/targeted/order-smit-locked`); with ManageThreads the send succeeds
  (`send/targeted/locked-thread-moderator`). Every one of these rows had the subject outside the thread, so the
  50001 may be Discord refusing the implicit auto-join (H-034) rather than the lock itself; M4's
  `send/targeted/locked-thread-member` (a member without ManageThreads) separates the two. **M4**: `level-vs-raw`
  on the locked rows (preflight's ThreadLocked is right; the code is 50001).
- **M3, H-102: in threads, TTS without SendTTSMessages degrades instead of failing.** The message is sent with
  `tts: false` (`send/forum-post/tts/member-overwrite-allow/payload/member-overwrite-deny/normal`,
  `send/public-thread/tts/...`: two thread rows, `preflight-vs-raw`). No M3 row outside a thread had
  SendTTSMessages as its only missing flag, so M4 adds `send/targeted/tts-without-tts-{text,voice}` before
  `PayloadRules.tts.mode` changes for every kind.
- **M3, H-103: embeds without EmbedLinks are refused (403 50013)**, not dropped
  (`send/announcement/embed/everyone/payload/absent/normal`), so `PayloadRules.embeds.mode = "error"` holds.
- **M3, H-100 confirmed: `@everyone` without MentionEveryone is sent and pings nobody** (`mention_everyone: false`
  in the create response, recorded as degraded MentionEveryone) in voice, and in public, private, announcement
  and archived threads. The two text rows answered 50001 or 50013 (View or Send missing as well), and the
  forum-post and locked-thread rows 50001, so no text, forum-post or locked row shows the degradation. Safety's
  oracle check showed the subject without MentionEveryone and Administrator before each such send.
- **M3 (correction by the M3 verifier): no M3 row had SendPolls, or a reply's ReadMessageHistory, as its only
  missing flag.** Each pairwise row that removed one either had the removal defeated by overwrite precedence (for
  example `send/stage/poll/role-overwrite-allow/payload/role-overwrite-deny/normal` succeeded: a role allow beats
  another role's deny, H-006) or had View, SMIT or Send missing as well. M4 adds
  `send/targeted/poll-without-send-polls` and `send/targeted/reply-without-history`.
- **M3, H-135/§3.2: a reply without ReadMessageHistory and without SendMessages answers 403 160002**, Discord's
  dedicated reply code, where our order ranks SendMessages first (`send/targeted/order-send-reply-history`). As
  §3.2 decided, agreement accepts the mapped tag because it is in the row's `preflightSet`.
- **M3, H-022 and H-023 confirmed: a bot can be timed out, and a timed-out bot's send answers 403 50013**
  (`send/targeted/order-timeout-send`, `send/announcement/plain/role/base/everyone-overwrite-deny/timed-out`).
  `Observed.botsCanBeTimedOut` stays `true`.
- **M3, H-021: giving a timed-out member Administrator ends its timeout.** Probed directly (a throwaway script,
  the lab reset after): after the timeout PATCH the subject read `communication_disabled_until` ten minutes ahead;
  right after `lab-admin` was added it read `null`, and still `null` two seconds later. So "administrator and timed
  out" cannot exist; the targeted row `send/targeted/administrator-timed-out` records `setup-unsupported:
  admin-exempt`. (Timing out a member that already holds Administrator answers 403 50013, the documented H-021.)
- **M3: Discord refuses to add a member to a private thread when that member cannot view the parent** (403 50001
  on `PUT /channels/{thread}/thread-members/{subject}`, while the subject had no View on `lab-text`). Converge
  and cleanup now change the subject's membership with View granted to it on the parent (a member overwrite),
  then restore the parent's overwrites.
- **M3, H-031 and H-014 confirmed:** in a thread, SendMessages without SendMessagesInThreads fails and SMIT
  without SendMessages succeeds; an embed in a thread needs no SendMessages (no implicit Send mask in threads,
  `send/targeted/thread-embed-without-send`).
- **M3, H-033 and H-047 confirmed:** a private thread the subject is not in answers 50001
  (`send/targeted/private-thread-non-member`), and ManageThreads makes it visible
  (`send/targeted/private-thread-moderator`). H-035: sending in an archived thread succeeds (it unarchives it).
- **M3, H-152 and H-153: voice and stage text chat without Connect answer 403 50001** (View-level, as §3.2 ranks
  Connect), with View and SendMessages granted (`send/voice/*/connect/*`, `send/stage/reply/everyone/connect/...`).
- **M3, H-006 and H-008 confirmed:** a role overwrite allow beats another role's deny
  (`send/voice/plain/role-overwrite-allow/connect/role-overwrite-deny/normal` succeeds), and a member overwrite
  allow beats a role deny (`send/stage/plain/member-overwrite-allow/view/role-overwrite-deny/normal`). H-003: an
  Administrator sends past an `@everyone` View deny.
- **M3 (gateway, before obfuscation becomes mandatory on 2026-11-16, without the M7 codec): the subject's
  GUILD_CREATE lists every guild channel with its real overwrites**, including the lab channels it cannot view,
  none obfuscated; its `threads` hold only threads it can view (at baseline none of the four lab threads). The
  projection accepts both shapes for a hidden channel (§5.8).
- **M3: `GET /guilds/{id}/channels` answered 429 several times a run** (once every ~8 scenarios, each costing
  30-65 s of dfx's retry wait) while Converge and the wait's read-back each listed the guild's channels. They
  now read single channels with `getChannel`; the next full run had no 429 at all.

M4, the whole matrix (the families of §5.9, targeted rows and flip controls). The rows named are in
`fixtures/truth-table.json`; rows from the development runs before a fix are in the M4 milestone notes. Each
finding changed a constant, and the replay holds the constant to the table (§5.13):

- **M4, H-102: TTS without SendTTSMessages degrades outside threads too.** In text and in voice text chat the
  message is sent with `tts: false` (`send/targeted/tts-without-tts-text`, `send/targeted/tts-without-tts-voice`),
  as in threads (M3). `PayloadRules.tts.mode = "degrade"` for every kind.
- **M4, H-055: SendPolls missing on its own answers 403 50013** (`send/targeted/poll-without-send-polls`), so
  `PayloadRules.poll.mode = "error"` holds. **H-091, H-135: a reply without ReadMessageHistory, SendMessages
  granted, answers 403 160002** (`send/targeted/reply-without-history`), mapped to `MissingReadMessageHistory`.
- **M4, H-036: the lock itself answers 403 50001.** A member of a locked thread without ManageThreads gets 50001
  on a send (`send/targeted/locked-thread-member`), as non-members did in M3, so the refused auto-join was not
  the cause. `Observed.viewCodeFailures["thread.send"]` lists `ThreadLocked`. **H-036 refuted for edits:** the
  same member edits its own message in a locked thread (`message/targeted/edit-own-locked-thread`, 200), so
  `message.edit.thread` no longer lists `ThreadLocked`. Unarchiving a locked thread without ManageThreads, as its
  creator, answers 403 160005 (`thread/targeted/unarchive-locked-creator`).
- **M4, H-144 refuted for ReadMessageHistory: a reaction needs none.** Without it the subject still reacts in a
  private thread, a text channel and voice text chat (`react/private-thread/unicode-existing/read-history/...`,
  `react/text/guild/read-history/...`, `react/voice/unicode-new/read-history/...`), so the `message.react.*` rows
  dropped it (the `reaction` variant stays, with nothing to build). AddReactions is conditional as documented: an
  emoji already on the message needs none (`react/public-thread/unicode-existing/add-reactions/...`, 200), a new
  one does (`react/text/unicode-new/add-reactions/absent/normal`, 50013).
- **M4, H-024: a timed-out bot cannot react even where no flag is needed**: with an emoji already there and View
  its only requirement, the timed-out subject got 403 50013 (the development run's
  `flip/react/text/unicode-existing/view/role-overwrite-deny/timed-out`). The react rows are `blockedByTimeout`.
- **M4: pinning and unpinning need ReadMessageHistory, checked as access to the message**: without it, every
  other flag granted, both answer 403 50001 (`pins/text/pin/read-history/absent/normal`,
  `pins/targeted/unpin-without-history`), and so does a timed-out subject without it
  (`pins/public-thread/pin/read-history/absent/timed-out`), so it ranks with View (`viewLevel`, §3.2 tier 1).
  H-050 confirmed: ManageMessages without PinMessages answers 50013 (`pins/targeted/manage-messages-without-pin`).
  H-107 confirmed: listing pins without ReadMessageHistory answers 200 with an empty list
  (`pins/announcement/list/read-history/role-overwrite-deny/normal`, recorded as degraded).
- **M4, H-159 refuted: voice text chat has no pins.** The subject with every flag got 400 50019 "This message
  cannot be pinned in this channel" in `lab-voice` (the development run's `flip/pins/voice/pin/*`), and so did the
  harness, an Administrator (its pin fixture, `setup-unsupported: rejected-by-discord`), as in `lab-stage` (M2).
  `message.pin.voice` and `message.unpin.voice` left the table and voice left the pins family; listing in voice
  stays (`pins/targeted/voice-list`). Whether voice messages lose `pin` in the types is M6's (a type rule).
- **M4, H-141: crossposting needs ReadMessageHistory, checked as access**: without it a crosspost with View,
  SendMessages and ManageMessages answered 403 50001 (the M4 messages trial), and with it 200
  (`message/announcement/crosspost-foreign/none/normal`). Without SendMessages, or under a timeout, a crosspost
  answers 50001 (`message/announcement/crosspost-own/op-flag/normal`, `.../crosspost-own/none/timed-out`); without
  ManageMessages on another's message 50013 (`.../crosspost-foreign/op-flag/normal`). Discord limits publishing to
  about 10 per hour per announcement channel; a run makes 4, so no two full runs may start within the same
  20 minutes or so.
- **M4, H-152 generalised: everything in voice text chat needs Connect.** Editing one's own message and deleting
  another's without it answer 403 50001 (`message/targeted/voice-edit-own-without-connect`,
  `message/targeted/voice-delete-foreign-without-connect`); deleting one's own and bulk delete are targeted rows
  too (`message/targeted/voice-{delete-own,bulk-delete}-without-connect`). New rows `message.edit.voice`,
  `message.deleteOwn.voice`, `message.deleteForeign.voice` and `voice.bulkDelete` require it. A timeout removes
  Connect, so a timed-out subject in voice gets 50001 (View level), whatever else it lacks.
- **M4, H-037 partly refuted: an archived thread refuses deletes too.** Deleting one's own message, another's, or
  a bulk delete in an archived thread answer 400 50083 (`message/targeted/delete-own-archived-thread`,
  `.../delete-foreign-archived-thread`, `.../bulk-delete-archived-thread`), as editing, reacting and pinning do;
  new rows `message.deleteOwn.thread`, `message.deleteForeign.thread`, `thread.bulkDelete` list `ThreadArchived`.
  But **joining, leaving and adding a member succeed** in an archived thread (`thread/targeted/join-archived`,
  `leave-archived`, `add-member-archived`; H-046 refuted for adding), so those rows dropped `ThreadArchived`.
- **M4, H-038 decided: unarchiving needs SendMessagesInThreads, not SendMessages, membership or ManageThreads.** A
  member with View and SMIT unarchives, and so does a non-member with SendMessages and SMIT; a moderator with
  ManageThreads but no SMIT gets 403 50001 (`thread/targeted/unarchive-*`). New row `thread.unarchive` (View, SMIT).
- **M4: every thread edit needs SendMessagesInThreads.** Archiving, locking and setting a thread's slowmode with
  View and ManageThreads but without SMIT answered 403 50001 (`thread/*/archive/subject/none/...` and
  `channelEdit/public-thread/none/absent/normal` in the development runs); `thread.setArchived`,
  `thread.setLocked` and `thread.edit` require it, and their missing SMIT or ManageThreads answers 50001.
- **M4, H-045 partly refuted: a thread's creator may archive, lock and delete it without ManageThreads**
  (`thread/targeted/archive-creator-without-manage`, `thread/announcement-thread/lock/subject/op-flag/...`,
  `thread/announcement-thread/delete/subject/op-flag/...`, all 200); without ManageThreads anyone else gets 50001
  (`thread/targeted/archive-without-manage`, `lock-without-manage`). `ResolverRules.threadCreatorMayArchive`
  (docs), `threadCreatorMayLock` and `threadCreatorMayDelete` (live). The new `thread.delete` row has no creator
  exception in its types: the exception only removes a failure.
- **M4, H-032 refined: leaving a thread needs no View**: a member left with View denied on the parent
  (`thread/targeted/member-without-parent-view`, `thread/forum-post/leave/harness/view/timed-out/member`), so
  `thread.leave` requires nothing and preflight does not fail it on a channel it cannot see.
- **M4, H-040, H-041: creating a thread without its creation flag, or under a timeout, answers 403 50001**
  (`createThread/*/op-flag/*`, `createThread/announcement/public/none/timed-out`, and from a message,
  `createThread/targeted/from-message-without-flag`); with the flag both kinds succeed. Adding a member without
  SMIT, or under a timeout, answers 50001 too (`thread/forum-post/add-member/subject/op-flag/...`).
- **M4, H-031, H-044 confirmed: a forum post needs SendMessages, not SMIT or CreatePublicThreads** (without it
  403 50001: `createPost/targeted/forum-with-threads-flags-only`), and a forum with `REQUIRE_TAG` refuses an
  untagged post with 400 40067 (`createPost/targeted/forum-require-tag-untagged`) and takes a tagged one.
- **M4, members: H-060, H-061, H-064, H-066 confirmed; role assignment answers 50001 where the others answer
  50013.** A role below the subject's highest is assigned whatever the target's rank (`member/add-role/above/below/...`);
  the role at or above it answers 50013 (`member/add-role/below/above/...`); nickname, timeout, kick and ban of an
  equal or higher target answer 50013 (`member/{nickname,timeout,kick-expect-fail,ban-expect-fail}/above|equal/...`).
  Without ManageRoles, or under a timeout, a role assignment answers 50001
  (`member/add-role/below/equal/op-flag/...`, `member/remove-role/equal/equal/none/target-plain/timed-out`). The
  timeout masks guild-level permissions too: a timed-out subject holding the flag fails every member operation.
  Every kick and ban the matrix sent was predicted to fail by the guard's docs model and did (50013).
- **M4, H-015 confirmed for edits, and H-162: renames and topic edits succeed with ManageChannels**, one per
  channel per run, with no 429 (`channelEdit/targeted/{rename-text,topic-announcement,topic-forum}`); a voice
  rename without Connect answers 50001 (`channelEdit/targeted/rename-voice-without-connect`).
- **M4, H-241 applied: with the oracle compared after the timeout mask, no timed-out row disagrees with it**
  (M3's ten `resolver-vs-oracle` rows agree). With the M3 verifier's change, unseen rows compare ViewChannel with
  the oracle; every one agrees.
- **M4: a timed-out thread send with SendMessagesInThreads also missing answers 50001**
  (`send/targeted/order-timeout-smit`). Both failures answer 50001 in threads, so which one Discord checked first is
  not observable; the timeout keeps its §3.2 rank and `viewCodeFailures["thread.send"]` lists it.

After the M4 verifier, from the targeted rows it asked for (the targeted subset run and the exit runs below):

- **M4, H-053 confirmed: slowmode does not apply to bots.** The subject without BypassSlowmode sent twice in a row,
  under three seconds apart, in `lab-text` with a 60 s slowmode: both 200, no 429
  (`send/targeted/slowmode-second-send`; with BypassSlowmode the same, `...-bypass`). `Observed.slowmodeAppliesToBots`
  stays `false`, now with a witness the replay requires.
- **M4, §3.2: Discord checks a send's payload flags before a thread's lock.** A member of a locked thread with View
  and SMIT sending an embed without EmbedLinks got 403 50013 (`send/targeted/order-locked-embed`), EmbedLinks' code;
  with EmbedLinks granted the same send got the lock's 50001 (its flip control). `ThreadLocked` now ranks after the
  payload flags ("Design deviations").
- **M4, H-005 and H-007 confirmed with an `@everyone` overwrite allow as the grant:** View and Send allowed only by
  the `@everyone` overwrite let the subject send (`send/targeted/overwrite-everyone-allow`), and a role overwrite
  deny of Send beats that allow (403 50013, `...-role-deny`).
- **M4, H-021 and H-067: timing out an Administrator answers 403 50013 even when it ranks below the bot**
  (`member/targeted/timeout-admin-below`: the target holds `lab-admin`, below the subject's `lab-mid`, and the
  subject holds ModerateMembers), so `TargetIsAdministrator` stands on its own.
- **M4: a timeout does not stop deleting one's own message** where the subject can see the channel, in a text
  channel and in a thread (`message/targeted/delete-own-timed-out`, `...-thread`, both 200), so `message.deleteOwn`
  and `message.deleteOwn.thread` rightly omit `CommunicationDisabled`.
- **M4 (H-087, cleanup): Discord's message list can lag a bulk delete.** Right after the subject's bulk delete in
  `lab-voice`, the harness's listing still returned a deleted message, and deleting it answered 404 10008 (the M4
  verifier's first exit run). Cleanup now treats 10008 as done ("Design deviations").

Before M5, from the M4 verifier's minor findings (read-only probes and self-test runs, each alone under the lock):

- **The message-listing 429s come from paging, and the pages come from undeletable thread notices.** The three
  provisioned threads held 707, 638 and 157 messages, all bot-authored "added to/removed from the thread" notices
  (types 1 and 2, which Discord does not let anyone delete; reset leaves them, `undeletableTypes`), one or two per
  scenario that changes thread membership, so every reset pages through 2 to 8 pages per thread, more each run. A
  traced self-test showed every 429 (`GET /channels/{id}/messages`, scope `user`) on the sixth consecutive page of
  one thread, with `limit 5`, `remaining 0` and `reset-after` 4.0 to 4.4 s. A single listing answers `limit 5`,
  `remaining 4`, `reset-after 1.000`, and listing every lab channel in turn, twice, never 429s: the bucket is per
  channel. dfx takes a route's first `remaining` (4) as its limit per `reset-after` window (1 s), so it let paging run
  at the harness's 5 requests per second. Reset now reads each page's headers (`Wire.bucketWait`) and waits for the
  bucket's reset before the next page when the bucket is empty ("Design deviations").

## dfx deviations

Where dfx got in the way and we wrapped or adapted it, and why.

- **M2: the base `HttpClient` handed to every dfx stack is ours** (`harness/Identities.ts`): the Lab guard, the
  global pacing bucket and the request, write and invalid-response counters run there, below dfx's own limiter,
  so they see every identity and every retry dfx makes after a 429 (dfx re-executes through the base client).
  dfx is unchanged; it just receives a wrapped client.
- **M2: GuildMedia channels are created through `rest.httpClient`.** dfx's generated `CreateGuildChannelRequest`
  has no type 16 (dfx.md §0), so provisioning sends all channel creates as raw JSON through the identity's
  authenticated, rate-limited `rest.httpClient` and decodes the response itself (`harness/Wire.ts`).
- **M2: the permission oracle goes through `rest.httpClient`** (`src/rest/Oracle.ts`): neither dfx 1.1.1 nor
  discord-api-types knows `GET /channels/{c}/permissions/member/{u}` (published 2026-10-30).
- **M2: dfx's 2xx bodies are re-decoded.** dfx casts every response to its generated type without validation, so
  the harness decodes each body it acts on with its own schemas (`harness/Wire.ts`), and startup decodes the
  user, application and member it reads; a mismatch is a defect.
- **M2: dfx's `DiscordRestError.code` is never read** (it is `undefined` at run time, dfx.md §3);
  `src/rest/ErrorMap.ts`'s `classify` reads `e.data.code` and decodes the body with Schema.
- **M3: the bot build re-composes nothing in dfx, but orders its layers.** `BotInternals.layerWith` builds dfx's
  `DiscordRESTMemoryLive` first, runs the startup checks and builds `GuildState` over it, and only then
  `DiscordLive` with our `DispatchHook`; dfx's own `DiscordRESTLive` inside `DiscordLive` is the same memoised
  instance within the build's `Layer.fresh` (probed: the client the checks used and the one `SubjectRaw` exposes
  are the same object), so the gateway, the library and step (c) share one client. dfx has no ready signal, so
  the build waits for GUILD_CREATE in the state the hook feeds (check 4).
- **M5: the coded-429 interceptor wraps the base client of every bot build** (`src/rest/Coded429.ts`, G2;
  `BotInternals.layerWith` provides it over the base client it leaves open). dfx retries every 429 forever; a 429
  whose JSON body has a nonzero `code` now fails with `HttpClientError(StatusCodeError)` carrying a `Coded429`
  (code, message, `retry_after` in ms, global) before dfx's response handling sees it, so dfx neither retries it
  nor updates its rate-limit bucket from that response. Uncoded 429s (and code 0) pass through unchanged and dfx
  retries them as before. `ErrorMap.classify` turns the `StatusCodeError` back into a 429 answer with the code. The
  harness's subject is that build, so `SubjectRaw` (step (c)) now sees a coded 429 as a refusal with its code
  instead of a dfx retry; no M4 row met a coded 429, so no recorded row changes.

## Design deviations

Where an implementation changed a decision in `docs/DESIGN.md`, with the evidence. The design is updated in
the same commit.

- **M0: rules claim directives by mention (`Rule.claims`, §5.5).** The design's `Rule` linked a rule to a
  fail fixture file only, but §5.5 (review finding L15) requires that *every directive* be claimed by a rule.
  Fixture files hold several rules' directives (`[sd:src/fail/channel-kinds.ts]` covers no-send-category,
  no-send-forum, crosspost and thread-op absence), so with file-level claiming any one rule pointing at the
  file would "claim" all of them and L15 would not be enforced. Smallest fix: `claims`, the non-empty list of
  directive mentions in `fail` that the rule owns. A claim must be a directive mention in that file and appear
  in its snapshot; a directive whose (file, mention) no rule claims fails rules-check.
- **M0: the trivial fixtures are a real rule.** With an empty registry, any fail fixture's directive would be
  unclaimed and rules-check would fail, so "empty registry allowed" and "one fail fixture" cannot both hold.
  The M0 fixtures are therefore `R-catch-tag-exact`'s (pure-typing, in the §5.5 allowlist), built on
  fixture-local `Schema.TaggedError` classes; M1 adds library-error assertions. This brought `test/rules.ts`
  and the `Observation` schema (`harness/scenario/Dsl.ts`, copied from `[sd:src/verify.ts]`) into M0.
- **M0: staged checks are reported, never silently passed.**
  - `verify:offline` prints `gen:errors` as "not built yet" until `scripts/gen-errors.ts` exists (M1; M1's
    exit also runs `gen:errors -- --check` on its own).
  - `budget` prints "nothing to measure yet" until the reference bot (M10) or the command probes (M8) exist.
    Each row then needs its baseline entry, and a baseline entry without its projects fails. The probe paths
    were unspecified; they are `examples/command-probe/tsconfig.{none,commands}.json` (§5.4).
  - `rules` fails closed on any `pair` rule until M6 adds the catalog and truth-table checks, and prints the
    flag-coverage (M6) and events (M7) checks as "not checked yet" (§5.5, §6 M6/M7).
- **M0: the native compiler is resolved per platform** (`@typescript/typescript-<platform>-<arch>`, as
  `typescript/lib/getExePath.js` does) instead of the hard-coded `typescript-linux-x64` path in §5.3, so the
  offline checks also run on the MacBook. On minisforum it is the same binary.
- **M1: the ID-mixing fail fixture moves to M6, with `R-ids-distinct`.** §6 M1 listed "fail fixtures for ID
  mixing", but the rule that must claim the directive, `R-ids-distinct`, has a live pair (§5.5), and a `pair`
  rule fails rules-check closed until M6 adds the live-pair checks. Evidence, with a temporary
  `test/types/fail/ids.ts` copied from `[sd:src/fail/ids.ts]` (removed after): its diagnostic passes the gate
  (`Argument of type 'string & Brand<"UserId">' is not assignable to parameter of type 'string &
  Brand<"ChannelId">'.`, 4 lines, 386 gated characters), but `bun run rules` exits 1 with
  `directive mention "ChannelId" is not claimed by any rule`, and with the rule registered as its §5.5 pair it
  exits 1 with `has a live pair, which this rules-check cannot verify yet`. Either way `verify:offline` would be
  red for M1-M5. Weakening the fail-closed staging, or listing the rule as pure-typing, would loosen a gate, so
  the fixture moves to M6, whose scope already has "type fixtures ... for §2.1" and "the registry entries". M1
  keeps the type-level proof as a pass fixture: `test/types/pass/ids.ts` asserts that no brand is assignable to
  any other (all 90 ordered pairs), that a plain `string` is none of them, and that `make` returns the brand.
- **M1: `voice.pins` lists `CommunicationDisabled`.** The prototype row (`[sd:src/ops.ts]`) omitted it, but §2.4
  puts the tag in every row whose flags the timeout mask removes (everything but ViewChannel and
  ReadMessageHistory, H-020), and `voice.pins` needs Connect. The new table-invariant test
  (`test/unit/operations.test.ts`) failed on exactly this row (`listsCommunicationDisabled: false` for
  `voice.pins`). §2.4's "pins" exception now reads `channel.pins`.
- **M1: `channel.pins`, `voice.pins`, `thread.join` and `thread.leave` list `PermissionDeniedUnattributed`.** The
  prototype rows omitted it, but §3.1 raises it from "every op that can return 50013/50001", and §4.9 sends a
  50001 through the recompute, which returns `PermissionDeniedUnattributed` when the fresh state shows nothing
  missing. All four are guild requests that return 50001 without View (H-080), so the recompute can produce
  the tag; without it in the row the type would not name a failure the runtime produces (M5's op-errors test
  would also have caught it). Only `dm.send` and `permissions.require` omit it; a unit test asserts exactly
  that.
- **M1: the transient classes type their cause as one member of `ErrorCause`.** `RequestTimedOut` and
  `NetworkError` take `NoResponse`, `DiscordUnavailable` and `RateLimited` take `DiscordResponse`, as §2.2 and
  §3.1 describe them, instead of the prototype's `ErrorCause`. Nothing else can produce them, so a transient
  error with a preflight cause is no longer representable.
- **M1: `ErrorCategories` covers the classes `errorFor` can build** (the 52 generated classes and the 2 D5
  variants, keyed by class name). §2.2 said "every class"; the generator knows only the permission flags and
  the variants, and duplicating the hand-written classes' categories in it would add a second source.
  `test/types/pass/error-categories.ts` checks each entry against `Categories<>` of its class, and
  `test/unit/d6-invariant.test.ts` reads every other class's marker. §2.2 is clarified.
- **M1: `errorFor` is an overload.** As an arrow function typed `OpPermissionErrors[Op][F]`, tsc rejected the
  body (TS2375, then TS2719 when spelled through `VariantErrors`), because the property read
  `Operations[op].variant` widens to every row's variant for a generic `Op`. Rule 7 of §2.12 is the pattern
  for this: the public signature returns `OpPermissionErrors[Op][F]` over a wide implementation, and
  `test/unit/error-for.test.ts` checks every (operation, flag) at run time. `test/types/pass/operations-table.ts`
  asserts the precise return (`errorFor("channel.send", "ReadMessageHistory", cause)` is
  `MissingReadMessageHistoryForReply`). §4.7 says so.
- **M1: `src/permissions/Observed.ts` arrives in M1** with only `slowmodeAppliesToBots: false` and
  `botsCanBeTimedOut: true`, because `TagClasses` maps the gated tags through them (§2.4). M3/M4 add the
  other constants (`codeForLevel`).

- **M2: the Lab guard runs in the shared base `HttpClient`, as a route allowlist** (§5.6 clarified). §5.6 asked for
  a guard on every identity's writes and a "narrow `Lab` interface" for the harness. One guard below every dfx
  stack covers all identities, `SubjectRaw` and (from M6) the library's own operations at once, and cannot be
  bypassed; the narrow interface is its allowlist of the routes the lab needs. `test/unit/lab-guard.test.ts`
  checks each refusal. Kick and ban are refused outright until M4 adds the harness-side failure prediction.
- **M2: the subject is a REST-only identity, and the READY and sent-intents identity checks are staged** (§4.4 and
  §6 M2 updated). M2 has no gateway (the library's bot layer arrives in M3, the codec in M7), so `SubjectRaw`
  is a fresh REST stack like `HarnessRest` and `TargetRest` (its tag lives in `src/bot/Internals.ts`, where
  M3 builds it from `BotInternals.layerWith`), and `harness:smoke` prints the two gateway checks as "not
  checked yet".
- **M2: `src/bot/Startup.ts` (`restChecks`, checks 1-3 of §4.4) and `src/rest/ErrorMap.ts` (`classify`, the dfx
  failure shapes of §4.9) arrive early**, because "the startup checks for three identities" is M2 scope. M7
  calls `restChecks` from `Bot.layer`; M5 adds the error table on top of `classify`. A member read answering
  403 50001 is also mapped to `not-in-guild` (unverified live: Perms Lab is the only guild the bots may touch).
- **M2: `harness/Wire.ts` and `harness/Smoke.ts` are new modules** (§1.2 updated): the harness's response schemas
  and raw-request helper, and smoke's oracle reads and the read-only `inventory` command.
- **M2: thread membership baseline covers every provisioned thread** (§5.7 step 5 updated). §5.7 named only the
  subject's membership of `lab-private-thread`. The subject now starts as a member of no provisioned thread
  (sending auto-joins it, H-034, so a public-thread row would otherwise leak into the next), and the target as a
  member of all four, so it can post fixtures in the private thread (it has no ManageThreads).
- **M2: role positions require distinct positions, and the position PATCH carries the harness's role** (§5.7
  updated, with the guard's positions-only admission of that role). Evidence in "Live findings".
- **M2: `lab-media` is recorded as unavailable instead of failing provisioning** (§5.7 updated). `.lab-state.json`
  gained `unavailable` (name to the status and code Discord gave), and §5.10's `kind-not-available` covers the
  scenarios.
- **M2: reset leaves undeletable system messages, deletes old bot messages singly, and restores parents, overwrites
  and lab-role permissions** (§5.7 updated). Evidence for the first in "Live findings"; the rest makes "a second
  reset makes zero writes" hold after scenarios that edit those settings. A subject or target holding a non-lab
  role fails the reset with `LabCheckFailed` instead of being edited (the guard would refuse it, and such a role
  would grant permissions the matrix does not control).
- **M2: `lab-admin` holds Administrator at baseline** (§5.7 updated): it is the `administrator` grant source and is
  only ever assigned by a scenario; every other lab role has no permissions at baseline.
- **M2 (verifier fixes): the Lab guard checks request bodies where a route alone admits writes outside the lab**
  (§5.6 updated). The M2 verifier probed `verdict` with an armed state and got `Allow` for
  `PATCH /guilds/{g}/channels` with `[{id: rules, position: 0, parent_id: lab}]`, for
  `PUT /channels/{lab}/thread-members/{rhys}`, and for `PATCH /guilds/{g}/members/{target}` with
  `{roles: [foreign role]}`. Now the channel-list PATCH is refused outright (nothing needs it); a channel create
  needs a `lab`/`lab-*` name and a lab parent; thread membership changes only for `@me`, the subject and the
  target; member edits may carry only `nick` and `communication_disabled_until` (roles go through the per-role
  routes, which check each role); a role create needs a `lab-*` name; AutoMod deletes need a rule named `lab-*`
  that reset listed and admitted. A body these routes cannot read is refused. Each case is in
  `test/unit/lab-guard.test.ts`, including one through real `HttpClientRequest.bodyJson` requests, and each
  check was mutated away once to see its test fail.
- **M2 (verifier fixes): smoke fails on a bad oracle result** (§6 M2 updated). It used to print `DIFFERS` and exit
  0. Now an available oracle fails smoke with `LabCheckFailed` when the control is not exactly `lab-target`'s
  allow, when the subject holds any flag at baseline, or when only some reads (the control included) answer.
  An unavailable oracle is still a recorded, non-failing outcome (§5.10).
- **M2 (verifier fixes): `Credentials` exports only layers** (§4.3 updated). `config` and `dotEnvPath` were
  exported, so code could read `.env` through `fromDotEnv` without the lock. Now `layer` (the repository's
  `.env`, the host's lock) and `layerFrom({dotEnvPath, lockPath})` are the only ways in, and
  `test/unit/credentials.test.ts` builds `layerFrom` with temporary files: a held lock gives `LockHeld` both
  with a valid `.env` and with none at all (where a free lock gets a `PlatformError` from reading it), so the
  lock is taken first.
- **M2 (verifier fixes): only GuildMedia's 400 50024 is recorded as unavailable** (§5.7 updated).
  `LabIds.optionalChannelTypes` holds the kinds a guild may lack (16); a 50024 on any other kind fails
  provisioning with `LabRequestFailed`.
- **M2 (verifier fixes): reset unpins every pinned message it does not delete** (§5.7 step 6 clarified), not only
  messages by humans, so a pinned forum-post starter or undeletable system message is unpinned too
  (`planUnpins`).
- **M2 (verifier fixes): vitest refuses to run under the Bun runtime** (§4.3 updated). The verifier found that
  `bun --no-env-file node_modules/.bin/vitest run` starts Bun workers without `--no-env-file`, which load `.env`
  (`env-isolation.test.ts` failed there). `vitest.config.ts` now throws under Bun before any worker starts;
  `bun run test` runs vitest under Node, as before.

- **M2 (verifier fixes, round 2): reset restores thread slowmode** (§5.7 step 4 clarified). The M2 verifier set
  `rate_limit_per_user: 5` on `lab-public-thread`; reset left it, and the next reset reported `writes: 0` with
  the lab off baseline, because `threadPatch` covered only name, archived, locked and auto-archive. Now
  `threadPatch` also sets slowmode 0 (`test/unit/reset-plan.test.ts`). Of the §5.8 `channelSettings` fields, a
  thread has `nameVariant` (restored) and `slowmode` (now restored); `requireTag` is the parent forum's flag,
  which `channelPatch` restores. Threads have no overwrites or parent to restore.
- **M2 (verifier fixes, round 2): the reset self-test is a committed command and part of M2's exit**
  (§5.1, §5.7, §6 M2 updated). `bun run harness:selftest` (`harness/SelfTest.ts`) replaces the git-ignored
  `.scratch/m2/dirty-lab.ts` (deleted). It resets, reads the lab back (must be at baseline), applies 13 dirt
  steps through the guarded identities, reads back (each step's expected problem must be reported, so a blind
  read-back fails), resets, reads back (no problem may remain) and resets again (zero writes). The read-back
  (`baselineProblems`) judges from the spec in `LabIds.ts`, not from reset's patch functions; it is unit-tested
  in `test/unit/selftest.test.ts`. Live evidence in the M2 milestone notes below: with the slowmode fix
  removed, the self-test failed with exactly `lab-public-thread slowmode (5)`.
- **M2 (verifier fixes, round 2): the guard reads thread and sticker bodies** (§5.6 updated). A thread create
  (`POST /channels/{lab}/threads`, `POST /channels/{lab}/messages/{id}/threads`) needs a `lab`/`lab-*` name, so
  reset can always tell a scenario thread; a sticker create needs a `lab-*` name, read from its multipart form,
  and sticker edits and deletes are refused. `verdict` now takes a `RequestBody` (`None`, `Text`, or a form's
  string fields) instead of the JSON text; a thread create sent as a form (a forum post with files) is refused,
  since its JSON is in a `payload_json` blob the guard cannot read synchronously. New verdict cases cover these,
  the overwrite sub-route (`/permissions/{id}/x`) and a real `bodyFormData` request.
- **M2 (verifier fixes, round 2): smoke fails when it would skip a lab channel** (§6 M2). `oracleTargets` fails
  with `LabCheckFailed` when a channel or thread in the spec has no stored ID and is not recorded as
  unavailable; `oracleReads` takes the loaded state, so `test/unit/oracle.test.ts` checks that it reads every
  channel and thread but the category and `lab-media`, the subject in each, and the target in `lab-text` for the
  control.
- **M2 (verifier fixes, round 2): `IdentityCheck.run` and the invalid-response count have offline tests.**
  `test/unit/identity-check.test.ts` runs the real wiring (`compose`) over a fake that answers per token: the
  success case (protected channels include the guild's rules channel even when it has a lab name, so it cannot
  be admitted) and six failures (another application's token, two tokens of one bot, another guild name, no
  `#rules`, no `#mod-updates`, a role above the harness's), each a `LabCheckFailed` that leaves the guard
  unarmed, so the next write is refused unsent. `test/unit/identities.test.ts` answers a 403 and a 429 (which
  dfx retries) through `compose` and sees `invalid: 2`.

- **Before M3 (the M0-M2 verifiers' minor findings):**
  - the type-test gate rejects an empty `@valid` block (no code line before the next directive), and runs tsc
    with `--listFiles` so a fixture missing from the program fails (§5.2 updated); each was mutated once: a
    tsconfig without `pass` now fails with `not in the compiled program` for every pass fixture;
  - `env-isolation.test.ts` asserts the resolved `envDir` is `test/env` holding only `.gitkeep` (Vite exposes
    only `VITE_` names, so the old `import.meta.env` check could not see an `envDir` regression);
  - `test/types/pass/error-categories.ts` pins the transient classes' `cause` types (M1's narrowing); widening
    `NetworkError`'s cause back to `ErrorCause` now fails `test:types`;
  - the self-test read-back has offline cases for a missing stored role and thread, `@everyone` absent,
    managed-role permissions, and a bot's type-6 pin notice as the only leftover (adding 6 to the system types
    now fails the test);
  - the guard reads a channel PATCH body (§5.6 updated): its `permission_overwrites` may name only lab roles,
    `@everyone` and the two bots (the per-overwrite route's rule), and its `parent_id` only a lab channel. M3's
    Converge sets overwrites through that PATCH;
  - the host-local lock limit is recorded under "Notes for every milestone";
  - the registry item was done by the orchestrator, outside the rift.

- **Before M4 (the M3 verifier's minor findings):**
  - offline cases for the pieces M4's replay depends on, each checked by applying the verifier's mutation and
    seeing the new test fail (18 mutations, all red, then reverted): `Resolver.inputFromSnapshot` (the unseen
    lookup, a thread under an unseen or missing parent, thread membership from the state's own map, each
    `NeedsRefresh`), `TruthTable.resolverRecord` and `levelOf` (missing after and before the masks, the voice
    Connect level), `GuildState.refresh` (membership from the REST thread's `member` field, the parent commit,
    `unseen` cleared by a later fetch), the reducer clearing `unseen` on a channel or thread event,
    `projectionProblems` (a hidden channel's real overwrites, the thread's state and membership),
    `Converge.readbackProblems` (role and `@everyone` permissions, thread membership), Safety's held-role
    MentionEveryone check, the reply readback, preflight's `degraded` read from the effective set, and a test
    that builds two bots in one layer graph (removing `Layer.fresh` from `BotInternals.layerWith` gives both the
    first token);
  - agreement compares ViewChannel with the oracle on `unseen` rows too, except a private thread the subject
    does not belong to (§5.10 updated). The full exemption M3 used was justified only by those rows: 7 of
    M3's 8 unseen rows were threads under a parent that hides View, where the comparison is well defined;
  - `send/targeted/locked-thread-member` separates the lock from a refused auto-join (H-036 reworded above), and
    `send/targeted/{poll-without-send-polls, reply-without-history, tts-without-tts-text, tts-without-tts-voice}`
    give SendPolls, a reply's ReadMessageHistory and TTS a row of their own outside threads (H-100 and H-102
    reworded above);
  - the runner prints the escalated rules from the registry (`scripts/lib/rules.ts` `escalatedRules`) instead
    of a fixed line, rules-check's staged flag-coverage message names what it now waits for (M6), and the runner
    checks every pairwise selection at run start (`Pairwise.selectionProblems`: valid rows, every valid pair and
    value covered, deterministic), which the catalog test also runs, so §5.9's "the run checks every selected
    row" holds.

- **M3: `--only` writes and compares a subset table, never `fixtures/truth-table.json`** (§5.1 updated). §5.1 said
  `--only` never writes the table, but M3's exit runs `--only 'send/**' --write` in two processes, the second with
  `--compare`. With `--only`, `--write` writes `/tmp/effect-discord-perms-truth-table.only-<glob slug>.json` and
  `--compare` compares with that file from a previous process; a missing previous table fails the comparison.
  The committed table is written only by a full run (M4).
- **M3: a fourth mask, `unseen`** (§4.5, §4.6, §5.10, §5.12 updated): a channel the subject's state lacks and a
  refresh could not fetch (`getChannel` 50001 or 10003), or a thread whose parent is unknown. §3.1 already said
  such a channel has no View; the mask names it, because "obfuscated" means Discord delivered the channel with
  flag `1 << 17`, which is not what happened. Agreement compares nothing with the oracle on an unseen row: the
  subject knows none of its overwrites, and the oracle's `implicit=false` ignores thread membership (the private
  thread a non-member cannot see reads as fully granted there).
- **M3: step (a) refreshes a scenario thread first** (§5.10 updated): so the subject's view of it is a function of
  the setup (fetched when visible, unseen when not), not of which events earlier scenarios delivered, and M4's
  replay can rebuild it from the setup. Without it the same setup could resolve with `implicit-view` (a thread
  the state kept from an earlier scenario) or `unseen` (one it never had).
- **M3: preflight lists independent problems** (§4.7 updated): a flag an implicit mask removes only because of
  another problem (no View, no Send, no Connect) is not a separate failure, so a flip control's next-ranked
  failure is real; `CommunicationDisabled` is a failure whenever the timeout applies and the request needs a
  flag it does not keep.
- **M3: the snapshot's generations are one per-guild map, and thread membership is its own map** (§4.5 updated):
  the map keeps a deleted entity's generation, so a refresh racing a delete and a re-create cannot commit; the
  membership map exists because THREAD_MEMBERS_UPDATE can arrive before its thread. A private thread the bot is
  removed from is dropped. The refresh reads the roles from `getGuild` (which carries them) instead of also
  calling `listGuildRoles`.
- **M3: `harness-message`, a new fixture** (§5.8 updated): a reply's target, posted by the harness, which can post
  in voice text chat where the target cannot without Connect.
- **M3: the send family's validity also excludes `missing=payload` for a guild sticker** (§5.9 updated): a guild
  sticker needs no flag (H-138), so the prototype's predicate let through rows with nothing to remove; the
  fixed family selects 89 rows instead of 88. With 14 targeted rows the send catalog has 103.
- **M3: Converge reads only the channels that may be off baseline, and changes thread membership with View**
  (§5.8, §5.10 updated): see the two live findings above (the channel-list 429s, the 50001 on adding a member who
  cannot view the parent). An administrator is never timed out: lab-admin is taken while the timeout is applied
  and given back after (§5.8's order), and when the role ends the timeout the row is `admin-exempt`.
- **M3: the harness's subject is the library's bot build** with intents Guilds and GuildMembers (Message Content
  waits for M7's intent catalog); `harness/IdentityCheck.ts` takes the subject's identity from that build's
  startup checks and now checks the READY user. The identity test (`test/unit/identities.test.ts`) and the
  identity-check test run over the real build with a fake gateway (`test/support/fakeGateway.ts`), which M7 had
  planned; `test/unit/bot-build.test.ts` covers the build's order (checks before the gateway), the hook, and
  `invalid-token` and `guild-not-ready`.
- **M3: modules the design did not name** (§1.2 updated): `src/state/Snapshot.ts` (the snapshot types and channel
  kinds), `src/rest/Request.ts` (one bounded dfx call, classified; M5's `DiscordApi` builds on it),
  `harness/Runner.ts` (the `run` command), and `src/bot/Bot.ts` with only `Bot.make` and `BotRuntime` (M7 adds the
  rest). `src/payload/PayloadRules.ts` arrives with the table and its flag lookups only (M6 adds the types), its
  keys in §3.2 order. `src/rest/ErrorMap.ts` gains `dedicatedCodeTags` (the start of M5's table) for the raw
  outcome's `mappedTag`, and `Observed.codeForLevel` arrives for `level-vs-raw`.
- **M3: setup groups are ordered by their canonical setup JSON**, which clusters equal channels and grant
  sources; §5.10 asked for an order that minimises writes, and this is a deterministic proxy for it, not an
  optimiser. The full send run made 563 writes for 103 scenarios.
- **M3: the dry-run stub is built but step (b) does not use it yet** (§6 M3 says (b) is `decide` until M6): the
  shared client applies the Lab guard, then answers a canned body (`fixtures/canned/create-message.json`) and
  sends nothing, unit-tested in `test/unit/dry-run.test.ts`.

- **M4: the operation table changed from the findings above** (§2.4, §4.7 updated): `thread.delete` (the threads
  family deletes the subject's own threads, and the table had no row for it); `thread.unarchive` (H-038);
  `message.edit.voice`, `message.deleteOwn.voice`, `message.deleteForeign.voice` and `voice.bulkDelete` (Connect);
  `message.deleteOwn.thread`, `message.deleteForeign.thread` and `thread.bulkDelete` (`ThreadArchived`); SMIT in
  `thread.setArchived`, `thread.setLocked` and `thread.edit`; ReadMessageHistory in the pin, unpin and crosspost
  rows and out of the react rows; `ThreadArchived` out of `thread.join`, `thread.leave` and `thread.addMember`,
  `ThreadLocked` out of `message.edit.thread`; `message.pin.voice` and `message.unpin.voice` removed; `thread.leave`
  requires nothing. 47 rows (M1 had 40). Three optional row fields carry what a flag list cannot: `degrades` (the
  pins list's ReadMessageHistory, reported as `degraded`), `blockedByTimeout` (an own edit, a reaction) and
  `viewLevel` (ReadMessageHistory for pin, unpin and crosspost, ranked with View, §3.2 tier 1). Each row's type is
  pinned in `test/types/pass/operations-table.ts`. The public signatures that use these rows arrive in M6, which
  must map each kind to its `.thread`/`.voice` row and drop `pin`/`unpin` from voice and stage messages.
- **M4: the resolver record's `level` counts every failure** (§5.10 updated): `action` when the bot can see the
  channel and preflight found any failure, the timeout, the hierarchy and a thread's state included; `view` also
  when a row's `viewLevel` flag is missing. M3 counted only missing error-mode flags, so a locked thread with every
  flag was `none` and its 50001 could only be a `level-vs-raw` mismatch.
- **M4: the observed codes are per operation** (§5.10, §8 item 2 updated): `Observed.viewCodeFailures` lists the
  first failures Discord answers with 50001 at the `action` level, and `Observed.expectedCode` gives the code
  agreement and the replay check. One mapping per level could not hold: in a text channel a missing SendMessages
  answers 50013, in a crosspost 50001.
- **M4: the oracle's timeout mask is `Observed.oracleAppliesTimeout`** (§8 item 9 named an `OracleScope`
  module): one more decided constant, held to the table by the replay like the others.
- **M4: member operations resolve at guild level** (§4.6 updated): `ChannelInput` `Guild` applies the base
  permissions and the timeout mask, no overwrites and no implicit rule, and step (a) reads the target member
  through `SubjectRaw` for the hierarchy, as the library's `Members.get` will. Member rows have no channel to read
  the oracle in, so their oracle is `not-applicable`.
- **M4: preflight takes the request's facts** (§4.7 updated): `DecideArgs` carries the reaction's emoji state, the
  target's and the assigned role's rank, whether the bot created the thread and whether a post is tagged, and
  `ChannelSnap.requireTag` (from the channel flag) feeds the new `TagRequired` failure. `scenario/Facts.ts` derives
  them for the matrix and the replay alike.
- **M4: new modules** (§1.2 updated): `harness/Predict.ts` (steps (a) and (b) from the setup alone, shared by the
  replay and the flip selection), `harness/Fixtures.ts`, `harness/Drivers.ts`, `harness/scenario/Facts.ts` and
  `catalog/{common,index}.ts`, plus the family catalogs §1.2 named (`createThread` lives in `catalog/threads.ts`
  with the threads family, the forum posts and the thread targeted rows; the flips in `catalog/flips.ts`).
- **M4: the subject's own fixtures are made before Converge, with temporary access** (§5.10 step 2 updated): a
  `subject-message` or `subject-thread` must be the subject's even in a setup that hides the channel or times it
  out. The harness lifts a leftover timeout and gives the subject a member overwrite on the overwrite channel;
  Converge, which reads the lab afterwards, replaces it. The DSL's fixtures changed (§5.8 updated): the
  foreign message, reaction and pin are the harness's (it can act in voice text chat), `target-role` gives a role
  removal's role, and M3's unused `target-message` and `crossposted-subject-message` are gone.
- **M4: the members family excludes two role collisions** (§5.9 updated): the lab has one role per position, so an
  add-role row never gives the target a role it already holds for its rank, and a remove-role row's target ranks at
  least as high as the role it holds to lose. 22 rows (the design had 21).
- **M4: the pins family has no voice or stage** (§5.9 updated): their text chat has no pins (above), so the
  channel dimension is text, announcement, a public thread and an archived one, and `connect` left the missing
  dimension. 18 rows (the design had 25).
- **M4: the flip controls are one per (operation row, first missing flag)** (§5.9 updated): §5.9's "every row
  where exactly one flag is the first missing flag" would flip nearly every failing row; the flag-coverage check
  of §5.5 needs one per (row, flag). The first family row in ID order whose prediction has the flag first and is not
  blind is flipped; the flip drops the flag from every removal and adds it to the first non-administrator grant.
  61 flips (this note said 57 until the M4 verifier caught it). `flip-control` is judged after the run against the
  original's live row (`Agreement.flipAgreement`), and `test/unit/facts.test.ts` checks offline that every flip's
  predicted failures are its original's minus the first.
- **M4: Converge also sets the target's roles and clears its nickname and timeout, and sets the scenario channel's
  slowmode and required tag** (§5.8). Cleanup restores the scenario thread before deleting messages, because an
  archived thread refuses message deletes (400 50083; the first trial run aborted on it).
- **M4: the lab has a guild emoji** (`lab_emoji`, §5.7 updated) for reactions with a guild emoji; the guard admits
  only `lab_` emoji creates and no emoji edits or deletes, and checks that a channel rename keeps a lab name (§5.6
  updated). It issues kick and ban permits as §5.6 describes (`LabGuard.permitKickOrBan`).
- **M4: Safety checks kick and ban rows and counts name and topic edits per channel** (§5.6); its target check
  resolves on the overwrite channel, since a thread the subject creates during the scenario has no ID yet, and it
  skips a channel the guild lacks (`lab-media`), where nothing is sent.
- **M4: the replay's catalog check.** Beyond §5.13 the replay requires the table's scenarios to be exactly the
  catalog's, each with the catalog's setup and operation, so a catalog change without a new live run fails it.
  `Limits` has no rows to be checked against yet: the limit probes are rule rows (§5.5), which arrive in M6 with
  `src/payload/Limits.ts`; M4 found nothing to change there.
- **M4: every lab step has a deadline, and every 429 is reported at once** (§5.10, §5.11): the first exit run sat
  idle for 15 minutes in its 53rd scenario (`send/announcement-thread/embed/role/view/role-overwrite-deny/timed-out`)
  with only the gateway socket open, which is dfx sleeping inside a harness call; harness calls had no deadline.
  `labStep` now fails after 90 s with status 0 (the command aborts naming the step), and the shared client prints
  `rate limited: <route> retry-after <s>` on stderr when a 429 arrives. The same scenario group then ran cleanly
  (`--only 'send/announcement-thread/**'`, no 429), so the stall did not reproduce; the run was stopped and the
  exit runs restarted.
- **M4: Discord allows 1,000 role edits per guild per day, and the matrix had used them** (§5.10, §5.11). The
  stall above, and a second abort 18 scenarios into the next run (`converge: lab-grant permissions`, no response
  within 90 s, no 429), are the role bucket: a no-op `PATCH /guilds/{id}/roles/{lab-grant}` answered
  `x-ratelimit-limit: 1000`, `x-ratelimit-remaining: 0`, `x-ratelimit-reset-after: 86371` (one more each time:
  a bucket that refills about one edit per 86 s). dfx takes the `remaining` of its first answer as the bucket's
  limit over the whole reset window, so a run that starts with fewer edits left than it needs stalls in dfx's
  own limiter without a 429. The runner's group order (§5.10's "ordered to minimise writes") now sorts setup groups
  by the role state they need first: a run makes 67 role edits, one per distinct role state, instead of 216. A
  full run must start with about 75 edits left in the bucket, which after a run takes about 1.8 hours of refill;
  the runner checks it before any scenario write (one no-op role PATCH, reading `x-ratelimit-remaining`) and
  fails fast with the wait instead of stalling.
- **M4: the truth table is committed by the implementer**, not the orchestrator (§6 M4), because the task requires
  a clean tree and the replay in `verify:offline` reads the committed file.

- **M4 (verifier): cleanup's message deletes are idempotent** (§5.10 step 9 updated). The verifier's first
  `bun run verify:live` exited 1 in its 198th scenario (`flip/message/voice/bulk-delete/op-flag/normal`) with
  `run FAILED: LabRequestFailed: Unknown Message {"step":"cleanup: delete in lab-voice","status":404,"code":10008}`:
  the subject's bulk delete had succeeded, and the harness's message listing right after it still returned one of
  the deleted messages, whose single delete answered 404 10008. The 195 rows before it matched the committed table,
  and the verifier's retry passed, so this is Discord's list catching up, not a state the setup controls. Cleanup
  and reset now share `Reset.deletePlanned`: a delete answered 10008 is skipped (the message is gone, which is what
  the delete wants), a bulk delete answered 10008 falls back to single deletes of its chunk, and every other refusal
  still aborts the run. Nothing is retried, and no row's outcome depends on it (cleanup runs after the raw call).
  `test/unit/cleanup.test.ts` covers the three cases; with either half of the fix reverted, its cases fail.
- **M4 (verifier): a `subject-prior-send` fixture and the H-053 rows** (§5.8, §5.9, §5.10 step 2, §5.13 updated).
  No M4 row sent twice under slowmode, so the replay's check (no row answered 20016) could not fail. The new
  fixture is a plain message the subject sends after Converge, under the setup's own permissions and slowmode (a
  refusal records `rejected-by-discord` with its code), and `send/targeted/slowmode-second-send` and
  `...-bypass` send again in `lab-text` with a 60 s slowmode, without and with BypassSlowmode. The slowmode is
  longer than the raw call's 30 s deadline on purpose: dfx retries every 429 after its `retry_after`, so a slowmode
  429 (20016) cannot come back as a late success; it would abort the run (a unit test holds the two constants
  apart). The replay now requires at least one witness (a send right after the prior send, under slowmode, without
  BypassSlowmode or Administrator, not timed out) and holds `Observed.slowmodeAppliesToBots` to it.
- **M4 (verifier): targeted rows for the gaps it found** (§5.9 updated): the §3.2 pair of tiers 5 and 6
  (`send/targeted/order-locked-embed`), `TargetIsAdministrator` on its own (`member/targeted/timeout-admin-below`),
  an `@everyone` overwrite allow as the grant (`send/targeted/overwrite-everyone-allow`, and with a role overwrite
  deny, `...-role-deny`; named `overwrite-*` so the reply flip control stays on `order-send-reply-history`, the
  first row in ID order for its key), and an own delete under a timeout with View, in a text channel and in a
  thread (`message/targeted/delete-own-timed-out`, `...-thread`). With the flip control the reordered row gained
  (next entry), 363 scenarios: 229 pairwise, 72 targeted, 62 flips; a run makes 68 role edits. The replay also
  asserts H-081 now (no 50013 or 50001 row carries inner errors).
- **M4 (verifier): `ThreadLocked` ranks after the payload flags** (§3.2, `Order.ts`). Revision 2 put it in tier 5,
  before the payload's flags. `send/targeted/order-locked-embed` (a member of a locked thread with View and SMIT
  sending an embed without EmbedLinks) answered 403 50013, EmbedLinks' code, where the lock alone answers 50001
  (`send/targeted/locked-thread-member`) and a missing EmbedLinks alone 50013, so Discord checks the payload's flags
  first: the row was a `level-vs-raw` mismatch under the old order. The lock now ranks last in tier 6. No committed
  row's prediction changed (re-judged offline), and the row gained a flip control (`flip/send/targeted/
  order-locked-embed`, EmbedLinks granted), which must then meet the lock. Whether `ThreadArchived` and
  `TagRequired` also come after the payload is untested: no M4 operation has both.

- **Before M5 (the M4 verifier's five minor findings):**
  - the reset self-test after `Reset.ts` changes: the M4 implementer did not run it after `3cb095f`
    (`deletePlanned`); it ran three times before M5 (below), each exiting 0, and its note under "Notes for every
    milestone" now says the exit checks include it;
  - the "Not covered by M4's rows" list now names every hypothesis of discord-semantics.md that no catalog row
    cites, with its reason or owner (M4 milestone notes; checked by taking every H-id of the doc, removing the
    catalog's citations and the list's, ranges expanded: none is left);
  - the subject's prior send is now required by the raw call (§5.10 step 2 updated): `Fixtures.subjectPriorSend`
    alone makes a `PriorSend` (a key private to `Fixtures.ts`; a forged literal is TS2322 `Property '[issued]' is
    missing`), `Drivers.rawCall` takes it and dies before sending anything unless it is `Sent` exactly when the setup
    has `subject-prior-send`, and the run log line records `after prior send <id>`. So `Runner.execute` cannot reach
    the raw call without asking for the prior send (a compile error), and `test/unit/drivers.test.ts` checks the
    order and the refusal through the fake REST seam (removing the check fails two of its cases);
  - reset's message listing waits for the per-channel bucket between pages (§5.11 updated; the finding is under
    "Live findings"). `test/unit/message-paging.test.ts` holds the next page back until `TestClock` passes the
    reported `reset-after` (removing the wait fails it). `Converge.cleanMessages` and the self-test's read-back list
    one page per channel, which never empties the bucket, so they are unchanged. The shared client's 429 report now
    also prints the scope and the bucket;
  - `PriorSend` has a `NotRequested` variant: a setup without the fixture no longer reports `Sent`.
  Live, in order: a read-only probe of the listing headers (every lab message channel twice, no 429); a self-test
  on the previous code with the 429 report's new fields (5 x 429 on `GET /channels/{id}/messages`, scope `user`,
  as the verifier saw); the same traced, which placed each 429 on a sixth consecutive page; a read-only count of
  each channel's messages by type; then the self-test on the fixed code: initial reset 0 writes, 13 dirt steps and
  37 writes, 34 problems seen, reset 28 writes, at baseline, second reset 0 writes, 344 requests, **0 invalid** (no
  429); and `harness:reset`: `writes: 0`.

- **M5: `DiscordApi` is §4.8's steps 3 to 5, not 2 to 5** (§4.8, §1.2 updated). Preflight (step 2) and the local
  checks and degradation readback (steps 1 and 6) stay in the operations (M6), which build a `Request` and call
  `DiscordApi.execute`. The request carries a `Recompute.Target`, §4.9's "handle": the operation row, the guild,
  a channel or guild scope, the handle's granted flags, the static `DecideArgs`, and what the recompute must read
  to complete them (`Completion`: nothing; the target member and the role for member operations; the message's
  reactions for a reaction whose emoji state was unknown). M6's preflight takes the same `Target`, so the two
  decide one request the same way.
- **M5: the error map is a code table plus the request's declarations, not a literal `(operation, status, code)`
  table** (§4.9 updated). `ErrorMap.Codes` maps each code to the statuses it comes with and its meaning; a code
  maps for a request only to a tag the request declares: one of its row's tags, a missing flag of its own
  requirements (160002 maps only for a reply), or a payload- or argument-derived tag its `LimitFacts` declare
  (`ErrorMap.limitFields` lists which an operation may declare, the runtime mirror of §2.3-§2.6). The operation
  half of the key is read from the operation table, the one source of the types, so the runtime cannot produce a
  tag the type does not name; `test/unit/op-errors.test.ts` enumerates every operation, code and status against
  the declared union. `Limits.ts` arrives in M6, so for now a request carries its lengths and limits in its
  `LimitFacts`.
- **M5: statuses.** The M4 matrix observed 403 for 50013, 50001, 160002 and 160005, and 400 for 50083 and 40067
  (`test/unit/error-map.test.ts` holds the table to every pair the truth table recorded). Every other status is a
  hypothesis from discord-semantics §8.1 and DESIGN §3.1 (20016: a coded 429 or 400, from §3.1; corrected before M6:
  this line said 10014 came with 400 or 404 "where the research lists two", but discord-semantics §8.1 and §3.1 give
  10014 only 404, and the 400 had no source, so `Codes` now lists 404 alone); a status outside the list is unmapped
  (H-082), so M6's rows decide them. A coded rate limit maps only with
  status 429 and a `retry_after` (`RateLimited` needs it); 30034 (`DailyCommandCreateLimit`) and the interaction
  codes (`InteractionExpired`) are left to M8's registration and M9's runner, which own them.
- **M5: a recompute that finds nothing returns the code's own error with `attributedBy: "code"`** (§4.9 clarified).
  §4.9 said the cause is the real response with `attributedBy: "recompute"`; that now holds for the errors the
  recompute's own decision picked, and the fallback (`PermissionDeniedUnattributed`, or the dedicated code's tag)
  says `code`, so a cause tells which of the two decided the tag.
- **M5: `GuildState.refreshGuild`** (§4.5 updated): member operations have no channel, so the recompute refreshes
  the bot's member, the owner and the roles alone; `refresh` and `refreshGuild` share one implementation.
- **M5: `Preflight.stateArgs` and `Preflight.Hierarchy` move into the library** from `harness/scenario/Facts.ts`:
  the thread's creator and the member hierarchy are what both the matrix's step (a) and the recompute complete a
  request with, so `Facts.complete` now calls the library's function (and keeps its own preconditions). The replay
  reproduces every row unchanged.
- **M5: `Preflight.toError` takes any `ErrorCause`, and `Preflight.toHandleError` applies D8** (a missing flag the
  handle granted is `PermissionRevokedSinceCheck`), for the recompute now and preflight in M6.
- **M5: the object schemas are `src/rest/Schemas.ts`, and the reducer and the refresh use them** (§4.11): the
  reducer's own channel, role and member schemas and the refresh's guild schema were moved there (the guild schema
  now also reads `id`, which GUILD_UPDATE and `GET /guilds/{id}` both carry).
- **M5: the deadline comes from `DiscordApiConfig`** (§4.1, §4.10 updated): a `Context.Reference` with the 30 s
  default, read when a bot is built, for the operations, the startup checks, the refreshes and the recompute's
  reads alike (`Internals.requestDeadline`, a constant, is gone).
- **M5: `UnmappedDiscordError` lives in `src/rest/ErrorMap.ts`**, not `src/errors/`: it is only ever a defect, never
  in an error channel, so it is not one of `ErrorClasses` (the D6 test's enumeration of error-channel classes).
- **M5: the `discord.rest` span** (§4.13 updated): `DiscordApi.execute` opens a child span with the route template,
  method, operation, guild and channel, below the operation's own span (M6). The recording-tracer test showed that
  Effect's HTTP client opens its own span below it, with `url.full` and the Authorization header redacted. Bot
  routes carry only IDs, but interaction webhook URLs carry the interaction token in their path: M9 must keep those
  requests out of that span (for example `HttpClient.TracerDisabledWhen`).

- **Before M6 (the M5 verifier's six minor findings).** Each new test was checked against the verifier's mutation
  (applied, the test failed, reverted), except where noted:
  - `GuildState.refreshGuild` now has its own case in `test/unit/state.test.ts`, over the real state and the
    scripted fake: it reads only the bot's member and the guild, commits the owner, roles and member, leaves the
    channels, the unseen set and the thread membership as the gateway left them, and clears `stale` (the member read
    dying without a channel fails it);
  - `ErrorMap.limitFields` is pinned by a table transcribed by hand from DESIGN §3.1 and §2.3-§2.6 in
    `test/unit/error-map.test.ts`, one case per operation row (dropping `poll` from `channel.send` or adding `topic`
    to `thread.edit` fails it); M6's `test/types/pass/op-errors.ts` pins the type side;
  - the deadline from `DiscordApiConfig` is tested through the real bot build with a 150 ms deadline: a stalled
    startup check fails with `discord-unavailable` and a `NoResponse` of 150 ms, a stalled guild-state refresh and a
    stalled recompute read (the target member of a refused role assignment) with `RequestTimedOut` after 150 ms
    (`test/unit/bot-build.test.ts`; hard-coding 30 s in `Internals.ts` or in `DiscordApi.make` fails them);
  - 10014's statuses are `[404]` (the LOG line under "M5: statuses" is corrected: discord-semantics §8.1 and DESIGN
    §3.1 list only 404, and the 400 had no source); M6's rows decide it if a reaction with an unknown emoji is run;
  - `Recompute.attribute` now logs at Warning, when it attributes nothing, every flag the bot lacks outside the
    request's requirements (DESIGN §4.9 says so; `test/unit/recompute.test.ts` captures the line);
  - an embeds path without an index (`embeds.title`) is unmapped (`test/unit/error-map.test.ts`), and
    `Preflight.stateArgs` marks the guild's owner (and a holder of an Administrator role) as an Administrator target
    (`test/unit/preflight.test.ts`). The verifier's owner mutation (removing `|| target is the owner`) still survives,
    and cannot be killed while `ResolverRules.ownerHasAll` is `true` (H-002): the owner's base permissions are then
    every flag, Administrator included, so the branch only matters if that rule flips. The new case pins the
    behaviour (the owner is an Administrator target, H-067) whichever branch provides it.

## Escalated rules

Rules with an escalated remainder, shown by `verify:live` as unmet Done criteria. None yet.

## Notes for every milestone

- Run the unit tests only with `bun run test` (or `bun run verify:offline`), which runs vitest under Node.
  `vitest.config.ts` refuses the Bun runtime, whose workers would load `.env`.

- Run `bun --no-env-file install`, not `bun install`: plain `bun install` loads `.env` into its own process
  (it printed `[0.26ms] ".env"` when M0 re-locked TypeScript), where dependency lifecycle scripts could read
  the tokens. Checked in M0: `bun run <script>` does not pass `.env` to the scripts it starts, and
  `bun --no-env-file` keeps it out of the process (probed with a throwaway `.env` in `/tmp`, counting names
  only).

- **The live lock is host-local** (`/tmp/effect-discord-perms-live.lock` on minisforum). There is no cross-host
  fencing (DESIGN §8 item 20): a process on the MacBook would take its own lock and could drive Perms Lab at the
  same time as one on minisforum. So live commands must only ever be run on minisforum.
- **Live commands** (minisforum only, one at a time; each takes the live lock through `Credentials`):
  `bun run harness:reset` prints `writes: N`; `bun run harness:smoke` runs the identity checks, reset,
  provision and the oracle reads; `bun run harness:selftest` is the reset self-test (below);
  `bun --no-env-file harness/main.ts inventory` lists the lab guild read-only.
  The lab's object IDs are in `.lab-state.json` (git-ignored). Deleting it makes the next reset delete every
  `lab-*` object and the next provision recreate them.
- **The matrix:** `bun --no-env-file harness/main.ts run [--only glob] [--write] [--compare] [--repeat N]`
  (`bun run verify:live` is `run --write --compare`). It runs the identity checks, reset and provisioning, Safety
  over every scenario's materialized state, the catalog in setup groups, and a closing reset, and prints one line
  per scenario (its raw class and any mismatch) and a summary. Per-scenario detail (message IDs, the oracle,
  step timings, 429s) goes to `/tmp/effect-discord-perms-live-<start ms>.log`. With `--only`, `--write` and
  `--compare` use `/tmp/effect-discord-perms-truth-table.only-<glob slug>.json`. The send catalog (103 rows) takes
  about 10 minutes and some 2,200 requests; it exits 1 while any mismatch remains. The whole M4 catalog (354
  rows) takes about 33 minutes, some 7,300 requests and 1,800 writes, about 220 of them invalid (the raw 403s).
- **Role edits are rate-limited per guild: 1,000 a day, refilled about one per 86 s.** A full run needs about 75
  (67 for its setups, plus resets); `run` checks the bucket at start and says how long to wait. Two full runs
  need about 1.8 hours between them. The reset self-test and smoke make a few each.
- **Crossposts are rate-limited per announcement channel** (about 10 publishes per hour). A full run publishes 4
  messages in `lab-announcement` in its first few minutes, so never start more than two full runs (or runs of
  `message/**` and `flip/**`) within one hour.
- **Reset self-test: re-run `bun run harness:selftest` whenever `Reset.ts` (or `LabIds.ts`'s baseline) changes,
  and record the run in that milestone's notes; it is part of the exit checks of any milestone that changes them.**
  The smoke and reset exit checks run on a clean lab, where a reset that wrote nothing would pass too. The
  self-test dirties the lab (role permissions and mentionability, a leftover role the target holds and the
  target without `lab-unmentionable`, the subject with lab roles, a nickname and a timeout, a leftover channel,
  bot messages in text, a thread, voice, stage and announcement, pins including the forum post's starter,
  `lab-text` slowmode and four kinds of overwrite, `lab-bots-only` out of the category, forum REQUIRE_TAG and
  tags, thread slowmode, archive, lock and auto-archive, the subject in the private thread and the target out
  of the forum post, archived public and private scenario threads, a subject guild command, and the target's
  nickname and timeout), checks the read-back sees all of it, resets, checks the lab is at baseline, and resets
  again expecting zero writes. When adding a field to reset, add its dirt step and its read-back check. It takes
  about 80 s and some 300 requests.

## Milestones

### M0 Tooling skeleton

- `typescript` is pinned to exactly `7.0.2` (D32); every script checks that the installed compiler is the pin.
- `package.json` has all the §5.1 scripts. `harness:*`, `verify:live` and `gen:errors` point at files later
  milestones write.
- `scripts/type-tests.ts` (§5.2): one `tsc -p test/types/tsconfig.json --pretty false`; the nine failure
  modes of type-testing §6; directives with TS codes, consecutive-directive blocks and `@valid` twins; the
  gate (4 lines, 800 characters after collapsing unions, the mention, banned texts, wrong-reason codes,
  truncation inside `UnhandledErrors<...>`/`Invalid<...>` found by bracket matching). Beyond the design, it
  also rejects `@ts-expect-error`/`@ts-ignore`/`@ts-nocheck` in fixtures, pass fixtures without an
  `expectTypeOf` or `Equals` assertion, malformed directives, `declare global`, and snapshots without a
  fixture.
- `scripts/hover.ts` (§5.3): the real `tsc --lsp --stdio` hover at every `//  ^?` marker, `<file>.hover.txt`
  snapshots, and `names: ...; no-object` expectations (`names` is required on every marker). Found while
  building it: the TS 7.0.2 language server rejects `shutdown` with `params: null` (`InvalidParams: expected
  no params, got null`), so requests without parameters omit the key.
- `scripts/budget.ts` (§5.4): five `--checkers 1` runs per project, identical counts required, median check
  time, ceilings 250k/60k/1000 ms, +2% and 1.5 x + 25 ms gates, the per-command row from the two probes, and
  the baseline's TypeScript version. Exercised with temporary projects (removed): baseline write, pass
  against it, +275.8% instantiations rejected, a lone probe rejected, a baseline row without its projects
  rejected, a project that does not compile rejected.
- `scripts/rules-check.ts` (§5.5) and `test/rules.ts` with `R-catch-tag-exact`.
- `scripts/verify-offline.ts` (§5.1) takes no arguments, so it can never pass `--update`.
- The scripts' logic is in `scripts/lib/*` and covered by `test/unit/*` (62 tests in all, including
  `test/unit/env-isolation.test.ts`, which asserts no `DISCORD_` variable is visible to unit tests).
- Exit evidence: `bun run verify:offline` exits 0 (1 pass fixture, 1 fail fixture with its `@valid` twin,
  1 hover marker). Temporary fail fixtures with a wrong mention, a wrong TS code and a missing import
  (`Cannot find name 'UserId'`, TS2304) each made `bun run test:types` exit 1 with exactly that gate reason,
  with their snapshots written first so the snapshot check could not be the cause. They were removed after.

### M1 Errors, categories, IDs, operation table

- `src/Snowflake.ts`: the ten branded IDs; `X.make` throws on a malformed snowflake (unit-tested).
- `src/errors/`: `Category.ts` (the `[cc:src/category.ts]` port: `withCategory`, `hasCategory`,
  `catchCategory`), `Cause.ts`, `Missing.generated.ts` (52 classes, `PermissionFlags`, `PermissionErrors`,
  `missing`, `MissingClasses`, `ErrorCategories` with 54 entries), `Variants.ts`, `Permission.ts`, `State.ts`,
  `Payload.ts`, `Transient.ts` (with the `Transient` union), and `index.ts` (`ErrorClasses`,
  `PermissionErrorClasses`, `AllErrors`). Each hand-written module exports a `*Classes` record so the D6 test
  enumerates every class; a unit test checks the record matches every error class the barrel exports.
- `scripts/gen-errors.ts` with the pure `scripts/lib/genErrors.ts`. It reads `PermissionFlagsBits`, drops
  `ManageEmojisAndStickers` (H-059), and refuses an unlisted alias (two names on one bit), a listed alias that
  aliases nothing, and a category-table flag that does not exist. `--check` exits 1 on a missing or stale
  module, naming the first different line (checked by hand-editing a doc comment: `stale from line 99`, exit 1).
  Never edit `src/errors/Missing.generated.ts`; run `bun run gen:errors`.
- `src/permissions/Operations.ts`: the 40-row table, `TagClasses`, `VariantErrors`, `OpFlags`, `OpTags`,
  `OpPermissionErrors`, `Revoked`, `OpErrors<G>`, `variantConstructors` and `errorFor`.
- Unit tests: `category.test.ts` (marker on the prototype, non-enumerable, frozen and non-configurable, not
  encoded, survives a decode, inherited without mutating the base; runtime catchCategory), `error-for.test.ts`
  (every one of 40 x 52 (operation, flag) builds the exact promised class, tag, flag and `ErrorCategories`
  categories), `d6-invariant.test.ts`, `operations.test.ts` (TwoFactorRequired exactly on 2FA-starred rows,
  CommunicationDisabled on every timeout-masked row, PermissionDeniedUnattributed on every guild request, View
  first and Connect second, variants, ThreadArchived never on send), `gen-errors.test.ts`, `snowflake.test.ts`.
- Type fixtures: pass `catch-tag-exact.ts` (now with library errors and the same-tag variants),
  `catch-category-exact.ts`, `operations-table.ts` (one exact union per row of `OpErrors<never>`, D8, D5,
  Observed gating, `errorFor`'s precise return), `error-categories.ts` (the mirror equals the type-level
  categories; D6 at the type level), `ids.ts`; fail `catch-category-exact.ts` (an absent category, alone, in a
  list, and data-first; each names the category, largest 325 gated characters). Registry: `R-catch-category-exact`
  (pure-typing). Hover: `test/hover/op-errors.ts` shows an `OpErrors` lookup as class names, with `Transient`
  kept as its alias name.
- Mutation checks (each reverted): dropping `ThreadArchived` from `message.pin.thread`, giving the reaction
  variant `state` instead of `access`, branding `StickerId` as `EmojiId`, and making `RateLimited` also `state`
  each made `bun run test:types` exit 1 in the fixture meant to catch it.
- Compile cost of `src/` alone (`--checkers 1`, two identical runs): 27,933 types, 112,607 instantiations,
  about 0.1 s check time (design measurement for the error module: 25,994 and 106,218).

### M2 Harness foundation, identities and oracle

- `src/config/Credentials.ts`: the `Credentials` service. `layer` takes the live lock first, then reads `.env`
  (resolved from the module, not the working directory) through `ConfigProvider.fromDotEnv`; tokens are only
  `Config.Redacted`, IDs decode through the branded schemas. Tests use fake credentials and take no lock.
- `harness/Lock.ts`: `/tmp/effect-discord-perms-live.lock`, created with `wx`; a dead pid on this host is taken
  over by renaming a temporary file over it and reading it back; another host's or an unreadable lock is never
  taken; released by its owner only.
- `harness/Pacing.ts`: one spacing bucket (5 per second, at most), the request and per-route write counters, and
  the 1,500 invalid-response abort.
- `harness/Identities.ts`: `SharedHttpClient` (guard, then pacing, then status counting) outside every
  `Layer.fresh`; `HarnessRest`, `TargetRest` and `SubjectRaw` as fresh REST stacks; `compose(base, credentials,
  pacing)` is the one wiring and `live` passes Bun's client and the real credentials.
  `test/unit/identities.test.ts` builds `compose` with a recording client and fake tokens and sees
  `Bot fake-harness-token`, `Bot fake-target-token`, `Bot fake-subject-token`, three distinct clients and one
  shared counter (3 requests). Mutations (each reverted): removing `Layer.fresh` failed it (one shared
  instance), and building pacing inside a fresh layer failed it (`expected +0 to be 3`).
- `harness/Lab.ts`: the guard (see "Design deviations"), `LabRequestFailed`, `LabCheckFailed`, `labStep`.
  `test/unit/lab-guard.test.ts` covers every refusal class, including kick, ban, member edits of a human, DMs,
  leaving the guild, global commands, protected channels and foreign roles, and (after the verifier fixes) the
  channel-list PATCH, channel and role creation, thread membership of a human, member edit bodies and AutoMod.
- `src/bot/Startup.ts` (`StartupFailed`, `restChecks`), `src/bot/Internals.ts` (`SubjectRaw`), `src/rest/ErrorMap.ts`
  (`classify`, `flattenFieldErrors`), `harness/IdentityCheck.ts`. `test/unit/startup.test.ts` drives the real
  dfx client over a scripted fake: success, 401, missing intent flags, 404 member, 502, transport, the 30 s
  deadline under `TestClock` (a `NoResponse` with reason `deadline`), and an unexpected answer as a defect; and
  `classify` on a 50035 body (`e.data.code`, field paths, numeric inner codes as strings), 5xx, a Cloudflare HTML
  403, transport, and a malformed body (defect).
- `src/rest/Oracle.ts` (`memberPermissions`): `Permissions`, `Unavailable` (404 code 0, 405) or `OracleFailed`;
  `test/unit/oracle.test.ts` (the request must carry `implicit=false`) also covers the lab-state file and smoke's
  judgment of the oracle; `test/unit/credentials.test.ts` covers the credentials layer and its lock.
- `harness/LabIds.ts` (spec and `.lab-state.json`), `harness/Wire.ts`, `harness/Reset.ts`, `harness/Provision.ts`,
  `harness/Smoke.ts`, `harness/main.ts` (`reset`, `smoke`, `inventory`, and from the second verifier round
  `selftest` with `harness/SelfTest.ts`; `run` prints "not built yet (M3)" and exits 1). Pure decisions are in `test/unit/reset-plan.test.ts` (channel and thread patches, member roles,
  delete plans with the undeletable types and the 14-day split, unpins, leftovers, role order with ties (a tie
  alone, with the harness above, fails), overwrites that differ only in `deny`, GuildMedia-only
  `kindNotAvailable`, the sticker PNG, write deltas).
- Live record for `LOG.md`'s M2 items: the oracle is **available**; `mfaLevel` is **0**; both managed roles'
  positions: **neither bot has a managed role** (`Perms Harness` 11, then `lab-high` 10 ... `lab-unmentionable`
  1, `@everyone` 0); the harness **has** the Message Content flag.
- The lab as provisioned: category `lab` with `lab-text`, `lab-announcement`, `lab-voice`, `lab-stage`,
  `lab-forum` (tag `lab-tag`), `lab-bots-only`; threads `lab-public-thread`, `lab-private-thread`,
  `lab-announcement-thread`, `lab-forum-post`; ten roles; sticker `lab-sticker`; `lab-media` unavailable.
- Provisioning from scratch was run twice (once with the first lab, once after forgetting every stored ID to
  check the final code): the second created 21 objects and made 31 writes, including the one role-position
  PATCH and the closing reset. That run found a bug, fixed in the same milestone: the first attempt failed with
  `404 10011 Unknown Role` because reset deleted a leftover role and then tried to remove it from the target;
  reset now drops deleted leftovers from its view (`withoutLeftovers`, unit-tested).
- Exit evidence (final code): `bun run harness:smoke` exited 0 twice in a row (each `reset: writes 0`,
  `provision: created 0; writes 0`, 75 requests, 0 invalid), then `bun run harness:reset` reported `writes: 0`
  twice; `bun run verify:offline` is green.
- Verifier fixes (see "Design deviations"): the guard's body checks, smoke's oracle judgment, the credentials
  layer's exports, GuildMedia-only `kindNotAvailable`, unpinning every kept pin, vitest refusing Bun. Mutation
  checks (each reverted, each failed its test): dropping `implicit=false`, `orderHolds` accepting ties,
  `overwritesMatch` ignoring `deny`, and each new guard, smoke, credentials, unpin and kind check. Exit evidence
  after the fixes: the reset self-test (14 writes, then 0), two `harness:smoke` runs exiting 0 (`oracle:
  available, 10 reads and the control`, the control matching, 75 requests, 0 writes, 0 invalid), two
  `harness:reset` runs with `writes: 0`, and `bun run verify:offline` green with 253 unit tests.
- Verifier fixes, round 2 (see "Design deviations"): reset restores thread slowmode; `harness:selftest` is
  committed and part of the exit; the guard checks thread and sticker names; smoke fails on a lab channel it
  would skip; offline tests for `IdentityCheck.run` and the invalid-response count. Live runs, in order, each
  alone under the lock:
  - `harness:selftest` with the final code: initial reset 0 writes; 13 dirt steps, 37 writes; the read-back saw
    34 problems, every step's among them; reset 28 writes (including 3 channel deletes, 1 unpin, 1 bulk delete,
    5 channel PATCHes, 2 member PATCHes); read-back at baseline; second reset 0 writes; 299 requests, 0 invalid.
  - The same with the thread-slowmode restore removed (reverted after): `selftest FAILED: LabCheckFailed
    ... reset (28 writes) left the lab off baseline: lab-public-thread slowmode (5)`. The reset after it, with the
    fix back, made 1 write (`PATCH /channels/{id}`).
  - The same with reset's `@everyone` step and timeout clearing removed (reverted after): `reset (27 writes) left
    the lab off baseline: @everyone permissions (1024, not 0); subject timeout (...); target timeout (...)`. The
    reset after it made 3 writes (one role PATCH, two member PATCHes). These two mutations still pass
    `bun run test`; they are effectful reset steps, and the self-test is their check.
  - Offline mutation checks (each reverted, each failed `bun run test`): every `IdentityCheck` check removed in
    turn (application ID, distinct bots, guild name, `#rules`, top role), an empty or name-only protected set,
    arming before the checks; no status counting in `SharedHttpClient`; smoke skipping a missing ID, dropping
    the thread reads, the control reading the subject; sticker writes allowed, sticker names ignored, form
    fields not read; the overwrite sub-route length check; thread names ignored, thread-from-message creates
    unchecked, the thread-create method check; the thread slowmode restore; and the read-back ignoring thread
    slowmode, `@everyone`, timeouts or system message types, and `unseen` going blind.
  - Exit runs on the committed code, in order: `harness:selftest` exited 0 (initial reset 0, 13 steps and 37
    writes, 34 problems seen, reset 28, at baseline, second reset 0); `harness:smoke` exited 0 twice (`reset:
    writes 0`, `provision: created 0; writes 0`, oracle available with 10 reads, the control matching, 75
    requests, 0 writes, 0 invalid); `harness:reset` reported `writes: 0` twice; the lock was gone afterwards.
    `bun run verify:offline` is green (291 unit tests in 21 files).

### M3 State store, resolver, preflight, matrix runner

- `src/permissions/`: `Flags.ts` (branded `PermissionSet`, the 2FA-starred set), `ResolverRules.ts` (13 switches
  with their H-ids, all "docs"), `Resolver.ts` (base, overwrites, the seven masks, hierarchy, `inputFromSnapshot`),
  `Order.ts` (§3.2), `Preflight.ts` (`decide`, `toError` through `errorFor`, `tagOf`, the internal `Mode`);
  `Observed.codeForLevel`; `src/payload/PayloadRules.ts` (the table and its flag lookups).
- `src/state/`: `Snapshot.ts`, `Reducer.ts` (READY, GUILD_*, roles, channels, threads, thread members, the bot's
  member; obfuscated channels; malformed payloads marked stale), `Hook.ts`, `GuildState.ts` (`apply`,
  `awaitGuild`, `refresh` with generations). `src/rest/Request.ts`, `ErrorMap.dedicatedCodeTags`.
- `src/bot/Bot.ts` (`Bot.make`, `BotRuntime`) and `src/bot/Internals.ts` (`BotInternals.layerWith`: checks, state,
  gateway with the hook, the guild awaited, `SubjectRaw` from the same build); the harness's subject is that build.
- `harness/`: `Materialize.ts` (desired state, resolver inputs over it, projection and its comparison),
  `Converge.ts`, `Wait.ts`, `DryRun.ts` (and `fixtures/canned/create-message.json`), `Outcome.ts`, `Agreement.ts`,
  `TruthTable.ts`, `Runner.ts`, `scenario/{Dsl,Pairwise,Safety}.ts`, `scenario/catalog/send.ts` (89 pairwise and 14
  targeted rows), and `run` in `harness/main.ts`. Pacing now counts 429s per route.
- Unit tests (381 in 30 files): `resolver.test.ts` (4,000 seeded random guilds against a literal transcription of
  the documented algorithm, stage by stage, plus each mask and the hierarchy), `preflight.test.ts`,
  `flags.test.ts`, `state.test.ts` (dispatches in Discord's shapes, a replay leaving every value unchanged, the
  refresh racing a CHANNEL_UPDATE under `Deferred`s, unseen channels), `bot-build.test.ts` (fake base client and
  fake gateway: checks before the socket opens, the hook, `invalid-token`, `guild-not-ready` under `TestClock`),
  `catalog.test.ts` (pairwise validity, coverage of every valid pair, determinism, counts; Safety over the catalog
  and every materialized state; Safety's refusals), `materialize.test.ts`, `agreement.test.ts` (each mismatch kind,
  the readback, canonical bytes), `dry-run.test.ts`; the identity tests run over the real subject build.
- Mutation checks (each reverted, each failed its test): role overwrites applied one by one instead of aggregated
  (the random comparison failed on case 29), refresh committing whatever the generations say, no timeout failure
  in preflight, no `level-vs-raw` check, the guild sticker allowed `missing=payload` (the catalog no longer
  builds), a member-overwrite removal that leaves the flag in `allow`.
- Live, in order (each alone under the lock): a 10-row trial (`--only 'send/text/**'`); two development runs of
  the send catalog, which found the channel-list 429s, the thread-membership 50001 and the administrator timeout
  (all fixed, see "Design deviations"); a run of the two administrator rows; then the exit runs on commit
  `e0a4d53`:
  - **A**: `bun run verify:live -- --only 'send/**'` finished and printed its summary: 103 scenarios in 585 s,
    2,174 requests, 565 writes, 64 invalid (the raw 403s), no 429, oracle available, 28 mismatches; compared with
    the second development run's table it differed only in `send/targeted/administrator-timed-out` (the fix made
    between them); exit 1 (mismatches).
  - **B**: `bun --no-env-file harness/main.ts run --only 'send/**' --write --compare`, a fresh process: 103
    scenarios in 605 s, the same counts and the same 28 mismatches, `compare: identical to the previous table`;
    the two tables are byte-identical (sha256 `4458a2ba...8b39aa`, 131,537 bytes). Exit 1 (mismatches).
  - then `bun run harness:selftest` (the guard now reads channel PATCH bodies): 13 dirt steps, 34 problems seen,
    reset 28 writes, at baseline, second reset 0 writes;
  - **C**, on commit `8a38125` (the final code but for two unused type imports removed after it):
    `bun --no-env-file harness/main.ts run --only 'send/**' --compare`, a third fresh process: 103 scenarios in
    611 s, 2,175 requests, 565 writes, 64 invalid, no 429, the same 28 mismatches, `compare: identical to the
    previous table`. The lock was gone afterwards.
- The table's raw classes: 46 `50001`, 39 `success`, 9 `50013`, 7 `degraded` (MentionEveryone 5, SendTTSMessages 2),
  1 `other-error` (160002), 1 `setup-unsupported` (`admin-exempt`). Agreement: 75 agree, 28 mismatches.
- **Mismatches left for M4** (all genuine, see "Live findings"):
  - `level-vs-raw` (16): a missing SendMessagesInThreads answers 50001 (H-080), and so does a locked thread
    (H-036): `send/announcement-thread/file/role-overwrite-allow/base/member-overwrite-deny/normal`,
    `send/archived-thread/file/role-overwrite-allow/base/member-overwrite-deny/normal`,
    `send/forum-post/{file/role/base/role-overwrite-deny, mention-everyone/everyone/base/role-overwrite-deny,
    poll/member-overwrite-allow/base/absent, reply/role-overwrite-allow/base/absent}/normal`,
    `send/locked-thread/{file/role-overwrite-allow/base/member-overwrite-deny, guild-sticker/everyone/none/absent,
    mention-everyone/everyone/none/absent, plain/everyone/none/absent, poll/everyone/none/absent,
    reply/member-overwrite-allow/payload/everyone-overwrite-deny}/normal`,
    `send/private-thread/reply/role-overwrite-allow/base/member-overwrite-deny/normal`,
    `send/targeted/{archived-locked-thread, order-smit-locked, thread-send-without-smit}`;
  - `resolver-vs-oracle` (10): the oracle applies the timeout (H-241):
    `send/announcement/{file/member-overwrite-allow/none/absent, reply/role-overwrite-allow/view/absent}/timed-out`,
    `send/stage/{embed/role-overwrite-allow/none/absent, guild-sticker/role-overwrite-allow/view/member-overwrite-deny}/timed-out`,
    `send/text/{embed/role/view/role-overwrite-deny, mention-everyone/everyone/none/absent,
    poll/everyone/view/member-overwrite-deny}/timed-out`,
    `send/voice/{embed/member-overwrite-allow/base/member-overwrite-deny, poll/role/connect/everyone-overwrite-deny,
    tts/role/payload/role-overwrite-deny}/timed-out`;
  - `preflight-vs-raw` (2): TTS degrades (H-102):
    `send/{forum-post,public-thread}/tts/member-overwrite-allow/payload/member-overwrite-deny/normal`.

### M4 Matrix to zero mismatches

- Before M4, the M3 verifier's five minor findings (commit `5d63b96`; "Design deviations", "Before M4").
- The catalog (`harness/scenario/catalog/`): `send.ts` (89 pairwise, 20 targeted), `messages.ts` (22, 10),
  `reactions.ts` (25, 4), `pins.ts` (18, 4), `threads.ts` (the createThread family 8 and the threads family 24,
  with 20 targeted rows for threads, thread creation from a message and forum posts), `channelEdit.ts` (21, 5),
  `members.ts` (22, 1), and `flips.ts`, one flip control per (operation row, first missing flag): 293 family rows
  and 61 flips, 354 scenarios. `index.ts` assembles them; Safety and the run-start selection check pass over all
  of them, offline and at run start.
- The runner (`harness/Runner.ts`) runs every operation: the subject's own fixtures with temporary access
  (`Fixtures.ts`), Converge with the target's roles and the channel's settings, the harness's fixtures, the wait,
  step (a) at channel or guild level, (b), the raw call per operation (`Drivers.ts`), cleanup, and the flip
  controls judged after the run. Kick and ban go out only with the guard's permit (`LabGuard.permitKickOrBan`);
  every one the matrix sent failed, as the docs model predicted.
- From the findings ("Live findings", M4): the operation table (47 rows), `PayloadRules.tts` (degrade),
  `ResolverRules.threadCreatorMayLock`/`MayDelete`, `Observed.viewCodeFailures`/`oracleAppliesTimeout`, preflight's
  conditional AddReactions, hierarchy, creator exemptions, tags, `blockedByTimeout` and `viewLevel`. `Limits` was
  not changed: M4 has no limit rows (they are M6's rule rows).
- `test/replay/truth-table.test.ts` (§5.13): every row's steps (a) and (b) rebuilt from the setup
  (`harness/Predict.ts`) and agreement; the table's scenarios equal the catalog's; the constants held to the
  table (each `viewCodeFailures` entry must be witnessed by a row; the four entries the first exit attempt did not
  witness got targeted rows, and the exit runs started again).
- Unit tests: `facts.test.ts` (the row per kind, predictions, the whole catalog through Safety, the flip
  controls' predicted failures), and new cases in the preflight, agreement, resolver, state, materialize and
  lab-guard tests. Mutation checks (each reverted, each failed its test): 18 for the verifier's findings and 29
  for M4's logic, among them the creator exemptions, the blind-row rule, `blockedByTimeout`, the hierarchy, tags,
  conditional AddReactions, the `viewLevel` order and level, the guild-level timeout mask, `Facts.complete`,
  agreement's state-failure and oracle-timeout rules, the flip judgment, `expectedCode`, the guard's permit
  consumption, target and prediction (including its ID tie-break), the rename check, Converge's settings and target
  read-back, the pins degradation's fixture condition, Safety's kick and ban check, the flips' blind rule, the
  target's Administrator, the rebuilt unseen thread, and the reducer's REQUIRE_TAG flag.
- **Not covered by M4's rows** (§5.9's targeted families and the other hypotheses of discord-semantics.md, with
  the reason or the owning milestone; none is claimed as verified). Corrected after the M4 verifier: the first
  version of this list said the Setup could express no overwrite-algebra row and left out several hypotheses.
  - overwrite algebra: H-004 (an Administrator bit inside an overwrite): a grant's flags could carry the bit, but
    H-004 itself says the API may refuse the overwrite, and Converge treats a refused setup write as an
    infrastructure abort; a row needs a Converge path that records the refusal, which M4 does not add. H-009
    (array order) and H-010 (role positions): the Setup has one role per grant source and Converge writes one
    array order. The resolver's 4,000-case comparison with the documented algorithm covers the three offline
    only. H-011 is covered on its allow side only (below); its deny side (a deny for a role not held) has no row;
  - H-043 (`ThreadAlreadyExists`, 160004) and H-141's `AlreadyCrossposted` (40033): preflight cannot know a
    message already has a thread or was crossposted from what it holds, so these stay recompute-only tags;
  - H-048, H-051 (250 pins, cost), H-052 (a message from another channel), H-062, H-063 (role edits, no such
    phase-1 operation), H-065 (the owner is Rhys), H-068 (Perms Lab has no managed roles, M2), H-069 (no own-
    nickname operation), H-146;
  - the type rules' live pairs (H-041 private threads in announcement channels, H-054 announcement slowmode,
    H-086, H-088, H-092, H-101, H-120..H-131 limits, H-143), which are M6's rule rows, and a voice message's
    missing `pin`, now a type rule too; H-104 and external stickers need a second guild;
  - error codes and payloads without a matrix row: H-016 (other undocumented implicit rules) is a standing
    question, answered row by row: any resolver/raw disagreement would be a mismatch, and the matrix has none;
    H-017 (`implicit=true` masks only View and Connect): the oracle reads `implicit=false` only and nothing
    depends on `implicit=true`, so it is not tested; H-025 (a timeout over 28 days, `TimeoutTooLong`): M6's
    limit rows; H-081 needs no row of its own: the replay now asserts that no 50013 or 50001 row carries inner
    errors; H-082: every failing row records its status and code, and M5's ErrorMap test holds each pair to its
    tag; H-083 (empty messages, 50006, `MessageEmpty`), H-084 (inner 50035 codes are strings, the first 50035s
    come with the limit rows), H-085 (a channel of the wrong type, 50024), H-105, H-106 (message flags outside
    their contexts), H-109 (`fail_if_not_exists: false`), H-110 and H-111 (`allowed_mentions` on send and edit):
    M6's payload and rule rows; H-087 (unknown IDs answer 10xxx with 404): M5's ErrorMap and M6's rows (cleanup
    met a live 404 10008, the flake under "Design deviations"); H-108 (content without MESSAGE_CONTENT): M7;
    H-112 (`enforce_nonce`): the library sends no nonce in phase 1, so M6 decides whether it needs a row. H-090
    does not exist in discord-semantics.md (its numbering skips it), and H-107 is covered (the pins list rows
    cite it: `pins/announcement/list/read-history/role-overwrite-deny/normal`);
  - H-160, H-161 (obfuscation): M7, with the codec.
  - Completed before M5 (the M4 verifier's second look found the list still short). Every remaining H-id of
    discord-semantics.md is now named here or cited by a catalog row; a range such as H-120..H-131 names every ID
    inside it. Phase-1 hypotheses inside §5.9's targeted ranges: H-002 (the owner holds everything): the owner is
    Rhys, a human no row may act as, so it stays resolver-only (`test/unit/resolver.test.ts`); H-026 (the
    permission endpoints reflect a timeout): its endpoint half is H-241, held to the table by
    `Observed.oracleAppliesTimeout` and the replay's witness check, and its `app_permissions` half is phase 3;
    H-027 (a timed-out bot answers interactions): `[human]`, the phase-3 checklist (M9); H-042 (a thread create
    without `type` is private): the raw calls and the library always send `type`, so nothing relies on the
    default; H-070, H-071 (editing overwrites, overwrites on channel creation): out of phase-1 scope, like
    H-144's reaction removal (§8 item 19); H-072 (2FA): does not apply at `mfa_level` 0 (M2), so
    `TwoFactorRequired` stays resolver-only (§8 item 16); H-073 (managed roles in the hierarchy): moot, neither
    bot has a managed role in Perms Lab (M2), and the hierarchy rows use lab roles.
  - Outside those ranges: H-018 (a category is viewable when a child is): no row acts on the category itself
    (M6's channel-kind rules decide whether a category edit row is needed); H-056, H-140 (voice messages):
    phase-1 payloads have no voice message, so SendVoiceMessages exists only in the category table; H-057
    (UseExternalApps), H-117, H-118 (interaction responses): phase 3; H-058 (creating expressions and events):
    outside phase 1; H-059 (the flag bits and the alias): offline, M1's generator and `gen-errors.test.ts`;
    H-093 (coded 429s): passive only, never provoked live; M5's coded-429 interceptor and its unit tests;
    H-094 (the invalid-request budget): `Pacing` counts every 401/403/429 and aborts at 1,500, and every run
    prints the count (about 225); H-096, H-158 (DMs, 50007, 50003): `dm.send` has no matrix row, since a DM to a
    human is forbidden and bot-to-bot DMs only fail; M6 decides whether `CannotMessageUser` gets a rule row;
    H-113, H-116 (what the client shows): not observable through the API; H-114, H-115 (content and embed-field
    stripping): no payload in the matrix depends on them; H-132, H-133, H-134 (flags per context,
    `allowed_mentions` details, whether a reply pings without them): M6's `create-flags-only`,
    `suppress-notifications-create-only` and `allowed-mentions-none` rows; H-136 (a reply across channels): the
    matrix replies in the same channel only, M6 decides with the reply payload; H-137 (forwards): not a phase-1
    operation; H-139 (poll limits, poll edits 520003): M6's `poll-limits` row, and `EditMessage` has no poll;
    H-145 (the nonce window): with H-112; H-148 (30046, edits of old messages): passive only, `RateLimited` through
    M5's interceptor; H-150, H-151 (forums and categories refuse messages): M6's `no-send-forum` and
    `no-send-category` rows; H-154, H-155 (private threads only in text channels): with H-041, M6; H-156
    (converting text and announcement channels): not a library operation; H-157 (Community channels cannot be
    deleted): resolver-only by design, the Lab guard refuses any write to `#rules` and `#mod-updates`.
  - Later phases and the oracle: H-170..H-182 (gateway, intents, message content): M7; H-190..H-210 (commands,
    registration): M8; H-220..H-232 (interactions): M9 offline and the phase-3 checklist; H-240 and H-241 (the
    permission oracle and its timeout mask): live findings of M2 and M3, used by every channel row's oracle
    comparison; H-242 (the guild-level permissions endpoint): unused, the member rows have no oracle; H-243 (a
    harness without Message Content): does not apply, the harness has the flag (M2); H-244 (the create response
    against a later read): the readback reads the create response only, as §4.12 specifies, and no later read
    is compared; H-245 (link previews arriving later): no payload carries a URL.
- Live, in order (each alone under the lock), after the M3 verifier's fixes:
  - a trial of the 48 targeted rows (it found the cleanup order bug and the first findings), then one run per
    family (`member/**`, `message/**`, `react/**`, `pins/**`, `createThread/**`, `thread/**`, `channelEdit/**`),
    then a full development run (352 scenarios, 16 mismatches, each a finding above; its table is the
    "development run" these notes cite). The fixes were checked offline before the next run: re-judging the
    development run's raw answers with the new code agreed on every row whose setup had not changed;
  - run A (346 scenarios, 1,911 s, 7,172 requests, zero mismatches); its replay showed four `viewCodeFailures`
    entries no committed row witnessed, so the targeted rows that witness them were added (354 scenarios);
  - an exit attempt that stalled in its 53rd scenario, and a second that aborted after 18 (the role bucket,
    "Design deviations"); the run order changed to need 67 role edits, the runner now checks the bucket first,
    and the next run waited about 110 minutes for the bucket to refill;
  - **exit run 1** on commit `24b745c`: `bun --no-env-file harness/main.ts run --write` exited 0: role budget 76
    left (75 needed), 354 scenarios in 1,974 s, 7,322 requests, 1,629 writes, 221 invalid (the raw 403s), no 429,
    oracle available, **0 mismatches**; the table (`b726e638...d26480`, 432,050 bytes) is committed. Raw classes:
    139 success, 136 `50001`, 48 `50013`, 17 other (12 x 50083, 3 x 160002, 40067, 160005), 12 degraded,
    2 `setup-unsupported` (`kind-not-available` for the media post, `admin-exempt`). `bun run verify:offline` is
    green with the replay: 799 tests in 32 files, 363 of them the replay.
  - **exit run 2**, 79 minutes later (the bucket's refill), same code: `bun run verify:live` (`run --write
    --compare`) exited 0: role budget 86 left, 354 scenarios in 2,061 s, 7,320 requests, 1,625 writes, 221
    invalid, no 429, **0 mismatches**, `compare: identical to the previous table` (the committed one); it wrote the
    same bytes (`b726e638...d26480`).
  - **exit run 3**, after the bucket refilled again, same code: `bun --no-env-file harness/main.ts run --compare`
    in a fresh process exited 0: role budget 84 left, 354 scenarios in 2,051 s, 7,322 requests, 1,625 writes, 221
    invalid, no 429, **0 mismatches**, `compare: identical to the previous table`. The lock was gone afterwards.
    `bun run verify:offline` is green after it (gen:errors, typecheck, 799 tests with the replay, test:types,
    hover, rules, budget).

#### After the M4 verifier

The verifier passed the milestone's runs but found two major and five minor problems. Each is fixed or answered
here (details under "Live findings" and "Design deviations"):

- **The exit command could abort in cleanup** (major): the verifier's first `bun run verify:live` exited 1 on a
  404 10008 from a message Discord's list still showed after the subject's bulk delete. Cleanup and reset share
  `Reset.deletePlanned` now, which treats 10008 as done (`test/unit/cleanup.test.ts`).
- **`Observed.slowmodeAppliesToBots` had no witness** (major): the `subject-prior-send` fixture and
  `send/targeted/slowmode-second-send{,-bypass}` decide it (H-053 confirmed: `false`), and the replay requires a
  witness. Flipping the constant to `true` fails the replay; on the previous table (no witness) it failed too.
- **Ordering gaps** (minor): `send/targeted/order-locked-embed` covers tiers 5 and 6 and showed Discord's own order
  (the payload flag first), so `ThreadLocked` moved after the payload flags; `member/targeted/timeout-admin-below`
  isolates `TargetIsAdministrator`. Tier 7 (local limits) waits for M6's limit rows.
- **Overwrite algebra** (minor): `send/targeted/overwrite-everyone-allow{,-role-deny}` (H-005, H-007 with an
  `@everyone` overwrite allow); H-011's allow side is cited on `send/targeted/order-view-send`; H-004, H-009 and
  H-010 stay offline, with the reason corrected in the list above.
- **Own deletes under a timeout** (minor): `message/targeted/delete-own-timed-out{,-thread}` succeed, so the rows
  keep omitting `CommunicationDisabled`.
- **Stale counts and comments** (minor): DESIGN's row count (47), §5.9's counts, §4.7's pin rows, this log's flip
  count, and the comments in `threads.ts`, `messages.ts` and `Order.ts`.
- **The not-covered list** (minor): rewritten above, with every hypothesis the verifier named. Two of its claims did
  not hold: H-107 has rows (the pins list rows cite it), and H-090 does not exist in discord-semantics.md.

The catalog is now 363 scenarios: `send.ts` 89 pairwise and 25 targeted, `messages.ts` 22 and 12, `reactions.ts`
25 and 4, `pins.ts` 18 and 4, `threads.ts` 32 and 20, `channelEdit.ts` 21 and 5, `members.ts` 22 and 2 (301
family rows), and 62 flips. A full run makes 68 role edits and needs about 76 in the bucket.

Live, in order (each alone under the lock):

- the targeted subset (`run --only '*/targeted/**' --write`, 72 scenarios, 462 s, 1,572 requests, no 429): one
  mismatch, `level-vs-raw` on `send/targeted/order-locked-embed` (the ordering finding); every other new row agreed;
- after the reorder, `run --only '**/order-locked-embed' --write` (the row and its new flip control): 0 mismatches;
- **exit run W** on commit `ca68b2f`: `bun --no-env-file harness/main.ts run --write` exited 0: role budget 79 left
  (76 needed), 363 scenarios in 2,153 s, 7,515 requests, 1,676 writes, 225 invalid, no 429, oracle available,
  **0 mismatches**. Raw classes: 144 success, 137 `50001`, 51 `50013`, 17 other (12 x 50083, 3 x 160002, 40067,
  160005), 12 degraded, 2 `setup-unsupported` (`kind-not-available`, `admin-exempt`). The table
  (`e835d554...6242f4`, 442,175 bytes) adds the nine new rows to the previous one and changes no other row; it is
  committed. `bun run verify:offline` is green with it.
- **exit run A**, after the bucket refilled, same code (`6568745`, only LOG.md changed since W): `bun run
  verify:live` (`run --write --compare`) exited 0: role budget 79 left, 363 scenarios in 2,199 s, 7,517 requests,
  1,676 writes, 225 invalid, no 429, **0 mismatches**, `compare: identical to the previous table` (W's, committed);
  it wrote the same bytes (`e835d554...6242f4`). It passed the bulk delete in voice text chat where the verifier's
  first run had aborted (`flip/message/voice/bulk-delete/op-flag/normal`).
- **exit run B**, after the bucket refilled again, same code (`eb05764`, only LOG.md changed since W): `bun
  --no-env-file harness/main.ts run --compare` in a fresh process exited 0: role budget 78 left, 363 scenarios in
  2,188 s, 7,520 requests, 1,676 writes, 226 invalid, **0 mismatches**, `compare: identical to the previous table`.
  One 429 (`GET /channels/{id}/messages`, retry-after 5 s, which dfx waited out) came during a reset's message
  listing, not during a scenario (no scenario line reports it), so no row could depend on it. The lock was gone
  afterwards. `bun run verify:offline` is green after it: gen:errors, typecheck, 817 tests in 34 files (373 of
  them the replay), test:types, hover, rules, budget.

### M5 REST wrapper

- Before M5, the M4 verifier's five minor findings (commit `2ea7c28`; "Design deviations", "Before M5"; "Live
  findings").
- `src/rest/Schemas.ts` (User, Overwrite, Channel, Role, Member, Guild, Reaction, Message: the object schemas,
  shared by the reducer, the refresh and the operations), `src/rest/Coded429.ts` (the interceptor and its layer),
  `src/rest/ErrorMap.ts` (`classify` with the coded 429; `Codes`; `LimitFacts` and `limitFields`; `mapResponse`;
  `dedicatedCodeTags`, now derived from `Codes`; `UnmappedDiscordError`), `src/rest/DiscordApi.ts`
  (`DiscordApiConfig`, `Request`, `ApiError`, `make`, `execute`), `src/permissions/Recompute.ts` (`Target`,
  `Completion`, `attribute`), `GuildState.refreshGuild`, `Preflight.stateArgs`/`toHandleError`, and the wiring:
  `BotRuntime.api`, built over the bot's client and state, and the interceptor over the build's base client.
- Unit tests (1,079 in 40 files; M4 ended with 817 in 34, and the minor fixes added 7):
  - `test/unit/error-map.test.ts`: every refusal the truth table recorded maps, for its operation, to its declared
    tag (the matrix's `mappedTag`, or Unattributed) with its class's categories (`ErrorCategories` for a permission
    class, the marker otherwise), through the recompute except 40067; every recorded `(status, code)` is in
    `Codes`; the unmapped cases (an unknown code, a wrong status, a tag the row does not list, 160002 without a
    reply, 20016 while slowmode does not apply to bots, a rate limit without `retry_after`, 50006 and 50016 without
    their declarations, a field an operation cannot declare); 50035's paths, lengths, limit names and tier-7 order,
    and the paths that stay unmapped;
  - `test/unit/op-errors.test.ts` (§4.7): every operation's widest request against every code and status of the
    map, every failure `Preflight.decide` gives the truth table's rows (with and without granted flags, so D8's
    `PermissionRevokedSinceCheck` too), and `errorFor` for every (operation, flag): each tag is declared
    (`test/support/declared.ts`, the runtime mirror of the row's union) and has its class's categories;
  - `test/unit/recompute.test.ts`: through the real `DiscordApi` and dfx client, with a guild state whose refresh
    answers the test's state: attribution from the refreshed state, not the stale one; Unattributed with Discord's
    answer as the cause; nothing attributed when the refreshed state lacks the guild; View before Send; D8; a timeout the state had not seen; a refresh without an answer; 160005
    with SendMessagesInThreads also missing (our order decides), alone, and with nothing found (the code's tag);
    160002 with nothing found (the reply variant, `payload`), with Send missing, and on a send without a reply (a
    defect, with no refresh); 50083 on a reaction with AddReactions missing too; a member operation (guild-level
    refresh, the target read again: `TargetAboveInHierarchy`), a role above the bot, a target that has left, and a
    reaction of unknown state (the message read). And **every refusal of the committed truth table** (205 rows:
    50013, 50001, 50083, 160002, 160005, 40067), replayed through the same path over the state the replay rebuilds
    from its setup, gives exactly the `{tag, categories}` preflight recorded for the row: what the matrix's step (d)
    will check live in M6;
  - `test/unit/discord-api.test.ts`: decoding and branding; a 2xx body that does not decode is a defect naming the
    route template; a coded 429 is `RateLimited` with its `retry_after`, sent once; an uncoded 429 and one with code
    0 are retried by dfx; a coded 20016 is a defect; the deadline gives `RequestTimedOut` with
    `NoResponse { reason: "deadline", afterMs: 30000 }` under `TestClock` (not at 29 s), and comes from
    `DiscordApiConfig`; transport and 5xx; an unmapped code is an `UnmappedDiscordError` carrying the answer; an
    undeclarable limit is a defect before anything is sent; and the recording-tracer span test: with the caller
    catching the error outside the operation's span, both `discord.channel.send` and `discord.rest` end failed,
    `discord.rest` carries the route template, method, operation, guild and channel, and no span carries the token;
  - `test/unit/bot-build.test.ts`: through the real bot build, a coded 429 reaches `runtime.api` (as `RateLimited`)
    and `SubjectRaw` (as a 429 answer with its code) once each, unretried;
  - the replay also asserts that the error map covers every `(operation, status, code, inner path)` of the table
    (§5.13).
- Mutation checks (each reverted, each failed the test meant to catch it): the recompute always falling back (215
  of the recompute tests failed), the recompute skipping the refresh (193), the error map not checking the row's
  tags (op-errors), not checking the status (error-map), 50035 not sorting by tier 7 (error-map), D8's revocation
  dropped (recompute), the interceptor treating code 0 as coded (discord-api), and the interceptor left out of the
  bot build (bot-build: dfx retried the coded 429 until the test's timeout).
- Live, once, after the M5 commit (`f948f45`), which changed the subject's build (the interceptor) and the raw call
  (the prior-send proof): `bun --no-env-file harness/main.ts run --only 'send/targeted/slowmode-second-send*'`
  exited 0: 2 scenarios in 61 s, 158 requests, 14 writes, 0 invalid, no 429, oracle available, 0 mismatches; the run
  log records each prior send's message ID before the created one (`raw success 200 0 after prior send <id>
  created <later id>`). The guild's role-edit bucket had 39 edits left at its start (the self-tests and this run
  used some), so a full run waits for the bucket to refill (about 1.8 hours from empty; the runner says how long).
- For M6: the message, reaction and pin rows do not list `UnknownChannel`, so a request on a message whose channel
  was deleted (10003) is an unmapped defect today; M6, which builds those operations and their live rows, decides
  whether the rows gain it. No row of the M4 matrix met 10003.
- Exit evidence, on the final code: `bun run verify:offline` exited 0 (gen:errors up to date, 52 flags and 54 classes;
  typecheck; 1,079 tests in 40 files, the replay's 374 among them; test:types 5 pass and 2 fail fixtures, largest
  gated 325 characters; hover 3 markers; rules 2 rules; budget nothing to measure yet).

