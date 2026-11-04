/**
 * The running bot (DESIGN §4.1): the `BotRuntime` service a bot build provides, and what a build is configured
 * with. Handles close over the runtime, so their methods need nothing (§4.1). This module imports no operation
 * module, so the handles (`channels/Ops.ts`), the events (`gateway/Events.ts`) and the bot (`Bot.ts`) can all
 * depend on it without a cycle.
 */
import { type Config, Context, type Effect, type Redacted, type Scope } from "effect"
import type { EventName, Intent } from "../gateway/Intents.ts"
import type * as DiscordApi from "../rest/DiscordApi.ts"
import type { GuildId } from "../Snowflake.ts"
import type * as GuildState from "../state/GuildState.ts"
import type { StartupIdentity } from "./Startup.ts"

/** What a bot build is configured with. */
export interface BotConfig {
  /** The bot token, read only as `Redacted`. */
  readonly token: Config.Config<Redacted.Redacted<string>>
  /**
   * The guild the bot works in: startup checks membership (check 3) and waits for its GUILD_CREATE (check 4),
   * which only a bot declaring `Guilds` receives.
   */
  readonly guildId?: GuildId
}

/** What a build needs to know of a bot definition: its declared intents. */
export interface BotDefinition {
  readonly intents: ReadonlyArray<Intent>
}

/**
 * The bot's gateway dispatches, as `bot.on` subscribes to them (`gateway/Dispatches.ts`): `subscribe(name, handle)`
 * runs `handle` in its own fiber for every dispatch named `name` published after it returns, until the caller's scope
 * closes. `handle` never fails; `data` is Discord's payload, decoded by the caller.
 */
export interface EventSource {
  readonly subscribe: <R>(name: EventName, handle: (data: unknown) => Effect.Effect<void, never, R>) => Effect.Effect<void, never, R | Scope.Scope>
}

/** A running bot: who it is, its declared intents, the guild state its operations read, and its events. */
export interface Runtime {
  /** Who the token belongs to, as the startup checks found it. */
  readonly identity: StartupIdentity
  readonly intents: ReadonlyArray<Intent>
  readonly guildId: GuildId | undefined
  readonly guildState: GuildState.Interface
  /** The REST wrapper every operation's request goes through (deadline, error mapping, recompute, decoding). */
  readonly api: DiscordApi.Interface
  /** The gateway's dispatches (`Bot.on`). */
  readonly events: EventSource
}

/** The running bot of one build. Handles close over it, so their methods need nothing (§4.1). */
export class BotRuntime extends Context.Service<BotRuntime, Runtime>()("bot/BotRuntime") {}
