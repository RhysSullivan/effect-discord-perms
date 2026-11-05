/**
 * The reference bot (DESIGN §2.11, §6 M10): a small poll bot written as a user of the library would write it, importing
 * only the package. Its compile cost, with the library it imports, is the compile budget's reference-bot row
 * (`examples/reference-bot/budget.json`, DESIGN §5.4; today over the Types and Instantiations ceilings, LOG.md). It
 * never turns a library error into a defect: every non-transient failure the library can return is handled by tag or
 * by category, and the handler boundary would reject the bot otherwise.
 *
 * - `!ping` in a channel the bot can read: `bot.on("MESSAGE_CREATE")` answers with `send` on `event.channel`.
 * - `/poll question [where]`: checks the bot may post the poll there (`Permissions.require`), posts it with Yes and No
 *   buttons, and answers the invoker privately.
 * - A click on Yes or No: the buttons' `custom_id`s are a schema-typed route (`ComponentRoute`); the handler records
 *   the vote and updates the poll message with the tally.
 *
 * The guarantee is the library's: the types guarantee every failure is handled, not that any call succeeds.
 */
import { Config, Context, Effect, Layer, type Redacted, Ref, Schema } from "effect"
import {
  Bot,
  catchCategory,
  Command,
  ComponentRoute,
  type Embed,
  type GuildId,
  Interactions,
  Permissions,
  row,
  type StartupFailed,
  type UserId
} from "effect-discord-perms"

/** The bot reads guild messages and their content (for `!ping`); Guilds is what the guild state is built from. */
export const bot = Bot.make({ intents: ["Guilds", "GuildMessages", "MessageContent"] })

/** `/poll`: what to ask, and optionally where to post it (a text or announcement channel). */
export const poll = Command.chatInput({
  name: "poll",
  description: "Ask a yes/no question",
  options: [
    { type: "string", name: "question", description: "What to ask", required: true },
    { type: "channel", name: "where", description: "Channel to post in (this one if absent)", channelTypes: ["text", "announcement"] }
  ]
})

/** A vote button's `custom_id`: the poll it belongs to and the choice. Decoded before the handler sees it. */
export const vote = ComponentRoute.make("vote", Schema.Struct({ poll: Schema.Int, choice: Schema.Literals(["yes", "no"]) }))

/** A choice on a poll. */
export type Choice = "yes" | "no"

/** One poll's question and its votes, one per voter. */
export interface Tally {
  readonly question: string
  readonly votes: ReadonlyMap<UserId, Choice>
}

/** The open polls, in memory: a restart closes them (a click on an old poll's button says so). */
export class Polls extends Context.Service<
  Polls,
  {
    /** Opens a poll and returns its number, which its buttons carry. */
    readonly open: (question: string) => Effect.Effect<number>
    /** Records `voter`'s choice (replacing an earlier one) and returns the tally, or `undefined` for a closed poll. */
    readonly vote: (poll: number, voter: UserId, choice: Choice) => Effect.Effect<Tally | undefined>
  }
>()("reference-bot/Polls") {
  /** The in-memory store. */
  static readonly layer = Layer.effect(
    Polls,
    Effect.gen(function* () {
      const polls = yield* Ref.make<ReadonlyMap<number, Tally>>(new Map())
      const next = yield* Ref.make(1)
      return Polls.of({
        open: (question) =>
          Effect.gen(function* () {
            const n = yield* Ref.getAndUpdate(next, (k) => k + 1)
            yield* Ref.update(polls, (all) => new Map([...all, [n, { question, votes: new Map() }]]))
            return n
          }),
        vote: (n, voter, choice) =>
          Ref.modify(polls, (all): readonly [Tally | undefined, ReadonlyMap<number, Tally>] => {
            const tally = all.get(n)
            if (tally === undefined) return [undefined, all]
            const updated: Tally = { question: tally.question, votes: new Map([...tally.votes, [voter, choice]]) }
            return [updated, new Map([...all, [n, updated]])]
          })
      })
    })
  )
}

