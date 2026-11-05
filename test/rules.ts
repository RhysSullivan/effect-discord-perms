/**
 * The rule registry (DESIGN §5.5, G10). Every compile-time rule names its pass fixture, its fail fixture, the
 * directive mentions in that fail fixture it claims, and either a live valid/invalid pair or an allowlisted
 * reason why it has none. `bun run rules` (`scripts/rules-check.ts`) checks the registry for completeness.
 */
import type { Observation } from "../harness/scenario/Dsl.ts"

/** One side of a live pair: its scenario ID and full expectation. */
export interface LiveSide {
  readonly scenario: string
  readonly expect: Observation
}

/**
 * A live pair: both sides run on a byte-identical Setup, and each side has its own full expectation. `also` holds
 * further sides of the rule on the same setup, checked like the two: more valid cases (M7: the message-content
 * exceptions, a mention, a ping-on reply and the bot's own message, each delivered without the intent), or the rule at
 * another level or for another field (M8: a command rule nested in subcommands and groups, a mutation of each
 * canonical field).
 */
export interface LivePair {
  readonly kind: "pair"
  /** The name of the Setup both sides share. */
  readonly setup: string
  readonly valid: LiveSide
  readonly invalid: LiveSide
  readonly also?: ReadonlyArray<LiveSide>
}

/** Why a rule (or the remainder of one) has no live pair. Each reason is allowed only for listed rule ids. */
export type NotLiveReason = "phase-3-offline" | "needs-second-guild" | "forbidden-action" | "pure-typing"

/**
 * No live pair: an allowlisted reason, or an escalation to Rhys citing a DESIGN §8 open question. An escalated
 * rule is an unmet Done criterion, never a pass.
 */
export type NotLive =
  | { readonly kind: "not-live"; readonly reason: NotLiveReason }
  | { readonly kind: "escalated"; readonly question: `Q-${number}` }

/** One compile-time rule. */
export interface Rule {
  readonly id: `R-${string}`
  readonly statement: string
  readonly pass: `test/types/pass/${string}.ts`
  readonly fail: `test/types/fail/${string}.ts`
  /**
   * The `// @expect-error` mentions in `fail` this rule claims. Every directive of every fail fixture must be
   * claimed by some rule, so each type restriction has a registry entry.
   */
  readonly claims: readonly [string, ...Array<string>]
  readonly live: LivePair | NotLive
  /** A not-live or escalated remainder next to a live half (e.g. registration live, delivered values escalated). */
  readonly remainder?: NotLive
  /**
   * Rule rows on other setups that the rule's statement rests on, each checked against the table like a pair's side
   * but never counted as one (after the final audit: the subject-only external-emoji rows, with and without
   * UseExternalEmojis, of a rule that needs a second guild for its pair). A side's setup is the one its ID names.
   */
  readonly evidence?: ReadonlyArray<LiveSide>
}

const succeeded: Observation = { _tag: "Succeeded" }
const refused = (status: number, code: number, inner: ReadonlyArray<{ readonly path: string; readonly code: string }> = []): Observation => ({ _tag: "Rejected", status, code, inner })
const ignored = (field: string): Observation => ({ _tag: "Ignored", field })
const applied = (field: string): Observation => ({ _tag: "Applied", field })

/** A live pair whose sides are the probes `valid` and `invalid` of the catalog's setup `setup` (`rule/<setup>/<probe>`). */
const pair = (setup: string, valid: readonly [probe: string, expect: Observation], invalid: readonly [probe: string, expect: Observation]): LivePair => ({
  kind: "pair",
  setup,
  valid: { scenario: `rule/${setup}/${valid[0]}`, expect: valid[1] },
  invalid: { scenario: `rule/${setup}/${invalid[0]}`, expect: invalid[1] }
})

const typedSend = ["typed-send", succeeded] as const

/** Further sides of a pair on its setup (`LivePair.also`): each probe of `setup` with its expectation. */
const more = (setup: string, sides: ReadonlyArray<readonly [probe: string, expect: Observation]>): ReadonlyArray<LiveSide> =>
  sides.map(([probe, expect]) => ({ scenario: `rule/${setup}/${probe}`, expect }))

const delivered = (event: string): Observation => ({ _tag: "EventDelivered", event })
const absent = (event: string, canary: string): Observation => ({ _tag: "EventAbsent", event, canary })

/**
 * A registration rule's sides (M8, `catalog/commands.ts`): the typed top-level registration succeeds, `invalid` is the
 * top-level raw side, and `also` holds the nested typed registration (which succeeds) and the nested raw sides.
 */
const commandSides = (invalid: string, expect: Observation, nested: ReadonlyArray<readonly [probe: string, expect: Observation]>): LivePair => ({
  kind: "pair",
  setup: "commands",
  valid: { scenario: "rule/commands/typed-register-options", expect: succeeded },
  invalid: { scenario: `rule/commands/${invalid}`, expect },
  also: [{ scenario: "rule/commands/typed-register-subcommands", expect: succeeded }, ...nested.map(([probe, observation]) => ({ scenario: `rule/commands/${probe}`, expect: observation }))]
})

/** A name rule: `raw-command-name-<kind>` at the top level and `raw-subcommand-name-<kind>` nested. */
const commandPair = (id: `R-${string}`, statement: string, claims: readonly [string, ...Array<string>], kind: "upper" | "space" | "33", top: Observation, nested: Observation): Rule => ({
  id,
  statement,
  pass: "test/types/pass/commands.ts",
  fail: "test/types/fail/commands.ts",
  claims,
  live: commandSides(`raw-command-name-${kind}`, top, [[`raw-subcommand-name-${kind}`, nested]])
})

