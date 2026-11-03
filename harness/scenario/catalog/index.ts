/**
 * The whole matrix catalog (DESIGN §5.9): every family's pairwise and targeted rows, their flip controls, and the
 * rule rows (§5.5, M6). Intent sessions (M7) join it later.
 */
import type { Scenario } from "../Dsl.ts"
import * as ChannelEdit from "./channelEdit.ts"
import { byId } from "./common.ts"
import { coverageRowsOf } from "./coverage.ts"
import { flipsOf } from "./flips.ts"
import * as Members from "./members.ts"
import * as Messages from "./messages.ts"
import * as Pins from "./pins.ts"
import * as Reactions from "./reactions.ts"
import * as Rules from "./rules.ts"
import * as Send from "./send.ts"
import * as Threads from "./threads.ts"

/** Every family's rows, before the flip controls. */
export const familyRows: ReadonlyArray<Scenario> = [
  ...Send.scenarios,
  ...Messages.scenarios,
  ...Reactions.scenarios,
  ...Pins.scenarios,
  ...Threads.scenarios,
  ...ChannelEdit.scenarios,
  ...Members.scenarios
]

/** The flag-coverage rows: one per (operation row, flag) the families leave without a first-failure row (M6). */
export const coverageRows: ReadonlyArray<Scenario> = coverageRowsOf(familyRows)

/** The flip controls of the family and coverage rows. */
export const flipRows: ReadonlyArray<Scenario> = flipsOf([...familyRows, ...coverageRows])

/** The rule rows: the live pairs of the registry's compile-time rules. */
export const ruleRows: ReadonlyArray<Scenario> = Rules.scenarios

/** The catalog `verify:live` runs, sorted by ID. */
export const scenarios: ReadonlyArray<Scenario> = byId([...familyRows, ...coverageRows, ...flipRows, ...ruleRows])
