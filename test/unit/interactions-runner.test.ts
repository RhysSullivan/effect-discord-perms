import { describe, expect, it } from "@effect/vitest"
import { Deferred, Duration, Effect, References, Ref, Schema, Tracer } from "effect"
import { TestClock } from "effect/testing"
import { Command } from "../../src/commands/Command.ts"
import { ComponentRoute } from "../../src/components/CustomId.ts"
import { catchCategory } from "../../src/errors/Category.ts"
import { Interactions } from "../../src/interactions/Runner.ts"
import { set } from "../support/guild.ts"
import { callback, followUp, interaction, only, original, settle, token, withRunner } from "../support/interactions.ts"

/**
 * The interaction runner (DESIGN §4.14, §6 M9) under `TestClock`, over a recording fake of Discord: a slow handler is
 * never interrupted and its reply is delivered; the deferral the runner posts is 5 (with EPHEMERAL in "ephemeral") or
 * 6, each request asserted by route and flags; a reply after a 5 is `PATCH .../@original`, and so is an update after a
 * 6 (it edits the component's message); continuations run only after posting; `giveUp` completes and logs; a
 * `custom_id` that no longer decodes gets the ephemeral expired-control reply.
 */
const ping = Command.chatInput({ name: "ping", description: "Ping", options: [{ type: "string", name: "word", description: "a word", required: true, choices: [{ name: "Hi", value: "hi" }] }] })
const invoke = interaction(2, { id: "700000000000000001", name: "ping", type: 1, options: [{ name: "word", type: 3, value: "hi" }] })
const vote = ComponentRoute.make("vote", Schema.Struct({ choice: Schema.Literals(["yes", "no"]) }))
const reason = ComponentRoute.make("reason", Schema.Struct({ poll: Schema.Int }))
const click = (customId: string) => interaction(3, { custom_id: customId, component_type: 2 }, { message: { id: "500000000000000009" } })