/** An intent rule's pair (M7): the session with one of the event's intents receives it; the one without does not, after a canary. */
const intentPair = (name: string, event: string, canary: string): LivePair =>
  pair("text-messages", [`session-${name}-with`, delivered(event)], [`session-${name}-without`, absent(event, canary)])

/**
 * The registry. Phase 1's rules (DESIGN §5.5): every type restriction of §2.1-§2.6 and its live pair, in which
 * both sides run on one setup of `harness/scenario/catalog/rules.ts` and differ only in what they send. Where
 * §5.5's table says "with flag / without", the pair keeps the flag absent on both sides and varies the payload
 * (the feature that needs the flag is what the type adds the flag for), because both sides must share a
 * byte-identical setup (LOG.md "Design deviations", M6).
 */
export const rules: ReadonlyArray<Rule> = [
  {
    id: "R-catch-tag-exact",
    statement: "Effect.catchTag removes exactly the tag it names; catching a tag the effect cannot fail with does not compile",
    pass: "test/types/pass/catch-tag-exact.ts",
    fail: "test/types/fail/catch-tag-exact.ts",
    claims: ["Beta"],
    live: { kind: "not-live", reason: "pure-typing" }
  },
  {
    id: "R-catch-category-exact",
    statement:
      "catchCategory removes exactly the members of the categories it names, written as literals (a category typed as a union, or a list typed wider than a tuple of literals, a union of such tuples among them, does not compile); catching a category the effect cannot fail with does not compile",
    pass: "test/types/pass/catch-category-exact.ts",
    fail: "test/types/fail/catch-category-exact.ts",
    claims: [
      "payload",
      "transient",
      "catchCategory needs each category as a literal, not a union",
      "catchCategory needs the categories as a literal list",
      "this effect cannot fail with any category"
    ],
    live: { kind: "not-live", reason: "pure-typing" }
  },
  {
    id: "R-require-narrows",
    statement: "on a handle Permissions.require returned, a checked flag's Missing* becomes PermissionRevokedSinceCheck",
    pass: "test/types/pass/channels.ts",
    fail: "test/types/fail/require.ts",
    claims: ["MissingSendMessages"],
    live: { kind: "not-live", reason: "pure-typing" }
  },
  // ---- IDs and channel kinds (§2.1, §2.4, §2.5) ----
  {
    id: "R-ids-distinct",
    statement: "snowflake ID brands cannot be mixed, and a plain string is no ID",
    pass: "test/types/pass/ids.ts",
    fail: "test/types/fail/ids.ts",
    claims: ["ChannelId"],
    live: pair("text-send", typedSend, ["raw-send-user-id", refused(404, 10003)])
  },
  {
    id: "R-no-send-category",
    statement: "categories have no send",
    pass: "test/types/pass/op-errors.ts",
    fail: "test/types/fail/channel-kinds.ts",
    claims: ["CategoryChannel"],
    live: pair("text-send", typedSend, ["raw-send-category", refused(400, 50008)])
  },
  {
    id: "R-no-send-forum",
    statement: "forum and media channels have no send; they take posts",
    pass: "test/types/pass/op-errors.ts",
    fail: "test/types/fail/channel-kinds.ts",
    claims: ["'send' does not exist on type 'ForumChannel"],
    live: pair("forum", ["typed-post", succeeded], ["raw-send-forum", refused(400, 50008)])
  },
  {
    id: "R-forum-threads-need-a-message",
    statement: "forum and media channels have no createThread: a post carries its first message",
    pass: "test/types/pass/op-errors.ts",
    fail: "test/types/fail/channel-kinds.ts",
    claims: ["'createThread' does not exist on type 'ForumChannel"],
    live: pair("forum", ["typed-post", succeeded], ["raw-thread-forum", refused(400, 50035, [{ path: "message", code: "BASE_TYPE_REQUIRED" }])])
  },
  {
    id: "R-crosspost-announcement-only",
    statement: "crosspost exists only on announcement messages",
    pass: "test/types/pass/op-errors.ts",
    fail: "test/types/fail/channel-kinds.ts",
    claims: ["crosspost"],
    live: pair("announcement", ["typed-crosspost", succeeded], ["raw-crosspost-text", refused(403, 50001)])
  },
  {
    id: "R-thread-ops-threads-only",
    statement: "thread operations (join, leave, members, archive, lock) exist only on threads",
    pass: "test/types/pass/op-errors.ts",
    fail: "test/types/fail/channel-kinds.ts",
    claims: ["'join' does not exist on type 'TextChannel"],
    live: pair("thread", ["typed-join", succeeded], ["raw-join-text", refused(400, 50024)])
  },
  {
    id: "R-no-threads-on-voice",
    statement: "voice and stage channels have no threads",
    pass: "test/types/pass/op-errors.ts",
    fail: "test/types/fail/channel-kinds.ts",
    claims: ["'createThread' does not exist on type 'VoiceChannel"],
    live: pair("text-threads", ["typed-thread-name-max", succeeded], ["raw-thread-voice", refused(400, 50024)])
  },
  {
    id: "R-announcement-public-threads-only",
    statement: "announcement channels have public threads only",
    pass: "test/types/pass/channels.ts",
    fail: "test/types/fail/channel-kinds.ts",
    claims: ["announcement channels only have public threads"],
    live: pair("announcement", ["typed-announcement-thread", succeeded], ["raw-private-announcement-thread", refused(400, 50024)])
  },
  {
    id: "R-bulk-delete-at-least-2",
    statement: "a bulk delete takes at least two message IDs",
    pass: "test/types/pass/op-errors.ts",
    fail: "test/types/fail/channel-kinds.ts",
    claims: ["target requires 2"],
    live: pair("text-manage", ["typed-bulk-delete-two", succeeded], ["raw-bulk-delete-one", refused(400, 50035, [{ path: "messages", code: "BASE_TYPE_BAD_LENGTH" }])])
  },
  {
    id: "R-edit-own-only",
    statement: "edit exists only on the bot's own messages",
    pass: "test/types/pass/channels.ts",
    fail: "test/types/fail/channel-kinds.ts",
    claims: ["'edit' does not exist on type 'ForeignMessage"],
    live: pair("text-messages", ["typed-edit-own", succeeded], ["raw-edit-foreign", refused(403, 50005)])
  },
  {
    id: "R-delete-foreign-manage",
    statement: "deleting another user's message adds MissingManageMessages; deleting one's own does not",
    pass: "test/types/pass/channels.ts",
    fail: "test/types/fail/payload-flags.ts",
    claims: ["MissingManageMessages"],
    live: pair("text-messages", ["typed-delete-own", succeeded], ["raw-delete-foreign", refused(403, 50013)])
  },
  {
    id: "R-no-pins-in-voice",
    statement: "voice and stage text chat has no pins: their messages have no pin or unpin",
    pass: "test/types/pass/op-errors.ts",
    fail: "test/types/fail/channel-kinds.ts",
    claims: ["'pin' does not exist"],
    live: pair("text-pins", ["typed-pin-text", succeeded], ["raw-pin-voice", refused(400, 50019)])
  },
  {
    id: "R-no-topic-on-voice",
    statement: "voice channels have no topic to edit (a stage channel has one, M6 live)",
    pass: "test/types/pass/channels.ts",
    fail: "test/types/fail/channel-kinds.ts",
    claims: ["topic cannot be edited on this channel kind"],
    live: pair("text-manage-channels", ["typed-topic-max", succeeded], ["raw-topic-voice", refused(400, 50035, [{ path: "topic", code: "CHANNEL_TOPIC_INVALID" }])])
  },
  // ---- payload permissions (§2.3) ----
  {
    id: "R-payload-embeds",
    statement: "embeds add MissingEmbedLinks",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/payload-flags.ts",
    claims: ["MissingEmbedLinks"],
    live: pair("text-send", typedSend, ["raw-embed", refused(403, 50013)])
  },
  {
    id: "R-payload-files",
    statement: "files add MissingAttachFiles",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/payload-flags.ts",
    claims: ["MissingAttachFiles"],
    live: pair("text-send", typedSend, ["raw-file", refused(403, 50013)])
  },
  {
    id: "R-payload-tts",
    statement: "TTS without SendTTSMessages is dropped: it is in `degraded`, not an error (M4: degrade mode)",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/payload-flags.ts",
    claims: ["SendTTSMessages"],
    live: pair("text-send", typedSend, ["raw-tts", ignored("tts")])
  },
  {
    id: "R-payload-poll",
    statement: "a poll adds MissingSendPolls",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/payload-flags.ts",
    claims: ["MissingSendPolls"],
    live: pair("text-send", typedSend, ["raw-poll", refused(403, 50013)])
  },
  {
    id: "R-payload-reply-rmh",
    statement: "a reply adds MissingReadMessageHistory (the payload variant)",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/payload-flags.ts",
    claims: ["MissingReadMessageHistory"],
    live: pair("text-send", typedSend, ["raw-reply", refused(403, 160002)])
  },
  {
    id: "R-payload-thread-smit",
    statement: "in threads SendMessagesInThreads replaces SendMessages",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/payload-flags.ts",
    claims: ["MissingSendMessages"],
    live: pair("thread", ["typed-thread-send", succeeded], ["raw-send-parent", refused(403, 50013)])
  },
  {
    id: "R-payload-guild-sticker",
    statement: "a guild sticker adds no flag; only an external one adds MissingUseExternalStickers",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/payload-flags.ts",
    claims: ["MissingUseExternalStickers"],
    live: pair("text-send", ["typed-guild-sticker", succeeded], ["raw-unknown-sticker", refused(400, 50081)])
  },
  {
    id: "R-payload-external-sticker",
    statement: "an external sticker adds MissingUseExternalStickers",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/payload-flags.ts",
    claims: ["MissingUseExternalStickers"],
    live: { kind: "not-live", reason: "needs-second-guild" }
  },
  {
    id: "R-payload-external-emoji",
    statement:
      "content that may carry custom-emoji markup may have an emoji rewritten to text, reported as UseExternalEmojis in `degraded` (live on the subject's own setup, after the final audit: a made-up emoji ID is rewritten to :name: with and without UseExternalEmojis, an application emoji and the guild's own emoji are kept with and without it; the flag's own effect needs an emoji of a second guild)",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/payload-flags.ts",
    claims: ["UseExternalEmojis"],
    live: { kind: "not-live", reason: "needs-second-guild" },
    // H-104 on the subject's own setup, without and with UseExternalEmojis: the made-up ID is rewritten for a reason other
    // than the flag (the bot can use no such emoji), and the app emoji is exempt, so neither pair shows the flag's effect
    evidence: [
      ...more("text-send", [["typed-emoji-made-up", ignored("content")], ["typed-emoji-app", applied("content")], ["typed-emoji-guild", applied("content")]]),
      ...more("text-external-emoji", [["typed-emoji-made-up", ignored("content")], ["typed-emoji-app", applied("content")], ["typed-emoji-guild", applied("content")]])
    ]
  },
  {
    id: "R-mention-everyone-degrades",
    statement: "without MentionEveryone a role mention is dropped (in `degraded`), not an error",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/payload-flags.ts",
    claims: ["MentionEveryone"],
    live: pair("text-send", ["typed-mention-mentionable", applied("mention_roles")], ["typed-mention-unmentionable", ignored("mention_roles")]),
    remainder: { kind: "not-live", reason: "forbidden-action" }
  },
  // ---- payload shape (§2.3) ----
  {
    id: "R-nonempty",
    statement: "a message needs content, embeds, files, stickers, a poll or components",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/payload-rules.ts",
    claims: ["a message needs"],
    live: pair("text-send", typedSend, ["raw-empty", refused(400, 50006)])
  },
  {
    id: "R-cv2-excludes",
    statement: "a Components V2 message has no content, embeds, stickers or poll",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/payload-rules.ts",
    claims: ["content is not allowed in a componentsV2 message", "embeds is not allowed in a componentsV2 message"],
    live: pair("text-send", ["typed-cv2", succeeded], ["raw-cv2-content", refused(400, 50035, [{ path: "content", code: "MESSAGE_CANNOT_USE_LEGACY_FIELDS_WITH_COMPONENTS_V2" }])])
  },
  {
    id: "R-row-5-buttons",
    statement:
      "an action row holds 1 to 5 buttons (live: 5 and 6, and an empty row), written as a literal list (a computed row is an error); a message holds at most 5 rows (after the final audit; live: 5 and 6 on a create and an edit; on an interaction reply typed only, as every interaction response is)",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/components.ts",
    claims: ["1 to 5 buttons", "an action row holds 1 to 5 buttons", "row takes its elements as a literal list", "a message holds at most 5 action rows"],
    live: {
      ...pair("text-send", ["typed-five-links", succeeded], ["raw-six-links", refused(400, 50035, [{ path: "components.0.components", code: "BASE_TYPE_BAD_LENGTH" }])]),
      // after the final audit: five rows of one button (also the lower bound of a row), six, an empty row; on an edit too
      also: more("text-send", [
        ["typed-five-rows", succeeded],
        ["raw-six-rows", refused(400, 50035, [{ path: "components", code: "BASE_TYPE_MAX_LENGTH" }])],
        ["raw-empty-row", refused(400, 50035, [{ path: "components.0.components", code: "BASE_TYPE_BAD_LENGTH" }])],
        ["typed-edit-five-rows", succeeded],
        ["raw-edit-six-rows", refused(400, 50035, [{ path: "components", code: "BASE_TYPE_MAX_LENGTH" }])]
      ])
    }
  },
  {
    id: "R-select-alone",
    statement: "a select menu is alone in its row",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/components.ts",
    claims: ["must be alone in its row"],
    live: pair("text-send", ["typed-select-alone", succeeded], ["raw-select-with-button", refused(400, 50035, [{ path: "components.0.components.1", code: "COMPONENT_LAYOUT_WIDTH_EXCEEDED" }])])
  },
  {
    id: "R-link-no-custom-id",
    statement: "link buttons have no customId; only link buttons have a url (after the final audit; live: an interactive button without a url is accepted, one with a url refused)",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/components.ts",
    claims: ["link buttons have no customId", "customId", "only link buttons have a url"],
    live: {
      ...pair(
        "text-send",
        ["typed-five-links", succeeded],
        [
          "raw-link-custom-id",
          refused(400, 50035, [
            { path: "components.0.components.0.custom_id", code: "BUTTON_COMPONENT_CUSTOM_ID_URL_MUTUALLY_EXCLUSIVE" },
            { path: "components.0.components.0.url", code: "BUTTON_COMPONENT_CUSTOM_ID_URL_MUTUALLY_EXCLUSIVE" }
          ])
        ]
      ),
      // after the final audit: an interactive button, and the same with a url
      also: more("text-send", [
        ["typed-interactive-button", succeeded],
        [
          "raw-interactive-url",
          refused(400, 50035, [
            { path: "components.0.components.0.custom_id", code: "BUTTON_COMPONENT_CUSTOM_ID_URL_MUTUALLY_EXCLUSIVE" },
            { path: "components.0.components.0.url", code: "BUTTON_COMPONENT_CUSTOM_ID_URL_MUTUALLY_EXCLUSIVE" }
          ])
        ]
      ])
    }
  },
  {
    id: "R-premium-no-label",
    statement: "premium buttons have no label; nor a customId (after the final audit; live: the customId's own path appears beside the unowned SKU's)",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/components.ts",
    claims: ["premium buttons have no label", "label", "premium buttons have no customId"],
    live: {
      ...pair(
        "text-send",
        // open question 6 decided (M6 live): with a SKU the application does not own, the label's own path still appears
        ["raw-premium-unlabelled", refused(400, 50035, [{ path: "components.0.components.0.sku_id", code: "BUTTON_COMPONENT_INVALID_SKU_UNAVAILABLE" }])],
        [
          "raw-premium-labelled",
          refused(400, 50035, [
            { path: "components.0.components.0.label", code: "BUTTON_COMPONENT_SKU_ID_LABEL_MUTUALLY_EXCLUSIVE" },
            { path: "components.0.components.0.sku_id", code: "BUTTON_COMPONENT_INVALID_SKU_UNAVAILABLE" }
          ])
        ]
      ),
      // after the final audit: a premium button with a custom_id, against the valid side's unowned SKU alone
      also: more("text-send", [
        [
          "raw-premium-custom-id",
          refused(400, 50035, [
            { path: "components.0.components.0.custom_id", code: "BUTTON_COMPONENT_CUSTOM_ID_SKU_MUTUALLY_EXCLUSIVE" },
            { path: "components.0.components.0.sku_id", code: "BUTTON_COMPONENT_INVALID_SKU_UNAVAILABLE" }
          ])
        ]
      ])
    }
  },
  // ---- mentions and flags (§2.3) ----
  {
    id: "R-allowed-mentions-none",
    statement: "allowed_mentions is not settable: the library pings nobody unless `mentions` opts in",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/payload-rules.ts",
    claims: ["allowed_mentions is not valid when creating a message"],
    live: pair("text-send", ["typed-mention-user", ignored("mentions")], ["raw-mention-user", applied("mentions")])
  },
  {
    id: "R-create-flags-only",
    statement: "Ephemeral exists only on interaction responses: a create has no `ephemeral`",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/payload-rules.ts",
    claims: ["ephemeral is not valid when creating a message"],
    live: pair("text-send", ["typed-suppress-notifications", applied("flags")], ["raw-ephemeral", ignored("flags")])
  },
  {
    id: "R-suppress-notifications-create-only",
    statement: "SuppressNotifications exists only on create",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/payload-rules.ts",
    claims: ["suppressNotifications is not valid when editing a message"],
    live: pair("text-send", ["typed-suppress-notifications", applied("flags")], ["raw-edit-suppress-notifications", ignored("flags")])
  },
  // ---- limits (§2.3, §2.4, §2.6), each sent at exactly `Limits` and one over ----
  {
    id: "R-content-length",
    statement: "non-literal content may be too long (ContentTooLong), and so may a literal over the limit; a literal within it cannot",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/limits.ts",
    claims: ["ContentTooLong"],
    live: pair("text-send", ["typed-content-max", succeeded], ["raw-content-over", refused(400, 50035, [{ path: "content", code: "BASE_TYPE_MAX_LENGTH" }])])
  },
  {
    id: "R-embed-limits",
    statement: "embeds may be too large (EmbedTooLarge); a payload without embeds cannot",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/limits.ts",
    claims: ["EmbedTooLarge"],
    live: pair("text-rich", ["typed-embed-max", succeeded], ["raw-embed-over", refused(400, 50035, [{ path: "embeds.0.title", code: "BASE_TYPE_MAX_LENGTH" }])])
  },
  {
    id: "R-poll-limits",
    statement: "a poll may be too large (PollTooLarge); a payload without a poll cannot",
    pass: "test/types/pass/payload.ts",
    fail: "test/types/fail/limits.ts",
    claims: ["PollTooLarge"],
    live: pair("text-rich", ["typed-poll-max", succeeded], ["raw-poll-over", refused(400, 50035, [{ path: "poll.question.text", code: "BASE_TYPE_BAD_LENGTH" }])])
  },
  {
    id: "R-name-length",
    statement:
      "a channel, thread or post name may be refused (NameTooLong) unless it is a literal of 1 to 100 characters: a non-literal, a literal over 100 (live: 100 and 101) or the empty literal (after the final audit; typed only: the lab guard sends only lab-named channels and threads, and an empty name is none)",
    pass: "test/types/pass/channels.ts",
    fail: "test/types/fail/limits.ts",
    claims: ["NameTooLong"],
    live: pair("text-threads", ["typed-thread-name-max", succeeded], ["raw-thread-name-over", refused(400, 50035, [{ path: "name", code: "BASE_TYPE_BAD_LENGTH" }])])
  },
  {
    id: "R-topic-length",
    statement: "a non-literal topic may be too long (TopicTooLong), and so may a literal over the limit; a literal within it cannot",
    pass: "test/types/pass/channels.ts",
    fail: "test/types/fail/limits.ts",
    claims: ["TopicTooLong"],
    live: pair("text-manage-channels", ["typed-topic-max", succeeded], ["raw-topic-over", refused(400, 50035, [{ path: "topic", code: "BASE_TYPE_MAX_LENGTH" }])])
  },
  {
    id: "R-slowmode-range",
    statement:
      "a slowmode may be refused (SlowmodeOutOfRange) unless it is a literal whole number of at most four digits (after the final audit; live: Discord accepts 21,600 and refuses 21,601 and -1; it accepts 1.5 and stores 1, so the library refuses a fraction before sending, rather than have Discord change the value)",
    pass: "test/types/pass/channels.ts",
    fail: "test/types/fail/limits.ts",
    claims: ["SlowmodeOutOfRange"],
    live: {
      ...pair("text-manage-channels", ["typed-slowmode-max", succeeded], ["raw-slowmode-over", refused(400, 50035, [{ path: "rate_limit_per_user", code: "NUMBER_TYPE_MAX" }])]),
      // after the final audit: below the range, and a fraction, which Discord accepts and truncates (a live finding)
      also: more("text-manage-channels", [
        ["raw-slowmode-negative", refused(400, 50035, [{ path: "rate_limit_per_user", code: "NUMBER_TYPE_MIN" }])],
        ["raw-slowmode-fraction", applied("rate_limit_per_user 1")]
      ])
    }
  },
  {
    id: "R-nickname-length",
    statement: "a non-literal nickname may be too long (NicknameTooLong), and so may a literal over the limit; clearing one cannot",
    pass: "test/types/pass/channels.ts",
    fail: "test/types/fail/limits.ts",
    claims: ["NicknameTooLong"],
    live: pair("members", ["typed-nickname-max", succeeded], ["raw-nickname-over", refused(400, 50035, [{ path: "nick", code: "BASE_TYPE_MAX_LENGTH" }])])
  },
  {
    id: "R-timeout-28-days",
    statement: "a timeout date may be more than 28 days ahead (TimeoutTooLong); lifting one cannot",
    pass: "test/types/pass/channels.ts",
    fail: "test/types/fail/limits.ts",
    claims: ["TimeoutTooLong"],
    live: pair("members", ["typed-timeout-max", succeeded], ["raw-timeout-over", refused(400, 50035, [{ path: "communication_disabled_until", code: "INVALID_COMMUNICATION_DISABLED_TIMESTAMP" }])])
  },
  // ---- intents, events and message content (§2.7, M7) ----
  {
    id: "R-intent-guild-messages",
    statement: "bot.on(\"MESSAGE_CREATE\") compiles only with GuildMessages or DirectMessages; a guild message arrives only with GuildMessages",
    pass: "test/types/pass/bot.ts",
    fail: "test/types/fail/bot.ts",
    claims: ["GuildMessages"],
    live: intentPair("guild-messages", "MESSAGE_CREATE", "CHANNEL_UPDATE"),
    // the DM intents' delivery needs a human DM (Q-22, the M7 verifier)
    remainder: { kind: "escalated", question: "Q-22" }
  },
  {
    id: "R-intent-reactions",
    statement: "bot.on(\"MESSAGE_REACTION_ADD\") compiles only with GuildMessageReactions or DirectMessageReactions; a guild reaction arrives only with GuildMessageReactions",
    pass: "test/types/pass/bot.ts",
    fail: "test/types/fail/bot.ts",
    claims: ["GuildMessageReactions"],
    live: intentPair("reactions", "MESSAGE_REACTION_ADD", "CHANNEL_UPDATE"),
    // the DM intents' delivery needs a human DM (Q-22, the M7 verifier)
    remainder: { kind: "escalated", question: "Q-22" }
  },
  {
    id: "R-intent-typing",
    statement: "bot.on(\"TYPING_START\") compiles only with GuildMessageTyping or DirectMessageTyping; guild typing arrives only with GuildMessageTyping",
    pass: "test/types/pass/bot.ts",
    fail: "test/types/fail/bot.ts",
    claims: ["GuildMessageTyping"],
    live: intentPair("typing", "TYPING_START", "CHANNEL_UPDATE"),
    // the DM intents' delivery needs a human DM (Q-22, the M7 verifier)
    remainder: { kind: "escalated", question: "Q-22" }
  },
  {
    id: "R-intent-guild-members",
    statement:
      "bot.on(\"GUILD_MEMBER_UPDATE\") compiles only with GuildMembers, declared as a literal list of literals (a widened list, an element typed as a union and a conditional spread are errors); an update about another member arrives only with GuildMembers",
    pass: "test/types/pass/bot.ts",
    fail: "test/types/fail/bot.ts",
    claims: ["GuildMembers", "intents must be written as a literal list", "each intent must be a literal"],
    live: intentPair("guild-members", "GUILD_MEMBER_UPDATE", "CHANNEL_UPDATE")
  },
  {
    id: "R-intent-guilds",
    statement: "bot.on(\"CHANNEL_UPDATE\") compiles only with Guilds; a channel update arrives only with Guilds",
    pass: "test/types/pass/bot.ts",
    fail: "test/types/fail/bot.ts",
    claims: ["Guilds"],
    live: intentPair("guilds", "CHANNEL_UPDATE", "GUILD_MEMBER_UPDATE")
  },
  {
    id: "R-message-content",
    statement:
      "message.content is a string only where Discord delivers it: with MessageContent, or (contentDelivered) for the bot's own messages, messages that mention it, ping-on replies to it and DMs; elsewhere it is ContentUnavailable",
    pass: "test/types/pass/bot.ts",
    fail: "test/types/fail/bot.ts",
    claims: ["ContentUnavailable"],
    live: {
      ...pair("text-messages", ["session-content-with", applied("content")], ["session-content-without", ignored("content")]),
      also: [
        { scenario: "rule/text-messages/session-content-mention", expect: applied("content") },
        { scenario: "rule/text-messages/session-content-reply", expect: applied("content") },
        { scenario: "rule/text-messages/session-content-own", expect: applied("content") }
      ]
    },
    remainder: { kind: "escalated", question: "Q-17" }
  },
  // ---- commands and registration (§2.8, §4.14, M8): typed registrations through the library / raw POSTs under one
  // command name (H-205), at the top level and nested ----
  commandPair(
    "R-command-name-lowercase",
    "command, subcommand and group names are lowercase (a literal name that is not fails with its lowercase form); live: the command's and a subcommand's name, and a group's name has its own fail directive",
    ['\'"ban"\'', "names must be lowercase: add", "names must be lowercase: role"],
    "upper",
    { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "name", code: "APPLICATION_COMMAND_INVALID_NAME" }] },
    { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "options.0.name", code: "APPLICATION_COMMAND_INVALID_NAME" }] }
  ),
  commandPair(
    "R-command-name-spaces",
    "command, subcommand and group names have no spaces; live: the command's and a subcommand's name, and a group's name has its own fail directive",
    ["names cannot contain spaces: ban user", "names cannot contain spaces: lab sub", "names cannot contain spaces: ro le"],
    "space",
    { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "name", code: "STRING_TYPE_REGEX" }] },
    { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "options.0.name", code: "STRING_TYPE_REGEX" }] }
  ),
  commandPair(
    "R-command-name-length",
    "command, subcommand and group names are 1 to 32 characters (the typed sides register 32); live: the command's and a subcommand's name, and a group's name has its own fail directive",
    ["names are 1 to 32 characters"],
    "33",
    { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "name", code: "BASE_TYPE_BAD_LENGTH" }] },
    { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "options.0.name", code: "BASE_TYPE_BAD_LENGTH" }] }
  ),
  {
    id: "R-option-name-lowercase",
    statement: "value option names are lowercase, at the top level and in subcommands",
    pass: "test/types/pass/commands.ts",
    fail: "test/types/fail/commands.ts",
    claims: ["names must be lowercase: reason", "names must be lowercase: user"],
    live: commandSides("raw-option-name-upper", { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "options.0.name", code: "APPLICATION_COMMAND_INVALID_NAME" }] }, [
      ["raw-option-name-upper-nested", { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "options.0.options.0.name", code: "APPLICATION_COMMAND_INVALID_NAME" }] }]
    ])
  },
  {
    id: "R-option-order",
    statement: "required options come before every optional option, at the top level and in subcommands",
    pass: "test/types/pass/commands.ts",
    fail: "test/types/fail/commands.ts",
    claims: ["required option feature must come before every optional option", "required option user must come before every optional option", "required option b must come before every optional option"],
    live: commandSides("raw-option-order", { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "options.1", code: "APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID" }] }, [
      ["raw-option-order-nested", { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "options.0.options.1", code: "APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID" }] }]
    ])
  },
  {
    id: "R-option-count",
    statement: "at most 25 options, and at most 25 subcommands and groups, per level (the typed sides register 25)",
    pass: "test/types/pass/commands.ts",
    fail: "test/types/fail/commands.ts",
    claims: ["at most 25 options per level", "at most 25 subcommands per level"],
    live: commandSides("raw-option-count", { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "options", code: "BASE_TYPE_MAX_LENGTH" }] }, [
      ["raw-option-count-nested", { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "options.0.options", code: "BASE_TYPE_MAX_LENGTH" }] }],
      ["raw-subcommand-count-nested", { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "options.0.options", code: "BASE_TYPE_MAX_LENGTH" }] }]
    ])
  },
  {
    id: "R-subcommand-nesting",
    statement: "a group holds only subcommands and a subcommand only value options: no group in a group or a subcommand (H-196)",
    pass: "test/types/pass/commands.ts",
    fail: "test/types/fail/commands.ts",
    claims: ['\'"subcommand"\'', '\'"group"\''],
    live: {
      kind: "pair",
      setup: "commands",
      valid: { scenario: "rule/commands/typed-register-subcommands", expect: succeeded },
      // a group's or a subcommand's options admit only subcommands or only value options: a group there fails the union
      invalid: { scenario: "rule/commands/raw-group-in-group", expect: { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "options.0.options.0", code: "UNION_TYPE_CHOICES" }] } },
      also: [{ scenario: "rule/commands/raw-group-in-subcommand", expect: { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "options.0.options.0", code: "UNION_TYPE_CHOICES" }] } }]
    }
  },
  {
    id: "R-subcommand-mixing",
    statement: "no value options next to subcommands, at the top level (Command.withSubcommands) and in a group (H-197)",
    pass: "test/types/pass/commands.ts",
    fail: "test/types/fail/commands.ts",
    claims: ["subcommands and groups go in Command.withSubcommands", '\'"string"\''],
    // H-197 holds: the top level refuses a subcommand after a value option; a group refuses a value option among its subcommands
    live: commandSides("raw-subcommand-mixed", { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "options.1", code: "APPLICATION_COMMAND_OPTIONS_TYPE_INVALID" }] }, [
      ["raw-subcommand-mixed-nested", { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "options.0.options.1", code: "UNION_TYPE_CHOICES" }] }]
    ])
  },
  {
    id: "R-options-typed",
    statement:
      "a handler's option values are typed from the definition: required versus optional, choices as their literal union (of the option's type), channel options as the handles of their kinds",
    pass: "test/types/pass/commands.ts",
    fail: "test/types/fail/commands.ts",
    claims: [
      "Type 'number' is not assignable to type 'string'",
      "possibly 'undefined'",
      "have no overlap",
      "Property 'createPost' does not exist"
    ],
    live: pair(
      "commands",
      ["typed-register-choices", applied("options")],
      ["raw-choice-wrong-type", { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "options.0.choices.0.value", code: "STRING_TYPE_CONVERT" }] }]
    ),
    // a handler receiving real option values needs a human to run the command (Q-18)
    remainder: { kind: "escalated", question: "Q-18" }
  },
  {
    id: "R-option-keys",
    statement:
      "each option type takes only its own keys (after the final audit): choices and autocomplete only string, integer and number options, minLength and maxLength only string options, minValue and maxValue only integer and number options, channelTypes only channel options (live: every key on a type that takes it is stored as defined; each key on every type the library refuses it on is accepted and dropped, so it would have no effect)",
    pass: "test/types/pass/commands.ts",
    fail: "test/types/fail/commands.ts",
    claims: [
      "only string, integer and number options take choices",
      "only string, integer and number options take autocomplete",
      "only string options take minLength",
      "only string options take maxLength",
      "only integer and number options take minValue",
      "only integer and number options take maxValue",
      "only channel options take channelTypes"
    ],
    live: {
      ...pair("commands", ["typed-register-option-keys", applied("option-keys")], ["raw-option-key-choices", ignored("choices")]),
      // every other key, each on every option type the library refuses it on
      also: more("commands", [
        ["raw-option-key-autocomplete", ignored("autocomplete")],
        ["raw-option-key-min-length", ignored("min_length")],
        ["raw-option-key-max-length", ignored("max_length")],
        ["raw-option-key-min-value", ignored("min_value")],
        ["raw-option-key-max-value", ignored("max_value")],
        ["raw-option-key-channel-types", ignored("channel_types")]
      ])
    }
  },
  {
    id: "R-registration-diff",
    statement:
      "a bot registers only commands Command.* built (so every definition passed its checks), only in a guild (BotConfig.commands needs a guildId, D18), and registration writes only when a canonical field changed: once per changed definition, never for the same definitions (live, each mutation row syncs over the row before it, so it shows one write per changed definition; that each single canonical field is detected is held offline, registration.test.ts and canonical.test.ts)",
    pass: "test/types/pass/commands.ts",
    fail: "test/types/fail/commands.ts",
    claims: ["InvocationType", "guildId"],
    live: {
      kind: "pair",
      setup: "commands",
      valid: { scenario: "rule/commands/typed-sync-identical", expect: { _tag: "Writes", count: 0 } },
      invalid: { scenario: "rule/commands/typed-sync-description", expect: { _tag: "Writes", count: 1 } },
      also: (["channel-types", "choices", "name", "option-name", "required"] as const).map((field) => ({ scenario: `rule/commands/typed-sync-${field}`, expect: { _tag: "Writes", count: 1 } }))
    }
  },
  {
    id: "R-custom-id-routing",
    statement:
      "a component's custom_id comes from a route: schema-typed data, checked against 100 characters when built (CustomIdTooLong), decoded back to the same data; a route name is a literal with no ':' (a route or command registered twice on one bot dies, after the final audit)",
    pass: "test/types/pass/routes.ts",
    fail: "test/types/fail/routes.ts",
    claims: ["route names cannot contain ':'", "route names must be literals", 'UnhandledErrors<"payload">', "Type '\"maybe\"' is not assignable", "have no overlap"],
    live: pair(
      "commands",
      ["typed-custom-id-max", succeeded],
      ["raw-custom-id-over", { _tag: "Rejected", status: 400, code: 50035, inner: [{ path: "components.0.components.0.custom_id", code: "BASE_TYPE_BAD_LENGTH" }] }]
    ),
    // a handler receiving a real click needs a human (Q-18)
    remainder: { kind: "escalated", question: "Q-18" }
  },
  // ---- the handler boundary (§2.7, D1, D6) ----
  {
    id: "R-handler-boundary",
    statement:
      "a handler registered with bot.on compiles only if every error it can still fail with is purely transient: a permission, payload, access or state error, an uncategorised one, or one widened to a categorised supertype (Categorized<\"transient\"> included), names what to handle; a handler that returns no Effect says so",
    pass: "test/types/pass/bot.ts",
    fail: "test/types/fail/bot.ts",
    claims: ["permission", "state", "payload", "Oops", "a widened categorised type", "MustReturnEffect", "a handler must return an Effect"],
    live: { kind: "not-live", reason: "pure-typing" }
  },
  {
    id: "R-transient-only-escapes",
    statement: "only a purely transient error may escape a handler; one that is transient and also state must be handled (D6), also once its type is widened to Categorized<\"transient\">",
    pass: "test/types/pass/bot.ts",
    fail: "test/types/fail/bot.ts",
    // the category the boundary names, not the error's name, which tsc prints in the effect's type anyway (M7 verifier)
    claims: ['UnhandledErrors<"state">', "a widened categorised type"],
    live: { kind: "not-live", reason: "pure-typing" }
  }
  ,
  // ---- the interaction state machine (§2.10, phase 3, M9): offline by the orchestrator's decision; the human checklist
  // is in LOG.md "Waiting for Rhys" ----
  {
    id: "R-modal-before-answer",
    statement:
      "showModal exists only on an interaction not yet answered with auto-defer off (\"manual\"); under auto-defer it does not exist, and ix stays typed under Effect.fn",
    pass: "test/types/pass/interactions.ts",
    fail: "test/types/fail/interactions.ts",
    claims: ["showModal", "thisDoesNotExist"],
    live: { kind: "not-live", reason: "phase-3-offline" }
  },
  {
    id: "R-no-modal-from-modal",
    statement: "a modal submit cannot open another modal",
    pass: "test/types/pass/interactions.ts",
    fail: "test/types/fail/interactions.ts",
    claims: ["ModalSubmitInteraction"],
    live: { kind: "not-live", reason: "phase-3-offline" }
  },
  {
    id: "R-followup-after-answer",
    statement: "follow-ups exist only in the continuation that receives the answered interaction, so following up before answering, or answering twice, cannot be written",
    pass: "test/types/pass/interactions.ts",
    fail: "test/types/fail/interactions.ts",
    claims: ["followUp"],
    live: { kind: "not-live", reason: "phase-3-offline" }
  },
  {
    id: "R-autocomplete-choices",
    statement: "an autocomplete handler can only respond with choices",
    pass: "test/types/pass/interactions.ts",
    fail: "test/types/fail/interactions.ts",
    claims: ["AutocompleteInteraction"],
    live: { kind: "not-live", reason: "phase-3-offline" }
  },
  {
    id: "R-must-respond",
    statement: "an interaction handler must return a response, which only the interaction's own methods make (an object literal is none)",
    pass: "test/types/pass/interactions.ts",
    fail: "test/types/fail/interactions.ts",
    claims: ["must return"],
    live: { kind: "not-live", reason: "phase-3-offline" }
  },
  {
    id: "R-deferred-must-complete",
    statement: "a deferral's continuation must finish with deferred.editOriginal(...) or deferred.giveUp(...), the only producers of the nominal Completed",
    pass: "test/types/pass/interactions.ts",
    fail: "test/types/fail/interactions.ts",
    claims: ["editOriginal"],
    live: { kind: "not-live", reason: "phase-3-offline" }
  },
  {
    id: "R-ephemeral-matches-mode",
    statement: "the registration mode fixes the response: a reply's and a deferral's ephemeral state match it (H-227), and \"update\" offers only update and deferUpdate",
    pass: "test/types/pass/interactions.ts",
    fail: "test/types/fail/interactions.ts",
    claims: ["ephemeral must match the registration mode public", "ephemeral must match the registration mode ephemeral", "Property 'reply' does not exist on type 'UpdateComponentInteraction"],
    live: { kind: "not-live", reason: "phase-3-offline" }
  },
  {
    id: "R-reply-nonempty",
    statement: "a reply or follow-up needs a body, and a dynamic reply's limit errors (too long, empty) are typed and must be handled",
    pass: "test/types/pass/interactions.ts",
    fail: "test/types/fail/interactions.ts",
    claims: ["a message needs", 'UnhandledErrors<"payload">'],
    live: { kind: "not-live", reason: "phase-3-offline" }
  }
]
