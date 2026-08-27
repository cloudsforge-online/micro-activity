/**
 * The email adapter: generic SMTP, and nothing else.
 *
 * The estate's convention, stated in its own `.env.example` and reproduced exactly: *"There is no
 * provider code and no SDK: this is plain SMTP, so Brevo, Resend, SendGrid, Mailtrap, a Gmail app
 * password and your own postfix are all the same four settings. Changing provider is an edit here
 * and a restart."* Four settings — host, port, user, pass — plus the From address the provider
 * has authorised.
 *
 * ## Unconfigured is a supported mode
 *
 * `SMTP_HOST` unset does not fail, does not throw, and does not lose the notification. It returns
 * `no_transport`, the delivery is recorded as `undeliverable_no_transport`, and the row is
 * retained. That is how the estate already runs — a password-reset request with no SMTP is
 * recorded and an operator issues the link by hand — and it is the behaviour that lets this
 * service be deployed before anybody has bought a mail provider.
 *
 * It is emphatically **not** the same as losing the notification. The notification row exists, it
 * is readable in-app, it appears in `GET /admin/deliveries`, and `notify_failed_total{channel=
 * "email",reason="no_transport"}` counts it. An operator can see exactly how much mail this
 * deployment is not sending.
 *
 * ## Why nodemailer is imported lazily
 *
 * A deployment with no SMTP must not need the module at all. The dynamic import happens on the
 * first send with a configured transport, so an unconfigured service never loads it — and a
 * broken install of it cannot stop this service from booting and delivering in-app.
 */

import type { SmtpConfig } from './env.ts'
import { failure, type ChannelAdapter, type OutboundMessage, type SendOutcome } from './channels.ts'
import { renderEmailHtml } from './emailhtml.ts'
import { isUndeliverableAddress } from './reserved.ts'

/** The slice of nodemailer this adapter uses. Narrow, so the lazy import stays typed. */
interface Transport {
  sendMail(message: {
    from: string
    to: string
    subject: string
    text: string
    /**
     * Optional, and nodemailer builds `multipart/alternative` when both are present. Optional
     * rather than required so the existing tests, which assert on `text`, keep compiling — and so
     * a future caller that deliberately wants text only can still express it.
     */
    html?: string
    replyTo?: string
    headers?: Record<string, string>
  }): Promise<{ messageId?: string }>
}

export interface EmailOptions {
  readonly smtp: SmtpConfig
  /**
   * Test seam. Every test in this repository passes one; none has ever opened a socket to a mail
   * server, and the unconfigured-transport test passes no transport at all — which is the point.
   */
  readonly transport?: () => Promise<Transport>
}

/**
 * Is there a way to send mail at all?
 *
 * Both halves are required. A host with no From address gets the connection accepted and the
 * message rejected, which is a delivery that fails at the provider rather than here — much harder
 * to diagnose than the honest `no_transport` this returns.
 */
export function smtpConfigured(smtp: SmtpConfig): boolean {
  return smtp.host !== null && smtp.from !== null
}

