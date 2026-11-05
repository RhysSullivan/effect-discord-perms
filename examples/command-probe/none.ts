// The per-command budget probe's base (DESIGN §5.4, M8; M9 with Interactions): commands.ts's imports and no commands. commands.ts's cost
// minus this one's is what scripts/budget.ts holds to the baseline's per-command row.
import { Effect } from "effect"
import { Command } from "../../src/commands/Command.ts"
import { Interactions } from "../../src/interactions/Runner.ts"
export const probe = [Effect.void, Command, Interactions] as const
