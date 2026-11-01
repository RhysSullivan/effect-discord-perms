/**
 * The live harness CLI (DESIGN §5.1, §5.6). Run through the package scripts, which use `bun --no-env-file`:
 *
 *   bun run harness:reset    identity checks, then reset; prints `writes: N`
 *   bun run harness:smoke    identity checks, reset, provision, one oracle read per lab channel and a control;
 *                            prints counts, and fails if an available oracle disagrees with the baseline
 *   bun run harness:selftest identity checks, then the reset self-test (`SelfTest.ts`): reset, dirt, a read-back
 *                            that must see it, reset, a read-back at baseline, and a second reset with 0 writes
 *   bun run verify:live      the matrix (`run`), built in M3
 *
 * `inventory` (no package script) runs the identity checks and lists the lab guild's channels and roles,
 * read-only, for inspecting the lab by hand.
 *
 * Every command takes the live lock through `Credentials` and talks to Discord only through the identities of
 * `Identities.ts` (guarded, paced, counted). Failures are printed as their tag and safe fields; tokens are
 * `Redacted` and never reach the output.
 */
import { BunRuntime } from "@effect/platform-bun"
import { Cause, Duration, Effect, Exit, Option } from "effect"
import * as Identities from "./Identities.ts"
import * as IdentityCheck from "./IdentityCheck.ts"
import { Pacing, defaults as pacingDefaults } from "./Pacing.ts"
import * as Provision from "./Provision.ts"
import * as Reset from "./Reset.ts"
import * as SelfTest from "./SelfTest.ts"
import * as Smoke from "./Smoke.ts"

/** Every live command is an infrastructure abort after this long. */
const commandDeadline = Duration.minutes(30)

const usage = "usage: bun harness/main.ts reset | smoke | selftest | inventory | run [--repeat N] [--only glob] [--write] [--compare]"

const printIdentities = (report: IdentityCheck.IdentityReport) => {
  console.log(`identities: harness ${report.harness.userId} (${report.harness.username}), subject ${report.subject.userId} (${report.subject.username}), target ${report.target.userId} (${report.target.username})`)
  console.log(`  app ids match .env; three distinct bots; harness top role "${report.harnessTopRole.name}" at position ${report.harnessTopRole.position}`)
  console.log(`  guild: ${report.guild.name}, mfaLevel ${report.guild.mfa_level}, protected: ${report.protectedChannels.map((channel) => `#${channel.name}`).join(", ")}`)
  console.log(`  harness Message Content flag: ${report.harnessHasMessageContent ? "yes" : "no"}`)
  for (const item of report.notCheckedYet) console.log(`  not checked yet: ${item}`)
}

const command = (name: string) =>
  Effect.gen(function* () {
    switch (name) {
      case "reset": {
        const report = yield* IdentityCheck.run
        printIdentities(report)
        const result = yield* Reset.run(Reset.contextFrom(report))
        console.log(`reset: ${Reset.summary(result)}`)
        console.log(`writes: ${result.writes}`)
        return
      }
      case "smoke": {
        const report = yield* IdentityCheck.run
        printIdentities(report)
        const reset = yield* Reset.run(Reset.contextFrom(report))
        console.log(`reset: ${Reset.summary(reset)}`)
        const provision = yield* Provision.run(Reset.contextFrom(report))
        console.log(`provision: ${Provision.summary(provision)}`)
        const oracle = yield* Smoke.oracleReadsOfStoredLab(Reset.contextFrom(report))
        const flags = (bits: bigint | undefined) => {
          if (bits === undefined) return "unavailable"
          const names = Smoke.flagNames(bits)
          return names.length === 0 ? "no flags" : names.join(", ")
        }
        console.log(`oracle: ${oracle.availability}, ${oracle.reads.length} reads and the control`)
        for (const read of oracle.reads) console.log(`  subject in ${read.channel}: ${flags(read.permissions)}`)
        const control =
          oracle.control.permissions === undefined ? "unavailable" : oracle.control.permissions === oracle.control.expected ? "matches lab-target's allow" : `DIFFERS: ${flags(oracle.control.permissions)}`
        console.log(`  control, target in lab-text: ${control} (expected ${flags(oracle.control.expected)})`)
        const stats = yield* (yield* Pacing).stats
        console.log(`requests: ${stats.requests}, writes: ${stats.writes}, invalid (401/403/429): ${stats.invalid}`)
        yield* Smoke.checkOracle(oracle)
        return
      }
      case "selftest": {
        const report = yield* IdentityCheck.run
        printIdentities(report)
        const result = yield* SelfTest.run(Reset.contextFrom(report))
        console.log(`initial reset: ${Reset.summary(result.initialReset)}`)
        console.log(`dirt: ${result.dirtSteps} steps, ${result.dirtWrites} writes; the read-back saw ${result.problemsSeen} problems, every step's among them`)
        console.log(`reset: ${Reset.summary(result.reset)}`)
        console.log("read-back after reset: at baseline")
        console.log(`second reset: ${Reset.summary(result.secondReset)}`)
        const stats = yield* (yield* Pacing).stats
        console.log(`requests: ${stats.requests}, writes: ${stats.writes}, invalid (401/403/429): ${stats.invalid}`)
        return
      }
      case "inventory": {
        const report = yield* IdentityCheck.run
        printIdentities(report)
        yield* Smoke.inventory(Reset.contextFrom(report), Smoke.flagNames)
        return
      }
      default:
        return yield* Effect.die(new Error(usage))
    }
  })

const describeFailure = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.findErrorOption(cause)
  if (Option.isSome(failure)) {
    const error = failure.value
    if (typeof error === "object" && error !== null && "_tag" in error) {
      const fields = Object.entries(error).filter(([key]) => key !== "_tag" && key !== "stack")
      const message = error instanceof Error && error.message.length > 0 ? `: ${error.message}` : ""
      return `${String(error._tag)}${message} ${JSON.stringify(Object.fromEntries(fields))}`
    }
  }
  return Cause.pretty(cause)
}

const name = process.argv[2]
if (name === "run") {
  console.error("verify:live: the matrix runner is not built yet (it arrives in M3)")
  process.exit(1)
}
if (name === undefined) {
  console.error(usage)
  process.exit(2)
}

const program = command(name).pipe(
  Effect.timeoutOrElse({ duration: commandDeadline, orElse: () => Effect.die(new Error(`infrastructure abort: ${name} ran longer than ${Duration.format(commandDeadline)}`)) }),
  Effect.provide(Identities.live(pacingDefaults)),
  Effect.exit,
  Effect.flatMap((exit) =>
    Effect.sync(() => {
      if (Exit.isSuccess(exit)) {
        console.log(`${name} ok`)
        return
      }
      console.error(`${name} FAILED: ${describeFailure(exit.cause)}`)
      process.exitCode = 1
    })
  )
)

BunRuntime.runMain(program)
