/**
 * Templates: the words, their parameters, and the localisation seam.
 *
 * Three properties are being bought here, and each one is a defect the estate has today.
 *
 *   1. **A template declares its parameters.** `catalogue.test.ts` asserts that every rule
 *      supplies every parameter its template requires. Today the estate's one outbound email
 *      interpolates whatever the caller passed and renders "Hello undefined" if it was wrong.
 *   2. **A missing parameter degrades, it does not throw.** Rendering returns the text with the
 *      placeholder blanked and lists what was missing. A notification with a gap in it is
 *      recoverable; a critical notification that threw on the way out of the door is a breach of
 *      04-domain-model §10.3.
 *   3. **Locale is a key, not a rewrite.** Every template is a map from locale to text with
 *      `en-GB` required. Adding a language is adding keys, and no call site changes.
 *
 * **Parameters are never logged.** A template parameter is arbitrary domain data — an address, an
 * amount, a device, a transaction hash — and the estate has already been burned once by putting a
 * live credential in a log line. Log the template id and the parameter *names*; never the values.
 */

import type { Category, Channel, Locale } from './model.ts'
import { DEFAULT_LOCALE } from './model.ts'

export interface TemplateText {
  readonly subject: string
  readonly body: string
}

export interface Template {
  readonly id: string
  readonly category: Category
  /** Names that must be present in `params`. Checked by the catalogue test, not at runtime. */
  readonly params: readonly string[]
  /**
   * Parameters that are single-use credentials rather than domain data.
   *
   * A verification link is a bearer token in a URL: whoever reads it can complete the action it
   * authorises. It has to be stored — the delivery is written now and rendered later, possibly
   * after a retry — but it must never leave over HTTP, and `GET /notifications` returns the whole
   * `params` object to the user AND to an operator with the admin role reading `?userId=`. So the
   * names are declared here and `redactSecretParams` is applied at the one place every notification
   * row becomes a response (`store.ts`, `toNotification`).
   *
   * Declaring one obliges the template to declare `deliverOn` as well; `templates.test.ts` asserts
   * the pairing, because a credential that is safe to store and safe to mail is not thereby safe to
   * sign and POST to a developer's endpoint.
   */
  readonly secretParams?: readonly string[]
  /**
   * The channels this template may be delivered on, when it may not go everywhere.
   *
   * Absent — the normal case — means every channel the user can be reached on. Present, it narrows
   * the candidates in `createNotification` before routing, so a notification whose body is only
   * meaningful at one address cannot fan out to every target the user happens to hold. `in_app` is
   * the floor channel and is never removed by this: it carries no address, it is what §10.3's "at
   * least one channel" rests on, and its parameters are redacted on the way out.
   */
  readonly deliverOn?: readonly Channel[]
  /**
   * Where the notification points, relative to `NOTIFY_PUBLIC_URL`. Substituted from the same
   * parameters. Relative because the origin is configuration: a link built from a request's Host
   * header is how identity was made to send genuine mail pointing at a host the attacker chose.
   */
  readonly path: string
  readonly text: Readonly<Record<Locale, TemplateText>>
}

/** British English throughout — "recognise", "authorised", "-ise" not "-ize". */
const en = (subject: string, body: string): Readonly<Record<Locale, TemplateText>> =>
  Object.freeze({ 'en-GB': Object.freeze({ subject, body }) })

/**
 * Every template. Frozen, and the only place a user-visible sentence is written.
 *
 * The security wording is deliberately actionable: a notification that says "a new device signed
 * in" and nothing else has told the user a fact they cannot act on. Each one names what happened,
 * when, and the single thing to do if it was not them.
 */
