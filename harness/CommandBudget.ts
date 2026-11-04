/**
 * The command-create budget (DESIGN §6 M8, §8 item 10; H-205). Discord allows 200 application-command creates per
 * guild per day (30034 after that), and whether a rejected create counts is open, so the harness keeps its own count
 * and stops before Discord would: it aborts the command (a defect, which no scenario catches) before sending a request
 * that would take the count past {@link dailyCap} within a rolling 24 hours.
 *
 * It sits in the shared base `HttpClient` (`Identities.ts`), so it sees every identity's requests, the library's
 * registration included. A request may create commands when it is a `POST` (one command, upserted by name) or a `PUT`
 * (the bulk overwrite) to `/applications/{application.id}/guilds/{guild.id}/commands`; each name in its body that is
 * not known to be registered counts as one create, whether Discord then accepts it or not. A name is known once a
 * 2xx answer to a `PUT` (which leaves exactly its names) or a `POST` (which adds its name) registered it; the process
 * starts knowing none, which can only over-count. So the negative registrations, which reuse one registered command
 * name, count nothing, and a run counts its few real creates.
 *
 * The count survives processes in a ledger file under `/tmp` (one entry per counted request, with its time), read when
 * the layer is built and written on every counted request.
 */
import { Clock, Context, Effect, FileSystem, Layer, Option, Ref, Schema } from "effect"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import type { PlatformError } from "effect/PlatformError"

/** The harness's ceiling on command creates per guild in 24 hours (Discord's is 200, H-205). */
export const dailyCap = 150

/** How far back the ledger counts. */
export const windowMs = 86_400_000

/** The live ledger. */
export const ledgerPath = "/tmp/effect-discord-perms-command-creates.json"

/** One counted request: when, which guild's commands, and how many names it may have created. */
export const LedgerEntry = Schema.Struct({ at: Schema.Number, scope: Schema.String, creates: Schema.Int })
export interface LedgerEntry extends Schema.Schema.Type<typeof LedgerEntry> {}

/** The ledger file. */
export const Ledger = Schema.Struct({ entries: Schema.Array(LedgerEntry) })
export interface Ledger extends Schema.Schema.Type<typeof Ledger> {}

/** Where the ledger lives: read once, written on every counted request. */
export interface LedgerStore {
  readonly read: Effect.Effect<Ledger>
  readonly write: (ledger: Ledger) => Effect.Effect<void>
}

/** What the budget has counted. */
export interface Stats {
  /** Creates counted in the last 24 hours, every process. */
  readonly last24h: number
  /** Creates counted by this process. */
  readonly thisProcess: number
}

/** The budget service. */
export interface Interface {
  /** Counts the creates `request` may make, before it is sent; dies when they would take the count past the cap. */
  readonly take: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<void>
  /** Learns the registered names from a 2xx answer to a command write. */
  readonly answered: (request: HttpClientRequest.HttpClientRequest, status: number) => Effect.Effect<void>
  readonly stats: Effect.Effect<Stats>
}

/** The process-wide command-create budget. */
export class CommandBudget extends Context.Service<CommandBudget, Interface>()("harness/CommandBudget") {}

const commandsPath = /^(?:\/api\/v\d+)?\/applications\/(\d{17,20})\/guilds\/(\d{17,20})\/commands$/

/** A command write, as the budget reads it: the scope (application and guild), the method, and the names in its body. */
export interface CommandWrite {
  readonly scope: string
  readonly method: "POST" | "PUT"
  readonly names: ReadonlyArray<string>
}

const Named = Schema.Struct({ name: Schema.String })
const decodePost = Schema.decodeUnknownOption(Schema.fromJsonString(Named))
const decodePut = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Named)))

/**
 * The command write `request` is, `None` when it is no `POST` or `PUT` to an application's guild commands. A command
 * write whose body cannot be read is a defect: the budget could not count it.
 */
export const commandWriteOf = (request: HttpClientRequest.HttpClientRequest): Effect.Effect<Option.Option<CommandWrite>> => {
  const method = request.method.toUpperCase()
  const match = URL.canParse(request.url) ? commandsPath.exec(new URL(request.url).pathname) : null
  if (match === null || (method !== "POST" && method !== "PUT")) return Effect.succeedNone
  const scope = `${match[1]}/${match[2]}`
  const text = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined
  const names =
    text === undefined
      ? Option.none<ReadonlyArray<string>>()
      : method === "POST"
        ? Option.map(decodePost(text), (body) => [body.name])
        : Option.map(decodePut(text), (body) => body.map((command) => command.name))
  return Option.isNone(names)
    ? Effect.die(new Error(`command budget: ${method} ${request.url}: the body names no command it could count`))
    : Effect.succeed(Option.some({ scope, method, names: names.value }))
}

