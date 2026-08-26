/**
 * Addresses that cannot have a mail exchanger, by standard rather than by policy.
 *
 * ## Why this is not a deny-list
 *
 * The estate's synthetic monitor registers a throwaway account per journey at
 * `beacon+<hex>@beacon.test` — measured at ~95/hour, 7,319 of mainnet's 7,398 user rows — and
 * `notify` dutifully tried to mail every one of them. That exhausted the provider's 250/day
 * allowance within minutes, after which a real visitor's verification mail returned `SMTP 535` and
 * their address could never be confirmed. 4,483 verification tokens were issued across the two
 * networks and none was ever consumed.
 *
 * The tempting fix is a rule about `beacon.test`. It would work, and the next monitor to pick a
 * different name would silently re-open the same hole. So the rule here is the one the DNS root
 * already makes, applied one layer earlier so the allowance is never spent proving it:
 *
 * - **RFC 6761 §6** reserves `.test`, `.example`, `.invalid` and `.localhost` so that they never
 *   resolve. There cannot be an MX record under any of them.
 * - **RFC 2606 §3** reserves `example.com`, `example.net` and `example.org` for documentation.
 *
 * Two other populations fall out of the same rule for free and were never worth their own code:
 * `deleted.invalid`, which identity writes when it tombstones an address, and the `example.test`
 * rows left by test runs.
 *
 * ## What this file does not decide
 *
 * It says an address is unroutable. It does not say a notification is unwanted — that is
 * `pipeline.ts`'s call, and it deliberately suppresses the *channel* and not the notification, so
 * the monitor's journeys still exercise ingest → notification → in-app delivery and still assert on
 * them. Blinding the monitor to fix its side effect would be the worse trade.
 */

/**
 * Top-level domains reserved so that they can never resolve (RFC 6761 §6, RFC 2606 §2).
 *
 * Matched as a whole final label, never as a substring: `testing.com` is a real domain somebody may
 * genuinely use, and a naive `endsWith('test')` would refuse their mail for ever.
 */
const RESERVED_TLDS: readonly string[] = ['test', 'example', 'invalid', 'localhost']

/**
 * Second-level domains reserved for documentation (RFC 2606 §3).
 *
 * Their subdomains are reserved with them — `mx.example.com` is as undeliverable as `example.com` —
 * which is why the check below accepts an exact match or a dot-anchored suffix rather than a bare
 * `includes`.
 */
const RESERVED_DOMAINS: readonly string[] = ['example.com', 'example.net', 'example.org']

/**
 * Can mail to this address ever be delivered?
 *
 * Returns `true` for an address whose domain is reserved by the standards above, and for an address
 * that is not one — no `@`, an empty domain, or more than one `@`. A malformed address is treated
 * as undeliverable rather than as deliverable: the failure mode of guessing wrong in that direction
 * is one bounced message, and of guessing wrong in the other is an allowance spent on a string that
 * was never an address.
 *
 * The domain is case-folded and a single trailing dot — the fully-qualified form, `beacon.test.` —
 * is stripped, because both spellings are the same name and only one of them would otherwise match.
 */
export function isUndeliverableAddress(address: string | null | undefined): boolean {
  if (!address) return true

  const at = address.lastIndexOf('@')
  if (at < 0) return true
  // A local part is required too: `@beacon.test` is not an address.
  if (at === 0) return true

  let domain = address.slice(at + 1).trim().toLowerCase()
  if (domain.endsWith('.')) domain = domain.slice(0, -1)
  if (domain.length === 0) return true

  const labels = domain.split('.')
  const tld = labels[labels.length - 1]
  if (tld !== undefined && RESERVED_TLDS.includes(tld)) return true

  return RESERVED_DOMAINS.some((reserved) => domain === reserved || domain.endsWith(`.${reserved}`))
}