export const TEMPLATES = Object.freeze({
  /* ------------------------------------------------------------------ security, critical */

  'security.new_device': Object.freeze({
    id: 'security.new_device',
    category: 'security',
    params: ['device', 'ipPrefix', 'at'],
    path: '/settings/security/devices',
    text: en(
      'A new device signed in to your CloudsForge account',
      'A new device signed in to your account at {{at}}.\n\nDevice: {{device}}\nApproximate location: {{ipPrefix}}\n\nIf this was not you, sign out everywhere and change your password now.',
    ),
  }),
  /**
   * Replaces `security.password_changed`, whose rule was keyed to a topic nobody emits.
   *
   * identity does not announce a password change as its own fact — it revokes the sessions and
   * says why — so the sentence is built around the revocation and names the reason. It has to work
   * for all of them: a password change, a reset, an admin revocation, and the family burn that
   * follows a replayed refresh token.
   */
  'security.session_revoked': Object.freeze({
    id: 'security.session_revoked',
    category: 'security',
    params: ['reason', 'at'],
    path: '/settings/security/sessions',
    text: en(
      'A session on your CloudsForge account was ended',
      'A session was signed out at {{at}} because {{reason}}.\n\nIf that was not you, someone else may hold your password: reset it and sign out everywhere now.',
    ),
  }),
  /**
   * The second mail that carries a credential, and the first one a signed-out person ever needs.
   *
   * Shaped on `account.verify_email` deliberately rather than on the security templates around it:
   * `path` is the parameter, `resetUrl` is a `secretParams` so it is redacted out of every HTTP
   * response, and `deliverOn` is email alone so the ordinary fan-out cannot sign it and POST it to
   * a developer's webhook endpoint. `POST /admin/broadcasts` refuses it by the same property, so
   * the most convincing phishing message this estate could send still cannot be sent by an
   * operator.
   *
   * Two things are said here that the verification mail does not have to say. **"You can ignore
   * this"** is the whole of what an unsolicited reset means, and it has to come before anything
   * else: the request is unauthenticated, so anybody who knows an address can cause this mail, and
   * a reader who did not ask needs to know in the first line that their password has not changed.
   * **Thirty minutes** is named because it is short enough to be the reason the link failed.
   */
  'security.password_reset': Object.freeze({
    id: 'security.password_reset',
    category: 'security',
    params: ['handle', 'resetUrl'],
    secretParams: ['resetUrl'],
    deliverOn: ['email'] as const,
    path: '{{resetUrl}}',
    text: en(
      'Reset your CloudsForge password',
      'Hello @{{handle}} — a password reset was requested for your CloudsForge account.\n\nThe link in this email works once and expires thirty minutes after it was sent. Your password has not changed yet, and nothing happens until you use it.\n\nIf this was not you, ignore this email: the link expires on its own and your account is untouched. Nobody at CloudsForge will ever ask you to forward it to them.',
    ),
  }),
  'security.mfa_changed': Object.freeze({
    id: 'security.mfa_changed',
    category: 'security',
    params: ['change', 'at', 'remainingFactors'],
    path: '/settings/security',
    text: en(
      'Your two-factor authentication was changed',
      'Two-factor authentication on your account was {{change}} at {{at}}.\n\nActive factors remaining: {{remainingFactors}}.\n\nIf this was not you, restore a second factor now — an account with none is protected by its password alone.',
    ),
  }),
  /* ------------------------------------------------------------------
   * The two halves of an external withdrawal destination.
   *
   * `wallet.link.verified` is the moment an address the platform does not control becomes somewhere
   * money can be sent, and it is authorised by a signature rather than by a password — so an
   * attacker who has taken an account adds their own address here and the theft looks like an
   * ordinary withdrawal from then on. That is why these file under `security` rather than `wallet`,
   * and why the revocation is worth a message too: a destination silently REMOVED is the same
   * account takeover seen from the other side.
   *
   * The address is printed in full. It is public by construction, it is the one field a reader can
   * check against the wallet they think they linked, and a truncated one is exactly what an
   * attacker substituting a lookalike address relies on nobody expanding.
   * ------------------------------------------------------------------ */
  'security.wallet_link_verified': Object.freeze({
    id: 'security.wallet_link_verified',
    category: 'security',
    params: ['chain', 'address', 'at'],
    path: '/wallet',
    text: en(
      'An external wallet was authorised for withdrawals',
      'An external {{chain}} wallet was authorised on your account at {{at}} and can now be used as a withdrawal destination.\n\nAddress: {{address}}\n\nIf this was not you, remove it and change your password now — an authorised destination is where money leaves to.',
    ),
  }),
  'security.wallet_link_revoked': Object.freeze({
    id: 'security.wallet_link_revoked',
    category: 'security',
    params: ['authorisation', 'walletId', 'at'],
    path: '/wallet',
    text: en(
      'An external wallet is no longer authorised',
      'An external wallet on your account stopped being authorised for {{authorisation}} at {{at}}.\n\nWallet {{walletId}}.\n\nIf this was not you, someone else may hold your password: change it and sign out everywhere now.',
    ),
  }),
  'security.key_export_requested': Object.freeze({
    id: 'security.key_export_requested',
    category: 'security',
    params: ['walletLabel', 'at', 'availableAt'],
    path: '/settings/security/exports',
    text: en(
      'A private key export was requested',
      'An export of the private key for {{walletLabel}} was requested at {{at}}.\n\nA 24-hour cooling-off period applies: the key becomes available at {{availableAt}}. Until then this request can be cancelled.\n\nIf this was not you, cancel it now and change your password.',
    ),
  }),
  'security.key_exported': Object.freeze({
    id: 'security.key_exported',
    category: 'security',
    params: ['walletLabel', 'at'],
    path: '/settings/security/exports',
    text: en(
      'A private key left the platform',
      'The private key for {{walletLabel}} was exported at {{at}}. That wallet is self-custodied from now on: CloudsForge can no longer protect, recover or freeze it.\n\nIf this was not you, treat every asset in that wallet as compromised and move it immediately.',
    ),
  }),

  /* ------------------------------------------------------------------ account and wallet */

  'account.registered': Object.freeze({
    id: 'account.registered',
    category: 'account',
    params: ['handle'],
    path: '/',
    text: en('Welcome to CloudsForge', 'Your account @{{handle}} is ready.'),
  }),
  /**
   * The first mail the platform sends, and the only one that has to arrive before anything else can.
   *
   * ## The link is the whole message, so the link is the whole risk
   *
   * `path` is the parameter rather than a route on this platform. Every other template points at a
   * page and lets the reader sign in; this one carries a credential minted by identity, and there
   * is nothing on this side to point at instead. Two consequences are declared above rather than
   * remembered: `verifyUrl` is a `secretParams`, so it is redacted out of every HTTP response, and
   * `deliverOn` is email alone, so it cannot be signed and POSTed to a developer's webhook endpoint
   * by the ordinary fan-out. `catalogue.ts`'s reader refuses anything that is not an http(s) URL and
   * falls back to the account settings page, so a producer that stops sending it degrades to a page
   * that can issue a new link rather than to a broken or hostile one.
   *
   * The body does not repeat `{{verifyUrl}}`: `email.ts` appends the rendered link after the body,
   * and printing it twice in a plain-text mail is how a reader ends up clicking the wrong one.
   *
   * The last sentence is anti-phishing wording and is not decoration. A single-use link in an inbox
   * is the highest-value thing this service will ever send, and "nobody here will ever ask you to
   * send it to them" is the one instruction that survives being forwarded to an attacker.
   */
  'account.verify_email': Object.freeze({
    id: 'account.verify_email',
    category: 'account',
    params: ['handle', 'verifyUrl'],
    secretParams: ['verifyUrl'],
    deliverOn: ['email'] as const,
    path: '{{verifyUrl}}',
    text: en(
      'Confirm your email address',
      'Hello @{{handle}} — one step is left: confirm this address, and your CloudsForge account is ready.\n\nThe link in this email works once and then expires. If it has already expired, ask for a new one from your account settings — nobody at CloudsForge can resend the old one, and nobody here will ever ask you to send it to them.',
    ),
  }),
  'wallet.created': Object.freeze({
    id: 'wallet.created',
    category: 'wallet',
    params: ['walletLabel', 'chain'],
    path: '/wallet',
    text: en(
      'A new wallet was created',
      'A {{chain}} wallet, {{walletLabel}}, was added to your account.',
    ),
  }),

  /* ------------------------------------------------------------------ money */

  'deposit.confirmed': Object.freeze({
    id: 'deposit.confirmed',
    category: 'deposit',
    params: ['amount', 'asset'],
    path: '/wallet/activity',
    text: en('Your deposit has been credited', '{{amount}} {{asset}} is now available in your wallet.'),
  }),
  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * A TOKEN ARRIVED AT A DEPOSIT ADDRESS AND IS NOT IN THE BALANCE — micro-org#200.
   *
   * The hardest wording in this file, because every reassuring sentence available for it is false.
   * What is true is small and has to be said anyway: the transfer was seen, it is at an address
   * the platform controls, it is not spendable, and nothing here can send it back today. A user
   * who reads this and does nothing has lost nothing; a user who reads a softer version and sends
   * a second transfer has.
   *
   * ── What this must not say ────────────────────────────────────────────────────────────────
   *
   * **Not "pending", and not "processing".** Both promise a later state that no code in this
   * estate can reach: crediting a `TOKEN:` asset needs decimals from a registry, a `chain_assets`
   * row and a withdrawal path, none of which exist. `withdrawal.stuck` in this file was rewritten
   * for the same class of error in the other direction — a template that told a user their money
   * was untouched while it was reserved — and the lesson it records is that the comforting
   * sentence is the one to check first.
   *
   * **No amount, and no asset name.** Every other money template opens with `{{amount}}
   * {{asset}}`, and this one cannot: the producer sends smallest units with no decimals, because
   * it has no source for them, so "250000000" is 250 of the token or 0.00000000025 of it and
   * nothing here can tell which. A number off by 10^12 in a mail about the user's own money is
   * worse than no number. The contract address is sent instead — it is unambiguous, it is what an
   * explorer takes, and it is the only name for a token that cannot be spoofed.
   *
   * `path` points at the deposits screen rather than activity, because the transfer is not in the
   * activity feed: there is no ledger entry for it to be in.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  'deposit.token_uncredited': Object.freeze({
    id: 'deposit.token_uncredited',
    category: 'deposit',
    params: ['chain', 'contract', 'txHash'],
    path: '/wallet/deposits',
    text: en(
      'A token arrived at your deposit address and has not been credited',
      'A token transfer reached your {{chain}} deposit address. It has NOT been added to your balance, and it cannot be withdrawn.\n\nThat address accepts the coin it was issued for. Tokens sent to it are held at an address CloudsForge controls, and support for crediting or returning them does not exist yet — so please do not send more to it.\n\nToken contract: {{contract}}\nTransaction: {{txHash}}\n\nThe transfer is recorded against your account and is visible on your deposits page. Contact support with that transaction reference and we will tell you where it stands.',
    ),
  }),
  'withdrawal.requested': Object.freeze({
    id: 'withdrawal.requested',
    category: 'withdrawal',
    params: ['amount', 'asset', 'destination', 'at'],
    path: '/wallet/activity',
    text: en(
      'A withdrawal was requested from your account',
      'A withdrawal of {{amount}} {{asset}} to {{destination}} was requested at {{at}}.\n\nIf this was not you, cancel it and change your password immediately — money is leaving.',
    ),
  }),
  'withdrawal.completed': Object.freeze({
    id: 'withdrawal.completed',
    category: 'withdrawal',
    params: ['amount', 'asset', 'destination', 'txHash'],
    path: '/wallet/activity',
    text: en(
      'Your withdrawal has been sent',
      '{{amount}} {{asset}} was sent to {{destination}}.\n\nTransaction: {{txHash}}',
    ),
  }),
  /*
   * `withdrawal.failed` STOOD HERE AND IS DELETED, not left for a future caller.
   *
   * It said "Nothing has left your balance. You can try again." — and it had exactly one consumer,
   * `settlement.withdrawal.stuck`, a topic where both sentences were false. It was never the
   * shared template it looked like. Once that rule moved to the pair below, the reachability test
   * in `catalogue.test.ts` called it: written, and nothing renders it.
   *
   * Leaving it would leave the sentence one `templateId:` away from being live again, which is how
   * it got onto a money topic in the first place. The two honest failure templates are
   * `withdrawal.failed_held` and `withdrawal.failed_refunded`, and they exist BECAUSE "your money
   * is coming back" and "your money is held" cannot share one reassuring sentence.
   */
  /* ------------------------------------------------------------------
   * The two halves of a failed withdrawal.
   *
   * These are two templates and not one parameterised sentence, because the fact they report is
   * two facts: `refundable` on `settlement.outbound.failed` decides whether the money is coming
   * back or is held, and every reader in the estate splits on it (`wallet/src/server.ts`,
   * `activity/src/classify.ts`). The ids are activity's own type names, so the feed entry and
   * the notification a user sees on one screen cannot disagree.
   *
   * Neither carries an amount. settlement's failure payload is
   * `{ withdrawalId, userId, reason, refundable }` and has never carried one, and a template
   * parameter whose only source is a fallback renders a sentence about "your withdrawal" that
   * pretends to a precision it does not have. The withdrawal id is here instead: it is the one
   * field a person quoting this to support cannot do without.
   * ------------------------------------------------------------------ */
  'withdrawal.failed_held': Object.freeze({
    id: 'withdrawal.failed_held',
    category: 'withdrawal',
    params: ['withdrawalId', 'reason', 'at'],
    path: '/wallet/activity',
    // Says the amount is HELD and does not say to try again. Suggesting a retry for a payment that
    // may have left the platform is how a user is invited to pay twice.
    text: en(
      'Your withdrawal could not be completed, and the amount is still held',
      'A withdrawal from your account could not be completed at {{at}}: {{reason}}.\n\nThe amount is still held. It has not been returned to your balance, and we cannot yet confirm whether the payment left the platform — so please do not request it again until this is resolved.\n\nSomeone is already looking at it. Quote withdrawal {{withdrawalId}} if you contact support.',
    ),
  }),
  'withdrawal.failed_refunded': Object.freeze({
    id: 'withdrawal.failed_refunded',
    category: 'withdrawal',
    params: ['withdrawalId', 'reason', 'at'],
    path: '/wallet/activity',
    text: en(
      'Your withdrawal was not sent, and the amount is coming back',
      'A withdrawal from your account was not sent at {{at}}: {{reason}}.\n\nThe payment never left the platform and the amount is being returned to your balance. You can request it again once it shows.\n\nWithdrawal {{withdrawalId}}.',
    ),
  }),
  /* ------------------------------------------------------------------
   * The two halves of a STUCK withdrawal — late, not failed.
   *
   * `settlement.withdrawal.stuck` rendered `withdrawal.failed` until this was split out, and that
   * template says "Nothing has left your balance. You can try again." Both halves of that sentence
   * are false for this topic and the second is dangerous:
   *
   *   - The reservation posts `available → reserved` when the withdrawal is REQUESTED
   *     (`wallet/src/withdrawals.ts`), so value has already left the available balance. Going
   *     stuck returns nothing — `markStuck` is "never a refund" (`settlement/src/worker.ts`)
   *     and wallet's own sweep "does not refund anything — the payment may have landed"
   *     (`wallet/src/withdrawals.ts`). The money is held, and the mail said it was untouched.
   *   - "You can try again" invites a second reservation against the balance the first is still
   *     holding. `withdrawal.failed_held` above already refuses to say it, for this exact reason.
   *
   * ## Why two templates and not one
   *
   * Same argument as the failed pair: two facts, not one parameterised sentence. `stuck` is
   * reached from `signed` or `broadcast` (`settlement/src/worker.ts`), and `broadcastAt` on
   * the payload is the evidence that separates them. The DEFAULT is the reading that holds when
   * there is no such evidence — we do not know whether anything reached the network — and the
   * variant has to be EARNED by a `broadcastAt`, which is the direction `Variant` is documented to
   * run in. Defaulting to "it has been sent" would state a transaction exists on the strength of a
   * missing field.
   *
   * ## Neither carries an amount, and that is deliberate
   *
   * The payload's `amount` is SMALLEST UNITS (`settlement/src/withdrawals.ts` —
   * `row.amount.toString()` off a `numeric(78,0)`), and notify has no decimals for any asset: no
   * `contracts-chain` dependency, no divisor, no formatter. Rendering it raw is the live defect
   * #199 — 1.5 LTC reads as "150000000" — and the old `withdrawal.failed` mail was doing exactly
   * that on this topic. The precedent is `tessera.venue.booked`'s `priceWei`, which is on the
   * payload and deliberately out of the words for the same reason. What would change this: a
   * pre-formatted amount on the payload, or the denomination exported from `@cloudsforge/contracts-*`.
   * Not a guess here, and not a factor of 10^10 in a sentence about someone's money.
   *
   * Both point the reader at the balance instead, where `GET /v1/portfolio` reports `available`
   * and `reserved` as separate rows carrying a `purpose` (`wallet/src/portfolio.ts`), so
   * the held amount is a number the user can actually see — as reserved, not as spendable.
   * ------------------------------------------------------------------ */
  'withdrawal.stuck': Object.freeze({
    id: 'withdrawal.stuck',
    category: 'withdrawal',
    params: ['withdrawalId', 'reason', 'at'],
    path: '/wallet/activity',
    text: en(
      'Your withdrawal is taking longer than expected, and the amount is held',
      'A withdrawal from your account has not completed within the expected time, as of {{at}}: {{reason}}.\n\nThe amount is held. It left your available balance when you requested it and has not been returned — it shows as reserved rather than available until this ends, so please do not request it again.\n\nWe cannot yet confirm whether the payment reached the network, so we cannot tell you yet how this ends. It is being tracked and someone is already looking at it, and you will be told what happened to the amount either way. Quote withdrawal {{withdrawalId}} if you contact support.',
    ),
  }),
  'withdrawal.stuck_sent': Object.freeze({
    id: 'withdrawal.stuck_sent',
    category: 'withdrawal',
    params: ['withdrawalId', 'reason', 'at'],
    path: '/wallet/activity',
    text: en(
      'Your withdrawal has been sent but has not confirmed, and the amount is held',
      'A withdrawal from your account was sent to the network but had not confirmed as of {{at}}: {{reason}}.\n\nThe amount is held. It left your available balance when you requested it and has not been returned — it shows as reserved rather than available until this ends, so please do not request it again.\n\nThe transaction may still confirm on its own and is being tracked. If it cannot complete, you will be told what happened to the amount. Quote withdrawal {{withdrawalId}} if you contact support.',
    ),
  }),
  'transfer.posted': Object.freeze({
    id: 'transfer.posted',
    category: 'transfer',
    params: ['amount', 'asset', 'description'],
    path: '/wallet/activity',
    /**
     * The subject carries the amount, and that is not cosmetic.
     *
     * A digest is an index of subjects (`describe` in `pipeline.ts`), so a subject with no
     * parameters produces a batch reading "Your balance changed" three times — which tells the
     * reader nothing and is worse than not sending it. Any template likely to appear in a digest
     * must have a subject that distinguishes one instance from another. A test caught this one.
     */
    text: en('Your balance changed: {{amount}} {{asset}}', '{{amount}} {{asset}} — {{description}}.'),
  }),

  /* ------------------------------------------------------------------ products */

  'market.offer_received': Object.freeze({
    id: 'market.offer_received',
    category: 'market',
    params: ['amount', 'asset', 'listingId'],
    path: '/market/offers',
    // The amount is in the SUBJECT deliberately, for the reason `transfer.posted` records: a
    // digest is an index of subjects, and three offers reading "You have a new offer" tell the
    // reader nothing about which to open. An offer holds the buyer's money in escrow while it
    // waits, so the sentence says the thing that makes it worth opening now.
    text: en(
      'A new offer of {{amount}} {{asset}} on your listing',
      'Somebody offered {{amount}} {{asset}} for your listing {{listingId}}.\n\nThe offer is funded and held in escrow until you accept or decline it, or it expires.',
    ),
  }),
  'market.sale': Object.freeze({
    id: 'market.sale',
    category: 'market',
    params: ['itemName', 'amount', 'asset'],
    path: '/market/sales',
    text: en('Your listing sold', '{{itemName}} sold for {{amount}} {{asset}}.'),
  }),
  'token.deployed': Object.freeze({
    id: 'token.deployed',
    category: 'token',
    params: ['tokenName', 'address', 'chain'],
    path: '/mint/tokens',
    text: en(
      'Your token is live',
      '{{tokenName}} is deployed on {{chain}} at {{address}}.',
    ),
  }),
  'trading.bot_paused': Object.freeze({
    id: 'trading.bot_paused',
    category: 'trading',
    params: ['botLabel', 'at'],
    path: '/trade/bots',
    // `paused` is terminal-ish and it does NOT flatten the position — trade/src/bots.ts pauses with
    // the position still open, marked to market from whenever the bot last ticked. So the sentence
    // has to say that the money is still exposed; "your bot stopped" on its own would read as safe.
    text: en(
      'Your trading bot stopped',
      '{{botLabel}} stopped trading at {{at}}.\n\nPausing does not close its position — anything the bot was holding is still open and still moving with the market. Review it and close it yourself if you want to be out.',
    ),
  }),
  /**
   * The platform charging the customer. micro-org#345.
   *
   * **The one trade notification that is not a confirmation of something the user just did.** A
   * performance fee is taken on the estate's own initiative, out of a balance the customer is not
   * watching at the moment it happens, and nothing else in the estate says so — `trade.fee.settled`
   * is the only event carrying it. That is the difference between this and the fills, which the
   * terminal shows live and which get no rule at all.
   *
   * **No figure, and the reason is the same one `activity` writes down at its classifier.** A
   * performance fee is `collected` Shards, an integer count with no sub-unit (`trade/src/money.ts`),
   * and this service has no more idea of an asset's scale than that one does — `transfer.posted`
   * above prints an amount only because `ledger.entry.posted` sends one it can print. A subject
   * reading "You were charged 1,250" for a $12.50 fee is worse than one that does not quote a
   * figure, because the reader believes it. The period and the link are what make it checkable.
   *
   * The second sentence is the one a support conversation would otherwise be about: a performance
   * fee is charged on the gain above the previous high-water mark, so a bot that lost and recovered
   * is not billed twice for the same ground.
   */
  'trading.fee_charged': Object.freeze({
    id: 'trading.fee_charged',
    category: 'trading',
    params: ['botLabel', 'period', 'at'],
    path: '/trade/bots',
    text: en(
      'A performance fee was charged on your trading bot',
      'A performance fee for {{botLabel}} was charged at {{at}}, for period {{period}}.\n\nThe fee is taken from the gain above the bot\'s previous high-water mark, so a bot that fell and recovered is not charged twice for the same ground. The amount and the journal entry are on the bot\'s settlement history.',
    ),
  }),
  /**
   * The same charge, when the balance did not cover it. micro-org#367.
   *
   * **TWO templates and not one with a `{{status}}` in it**, for the reason the exchange-transfer
   * split below states and one more that is specific to money the platform is still owed. A full
   * collection is finished business: the fee was taken and the sentence's job is to make it
   * checkable. A partial one is unfinished — there is an amount the customer still owes, it is
   * still going to be taken, and the reader's next question is "when, and do I have to do
   * anything?" A single template covering both would have to hedge that away into "some or all of
   * the fee was charged", which is the shape this catalogue keeps calling a plausible screen over
   * nothing: it reads fine and answers neither case.
   *
   * **What the second paragraph asserts, read off `trade/src/fees.ts` rather than assumed.** The
   * uncollected remainder is not written off and it is not re-derived later from anything:
   * `settle` finishes with `updateBot(deps.sql, bot.id, { feePaid: feePaid + collected, feeOwed:
   * due - collected })`, so the shortfall is recorded on the bot as `feeOwed` the moment the
   * partial happens. The next pass then computes `const due = fee + feeOwed`, which is arrears
   * plus whatever that period newly assesses — one charge, not two — and the `fee < 1n` branch
   * above it asks the ledger for the balance before writing another settlement row, so a wallet
   * that still cannot cover it defers rather than accumulating an uncollectable row per period.
   * A paused bot is swept too, under `SettleScope`'s `arrears`. Hence "at a later settlement"
   * rather than a date this service cannot know, and hence the claim that topping up is the whole
   * of the reader's part in it.
   *
   * **`uncollectable` gets no template here, and that is a producer fact rather than an
   * oversight.** `settleFee` guards its emit with `if (collected > 0n)`, so a settlement that
   * collected nothing never reaches this topic at all — trade documents that at the emit site and
   * files the arrears case as wanting a topic of its own. Writing the third sentence now would put
   * a template in this file that nothing can render, which `catalogue.test.ts` fails on by design.
   *
   * **No figure, for the reason `trading.fee_charged` gives above, and it costs more here.** The
   * event now carries `due` as well as `collected` and both are smallest-unit counts off a
   * `numeric(78,0)` column, so this service could subtract them and still not know what the answer
   * is denominated in. "You still owe 850" is a number the reader supplies their own unit for. The
   * settlement history is where the two amounts belong, and the link goes there.
   */
  'trading.fee_charged_partial': Object.freeze({
    id: 'trading.fee_charged_partial',
    category: 'trading',
    params: ['botLabel', 'period', 'at'],
    path: '/trade/bots',
    text: en(
      'Only part of a performance fee could be charged on your trading bot',
      'A performance fee for {{botLabel}} was settled at {{at}}, for period {{period}}, and your balance covered only part of it.\n\nThe rest is still owed. It stays recorded against the bot and is added to what is due at a later settlement, so it is deferred rather than written off, and topping up the balance is all that is needed for it to be taken. No gain is billed twice for this: the fee is charged on the gain above the bot\'s previous high-water mark, and that mark has already moved. The amount taken, the amount still outstanding and the journal entry are on the bot\'s settlement history.',
    ),
  }),
  /* ── the two halves of an exchange transfer. micro-org#345 ─────────────────────────────────
   *
   * TWO templates and not one with a `{{direction}}` in it. The direction is not an adjective on
   * one sentence: a deposit ends with money that can be traded and a withdrawal ends with money
   * back in a wallet balance, and those are the two different things the reader opened the message
   * to find out. A single template would have had to hedge to cover both, and `withdrawal.stuck` /
   * `withdrawal.stuck_sent` is the precedent for splitting rather than hedging.
   *
   * Neither prints an amount, for the reason `trading.fee_charged` gives above: `settleTransfer`
   * sends base units of the asset, whose scale is `chainSpec(asset).decimals` and which neither
   * this service nor `activity` may look up. The ASSET is named, because the code is on the
   * payload and "your EMBER deposit" is a sentence a reader can match against what they did.
   * ---------------------------------------------------------------------------------------- */
  'transfer.exchange_deposit': Object.freeze({
    id: 'transfer.exchange_deposit',
    category: 'transfer',
    params: ['asset', 'at'],
    path: '/trade/balances',
    text: en(
      'Your exchange deposit settled',
      'Your {{asset}} deposit into the exchange settled at {{at}} and is now available to trade.',
    ),
  }),
  'transfer.exchange_withdrawal': Object.freeze({
    id: 'transfer.exchange_withdrawal',
    category: 'transfer',
    params: ['asset', 'at'],
    path: '/wallet',
    // A different `path` from the deposit above, and that is the point of the split rather than a
    // detail of it: the money is in a different place at the end of each, so the link that would
    // show the reader their own money is a different link.
    text: en(
      'Your exchange withdrawal settled',
      'Your {{asset}} withdrawal out of the exchange settled at {{at}} and is back in your wallet balance.',
    ),
  }),
  'api.key_issued': Object.freeze({
    id: 'api.key_issued',
    category: 'api',
    params: ['keyDisplay', 'project', 'at'],
    path: '/developers/keys',
    // The DISPLAY (`cfk_live_…`), never the key. devplatform's own emit says so — `emitKeyIssued`
    // in `devplatform/src/apikeys.ts` is documented as carrying "the DISPLAY, never the key" — and
    // the display is the value an operator finds in a log line and revokes by.
    text: en(
      'A new API key was created',
      'API key {{keyDisplay}} was created for project {{project}} at {{at}}.\n\nAn API key acts as you. If this was not you, revoke it now and change your password.',
    ),
  }),
  'api.key_revoked': Object.freeze({
    id: 'api.key_revoked',
    category: 'api',
    params: ['keyDisplay', 'project', 'at', 'reason'],
    path: '/developers/keys',
    text: en(
      'An API key was revoked',
      'API key {{keyDisplay}} for project {{project}} was revoked at {{at}} — {{reason}}.\n\nAnything using it has stopped working. If this was not you, someone else can reach your project: change your password and review the remaining keys.',
    ),
  }),
  'reward.granted': Object.freeze({
    id: 'reward.granted',
    category: 'reward',
    params: ['rewardName', 'titleName'],
    path: '/play/rewards',
    text: en('You earned a reward', 'You earned {{rewardName}} in {{titleName}}.'),
  }),
  'provision.failed': Object.freeze({
    id: 'provision.failed',
    category: 'billing',
    params: ['entitlementId'],
    path: '/play/worlds',
    // The entitlement id is in the body deliberately: it is the one field a person quoting this
    // to support cannot do without, and the refund names exactly it.
    text: en(
      'A world purchase could not be delivered',
      'Your private world could not be set up. Nothing further is needed from you — the purchase (entitlement {{entitlementId}}) is being reviewed for refund or redelivery.',
    ),
  }),
  'community.proposal': Object.freeze({
    id: 'community.proposal',
    category: 'community',
    params: ['communityName', 'proposalTitle', 'status'],
    path: '/communities/proposals',
    text: en(
      'A proposal in {{communityName}} is {{status}}',
      '"{{proposalTitle}}" in {{communityName}} is {{status}}.',
    ),
  }),
  'governance.vote': Object.freeze({
    id: 'governance.vote',
    category: 'governance',
    params: ['communityName', 'proposalTitle', 'choice', 'weight'],
    path: '/communities/proposals',
    text: en(
      'Your vote was recorded',
      'Your vote of {{choice}} on "{{proposalTitle}}" in {{communityName}} was recorded with a weight of {{weight}}.',
    ),
  }),
  'billing.entitlement_granted': Object.freeze({
    id: 'billing.entitlement_granted',
    category: 'billing',
    params: ['productName'],
    path: '/billing',
    text: en('{{productName}} is ready', 'Your purchase of {{productName}} is active.'),
  }),
  'billing.entitlement_revoked': Object.freeze({
    id: 'billing.entitlement_revoked',
    category: 'billing',
    params: ['productName', 'reason'],
    path: '/billing',
    text: en(
      'Your access to {{productName}} has ended',
      'Access to {{productName}} has ended: {{reason}}.',
    ),
  }),

  /* ------------------------------------------------------------------ aetherholm */

  'ownership.battle_report': Object.freeze({
    id: 'ownership.battle_report',
    category: 'ownership',
    params: ['cityName', 'outcome', 'at'],
    path: '/aetherholm',
    text: en(
      'Your city {{cityName}} came under attack',
      'Your city {{cityName}} came under attack at {{at}}.\n\nOutcome: {{outcome}}.\n\nThe full battle report — losses, loot and the wind of the approach — is waiting in Aetherholm.',
    ),
  }),
  'reward.heraldry': Object.freeze({
    id: 'reward.heraldry',
    category: 'reward',
    params: ['seasonName'],
    path: '/aetherholm',
    text: en(
      'You held an Aether Spire as {{seasonName}} sealed',
      '{{seasonName}} has sealed into the chronicle with your banner on an Aether Spire.\n\nHeraldry is yours: it will appear on your Worlds profile, visible in every title.',
    ),
  }),

  /* ------------------------------------------------------------------ tessera */

  // All five are `ownership`, and none of them is a confirmation of a thing the reader just did.
  // That is the test every tessera topic was put to: the two of the seven with no template here
  // announce the reader's own deliberate act or name nobody at all, and they have no rule either —
  // see `NON_NOTIFYING_TOPICS`.
  //
  // The last two arrived together and are the reason that count moved from three to five: their
  // topics were deferred, not declined, because the payloads named the challenger and the booker
  // rather than the owner. tessera `33ead39` added `ownerSubject` to both. Both of these templates
  // are therefore written for a reader who is NOT the actor and did not ask for the news, which is
  // why neither opens with a congratulation and both say what the reader may do next.

  'tessera.object_fired': Object.freeze({
    id: 'tessera.object_fired',
    category: 'ownership',
    params: ['objectCategory', 'checksum'],
    path: '/tessera/kiln',
    // The checksum is in the body rather than the subject: it is how the object is addressed
    // (`tessera/src/kiln.ts` content-addresses by the sha256 of its own bytes) but it is not a
    // sentence anybody reads. The category is, and it is what tells five queued firings apart.
    text: en(
      'Your {{objectCategory}} came out of the Kiln',
      'The Kiln finished firing your {{objectCategory}}.\n\nIt is addressed by the checksum of its own bytes: {{checksum}}. It can be placed on a parcel now, and anchored on-chain whenever you want a permanent record of it.',
    ),
  }),
  'tessera.object_anchored': Object.freeze({
    id: 'tessera.object_anchored',
    category: 'ownership',
    params: ['transactionHash', 'blockNumber'],
    path: '/tessera/objects',
    text: en(
      'Your object is anchored on-chain',
      'The anchor confirmed in block {{blockNumber}}, transaction {{transactionHash}}.\n\nThe checksum of the object is now on a chain nobody controls, so authorship can be proved without this platform.',
    ),
  }),
  'tessera.parcel_lost': Object.freeze({
    id: 'tessera.parcel_lost',
    category: 'ownership',
    params: ['parcelId', 'wardId'],
    path: '/tessera/parcels',
    // Says WHY, because the reader did nothing and will otherwise read this as a platform error.
    // A contest is only openable against a parcel that has already been fallow — the sentence has
    // to carry that, or "your land was taken" is the whole of what they learn.
    text: en(
      'A parcel of yours changed hands after a contest',
      'Parcel {{parcelId}} in ward {{wardId}} is no longer yours.\n\nIt had gone fallow — no visitor and no edit for 90 days — and was contested 30 days after that. The contest resolved in the challenger\'s favour.\n\nA Homestead can never be contested. Everything you built on the parcel is still yours and still in your objects.',
    ),
  }),
  /**
   * The warning `tessera.parcel_lost` is the aftermath of, and the harder of the two to write.
   *
   * This is bad news about property told to somebody who did nothing, so the body has to answer
   * three questions in order: what has happened, why it was allowed to happen, and what — if
   * anything — is still theirs to do. The third is where a template of this kind normally lies.
   *
   * **It does not tell the reader to bank this parcel, and that omission is deliberate.** Banking
   * moves `banked_until` and therefore `tessera_contestable_at`, but `resolveContest` does not
   * re-read the window — `tessera/src/jobs.ts`, the `parcel.settle` handler, says why in as many
   * words: "a contest that exists is one the window already permitted". Nothing withdraws an open
   * contest; `contests_status_known` allows `withdrawn` and no code writes it. So "bank it to save
   * it" would be a defence that does not exist, offered to somebody who would then believe their
   * ground was safe. Banking appears here only as what keeps their OTHER land out of this, which
   * is true.
   */
  'tessera.parcel_contested': Object.freeze({
    id: 'tessera.parcel_contested',
    category: 'ownership',
    params: ['parcelId', 'wardId'],
    path: '/tessera/parcels',
    text: en(
      'Someone has opened a contest on a parcel of yours',
      'Parcel {{parcelId}} in ward {{wardId}} has been contested. Anyone may claim ground that has gone quiet, and this parcel reached that point: 90 days with no visitor and no edit, and 30 days more after that.\n\nIf the contest is resolved the parcel changes hands, and we will tell you when it is. Nothing you made goes with it — everything you built on the parcel is still yours and still in your objects.\n\nYour other land is on the same clock. A visitor or an edit restarts it, and banking a parcel extends it to 270 days — free, once a year. A Homestead is never fallow and never contestable, whatever happens to the rest.',
    ),
  }),
  /**
   * Money owed, and an hour of the reader's calendar spent by a stranger.
   *
   * The amount is not in these words and `catalogue.ts`'s rule carries the full argument: the
   * payload's `priceWei` is a count of the smallest unit, and the divisor that turns it into the
   * Sparks a person would recognise lives in `micro-tessera` and is exported by no shared package.
   * A second copy of a denomination that drifts states the wrong amount of money; the raw integer
   * reads as a bug. Neither is better than pointing at the parcel, where the figure is shown
   * beside its unit.
   *
   * It says the fee is HELD rather than paid, and stops there, because that is all the estate can
   * prove today: `bookings_open_holds_money` makes an open booking without a ledger reservation
   * unrepresentable, and nothing in `micro-tessera` moves a booking to `settled` yet. Promising a
   * payout date this service cannot see is the withdrawal-refund error in a smaller currency.
   */
  'tessera.venue_booked': Object.freeze({
    id: 'tessera.venue_booked',
    category: 'ownership',
    params: ['parcelId', 'slot'],
    path: '/tessera/parcels',
    text: en(
      'Someone has booked your Venue',
      'Your Venue at parcel {{parcelId}} is booked for {{slot}}.\n\nThe fee is already escrowed: a booking cannot hold a slot on your calendar without a ledger reservation holding the money behind it, so this is not a promise to pay you — it is money set aside. The amount is on the parcel, shown with its unit.\n\nThe slot is yours to be ready for. Nothing else can take it while this booking stands.',
    ),
  }),

  /* ------------------------------------------------------------------ agora */

  /**
   * Thirteen kinds of square notification, two templates, and the split is the argument.
   *
   * A reply, a mention, a follow, a whisper and an invitation are the SAME news — somebody did
   * something to you in the square and it is waiting there — so they share one template and the
   * sentence that distinguishes them arrives as `headline`, already built by the rule from
   * agora's own words. Thirteen near-identical templates differing by one verb would be thirteen
   * places to get the tone wrong and one place a new kind is forgotten.
   *
   * `path` is the whole `{{url}}`, absolute, and that is the `account.verify_email` precedent
   * rather than a new one. `NOTIFY_PUBLIC_URL` is the hub, the hub has no route into the square,
   * and a relative path here would render a mail whose one button 404s. agora is the only party
   * that knows its own origin — see `Env.publicUrl` there — so agora sends it, and the rule
   * substitutes `/notifications` when a deployment has not been told, which lands on a page that
   * exists rather than a hostname somebody guessed.
   *
   * The body does not print the post's words. agora deliberately puts none on the payload: a
   * followers-only post whose text reached a mail server would be readable by anyone holding the
   * mailbox, which is not the audience the author chose.
   */
  'agora.notification': Object.freeze({
    id: 'agora.notification',
    category: 'community',
    params: ['headline', 'url'],
    path: '{{url}}',
    text: en(
      'Forge Agora: {{headline}}',
      '{{headline}}.\n\nIt is waiting in the square. Reading it there is what stops this reminder — one notification is one mail, and only while it is still unread.\n\nTo stop these altogether, open Forge Agora and turn them off under settings.',
    ),
  }),

  /**
   * The moderation half, and it is different news rather than a louder version of the same news.
   *
   * Every other kind is somebody talking to you and can wait; this one is the platform having
   * taken something of yours down, which is the case where a person concludes the product is
   * broken unless it says otherwise. It also carries the one `detail` agora ever fills in — the
   * reason a moderator gave — and a reason a reader cannot see is worse than no message at all.
   *
   * Its link is `{{url}}` for the same reasons as above, and in practice that resolves to the
   * notification list: `agora/src/moderation.ts` notifies with no post id, because the post the
   * message is about is exactly the one that is no longer there.
   */
  'agora.moderation': Object.freeze({
    id: 'agora.moderation',
    category: 'community',
    params: ['detail', 'url'],
    path: '{{url}}',
    text: en(
      'A moderator acted on something of yours in Forge Agora',
      'Something of yours in Forge Agora was acted on after review.\n\nReason given: {{detail}}\n\nThe guidelines this was measured against are published in the square, at /guidelines.',
    ),
  }),

  /* ------------------------------------------------------------------ platform */

  'system.incident': Object.freeze({
    id: 'system.incident',
    category: 'system',
    params: ['title', 'status', 'affected'],
    path: '/status',
    text: en(
      'Service update: {{title}}',
      '{{title}} — {{status}}.\n\nAffected: {{affected}}.',
    ),
  }),
  'system.broadcast': Object.freeze({
    id: 'system.broadcast',
    category: 'system',
    params: ['title', 'message'],
    path: '/status',
    text: en('{{title}}', '{{message}}'),
  }),
  'digest.summary': Object.freeze({
    id: 'digest.summary',
    category: 'system',
    params: ['count', 'period', 'items'],
    path: '/notifications',
    text: en(
      'Your {{period}} summary: {{count}} updates',
      'Here is what happened in the last {{period}}:\n\n{{items}}',
    ),
  }),
} as const satisfies Readonly<Record<string, Template>>)

