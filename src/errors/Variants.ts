/**
 * Same-tag subclasses (D5, G5). Some missing permissions belong to an extra category depending on the
 * operation, while keeping the generated class's tag, so `catchTag("MissingReadMessageHistory")` still catches
 * them:
 *
 * - replying without ReadMessageHistory is fixable by dropping the reply, so the send rows build
 *   `MissingReadMessageHistoryForReply` (`payload`);
 * - reacting without it cannot happen at all, so the react rows build `MissingReadMessageHistoryForReaction`
 *   (`access`).
 *
 * They are built only through `errorFor` (`src/permissions/Operations.ts`), whose constructor table is typed
 * against each operation's variant. `scripts/lib/genErrors.ts` lists them so `ErrorCategories` mirrors them.
 */
import { withCategory } from "./Category.ts"
import { MissingReadMessageHistory } from "./Missing.generated.ts"

/** A reply was refused because the bot lacks ReadMessageHistory (tag `MissingReadMessageHistory`; `payload`). */
export class MissingReadMessageHistoryForReply extends MissingReadMessageHistory.pipe(withCategory("payload")) {}

/** A reaction was refused because the bot lacks ReadMessageHistory (tag `MissingReadMessageHistory`; `access`). */
export class MissingReadMessageHistoryForReaction extends MissingReadMessageHistory.pipe(withCategory("access")) {}

/** Every D5 variant class, keyed by class name. */
export const VariantClasses = { MissingReadMessageHistoryForReply, MissingReadMessageHistoryForReaction } as const