/** Creates counted in `ledger` since `now - windowMs`. */
export const countSince = (ledger: Ledger, now: number): number => ledger.entries.filter((entry) => entry.at > now - windowMs).reduce((sum, entry) => sum + entry.creates, 0)

/** Builds the budget over `store` (see the module comment). */
export const make = (store: LedgerStore): Effect.Effect<Interface> =>
  Effect.gen(function* () {
    const ledger = yield* Ref.make(yield* store.read)
    const known = yield* Ref.make<ReadonlyMap<string, ReadonlySet<string>>>(new Map())
    const mine = yield* Ref.make(0)
    const take = (request: HttpClientRequest.HttpClientRequest): Effect.Effect<void> =>
      Effect.gen(function* () {
        const write = yield* commandWriteOf(request)
        if (Option.isNone(write)) return
        const registered = (yield* Ref.get(known)).get(write.value.scope) ?? new Set<string>()
        const creates = new Set(write.value.names.filter((name) => !registered.has(name))).size
        if (creates === 0) return
        const now = yield* Clock.currentTimeMillis
        const current = yield* Ref.get(ledger)
        const counted = countSince(current, now)
        if (counted + creates > dailyCap) {
          return yield* Effect.die(
            new Error(`infrastructure abort: command-create budget: ${counted} creates counted in the last 24 hours, and this ${write.value.method} may make ${creates} more (cap ${dailyCap}; Discord allows 200, H-205)`)
          )
        }
        const next: Ledger = { entries: [...current.entries.filter((entry) => entry.at > now - windowMs), { at: now, scope: write.value.scope, creates }] }
        yield* Ref.set(ledger, next)
        yield* Ref.update(mine, (count) => count + creates)
        yield* store.write(next)
      })
    const answered = (request: HttpClientRequest.HttpClientRequest, status: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (status < 200 || status >= 300) return
        const write = yield* commandWriteOf(request)
        if (Option.isNone(write)) return
        const { scope, method, names } = write.value
        yield* Ref.update(known, (all) => new Map(all).set(scope, method === "PUT" ? new Set(names) : new Set([...(all.get(scope) ?? []), ...names])))
      })
    const stats = Effect.gen(function* () {
      return { last24h: countSince(yield* Ref.get(ledger), yield* Clock.currentTimeMillis), thisProcess: yield* Ref.get(mine) }
    })
    return CommandBudget.of({ take, answered, stats })
  })

/** A budget over a ledger in memory (tests). */
export const layerMemory = (initial: Ledger = { entries: [] }): Layer.Layer<CommandBudget> =>
  Layer.effect(
    CommandBudget,
    Effect.gen(function* () {
      const ref = yield* Ref.make(initial)
      return yield* make({ read: Ref.get(ref), write: (ledger) => Ref.set(ref, ledger) })
    })
  )

const LedgerJson = Schema.fromJsonString(Ledger)

/** The ledger file at `path`: absent means empty; one that does not decode, or a failed write, is a defect. */
export const fileStore = (path: string): Effect.Effect<LedgerStore, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const orDie = <A>(effect: Effect.Effect<A, PlatformError | Schema.SchemaError>): Effect.Effect<A> => effect.pipe(Effect.mapError((error) => new Error(`command budget ledger ${path}: ${error.message}`)), Effect.orDie)
    const read = Effect.gen(function* () {
      if (!(yield* orDie(fs.exists(path)))) return { entries: [] }
      return yield* orDie(Schema.decodeUnknownEffect(LedgerJson)(yield* orDie(fs.readFileString(path))))
    })
    const write = (ledger: Ledger) => orDie(Effect.flatMap(Schema.encodeEffect(LedgerJson)(ledger), (text) => fs.writeFileString(path, `${text}\n`)))
    return { read, write }
  })

/** The live budget, over the ledger at {@link ledgerPath}. */
export const layerFile = (path: string = ledgerPath): Layer.Layer<CommandBudget, never, FileSystem.FileSystem> =>
  Layer.effect(CommandBudget, Effect.flatMap(fileStore(path), make))