export type TemplateId = keyof typeof TEMPLATES

export const TEMPLATE_IDS: readonly TemplateId[] = Object.freeze(
  Object.keys(TEMPLATES) as TemplateId[],
)

export function isTemplateId(value: string): value is TemplateId {
  return Object.hasOwn(TEMPLATES, value)
}

export function templateFor(id: TemplateId): Template {
  return TEMPLATES[id]
}

/** The value a redacted parameter is replaced by. Visible, so it reads as removed, not as absent. */
export const REDACTED = '[redacted]'

/**
 * Blank the parameters a template declares as single-use credentials.
 *
 * Applied where a stored notification row becomes something a caller can read — `store.ts`,
 * `toNotification` — and nowhere near the dispatch path, which reads `notifications.params`
 * straight out of its own query and must still be able to render the real link.
 *
 * **Replaced rather than deleted.** An absent key reads as "the producer never sent it", which is a
 * different fact and one somebody would go and investigate; a visible marker says the value exists
 * and is deliberately not being shown. The estate has been burned once by a live credential in a
 * log line, and this is the same value arriving by a different door: `GET /notifications` returns
 * the whole parameter object, and an operator with the admin role may ask for another user's.
 *
 * An unknown template id redacts nothing, which is the same degradation `messageFor` makes for a
 * template a deploy has removed. It is safe here because a template that has been deleted cannot
 * have declared a secret parameter that a rule is still supplying.
 */
