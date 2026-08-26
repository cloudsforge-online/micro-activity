/**
 * The HTML half of an email, rendered from the same text the plain part carries.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS AT ALL, GIVEN THAT `email.ts` REFUSED IT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `email.ts` sent `text` and nothing else, and said why:
 *
 *   > Plain text only. An HTML body is an injection surface for every template parameter, and
 *   > every parameter here is domain data from an event this service did not write.
 *
 * That reasoning was correct and is not overturned here — it is satisfied. The refusal assumed
 * HTML would be built by interpolating parameters into markup. This module never does that. It
 * receives the SAME already-rendered plain-text body the text part carries, escapes it whole, and
 * wraps structure around it. A parameter carrying `<script>` or `"><a href=` reaches this file as
 * text, leaves it as `&lt;script&gt;`, and is displayed rather than executed. There is no path by
 * which a template parameter becomes markup, because no parameter is ever read here at all.
 *
 * The two guards that make that true, and which must not be softened:
 *
 *   - `escapeHtml` runs on EVERY interpolated value without exception, including ones that "cannot"
 *     contain markup. A handle is user-chosen, a wallet label is user-chosen, and the subject line
 *     is built from both.
 *   - `safeHref` refuses any URL that is not http(s). A `javascript:` link in an email is mostly
 *     inert in modern clients, but "mostly" is not a security property, and the cost of the check
 *     is one comparison.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THE DESIGN IS FOR
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * This estate emails people about private-key exports, password resets and wallet links. The
 * threat this mail actually faces is not being ignored — it is being IMITATED. So the layout is
 * built around provenance rather than decoration, and two elements carry it:
 *
 *   1. The category stripe, from `message.category` — the notification's own classification, not a
 *      label invented for the design. A recipient who has seen one `SECURITY` mail knows what the
 *      next one looks like, and a forgery that omits it looks wrong.
 *   2. The link, printed IN FULL in a monospaced well beneath the button. This is the element a
 *      prettier template would delete, and it is the one that lets somebody read the domain before
 *      they trust it. It is also the accessible fallback when a button does not render.
 *
 * Everything else is deliberately quiet: one column, no images, no icons, no gradient. There are
 * no remote assets of any kind, which is a privacy property as much as an aesthetic one — nothing
 * here reports back when the mail is opened, and there is no tracking pixel to strip.
 *
 * Colours and type stacks are lifted verbatim from `ui/packages/ui/src/tokens.css`, the same file
 * the web surfaces derive from, so this cannot drift into a second palette. The light ground is
 * used unconditionally: `prefers-color-scheme` support across mail clients is inconsistent enough
 * that a dark variant would be a second design nobody could test, and the light tokens already
 * carry measured contrast ratios (ember is 5.49:1 on the tightest light ground, its ink 7.20:1 on
 * the fill).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * EMAIL HTML IS NOT WEB HTML
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Tables for layout, inline styles on every element, and no custom properties. Not stylistic
 * preference: Outlook's word-processor renderer ignores `div` positioning, Gmail strips `<style>`
 * blocks in several contexts, and `var()` is unsupported widely enough to be unusable. The token
 * VALUES are therefore inlined below as literals, with the token name in a comment beside each so
 * the correspondence stays greppable when `tokens.css` changes.
 */

import type { Category } from './model.ts'

/**
 * Palette, copied from `ui/packages/ui/src/tokens.css`.
 *
 * Literals rather than `var()` because mail clients do not implement custom properties. The token
 * each one came from is named so that `grep -r cf-ember-light` still finds this file.
 */
const C = {
  paper: '#f4f0e8', //  --cf-bg
  card: '#fbf8f2', //   --cf-bg-raised
  well: '#e8e2d6', //   --cf-bg-sunken
  ink: '#1a1613', //    --cf-fg
  inkDim: '#4a4239', // --cf-fg-dim
  inkMute: '#6b6155', //--cf-fg-mute
  ember: '#913a18', //  --cf-ember-light   5.49:1 on the tightest light ground
  emberInk: '#fdfbf7', //--cf-ember-ink-light 7.20:1 on the fill above
  line: '#dcd5c7', //   --cf-line, resolved: color-mix() is not available here
} as const

/** Type stacks from the same file. No webfont is loaded — see the header. */
const F = {
  display: "'Bricolage Grotesque','Archivo',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
  sans: "'Archivo',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  mono: "'Spline Sans Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
} as const

/**
 * Every character that can end an attribute or open a tag.
 *
 * `'` and `"` are both escaped because interpolation happens inside single-quoted style attributes
 * in some places and double-quoted `href` in others, and a rule that depends on remembering which
 * is a rule that will be got wrong. `&` goes first or it would double-escape the others.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The link, if it is one this file is willing to put behind a button.
 *
 * Returns `null` for anything that is not http(s) — including the empty string, which is what
 * `OutboundMessage.link` carries for a notification that has no action. The caller renders no
 * button at all in that case rather than an inert one.
 *
 * `new URL` rather than a prefix test: `java\tscript:` and ` javascript:` both defeat `startsWith`
 * and both are parsed by clients.
 */