describe("the interaction runner", () => {
  it.effect("answers a fast handler with its reply as the initial response (callback 4), flags and invocation as given", () =>
    withRunner(({ publish, sent }) =>
      Effect.gen(function* () {
        yield* Interactions.command(ping, "ephemeral", (ix) => ix.reply({ content: `pong ${ix.invocation.options.word}`, ephemeral: true }))
        yield* publish(invoke)
        yield* settle
        const all = yield* sent
        expect(only(all)).toEqual([`POST ${callback}`])
        expect(all[0]?.body).toEqual({ type: 4, data: { allowed_mentions: { parse: [] }, content: "pong hi", flags: 64 } })
      })
    )
  )

  it.effect("takes a fast reply's EPHEMERAL from the registration mode: a reply that omits the key is private in \"ephemeral\" mode", () =>
    withRunner(({ publish, sent }) =>
      Effect.gen(function* () {
        // the final audit's case: the same reply without the key, fast, was posted publicly
        yield* Interactions.command(ping, "ephemeral", (ix) => ix.reply({ content: "your secret" }))
        yield* publish(invoke)
        yield* settle
        const all = yield* sent
        expect(only(all)).toEqual([`POST ${callback}`])
        expect(all[0]?.body).toEqual({ type: 4, data: { allowed_mentions: { parse: [] }, content: "your secret", flags: 64 } })
      })
    )
  )

  it.effect("a fast reply without the key in \"public\" mode, and one in \"manual\" mode, carry no EPHEMERAL; \"manual\" sets it only when the payload asks", () =>
    withRunner(({ publish, sent }) =>
      Effect.gen(function* () {
        const word = Command.chatInput({ name: "word", description: "Word" })
        const shout = Command.chatInput({ name: "shout", description: "Shout" })
        yield* Interactions.command(ping, "public", (ix) => ix.reply({ content: "for everyone" }))
        yield* Interactions.command(word, "manual", (ix) => ix.reply({ content: "manual public" }))
        yield* Interactions.command(shout, "manual", (ix) => ix.reply({ content: "manual private", ephemeral: true }))
        yield* publish(invoke)
        yield* publish(interaction(2, { id: "700000000000000002", name: "word", type: 1 }))
        yield* publish(interaction(2, { id: "700000000000000003", name: "shout", type: 1 }))
        yield* settle
        const bodies = (yield* sent).map((request) => request.body)
        expect(bodies).toHaveLength(3)
        expect(bodies).toContainEqual({ type: 4, data: { allowed_mentions: { parse: [] }, content: "for everyone" } })
        expect(bodies).toContainEqual({ type: 4, data: { allowed_mentions: { parse: [] }, content: "manual public" } })
        expect(bodies).toContainEqual({ type: 4, data: { allowed_mentions: { parse: [] }, content: "manual private", flags: 64 } })
      })
    )
  )

  it.effect("never interrupts a slow handler: after 2.5 s it posts the public deferral (5), then delivers the reply as PATCH @original", () =>
    withRunner(({ publish, sent }) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        yield* Interactions.command(ping, (ix) => Effect.andThen(Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(gate)), ix.reply({ content: "slow pong" })))
        yield* publish(invoke)
        yield* Deferred.await(started)
        yield* settle
        yield* TestClock.adjust("2499 millis")
        yield* settle
        expect(yield* sent).toEqual([])
        yield* TestClock.adjust("1 millis")
        yield* settle
        expect(yield* sent).toEqual([{ method: "POST", path: callback, body: { type: 5 } }])
        // the handler is still running: release it, and its reply is delivered by editing the deferred message
        yield* Deferred.succeed(gate, undefined)
        yield* settle
        const all = yield* sent
        expect(only(all)).toEqual([`POST ${callback}`, `PATCH ${original}`])
        expect(all[1]?.body).toEqual({ allowed_mentions: { parse: [] }, content: "slow pong" })
      })
    )
  )

  it.effect("posts the ephemeral mode's deferral with EPHEMERAL (5, flags 64)", () =>
    withRunner(({ publish, sent }) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        yield* Interactions.command(ping, "ephemeral", (ix) => Effect.andThen(Deferred.await(gate), ix.reply({ content: "later", ephemeral: true })))
        yield* publish(invoke)
        yield* settle
        yield* TestClock.adjust("2500 millis")
        yield* settle
        expect(yield* sent).toEqual([{ method: "POST", path: callback, body: { type: 5, data: { flags: 64 } } }])
        yield* Deferred.succeed(gate, undefined)
        yield* settle
        expect(only(yield* sent)).toEqual([`POST ${callback}`, `PATCH ${original}`])
      })
    )
  )

  it.effect("posts the update mode's deferral (6), and delivers the update as PATCH @original, which edits the component's message", () =>
    withRunner(({ publish, sent }) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const id = yield* vote.customId({ choice: "yes" })
        yield* Interactions.component(vote, (ix) => Effect.andThen(Deferred.await(gate), ix.update({ content: `counted ${ix.data.choice}`, components: [] })))
        yield* publish(click(id))
        yield* settle
        yield* TestClock.adjust("2500 millis")
        yield* settle
        expect(yield* sent).toEqual([{ method: "POST", path: callback, body: { type: 6 } }])
        yield* Deferred.succeed(gate, undefined)
        yield* settle
        const all = yield* sent
        expect(only(all)).toEqual([`POST ${callback}`, `PATCH ${original}`])
        expect(all[1]?.body).toEqual({ allowed_mentions: { parse: [] }, content: "counted yes", components: [] })
      })
    )
  )

  it.effect("answers a fast update with callback 7 (UPDATE_MESSAGE)", () =>
    withRunner(({ publish, sent }) =>
      Effect.gen(function* () {
        const id = yield* vote.customId({ choice: "no" })
        yield* Interactions.component(vote, (ix) => ix.update({ content: `counted ${ix.data.choice}` }))
        yield* publish(click(id))
        yield* settle
        expect(yield* sent).toEqual([{ method: "POST", path: callback, body: { type: 7, data: { allowed_mentions: { parse: [] }, content: "counted no" } } }])
      })
    )
  )

  it.effect("runs a continuation only after its response is posted: the follow-up goes to the webhook after the callback", () =>
    withRunner(({ publish, sent }) =>
      Effect.gen(function* () {
        const seenAtContinuation = yield* Ref.make<ReadonlyArray<string>>([])
        yield* Interactions.command(ping, (ix) =>
          ix.reply({ content: "first" }, (answered) =>
            Effect.gen(function* () {
              yield* Ref.set(seenAtContinuation, ["continuation"])
              yield* answered.followUp({ content: "second", ephemeral: true }).pipe(catchCategory(["permission", "state"], () => Effect.void))
            })
          )
        )
        yield* publish(invoke)
        yield* settle
        const all = yield* sent
        expect(only(all)).toEqual([`POST ${callback}`, `POST ${followUp}`])
        expect(all[1]?.body).toEqual({ allowed_mentions: { parse: [] }, content: "second", flags: 64 })
        expect(yield* Ref.get(seenAtContinuation)).toEqual(["continuation"])
      })
    )
  )

  it.effect("runs a slow handler's own deferral's continuation after the runner's deferral, without posting it twice", () =>
    withRunner(({ publish, sent }) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        yield* Interactions.command(ping, (ix) =>
          Effect.andThen(
            Deferred.await(gate),
            ix.defer({ ephemeral: false }, (deferred) => deferred.editOriginal({ content: "done" }).pipe(Effect.catchTag("InteractionExpired", deferred.giveUp), Effect.orDie))
          )
        )
        yield* publish(invoke)
        yield* settle
        yield* TestClock.adjust("2500 millis")
        yield* settle
        yield* Deferred.succeed(gate, undefined)
        yield* settle
        const all = yield* sent
        expect(only(all)).toEqual([`POST ${callback}`, `PATCH ${original}`])
        expect(all[0]?.body).toEqual({ type: 5 })
        expect(all[1]?.body).toEqual({ allowed_mentions: { parse: [] }, content: "done" })
      })
    )
  )

  it.effect("completes a deferral with giveUp when the token expired, and logs it at Info", () =>
    withRunner(
      ({ publish, sent, logs }) =>
        Effect.gen(function* () {
          const completedWith = yield* Ref.make("")
          yield* Interactions.command(ping, "ephemeral", (ix) =>
            ix.defer({ ephemeral: true }, (deferred) =>
              deferred.editOriginal({ content: "too late" }).pipe(
                Effect.catchTag("InteractionExpired", deferred.giveUp),
                Effect.tap(() => Ref.set(completedWith, "completed")),
                Effect.orDie
              )
            )
          )
          yield* publish(invoke)
          yield* settle
          expect(only(yield* sent)).toEqual([`POST ${callback}`, `PATCH ${original}`])
          expect(yield* Ref.get(completedWith)).toBe("completed")
          const line = (yield* logs).find((entry) => entry.includes("gave up"))
          expect(line).toContain("Info")
          expect(line).toContain("command ping: gave up: the interaction token expired (InteractionExpired)")
          // the token never reaches a log line
          expect((yield* logs).some((entry) => entry.includes(token))).toBe(false)
        }),
      (method, path) => (method === "PATCH" && path === original ? { status: 401, body: { code: 50027, message: "Invalid Webhook Token" } } : undefined)
    )
  )

  it.effect("answers a custom_id that no longer decodes with the ephemeral expired-control reply, and logs it", () =>
    withRunner(({ publish, sent, logs }) =>
      Effect.gen(function* () {
        const handled = yield* Ref.make(false)
        yield* Interactions.component(vote, () => Effect.andThen(Ref.set(handled, true), Effect.never))
        yield* publish(click(`vote:{"choice":"maybe"}`))
        yield* settle
        expect(yield* sent).toEqual([{ method: "POST", path: callback, body: { type: 4, data: { content: "This control has expired.", flags: 64, allowed_mentions: { parse: [] } } } }])
        expect(yield* Ref.get(handled)).toBe(false)
        expect((yield* logs).find((entry) => entry.includes("no longer decodes"))).toContain("Warn")
      })
    )
  )

  it.effect("routes a command by type and name: an autocomplete of it and another command that fits its definition are not its handler's", () =>
    withRunner(({ publish, sent, logs }) =>
      Effect.gen(function* () {
        yield* Interactions.command(ping, (ix) => ix.reply({ content: `pong ${ix.invocation.options.word}` }))
        // each of these would decode as ping's invocation: only the type and the name keep them out
        yield* publish(interaction(2, { id: "700000000000000002", name: "other", type: 1, options: [{ name: "word", type: 3, value: "hi" }] }))
        yield* publish(interaction(4, { id: "700000000000000001", name: "ping", type: 1, options: [{ name: "word", type: 3, value: "hi", focused: true }] }))
        yield* publish(click("other:{}"))
        yield* settle
        expect(yield* sent).toEqual([])
        expect((yield* logs).filter((line) => line.startsWith("Error"))).toEqual([])
        // and ping itself is answered
        yield* publish(invoke)
        yield* settle
        expect(only(yield* sent)).toEqual([`POST ${callback}`])
      })
    )
  )

  it.effect("routes an autocomplete by type and name: an invocation of its command and another command's autocomplete are not its handler's", () =>
    withRunner(({ publish, sent, logs }) =>
      Effect.gen(function* () {
        yield* Interactions.autocomplete(ping, (ix) => ix.choices([{ name: "hi", value: "hi" }]))
        yield* publish(invoke)
        yield* publish(interaction(4, { id: "700000000000000002", name: "other", type: 1, options: [{ name: "word", type: 3, value: "h", focused: true }] }))
        yield* settle
        expect(yield* sent).toEqual([])
        expect((yield* logs).filter((line) => line.startsWith("Error"))).toEqual([])
        yield* publish(interaction(4, { id: "700000000000000001", name: "ping", type: 1, options: [{ name: "word", type: 3, value: "h", focused: true }] }))
        yield* settle
        expect(only(yield* sent)).toEqual([`POST ${callback}`])
      })
    )
  )

  it.effect("posts nothing in manual mode until the handler answers, then the modal (callback 9)", () =>
    withRunner(({ publish, sent }) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const form = yield* vote.customId({ choice: "yes" })
        yield* Interactions.command(ping, "manual", (ix) => Effect.andThen(Deferred.await(gate), ix.showModal({ customId: form, title: "Why?", inputs: [{ customId: "why", label: "Why", style: "paragraph", required: true }] })))
        yield* publish(invoke)
        yield* settle
        yield* TestClock.adjust("10 seconds")
        yield* settle
        expect(yield* sent).toEqual([])
        yield* Deferred.succeed(gate, undefined)
        yield* settle
        expect(yield* sent).toEqual([
          {
            method: "POST",
            path: callback,
            body: { type: 9, data: { custom_id: form, title: "Why?", components: [{ type: 1, components: [{ type: 4, custom_id: "why", label: "Why", style: 2, required: true }] }] } }
          }
        ])
      })
    )
  )

  it.effect("answers an autocomplete with its choices (callback 8), from the focused option", () =>
    withRunner(({ publish, sent }) =>
      Effect.gen(function* () {
        yield* Interactions.autocomplete(ping, (ix) => ix.choices([{ name: `${ix.focused.name}=${ix.focused.value}`, value: ix.focused.value }]))
        yield* publish(interaction(4, { id: "700000000000000001", name: "ping", type: 1, options: [{ name: "word", type: 3, value: "h", focused: true }] }))
        yield* settle
        expect(yield* sent).toEqual([{ method: "POST", path: callback, body: { type: 8, data: { choices: [{ name: "word=h", value: "h" }] } } }])
      })
    )
  )

  it.effect("answers a modal submit with its route's data and the inputs' values", () =>
    withRunner(({ publish, sent }) =>
      Effect.gen(function* () {
        const form = yield* vote.customId({ choice: "no" })
        yield* Interactions.modal(vote, "ephemeral", (ix) =>
          ix.reply({ content: `${ix.data.choice}: ${ix.fields.get("why") ?? "?"}`, ephemeral: true }).pipe(catchCategory("payload", () => ix.reply({ content: "too long", ephemeral: true })))
        )
        yield* publish(interaction(5, { custom_id: form, components: [{ type: 1, components: [{ type: 4, custom_id: "why", value: "busy" }] }] }))
        yield* settle
        expect(yield* sent).toEqual([{ method: "POST", path: callback, body: { type: 4, data: { allowed_mentions: { parse: [] }, content: "no: busy", flags: 64 } } }])
      })
    )
  )

  it.effect("routes a modal submit by its custom_id's route prefix: with two modal routes registered, only the submitted route's handler answers", () =>
    withRunner(({ publish, sent, logs }) =>
      Effect.gen(function* () {
        const why = { components: [{ type: 1, components: [{ type: 4, custom_id: "why", value: "busy" }] }] }
        yield* Interactions.modal(vote, "ephemeral", (ix) => ix.reply({ content: "vote's handler", ephemeral: true }))
        yield* Interactions.modal(reason, "ephemeral", (ix) => ix.reply({ content: "reason's handler", ephemeral: true }))
        yield* publish(interaction(5, { custom_id: yield* vote.customId({ choice: "yes" }), ...why }))
        yield* settle
        // one callback, from vote's handler: reason's registration neither decoded the submit nor answered it as expired
        expect(yield* sent).toEqual([{ method: "POST", path: callback, body: { type: 4, data: { allowed_mentions: { parse: [] }, content: "vote's handler", flags: 64 } } }])
        yield* publish(interaction(5, { custom_id: yield* reason.customId({ poll: 3 }), ...why }))
        yield* settle
        expect((yield* sent).map((entry) => entry.body)).toEqual([
          { type: 4, data: { allowed_mentions: { parse: [] }, content: "vote's handler", flags: 64 } },
          { type: 4, data: { allowed_mentions: { parse: [] }, content: "reason's handler", flags: 64 } }
        ])
        expect((yield* logs).filter((line) => line.includes("no longer decodes"))).toEqual([])
      })
    )
  )

  it.effect("runs no continuation when Discord refuses its response: a callback answered 404 10062 sends no follow-up, and the runner logs InteractionExpired at Warn", () =>
    withRunner(
      ({ publish, sent, logs }) =>
        Effect.gen(function* () {
          const ran = yield* Ref.make(false)
          yield* Interactions.command(ping, (ix) =>
            ix.reply({ content: "first" }, (answered) =>
              Effect.andThen(Ref.set(ran, true), answered.followUp({ content: "second" }).pipe(catchCategory(["permission", "state"], () => Effect.void)))
            )
          )
          yield* publish(invoke)
          yield* settle
          expect(only(yield* sent)).toEqual([`POST ${callback}`])
          expect(yield* Ref.get(ran)).toBe(false)
          expect((yield* logs).filter((line) => line.includes("was refused"))).toEqual(["Warn: discord.interaction command ping: the reply was refused: InteractionExpired (10062)"])
        }),
      (method, path) => (method === "POST" && path === callback ? { status: 404, body: { code: 10062, message: "Unknown interaction" } } : undefined)
    )
  )

  it.effect("manual: Discord takes a reply within its 3 s and refuses a slower handler's with 10062; the runner posts nothing before the handler answers and logs the refusal as InteractionExpired", () =>
    withRunner(
      ({ publish, sent, logs }) =>
        Effect.gen(function* () {
          const takes = yield* Ref.make(Duration.seconds(1))
          yield* Interactions.command(ping, "manual", (ix) => Effect.andThen(Effect.flatMap(Ref.get(takes), (duration) => Effect.sleep(duration)), ix.reply({ content: "pong" })))
          const refused = Effect.map(logs, (lines) => lines.filter((line) => line.includes("was refused")))
          // within the window: the reply is the initial response, and Discord takes it
          yield* publish(invoke)
          yield* settle
          yield* TestClock.adjust("1 second")
          yield* settle
          expect(yield* sent).toEqual([{ method: "POST", path: callback, body: { type: 4, data: { allowed_mentions: { parse: [] }, content: "pong" } } }])
          expect(yield* refused).toEqual([])
          // slower than 3 s: no deferral while the handler runs, then its reply arrives after the window and is refused
          yield* Ref.set(takes, Duration.seconds(4))
          yield* publish(invoke)
          yield* settle
          yield* TestClock.adjust("3 seconds")
          yield* settle
          expect(only(yield* sent)).toEqual([`POST ${callback}`])
          yield* TestClock.adjust("1 second")
          yield* settle
          expect(only(yield* sent)).toEqual([`POST ${callback}`, `POST ${callback}`])
          expect(yield* refused).toEqual(["Warn: discord.interaction command ping: the reply was refused: InteractionExpired (10062)"])
        }),
      // Discord's window for the initial response: a callback 3 s or more after the interaction is refused
      (method, path, ageMs) => (method === "POST" && path === callback && ageMs >= 3000 ? { status: 404, body: { code: 10062, message: "Unknown interaction" } } : undefined)
    )
  )

  it.effect("drops and logs an invocation that does not fit the definition, posting nothing", () =>
    withRunner(({ publish, sent, logs }) =>
      Effect.gen(function* () {
        yield* Interactions.command(ping, (ix) => ix.reply({ content: "pong" }))
        yield* publish(interaction(2, { id: "700000000000000001", name: "ping", type: 1, options: [{ name: "word", type: 3, value: "not a choice" }] }))
        yield* publish(interaction(2, { id: "700000000000000001", name: "ping", type: 1 }))
        yield* settle
        expect(yield* sent).toEqual([])
        const dropped = (yield* logs).filter((entry) => entry.includes("dropped"))
        expect(dropped.map((entry) => entry.includes("Error"))).toEqual([true, true])
        expect(dropped.join("\n")).toContain("not one of its choices")
        expect(dropped.join("\n")).toContain("required option word is missing")
      })
    )
  )

  it.effect("checks the interaction's channel against app_permissions: a send without SendMessages fails preflight on that basis", () =>
    withRunner(({ publish, sent }) =>
      Effect.gen(function* () {
        const outcome = yield* Ref.make("")
        yield* Interactions.command(ping, (ix) =>
          ix.channel.send({ content: "hello" }).pipe(
            Effect.andThen(ix.reply({ content: "sent" })),
            Effect.catchTag("MissingSendMessages", (error) => Effect.andThen(Ref.set(outcome, `${error._tag} ${error.cause._tag === "PreflightDecision" ? error.cause.basis : "?"}`), ix.reply({ content: "cannot" }))),
            catchCategory(["permission", "state", "access"], () => ix.reply({ content: "other" }))
          )
        )
        // the guild state grants View and Send; the interaction says the bot holds View only
        yield* publish({ ...invoke, app_permissions: String(set("ViewChannel")) })
        yield* settle
        expect(yield* Ref.get(outcome)).toBe("MissingSendMessages app-permissions")
        expect(only(yield* sent)).toEqual([`POST ${callback}`])
      })
    )
  )

  it.effect("keeps the interaction token out of every span and log line: the callback, PATCH @original and a follow-up dfx logs at Debug", () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    return withRunner(
      ({ publish, sent, logs }) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          const followed = yield* Ref.make("")
          yield* Interactions.command(ping, (ix) =>
            Effect.andThen(
              Deferred.await(gate),
              ix.reply({ content: "slow" }, (answered) => answered.followUp({ content: "more" }).pipe(Effect.catchTag("PermissionDeniedUnattributed", (error) => Ref.set(followed, error._tag)), catchCategory(["permission", "state"], () => Effect.void)))
            )
          )
          yield* publish(invoke)
          yield* settle
          yield* TestClock.adjust("2500 millis")
          yield* settle
          yield* Deferred.succeed(gate, undefined)
          yield* settle
          expect(only(yield* sent)).toEqual([`POST ${callback}`, `PATCH ${original}`, `POST ${followUp}`])
          expect(yield* Ref.get(followed)).toBe("PermissionDeniedUnattributed")
          // every request ran in its discord.rest span, named by its route template
          expect(spans.filter((span) => span.name === "discord.rest").map((span) => span.attributes.get("discord.route"))).toEqual([
            "/interactions/{interaction.id}/{interaction.token}/callback",
            "/webhooks/{application.id}/{interaction.token}/messages/@original",
            "/webhooks/{application.id}/{interaction.token}"
          ])
          const texts = spans.flatMap((span) => [span.name, ...[...span.attributes.values()].map(String), ...span.events.flatMap(([name, , attributes]) => [name, JSON.stringify(attributes ?? {})])])
          expect(texts.filter((text) => text.includes(token))).toEqual([])
          // Debug is on, and dfx logs a 403's URL at Debug: nothing of it reaches a line
          expect((yield* logs).filter((line) => line.includes(token))).toEqual([])
        }),
      (method, path) => (method === "POST" && path === followUp ? { status: 403, body: { code: 50013, message: "Missing Permissions" } } : undefined)
    ).pipe(Effect.provideService(Tracer.Tracer, tracer), Effect.provideService(References.MinimumLogLevel, "Debug"))
  })

  it.effect("attributes a follow-up's 50013 to SendMessages only when app_permissions lacks it; held or absent, it is unattributed", () =>
    Effect.gen(function* () {
      const refusedWith = (appPermissions: string | undefined) =>
        withRunner(
          ({ publish }) =>
            Effect.gen(function* () {
              const outcome = yield* Ref.make("")
              yield* Interactions.command(ping, (ix) =>
                ix.reply({ content: "first" }, (answered) =>
                  answered.followUp({ content: "second" }).pipe(
                    Effect.catchTags({ MissingSendMessages: (error) => Ref.set(outcome, error._tag), PermissionDeniedUnattributed: (error) => Ref.set(outcome, error._tag) }),
                    catchCategory("state", () => Effect.void)
                  )
                )
              )
              const { app_permissions: _, ...withoutPermissions } = invoke
              yield* publish(appPermissions === undefined ? withoutPermissions : { ...invoke, app_permissions: appPermissions })
              yield* settle
              return yield* Ref.get(outcome)
            }),
          (method, path) => (method === "POST" && path === followUp ? { status: 403, body: { code: 50013, message: "Missing Permissions" } } : undefined)
        )
      expect(yield* refusedWith(String(set("ViewChannel")))).toBe("MissingSendMessages")
      expect(yield* refusedWith(String(set("ViewChannel", "SendMessages")))).toBe("PermissionDeniedUnattributed")
      expect(yield* refusedWith(undefined)).toBe("PermissionDeniedUnattributed")
    })
  )

  it.effect("stops a continuation at 14 minutes (the token lasts 15) and logs it", () =>
    withRunner(({ publish, sent, logs }) =>
      Effect.gen(function* () {
        const interrupted = yield* Ref.make(false)
        yield* Interactions.command(ping, (ix) => ix.reply({ content: "first" }, () => Effect.never.pipe(Effect.onInterrupt(() => Ref.set(interrupted, true)))))
        yield* publish(invoke)
        yield* settle
        expect(only(yield* sent)).toEqual([`POST ${callback}`])
        yield* TestClock.adjust("13 minutes")
        yield* settle
        expect(yield* Ref.get(interrupted)).toBe(false)
        expect((yield* logs).some((line) => line.includes("continuation passed"))).toBe(false)
        yield* TestClock.adjust("1 minute")
        yield* settle
        expect(yield* Ref.get(interrupted)).toBe(true)
        expect((yield* logs).find((line) => line.includes("continuation passed"))).toBe("Warn: discord.interaction command ping: the continuation passed 14m; the token lasts 15 minutes")
      })
    )
  )

  it.effect("posts nothing for a copy of a response: only the value its method made is a response (the plans are kept by identity)", () =>
    withRunner(({ publish, sent, logs }) =>
      Effect.gen(function* () {
        // a copy has the response's type, symbol key included, but no plan
        yield* Interactions.command(ping, (ix) => Effect.map(ix.reply({ content: "pong" }), (response) => ({ ...response })))
        yield* publish(invoke)
        yield* settle
        expect(yield* sent).toEqual([])
        expect((yield* logs).find((line) => line.includes("returned no response"))).toBe("Error: discord.interaction command ping: the handler returned no response")
      })
    )
  )
})