export function redactSecretParams(
  templateId: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (!isTemplateId(templateId)) return params
  const secret = templateFor(templateId).secretParams
  if (!secret || secret.length === 0) return params
  const out = { ...params }
  for (const name of secret) {
    if (Object.hasOwn(out, name)) out[name] = REDACTED
  }
  return out
}

export interface Rendered {
  readonly subject: string
  readonly body: string
  /** Absolute, built from `NOTIFY_PUBLIC_URL`. Safe to put in an email. */
  readonly link: string
  /** Parameters the template asked for and did not get. Empty in a correct build. */
  readonly missing: readonly string[]
}

/** `{{name}}` — no expressions, no filters, no conditionals. A template language is a footgun. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

/**
 * Substitute, in a single pass.
 *
 * Single-pass matters: a parameter whose *value* contains `{{something}}` is never rescanned, so
 * a hostile display name cannot reach another parameter's value. That is the whole of the
 * injection story for a plain-text renderer.
 */
function substitute(text: string, params: Record<string, unknown>, missing: Set<string>): string {
  return text.replace(PLACEHOLDER, (_match, name: string) => {
    const value = params[name]
    if (value === undefined || value === null) {
      missing.add(name)
      return ''
    }
    return String(value)
  })
}

/**
 * Render a template for a locale.
 *
 * An unknown locale falls back to `en-GB` rather than failing — see `resolveLocale`. Withholding
 * a notification because the platform does not speak the user's language would breach §10.3 for
 * anything critical.
 */