export function emailAdapter(options: EmailOptions): ChannelAdapter {
  const { smtp } = options
  // Built once and reused: a transport per message opens a TCP connection per message, which is
  // how a provider's rate limiter starts refusing an otherwise healthy deployment.
  let transport: Promise<Transport> | null = null

  const open = (): Promise<Transport> => {
    if (transport) return transport
    transport = options.transport ? options.transport() : openSmtp(smtp)
    return transport
  }

  return {
    channel: 'email',
    async send(message: OutboundMessage): Promise<SendOutcome> {
      if (!smtpConfigured(smtp) && !options.transport) {
        return failure('no_transport', false, 'SMTP_HOST or SMTP_FROM is not set; no mail is sent')
      }
      if (!message.address) {
        return failure('no_address', false, 'no email address on file for this user')
      }
      // Backstop. `pipeline.ts`'s `channelsAvailable` already declines to route email to a domain
      // the standards reserve, so on the live path no delivery reaches here — this catches a row
      // written before that shipped, or a caller that builds an OutboundMessage some other way.
      //
      // Permanent, not retryable, and that is the whole point: no number of attempts makes
      // `beacon.test` resolvable, `deliveries.max_attempts` is 6, and each of those six is a unit of
      // an allowance real recipients share. Retrying here is how one synthetic account costs six.
      //
      // The reason is `reserved_domain` and not `rejected` because reaching this line AT ALL is
      // the alarm. `rejected` is written by five call sites across push, webhook and SMTP, all of
      // which are ordinary upstream refusals; this one is the only failure in the set that should
      // be impossible, so it gets a series an operator can threshold at greater than zero.
      // micro-org#390 — where the rule was in the tree and the running process did not have it,
      // and nothing anywhere said so for six days.
      if (isUndeliverableAddress(message.address)) {
        return failure('reserved_domain', false, 'reserved domain; no mail exchanger can exist (RFC 6761 §6, RFC 2606 §3)')
      }

      try {
        const sender = await open()
        const result = await sender.sendMail({
          from: smtp.from ?? 'CloudsForge <no-reply@invalid>',
          to: message.address,
          subject: message.subject,
          // The text part is unchanged, and stays FIRST for a reason beyond ordering: it is the
          // part that must remain correct on its own. A client that refuses HTML, a screen reader
          // set to prefer plain text, and `deliveries` replay all read this and only this.
          text: `${message.body}\n\n${message.link}\n`,
          // ── THE REFUSAL ABOVE THIS LINE USED TO SAY "PLAIN TEXT ONLY" ───────────────────────
          // and its reason — that every template parameter is domain data this service did not
          // write — was right. It is satisfied rather than overruled: `renderEmailHtml` is handed
          // the SAME already-rendered text, escapes it whole, and never reads a parameter. A
          // parameter carrying markup arrives as text and leaves as entities. See the header of
          // `emailhtml.ts` for the two guards that hold that up.
          html: renderEmailHtml({
            subject: message.subject,
            body: message.body,
            link: message.link,
            category: message.category,
          }),
          ...(smtp.replyTo ? { replyTo: smtp.replyTo } : {}),
          headers: {
            // Lets a receiving server collapse a retried delivery instead of showing it twice.
            'X-Entity-Ref-ID': message.deliveryId,
            'X-CloudsForge-Category': message.category,
          },
        })
        return { ok: true, ...(result.messageId ? { providerRef: result.messageId } : {}) }
      } catch (err) {
        // A transport failure is discarded so the next attempt reconnects. Holding a dead pooled
        // connection is how one network blip turns into every subsequent send failing.
        transport = null
        return classify(err)
      }
    },
  }
}

/**
 * SMTP failures split cleanly on the first digit of the reply code.
 *
 * 4xx is a transient negative reply — greylisting, a full mailbox, a rate limit — and is exactly
 * what retries exist for. 5xx is permanent: the address does not exist, or the provider will not
 * send as that From. Retrying a 5xx six times annoys the provider and delivers nothing.
 *
 * The message is truncated and never includes the configuration, because a nodemailer error can
 * carry the connection options — and those hold `SMTP_PASS`.
 */
function classify(err: unknown): SendOutcome {
  const code = (err as { responseCode?: number } | null)?.responseCode
  const message = err instanceof Error ? err.message : String(err)
  const safe = message.slice(0, 300)
  // THE QUOTA TEST COMES FIRST, AND IT HAS TO (#201).
  //
  // The digit rule below is right in general and wrong for the one reply this estate's provider
  // actually sends most often. Mailtrap answers an exhausted daily allowance with
  //
  //     535 5.7.8 Your account has reached its daily sending limit ... retry in 19m21s
  //
  // — a 5xx AUTH code, with the enhanced code for "credentials invalid", for a condition that is
  // temporary and that states its own retry-after in the text. Classified on the digit it is
  // permanent, so the delivery goes to `undeliverable` and is never attempted again.
  //
  // That silently discarded 707 messages across the two estates on 2026-08-05, including
  // identity's email-verification links: a user who registered inside the window never got one,
  // could not verify, and therefore could not sign in. The plan's limit is DAILY, so this is not
  // an edge case — it recurs every time volume crosses it.
  //
  // Matched on the message rather than the code, because the code is the part that lies. A
  // genuine 5.7.8 credential failure carries none of these phrases and still fails fast.
  //
  // ── WHAT CHANGED ON 2026-08-09, AND WHY (micro-org#243) ──────────────────────────────────────
  //
  // This branch used to answer `upstream_error` with a detail of `SMTP 535`. Retryable, which was
  // the #201 fix and is still right — and unreadable, which was the rest of #243. `SMTP 535`
  // is the reply code for "credentials invalid"; it is what an operator sees in `last_error`, and
  // `notify_failed_total{reason="upstream_error"}` is where the count landed, beside timeouts and
  // gateway 5xxs. The estate diagnosed broken SMTP credentials twice from exactly this pair, on a
  // relay that was authenticated and externally deliverable throughout.
  //
  // So the condition now has its own name and carries the provider's own retry-after out with it.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  if (/sending limit|rate limit|too many|quota|try again later|retry in/i.test(message)) {
    const stated = retryAfterMs(message)
    return failure(
      'quota_exhausted',
      true,
      // Says the thing, in words, in the column an operator reads first. The code is kept because
      // it is what a provider's support desk asks for; it is no longer the whole message.
      `the mail provider's allowance is spent, not the credentials — SMTP ${code ?? 'rate-limited'}` +
        `, waiting ${Math.round((stated ?? QUOTA_RETRY_FLOOR_MS) / 60_000)}m`,
      stated ?? QUOTA_RETRY_FLOOR_MS,
    )
  }
  if (typeof code === 'number') {
    if (code >= 500) return failure('rejected', false, `SMTP ${code}`)
    if (code >= 400) return failure('upstream_error', true, `SMTP ${code}`)
  }
  const name = (err as { code?: string } | null)?.code
  if (name === 'ETIMEDOUT' || name === 'ESOCKET' || name === 'ECONNECTION') {
    return failure('timeout', true, `SMTP ${name}`)
  }
  return failure('upstream_error', true, safe)
}