export function safeHref(link: string): string | null {
  if (link === '') return null
  let parsed: URL
  try {
    parsed = new URL(link)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.toString()
}

/**
 * The plain-text body as paragraphs.
 *
 * Templates separate paragraphs with a blank line and wrap with a single newline, which is exactly
 * how `TEMPLATES` in `templates.ts` is written. Escaping happens BEFORE any tag is introduced, so
 * the `<br>` this adds is the only markup that can exist in the result.
 */
function paragraphs(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => {
      const html = escapeHtml(block).replace(/\n/g, '<br>')
      return `<p style="margin:0 0 16px;font-family:${F.sans};font-size:15px;line-height:1.65;color:${C.inkDim}">${html}</p>`
    })
    .join('')
}

/**
 * The line a client shows beside the subject in the inbox list.
 *
 * Without one, clients scrape the top of the body, which here is the wordmark and the category —
 * so every CloudsForge mail would preview identically as "CloudsForge SECURITY". Taken from the
 * body's first sentence instead, which is the one line that differs per template.
 *
 * The trailing entities pad the preview so the client cannot pull following markup into it. This
 * is the standard technique and it is ugly on purpose.
 */
function preheader(body: string): string {
  const first = body.split(/\n/)[0]?.trim() ?? ''
  const text = first.length > 140 ? `${first.slice(0, 139)}…` : first
  return (
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0">` +
    `${escapeHtml(text)}${'&#8203;&nbsp;'.repeat(30)}</div>`
  )
}

/**
 * What the stripe says.
 *
 * Derived from the category rather than looked up in a table here. `CATEGORIES` in `model.ts` has
 * eighteen members and grows; a hand-written map would have covered the six that were obvious,
 * silently printed a fallback for `deposit`, `withdrawal`, `governance` and nine others, and gone
 * on doing so every time a category was added — a drift nothing would report, because a stripe
 * that reads the wrong word still renders.
 *
 * Every member is a single lower-case word, which is a property of that list and is asserted in
 * `emailhtml.test.ts` so this stays true rather than being assumed.
 *
 * The stripe is upper-cased by CSS (`text-transform`), not here, so a client that drops the style
 * shows `Deposit` rather than `DEPOSIT` — the graceful end of that failure.
 */
function stripeFor(category: Category): string {
  return category.charAt(0).toUpperCase() + category.slice(1)
}

export interface EmailHtmlInput {
  readonly subject: string
  readonly body: string
  readonly link: string
  readonly category: Category
}

/**
 * Render the HTML part.
 *
 * Pure, synchronous and dependency-free, so it is testable as a string function and cannot fail a
 * send. `email.ts` calls it inside the same try as `sendMail`, but there is nothing here to throw.
 */
export function renderEmailHtml(input: EmailHtmlInput): string {
  const href = safeHref(input.link)
  const subject = escapeHtml(input.subject)
  const stripe = escapeHtml(stripeFor(input.category))

  // The button and the printed URL are one unit: a mail with an action shows both, a mail without
  // an action shows neither. Splitting them would let a client that drops the button leave the
  // recipient with no way to act at all.
  const action =
    href === null
      ? ''
      : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px">
<tr><td style="border-radius:6px;background:${C.ember}">
<a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 26px;font-family:${F.sans};font-size:15px;font-weight:600;color:${C.emberInk};text-decoration:none;border-radius:6px">Open CloudsForge</a>
</td></tr></table>
<p style="margin:0 0 8px;font-family:${F.sans};font-size:12px;line-height:1.5;color:${C.inkMute}">Or paste this address into your browser. Check it reads <strong style="color:${C.inkDim}">cloudsforge.online</strong> before you trust it:</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 4px">
<tr><td style="padding:12px 14px;background:${C.well};border-radius:6px;font-family:${F.mono};font-size:12px;line-height:1.6;color:${C.inkDim};word-break:break-all">${escapeHtml(href)}</td></tr>
</table>`

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:${C.paper};-webkit-text-size-adjust:100%">
${preheader(input.body)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.paper}">
<tr><td align="center" style="padding:32px 16px">

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;background:${C.card};border:1px solid ${C.line};border-radius:10px">

<!-- The ember rule. Three pixels, and the only unmixed use of the accent in the whole message. -->
<tr><td style="height:3px;line-height:3px;font-size:0;background:${C.ember};border-radius:9px 9px 0 0">&nbsp;</td></tr>

<tr><td style="padding:26px 32px 0">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr>
    <td align="left" style="font-family:${F.display};font-size:16px;font-weight:700;letter-spacing:-0.01em;color:${C.ink}">CloudsForge</td>
    <td align="right" style="font-family:${F.mono};font-size:10px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:${C.ember}">${stripe}</td>
  </tr>
  </table>
</td></tr>

<tr><td style="padding:22px 32px 0">
  <h1 style="margin:0 0 18px;font-family:${F.display};font-size:23px;line-height:1.25;font-weight:700;letter-spacing:-0.02em;color:${C.ink}">${subject}</h1>
  ${paragraphs(input.body)}
  ${action}
</td></tr>

<tr><td style="padding:8px 32px 26px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr><td style="height:1px;line-height:1px;font-size:0;background:${C.line}">&nbsp;</td></tr>
  </table>
  <p style="margin:16px 0 0;font-family:${F.sans};font-size:12px;line-height:1.6;color:${C.inkMute}">
    Sent by CloudsForge because of activity on your account. Nobody at CloudsForge will ever ask you to forward a link from this email.
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body></html>`
}
