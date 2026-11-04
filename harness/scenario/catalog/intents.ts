/**
 * The intent sessions (DESIGN §5.5, §5.10 "Intent sessions"; M7): pure descriptions of the subject sessions that are
 * the live pairs of the intent rules and the message-content rule. Execution is `harness/Sessions.ts`; the rows are
 * rule rows (`rule/<setup>/<session>`, `catalog/rules.ts`), so they share the rule rows' setups, safety, cleanup and
 * agreement (`rule-observation`).
 *
 * Each session is one fresh gateway connection of the subject (the library's own bot build, with the capabilities
 * codec), identified with exactly `intents`, run serially while the subject's main session stays connected:
 *
 * 1. READY must name the subject, and the codec's Identify must carry exactly the declared intents;
 * 2. the trigger: the target (or the harness, or the subject) does what produces `event` in `lab-text`;
 * 3. the canary, after the trigger: an event the session receives whatever the intent under test (a harness
 *    slowmode edit of `lab-bots-only`, CHANNEL_UPDATE under Guilds; for a session without Guilds, a GUILD_MEMBER_UPDATE
 *    about the subject itself, which arrives without GuildMembers, H-175);
 * 4. the observation: `EventDelivered` when the trigger's own dispatch arrived, `EventAbsent` with the canary that did
 *    arrive (or `none`, which no expectation accepts); for `content`, `Applied`/`Ignored` `content` from Discord's
 *    payload. Where the dispatch arrived, the library's `bot.on` must have received it decoded, and for content its
 *    `contentDelivered` must say what Discord delivered; otherwise the observation names the library's
 *    disagreement, which no expectation accepts.
 *
 * The trigger for member events targets the target, never the subject, because events about the subject arrive
 * without the intent (H-175). Sessions run on `catalog/rules.ts`'s `text-messages` setup (the subject sees and may
 * post in `lab-text`, where the harness's and the subject's messages are the reaction's and the reply's targets).
 */
import type { EventName, Intent } from "../../../src/gateway/Intents.ts"

/** What makes the session's event happen. */
export type Trigger =
  /** The target posts a plain message in `lab-text`. */
  | "target-message"
  /** The target posts a message that mentions the subject (with `allowed_mentions.users` naming it). */
  | "target-mention"
  /** The target replies to the subject's message with `replied_user: true` (a ping-on reply). */
  | "target-reply"
  /** The subject posts a plain message itself (through `SubjectRaw`). */
  | "subject-message"
  /** The target reacts to the harness's message. */
  | "target-reaction"
  /** The target starts typing in `lab-text`. */
  | "target-typing"
  /** The harness sets the target's nickname. */
  | "target-nickname"
  /** The harness sets `lab-bots-only`'s slowmode. */
  | "channel-slowmode"

/** One session's description. */
export interface SessionSpec {
  readonly intents: ReadonlyArray<Intent>
  /** The event the observation is about. */
  readonly event: EventName
  readonly trigger: Trigger
  /** `delivery`: did the event arrive; `content`: did its message carry content. */
  readonly observe: "delivery" | "content"
  /** The event that must arrive after the trigger for an absence to count. */
  readonly canary: "CHANNEL_UPDATE" | "GUILD_MEMBER_UPDATE"
}

const delivery = (event: EventName, trigger: Trigger, intents: ReadonlyArray<Intent>): SessionSpec => ({ intents, event, trigger, observe: "delivery", canary: "CHANNEL_UPDATE" })
const content = (trigger: Trigger, intents: ReadonlyArray<Intent>): SessionSpec => ({ intents, event: "MESSAGE_CREATE", trigger, observe: "content", canary: "CHANNEL_UPDATE" })
const withoutContent: ReadonlyArray<Intent> = ["Guilds", "GuildMessages"]

/** The session probe names, in table order. */
export const sessionNames = [
  "session-guild-messages-with",
  "session-guild-messages-without",
  "session-reactions-with",
  "session-reactions-without",
  "session-typing-with",
  "session-typing-without",
  "session-guild-members-with",
  "session-guild-members-without",
  "session-guilds-with",
  "session-guilds-without",
  "session-content-with",
  "session-content-without",
  "session-content-mention",
  "session-content-reply",
  "session-content-own"
] as const

/** A session's probe name. */
export type SessionName = (typeof sessionNames)[number]

/** Every session, by its probe name. */
export const sessions: { readonly [N in SessionName]: SessionSpec } = {
  "session-guild-messages-with": delivery("MESSAGE_CREATE", "target-message", ["Guilds", "GuildMessages"]),
  "session-guild-messages-without": delivery("MESSAGE_CREATE", "target-message", ["Guilds"]),
  "session-reactions-with": delivery("MESSAGE_REACTION_ADD", "target-reaction", ["Guilds", "GuildMessageReactions"]),
  "session-reactions-without": delivery("MESSAGE_REACTION_ADD", "target-reaction", ["Guilds"]),
  "session-typing-with": delivery("TYPING_START", "target-typing", ["Guilds", "GuildMessageTyping"]),
  "session-typing-without": delivery("TYPING_START", "target-typing", ["Guilds"]),
  "session-guild-members-with": delivery("GUILD_MEMBER_UPDATE", "target-nickname", ["Guilds", "GuildMembers"]),
  "session-guild-members-without": delivery("GUILD_MEMBER_UPDATE", "target-nickname", ["Guilds"]),
  "session-guilds-with": { intents: ["Guilds"], event: "CHANNEL_UPDATE", trigger: "channel-slowmode", observe: "delivery", canary: "GUILD_MEMBER_UPDATE" },
  "session-guilds-without": { intents: [], event: "CHANNEL_UPDATE", trigger: "channel-slowmode", observe: "delivery", canary: "GUILD_MEMBER_UPDATE" },
  "session-content-with": content("target-message", ["Guilds", "GuildMessages", "MessageContent"]),
  "session-content-without": content("target-message", withoutContent),
  "session-content-mention": content("target-mention", withoutContent),
  "session-content-reply": content("target-reply", withoutContent),
  "session-content-own": content("subject-message", withoutContent)
}

/** Whether a probe name is a session's. */
export const isSessionName = (name: string): name is SessionName => (sessionNames as ReadonlyArray<string>).includes(name)