/** The poll message's embed: the question, and the tally once anyone voted. */
export const pollEmbed = (tally: Tally): Embed => {
  const choices = [...tally.votes.values()]
  const yes = choices.filter((choice) => choice === "yes").length
  return choices.length === 0 ? { title: tally.question } : { title: tally.question, description: `Yes ${yes}, no ${choices.length - yes}` }
}

/** `!ping`: a missing permission, a timeout or a locked thread is expected, so it is logged, not raised. */
export const onMessage = bot.on("MESSAGE_CREATE", (event) =>
  event.message.author === "self" || event.message.authorIsBot || event.message.content !== "!ping"
    ? Effect.void
    : event.channel.send({ content: "pong" }).pipe(catchCategory(["permission", "state"], (error) => Effect.logWarning(`cannot answer !ping: ${error._tag}`)))
)

/** Logs each session's start. */
export const onReady = bot.on("READY", (event) => Effect.logInfo(`ready as ${event.userId}`))

/**
 * `/poll`: answered privately ("ephemeral"). The checked permissions narrow the send's errors (a flag lost between the
 * check and the request is `PermissionRevokedSinceCheck`); every failure becomes an answer to the invoker.
 */
export const onPoll = Interactions.command(poll, "ephemeral", (ix) =>
  Effect.gen(function* () {
    const { question, where } = ix.invocation.options
    // optional: checked up front, so a poll the bot cannot post is never opened
    const channel = yield* Permissions.require(where ?? ix.channel, ["SendMessages", "EmbedLinks"])
    const polls = yield* Polls
    const n = yield* polls.open(question)
    const yes = yield* vote.customId({ poll: n, choice: "yes" })
    const no = yield* vote.customId({ poll: n, choice: "no" })
    const sent = yield* channel.send({
      embeds: [pollEmbed({ question, votes: new Map() })],
      components: [
        row([
          { kind: "button", style: "success", label: "Yes", customId: yes },
          { kind: "button", style: "danger", label: "No", customId: no }
        ])
      ]
    })
    return yield* ix.reply({ content: `Posted poll ${n} (message ${sent.message.id}).`, ephemeral: true })
  }).pipe(
    // first: a missing flag (EmbedLinks is a permission and a payload error: the poll needs its embed) or a state
    catchCategory(["permission", "state"], (error) => ix.reply({ content: `I can't post the poll there (${error._tag}).`, ephemeral: true })),
    // then what is left of payload: a question too long for the embed's title, or a reply too long
    catchCategory("payload", () => ix.reply({ content: "That poll does not fit in a message.", ephemeral: true }))
  )
)

/** A vote: updates the poll message's tally (the component's default "update" mode edits the clicked message). */
export const onVote = Interactions.component(vote, (ix) =>
  Effect.gen(function* () {
    const polls = yield* Polls
    const tally = yield* polls.vote(ix.data.poll, ix.user.id, ix.data.choice)
    if (tally === undefined) return yield* ix.update({ content: "This poll has closed.", components: [] })
    return yield* ix.update({ embeds: [pollEmbed(tally)] })
  }).pipe(catchCategory("payload", () => ix.update({ content: "This poll's tally no longer fits its message.", components: [] })))
)

/** Every handler, registered for the layer's lifetime. */
export const Handlers = Layer.effectDiscard(Effect.all([onMessage, onReady, onPoll, onVote], { discard: true }))

/** Where the bot runs: its token (kept `Redacted`) and the guild its command is registered in. */
export interface Target {
  readonly token: Redacted.Redacted<string>
  readonly guildId: GuildId
}

/** The running bot: the handlers over the poll store and the bot's runtime, `/poll` registered in `target.guildId`. */
export const layer = (target: Target): Layer.Layer<never, StartupFailed | Config.ConfigError> =>
  Handlers.pipe(
    Layer.provide(Polls.layer),
    Layer.provide(Bot.layer(bot, { token: Config.succeed(target.token), guildId: target.guildId, commands: [poll] }))
  )
