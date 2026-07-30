/**
 * The sixteen categories, and the one that is not a category.
 *
 * 04-domain-model §10.1 names them exactly: account, security, wallet, deposit, withdrawal,
 * transfer, conversion, token, ownership, trading, market, reward, community, governance, api,
 * billing. That is the set a user's unified feed is filtered by, and it is closed — a
 * seventeenth would appear in a filter menu the frontend derives from this list, so adding one is
 * a product decision and not a shortcut for an event nobody classified.
 *
 * Not every category has a topic producing into it yet, and that is fine: the set describes what
 * the feed covers, not what has happened so far. `transfer`, `conversion`, `ownership`, `trading`,
 * `reward`, `community` and `api` are all waiting on producers.
 *
 * ## `unclassified`
 *
 * A seventeenth value exists and is deliberately **not** one of the sixteen.
 *
 * An event whose topic this build has never heard of has to go somewhere. Dropping it is the one
 * option that is definitely wrong: losing an event silently is worse than filing it badly,
 * because the event is gone and nothing records that it ever arrived. Guessing a category is only
 * slightly better — it puts a wrong fact in a user's feed and there is no way afterwards to find
 * which entries were guesses.
 *
 * So `unclassified` is a quarantine: the record is written, the raw payload is kept, its
 * visibility is `internal` so no user is shown something nobody has classified, and a query for
 * `category = 'unclassified'` is the backlog of topics this build predates. When the mapping
 * arrives, those rows can be reclassified from data that was never thrown away.
 */

/** The sixteen. Frozen, ordered as 04-domain-model §10.1 lists them. */
export const CATEGORIES = Object.freeze([
  'account',
  'security',
  'wallet',
  'deposit',
  'withdrawal',
  'transfer',
  'conversion',
  'token',
  'ownership',
  'trading',
  'market',
  'reward',
  'community',
  'governance',
  'api',
  'billing',
] as const)

export type Category = (typeof CATEGORIES)[number]

/** Not one of the sixteen. See the note above. */
export const UNCLASSIFIED = 'unclassified'

export type StoredCategory = Category | typeof UNCLASSIFIED

/** Every value the `category` column may hold, which is the sixteen plus the quarantine. */
export const STORED_CATEGORIES: readonly StoredCategory[] = Object.freeze([...CATEGORIES, UNCLASSIFIED])

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value)
}

export function isStoredCategory(value: string): value is StoredCategory {
  return (STORED_CATEGORIES as readonly string[]).includes(value)
}

/**
 * Who may see a record.
 *
 *   * `user` — appears in the owner's feed.
 *   * `internal` — appears only to an operator. A reconciliation run, a stuck withdrawal with no
 *     user attached, and anything quarantined as unclassified.
 */
export type Visibility = 'user' | 'internal'

export const VISIBILITIES: readonly Visibility[] = Object.freeze(['user', 'internal'])