export function renderTemplate(
  template: Template,
  params: Record<string, unknown>,
  locale: Locale,
  baseUrl: string,
): Rendered {
  const text = template.text[locale] ?? template.text[DEFAULT_LOCALE]
  const missing = new Set<string>()
  const subject = substitute(text.subject, params, missing)
  const body = substitute(text.body, params, missing)
  const path = substitute(template.path, params, missing)
  // `new URL` rather than string concatenation: it normalises a trailing slash on the base and a
  // leading one on the path, which is the join two services in this estate already get wrong.
  const link = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString()
  return { subject, body, link, missing: [...missing] }
}

/** A stored notification reduced to the two things a screen needs in order to draw a row. */
export interface Described {
  /** The template's subject, substituted. Never the template id, unless the template is gone. */
  readonly title: string
  /**
   * Where the row points, RELATIVE — `/settings/security/devices`, never an origin.
   *
   * Null when there is nowhere honest to point. See `describeNotification` for the two cases.
   */
  readonly href: string | null
}

/**
 * The words a notification carries when it is READ, rather than when it is delivered.
 *
 * ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────────────────────────
 *
 * `GET /notifications` used to answer with a template id and a parameter bag and nothing else, and
 * "the only place a user-visible sentence is written" (this file's header) was therefore reachable
 * only by the dispatch path. Any screen wanting to draw a notification had to hold its own copy of
 * these subjects — a second set of the estate's words, in a bundle, free to drift from these. The
 * measurement that made it urgent is micro-org #415: hub-api now composes a `notifications` tile
 * for every signed-in Overview, and the estate's live rows are `account.registered`,
 * `account.verify_email` and `security.password_reset` — three sentences that exist here and
 * nowhere a client can see.
 *
 * So the words come from here, over the wire, and the SPA renders `title` without knowing what a
 * template is.
 *
 * ── WHY `href` IS RELATIVE, AND WHY IT IS SOMETIMES NULL ───────────────────────────────────────
 *
 * Relative because the reader's origin is the reader's business: `renderTemplate` builds an
 * absolute `link` against `NOTIFY_PUBLIC_URL` because it is going into an email, where there is no
 * origin to be relative to. A row in a signed-in SPA has one, and hub-api's own rule for deep
 * links — "the SPA owns its own origin" (`nextactions.ts`) — is the same rule.
 *
 * Null in two cases, both of which would otherwise produce a link that lies:
 *
 *   1. **The template is gone.** A deploy may remove a template while rows referencing it remain.
 *      The title degrades to the template id, exactly as `messageFor` does for a pending delivery,
 *      rather than throwing — and there is no path to point at.
 *   2. **The path IS a credential.** `account.verify_email` declares `path: '{{verifyUrl}}'` and
 *      `verifyUrl` as a `secretParams`, so by the time a row reaches this function `store.ts` has
 *      already replaced that parameter with `[redacted]` — the whole point of that redaction. A
 *      naive substitution here would emit `href: '/[redacted]'`, a dead link on the single most
 *      important notification the platform sends, and it would do it silently. The check is
 *      declarative — does the path reference a parameter the template calls secret — rather than a
 *      scan for the marker, so it holds for a template that has not been written yet.
 */
export function describeNotification(
  templateId: string,
  params: Record<string, unknown>,
  locale: Locale,
): Described {
  if (!isTemplateId(templateId)) return { title: templateId, href: null }
  const template = templateFor(templateId)
  const text = template.text[locale] ?? template.text[DEFAULT_LOCALE]
  // Discarded rather than reported: a caller reading its own notifications can do nothing about a
  // missing parameter, and the dispatch path already logs the names when it renders for delivery.
  const missing = new Set<string>()
  const title = substitute(text.subject, params, missing)

  const referenced = new Set<string>()
  for (const [, name] of template.path.matchAll(PLACEHOLDER)) referenced.add(name as string)
  const pathIsCredential = (template.secretParams ?? []).some((name) => referenced.has(name))

  return { title, href: pathIsCredential ? null : substitute(template.path, params, missing) }
}
