// The per-command budget probe's base (DESIGN §5.4, M8): commands.ts's imports and no commands. commands.ts's cost
// minus this one's is what scripts/budget.ts holds to the baseline's per-command row.
import { Effect } from "effect"
import { Command, type InvocationOf } from "../../src/commands/Command.ts"
export const probe = [Effect.void, Command] as const
