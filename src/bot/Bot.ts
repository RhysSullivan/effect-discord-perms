/**
 * The bot (DESIGN §2.7, §4.1). M3 brings what the harness's subject needs: `Bot.make` with the declared
 * intents, and the `BotRuntime` service a bot build provides. `Bot.on`, `Bot.layerWith`, `Bot.layer`, the event
 * typing and the handler boundary arrive in M7; the internal build is `BotInternals.layerWith` (`Internals.ts`).
 */
import { Discord } from "dfx"
import { type Config, Context, type Redacted } from "effect"
import type * as GuildState from "../state/GuildState.ts"
import type { GuildId } from "../Snowflake.ts"
import type { PrivilegedIntent, StartupIdentity } from "./Startup.ts"

/** A gateway intent, by dfx's (and Discord's) name. */
export type Intent = keyof typeof Discord.GatewayIntentBits

/** A bot definition: its declared intents (the event and field types derive from them in M7). */
export interface Bot<I extends Intent> {
  readonly intents: ReadonlyArray<I>
}

/** The bot constructor. */
export const Bot = {
  /** A bot that identifies with exactly `intents`. */
  make: <const I extends ReadonlyArray<Intent>>(config: { readonly intents: I }): Bot<I[number]> => ({ intents: config.intents })
}

/** The intents bitfield Identify sends for `intents`. */
export const intentBits = (intents: ReadonlyArray<Intent>): number => intents.reduce((bits, intent) => bits | Discord.GatewayIntentBits[intent], 0)

const privileged: ReadonlySet<Intent> = new Set<Intent>(["GuildMembers", "MessageContent", "GuildPresences"])

/** The declared intents Discord gates behind an application flag (startup check 2, §4.4). */
export const privilegedIntents = (intents: ReadonlyArray<Intent>): ReadonlyArray<PrivilegedIntent> =>
  intents.filter((intent): intent is PrivilegedIntent => privileged.has(intent))

/** What a bot build is configured with. */
export interface BotConfig {
  /** The bot token, read only as `Redacted`. */
  readonly token: Config.Config<Redacted.Redacted<string>>
  /** The guild the bot works in: startup checks membership (check 3) and waits for its GUILD_CREATE (check 4). */
  readonly guildId?: GuildId
}

/** A running bot: who it is, its declared intents, and the guild state its operations read. */
export interface Runtime {
  /** Who the token belongs to, as the startup checks found it. */
  readonly identity: StartupIdentity
  readonly intents: ReadonlyArray<Intent>
  readonly guildId: GuildId | undefined
  readonly guildState: GuildState.Interface
}

/** The running bot of one build. Handles close over it, so their methods need nothing (§4.1). */
export class BotRuntime extends Context.Service<BotRuntime, Runtime>()("bot/BotRuntime") {}