/**
 * How long to wait when the provider refuses on volume and says nothing about when to come back.
 *
 * Fifteen minutes, chosen from the reply the estate's provider actually sends: measured on
 * 2026-08-07 it named `retry in 19m21s`, and the phrasing ("daily sending limit") means the true
 * wait can be hours. The shared exponential backoff tops out at five minutes and reaches
 * `max_attempts` = 6 in well under one, so anything derived from attempt count is guaranteed to
 * spend the whole budget inside a window the provider already told us to sit out.
 *
 * Erring long is the cheap direction. Too long delays a verification mail by minutes; too short
 * dead-letters it, and a dead-lettered verification link is an account that can never sign in.
 */
export const QUOTA_RETRY_FLOOR_MS = 15 * 60_000

/**
 * The wait a provider states inside its refusal, in milliseconds, or null.
 *
 * There is no header to read: SMTP has no `Retry-After`, so the only place the duration exists is
 * the free text of the reply, and the estate's provider writes it as `retry in 19m21s`. Parsed
 * defensively — a provider is free to reword this tomorrow, and the answer to an unrecognised
 * phrasing is `null` and the floor above, never a guess.
 *
 * Clamped to one hour, and the clamp is not paranoia about big numbers.
 *
 * A parked delivery costs one refused connection per wake-up and no attempt budget (see
 * `markDeliveryFailed`), so waking early is nearly free while waiting long is not: every extra
 * minute is a minute a verification link sits in a queue after the allowance has already come
 * back. An hour is therefore "believe the provider, then go and look". It also contains the other
 * direction — a reworded reply where this parser reads some unrelated number as a duration
 * cannot park a delivery for a week.
 */
export function retryAfterMs(message: string): number | null {
  const match = /(?:retry|try again)(?:\s+\w+)*?\s+in\s+(\d+)\s*([hms])(?:\s*(\d+)\s*([ms]))?/i.exec(message)
  if (!match) return null

  const unit = (value: string, suffix: string): number => {
    const n = Number(value)
    if (!Number.isFinite(n)) return 0
    if (suffix.toLowerCase() === 'h') return n * 3_600_000
    if (suffix.toLowerCase() === 'm') return n * 60_000
    return n * 1_000
  }

  const total =
    unit(match[1] ?? '0', match[2] ?? 's') +
    (match[3] !== undefined && match[4] !== undefined ? unit(match[3], match[4]) : 0)

  if (total <= 0) return null
  return Math.min(total, 3_600_000)
}

/**
 * Open a real transport. Called only when SMTP is configured, and never from a test.
 *
 * 465 is implicit TLS and needs `secure: true`; 587 is STARTTLS and needs `secure: false`. The
 * two are not interchangeable, and 465 with `secure` unset hangs until the connect timeout —
 * which the estate's `.env.example` already warns about, having been bitten by it.
 */
async function openSmtp(smtp: SmtpConfig): Promise<Transport> {
  const nodemailer = await import('nodemailer')
  const transport = nodemailer.createTransport({
    host: smtp.host ?? '',
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.user && smtp.pass ? { auth: { user: smtp.user, pass: smtp.pass } } : {}),
  })
  return transport as unknown as Transport
}
