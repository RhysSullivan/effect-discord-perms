/**
 * Same-tag variants (D5, G5). Some missing permissions belong to an extra category depending on the operation,
 * while keeping the generated class's tag, so `catchTag("MissingReadMessageHistory")` still catches them:
 *
 * - replying without ReadMessageHistory is fixable by dropping the reply, so the send rows build
 *   `MissingReadMessageHistoryForReply` (`payload`);
 * - reacting without it cannot happen at all, so the react rows build `MissingReadMessageHistoryForReaction`
 *   (`access`).
 *
 * Each is a tagged error class of its own (`CategorizedError`) with the generated class's tag, fields, `flag` and
 * `message`, and its categories: the generated class's (`permission`) and the one it adds. They are not subclasses
 * of `MissingReadMessageHistory`: a subclass re-typed by the category mixin cost every consumer's compile about
 * 2,800 types (DESIGN §2.2, §5.4), and nothing tells the classes apart by `instanceof`.
 *
 * They are built only through `errorFor` (`src/permissions/Operations.ts`), whose constructor table is typed
 * against each operation's variant. `scripts/lib/genErrors.ts` lists them so `ErrorCategories` mirrors them, and
 * the tests hold each class's categories to that mirror.
 */
import { CategorizedError } from "./Category.ts"
import { ErrorCause } from "./Cause.ts"

/** A reply was refused because the bot lacks ReadMessageHistory (tag `MissingReadMessageHistory`; `payload`). */
export class MissingReadMessageHistoryForReply extends CategorizedError<MissingReadMessageHistoryForReply>()("MissingReadMessageHistory", { cause: ErrorCause }, ["permission", "payload"]) {
  get flag(): "ReadMessageHistory" {
    return "ReadMessageHistory"
  }
  override get message(): string {
    return "Missing permission ReadMessageHistory (" + this.cause.route + ")"
  }
}

/** A reaction was refused because the bot lacks ReadMessageHistory (tag `MissingReadMessageHistory`; `access`). */
export class MissingReadMessageHistoryForReaction extends CategorizedError<MissingReadMessageHistoryForReaction>()("MissingReadMessageHistory", { cause: ErrorCause }, ["permission", "access"]) {
  get flag(): "ReadMessageHistory" {
    return "ReadMessageHistory"
  }
  override get message(): string {
    return "Missing permission ReadMessageHistory (" + this.cause.route + ")"
  }
}

/** Every D5 variant class, keyed by class name. */
export const VariantClasses = { MissingReadMessageHistoryForReply, MissingReadMessageHistoryForReaction } as const
