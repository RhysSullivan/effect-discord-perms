/**
 * Gateway intents and the events they deliver (DESIGN §2.7, D24; `[sd:src/bot.ts]`).
 *
 * - {@link Intents} is the list of intent names, exactly dfx's (and Discord's) `GatewayIntentBits` keys; a pass
 *   fixture holds the two equal, so a dfx upgrade that adds one fails the build.
 * - {@link EventIntents} lists **only the events the library supports**: each has a live intent pair in the rule
 *   registry (`test/rules.ts`), a subject session with one of its intents that received it and one without that
 *   did not, after a canary event the same session did receive (§5.5, §5.10; rules-check's events check). An
 *   event delivered whatever the intents (READY, H-179) maps to `never`. Adding an event means adding its pair.
 * - `IntentCheck<K, I>` is prior-art formulation 2: the event name is intersected with a message type naming the
 *   intents that would deliver it, so `bot.on("GUILD_MEMBER_UPDATE", ...)` without GuildMembers fails in one line
 *   that says `missing intent, add one of: "GuildMembers"`.
 */
import { Discord } from "dfx"

/** Every gateway intent, by dfx's (and Discord's) name, in bit order. */
export const Intents = [
  "Guilds",
  "GuildMembers",
  "GuildModeration",
  "GuildExpressions",
  "GuildIntegrations",
  "GuildWebhooks",
  "GuildInvites",
  "GuildVoiceStates",
  "GuildPresences",
  "GuildMessages",
  "GuildMessageReactions",
  "GuildMessageTyping",
  "DirectMessages",
  "DirectMessageReactions",
  "DirectMessageTyping",
  "MessageContent",
  "GuildScheduledEvents",
  "AutoModerationConfiguration",
  "AutoModerationExecution",
  "GuildMessagePolls",
  "DirectMessagePolls"
] as const satisfies ReadonlyArray<keyof typeof Discord.GatewayIntentBits>

/** A gateway intent's name. */
export type Intent = (typeof Intents)[number]

/** The intents bitfield Identify sends for `intents`. */
export const intentBits = (intents: ReadonlyArray<Intent>): number => intents.reduce((bits, intent) => bits | Discord.GatewayIntentBits[intent], 0)

/** The intent names a bitfield holds, in {@link Intents} order (bits no intent has are dropped). */
export const intentsOf = (bits: number): ReadonlyArray<Intent> => Intents.filter((intent) => (bits & Discord.GatewayIntentBits[intent]) !== 0)

/** The intents Discord gates behind an application flag (startup check 2, §4.4). */
export type PrivilegedIntent = "GuildPresences" | "GuildMembers" | "MessageContent"

const privileged: ReadonlySet<Intent> = new Set<Intent>(["GuildMembers", "MessageContent", "GuildPresences"])

/** The declared intents Discord gates behind an application flag (startup check 2, §4.4). */
export const privilegedIntents = (intents: ReadonlyArray<Intent>): ReadonlyArray<PrivilegedIntent> =>
  intents.filter((intent): intent is PrivilegedIntent => privileged.has(intent))

/**
 * The supported events and the intents that deliver each (one of them suffices): the runtime table the types
 * derive from and rules-check's events check reads. Only events with a live intent pair are here (see the
 * module comment); READY needs no intent (H-179).
 */
export const EventIntents = {
  READY: [],
  MESSAGE_CREATE: ["GuildMessages", "DirectMessages"],
  MESSAGE_REACTION_ADD: ["GuildMessageReactions", "DirectMessageReactions"],
  TYPING_START: ["GuildMessageTyping", "DirectMessageTyping"],
  GUILD_MEMBER_UPDATE: ["GuildMembers"],
  CHANNEL_UPDATE: ["Guilds"]
} as const satisfies Record<string, ReadonlyArray<Intent>>

/** A supported event's name. */
export type EventName = keyof typeof EventIntents

/** For each supported event, the intents that deliver it, as a union (`never`: always delivered). */
export type EventIntents = { readonly [K in EventName]: (typeof EventIntents)[K][number] }

/** The supported events' names, in table order. */
export const eventNames: ReadonlyArray<EventName> = ["READY", "MESSAGE_CREATE", "MESSAGE_REACTION_ADD", "TYPING_START", "GUILD_MEMBER_UPDATE", "CHANNEL_UPDATE"]

/** The message a missing intent fails with: the intents that would deliver the event. */
export interface MissingIntent<Needed extends Intent> {
  readonly "missing intent, add one of": Needed
}

/**
 * `unknown` when a bot declaring `I` receives event `K` (no intent needed, or one of its intents declared), else the
 * {@link MissingIntent} message, which the event name argument is intersected with (D24, formulation 2).
 */
export type IntentCheck<K extends EventName, I extends Intent> = [EventIntents[K]] extends [never]
  ? unknown
  : [Extract<EventIntents[K], I>] extends [never]
    ? MissingIntent<EventIntents[K]>
    : unknown
