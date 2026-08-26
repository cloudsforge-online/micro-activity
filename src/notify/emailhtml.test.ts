/**
 * The HTML part, and specifically the two guards that let it exist.
 *
 * `email.ts` refused an HTML body for years because "every parameter here is domain data from an
 * event this service did not write". These tests are the evidence that the refusal is satisfied
 * rather than forgotten: the escaping cases below are not decoration, they are the reason the
 * feature is allowed to ship. Deleting one re-opens the hole the comment described.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CATEGORIES } from './model.ts'
import { escapeHtml, renderEmailHtml, safeHref } from './emailhtml.ts'

const base = {
  subject: 'Confirm your email address',
  body: 'Hello @someone — one step is left.\n\nThe link works once and then expires.',
  link: 'https://hub.cloudsforge.online/account/verify#token=abc',
  category: 'account',
} as const

/* ---------------------------- the injection guard ---------------------------- */

test('a template parameter carrying markup is displayed, never executed', () => {
  // The shape a hostile handle would take. It reaches this renderer already interpolated into the
  // body, exactly as `pipeline.ts` produces it — which is the whole reason HTML was refused.
  const hostile = '<script>alert(1)</script>'
  const html = renderEmailHtml({ ...base, body: `Hello @${hostile} — welcome.` })

  assert.ok(!html.includes('<script>'), 'a script tag must never survive into the output')
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
})

test('a parameter cannot break out of an attribute', () => {
  // `">` closes an href and opens whatever follows. Both quote styles are escaped because
  // interpolation happens inside single-quoted style attributes and double-quoted href alike.
  const html = renderEmailHtml({ ...base, subject: `x" onmouseover="alert(1)` })
  assert.ok(!html.includes('onmouseover="alert'), 'the attribute must not close early')
  assert.ok(html.includes('&quot;'))
})

test('escapeHtml covers every character that can open a tag or end an attribute', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;')
  // `&` first, or the entities the others introduce get double-escaped into visible mojibake.
  assert.equal(escapeHtml('&lt;'), '&amp;lt;')
})

/* ------------------------------- the link guard ------------------------------ */

test('a javascript: link is refused and no button is rendered', () => {
  assert.equal(safeHref('javascript:alert(1)'), null)
  const html = renderEmailHtml({ ...base, link: 'javascript:alert(1)' })
  assert.ok(!html.includes('alert(1)'), 'the refused URL must not appear anywhere')
  assert.ok(!html.includes('Open CloudsForge'), 'no button without a usable link')
})

test('the schemes that defeat a startsWith check are also refused', () => {
  // Each of these is parsed by at least one mail client and defeats a prefix test.
  for (const link of ['data:text/html,<script>1</script>', ' javascript:alert(1)', 'JavaScript:alert(1)', 'file:///etc/passwd']) {
    assert.equal(safeHref(link), null, `${link} must be refused`)
  }
})

test('an empty link renders no button rather than an inert one', () => {
  // `OutboundMessage.link` is '' for a notification with no action; that is ordinary, not an error.
  const html = renderEmailHtml({ ...base, link: '' })
  assert.equal(safeHref(''), null)
  assert.ok(!html.includes('Open CloudsForge'))
  assert.ok(html.includes('Confirm your email address'), 'the message itself still renders')
})

test('an ordinary https link survives intact, fragment and all', () => {
  const html = renderEmailHtml(base)
  assert.ok(html.includes(`href="${base.link}"`))
  // Printed in full as well as linked. This is the anti-phishing element and the fallback for a
  // client that drops the button; losing it silently would leave some recipients unable to act.
  assert.ok(html.split(base.link).length - 1 >= 2, 'the URL appears as href AND as readable text')
})

/* ------------------------------- the rendering ------------------------------- */

test('every category in the estate produces its own stripe', () => {
  // The stripe used to be a hand-written map of six. `CATEGORIES` has eighteen and grows, so this
  // asserts the derivation holds for all of them rather than for the ones somebody remembered.
  for (const category of CATEGORIES) {
    const html = renderEmailHtml({ ...base, category })
    const expected = category.charAt(0).toUpperCase() + category.slice(1)
    assert.ok(html.includes(`>${expected}</td>`), `${category} must render as ${expected}`)
  }
})

test('the category list stays single lower-case words, which stripeFor assumes', () => {
  // stripeFor upper-cases the first letter and nothing else. A category named `key_export` would
  // render as `Key_export` at a user — caught here rather than in somebody's inbox.
  for (const category of CATEGORIES) {
    assert.match(category, /^[a-z]+$/, `${category} is not a single lower-case word`)
  }
})

test('paragraphs are split on blank lines and single newlines become breaks', () => {
  const html = renderEmailHtml({ ...base, body: 'One.\n\nTwo.\nStill two.' })
  // Counted by the BODY's own type size. A bare `<p style=` count also picks up the two chrome
  // paragraphs — the paste-this-address hint and the footer — and reports 4 for a two-paragraph
  // body, which is how this assertion failed the first time it ran.
  assert.equal(html.split('font-size:15px;line-height:1.65').length - 1, 2, 'two body paragraphs')
  assert.ok(html.includes('Two.<br>Still two.'))
})

test('the preheader carries the first line, not the wordmark', () => {
  // Without one, clients scrape the top of the body and every CloudsForge mail previews
  // identically as "CloudsForge Account".
  const html = renderEmailHtml(base)
  const preheader = html.slice(html.indexOf('display:none'), html.indexOf('</div>'))
  assert.ok(preheader.includes('Hello @someone'))
  assert.ok(!preheader.includes('CloudsForge</td>'))
})

test('nothing is loaded from the network', () => {
  // No tracking pixel, no remote image, no webfont request. A privacy property as much as an
  // aesthetic one, and it is only true for as long as nobody adds a logo.
  const html = renderEmailHtml(base)
  assert.ok(!/<img/i.test(html), 'no image, so no open-tracking pixel')
  assert.ok(!/https?:\/\/(?!hub\.cloudsforge\.online)/.test(html.replace(base.link, '')), 'no remote asset')
  assert.ok(!/@import|url\(/i.test(html), 'no webfont or remote stylesheet')
})

test('the brand tokens are the ones the web surfaces use', () => {
  // These literals exist only because mail clients do not implement custom properties. If
  // `tokens.css` moves, this test is the thing that says so — a mail rendered in a stale palette
  // looks like a forgery, which is the exact opposite of what the design is for.
  const html = renderEmailHtml(base)
  for (const token of ['#f4f0e8', '#fbf8f2', '#1a1613', '#913a18', '#fdfbf7']) {
    assert.ok(html.includes(token), `${token} must appear; it is a token from ui/packages/ui`)
  }
})

test('the layout is table-based, because Outlook ignores the alternative', () => {
  const html = renderEmailHtml(base)
  assert.ok(html.includes('role="presentation"'), 'layout tables must be hidden from assistive tech')
  assert.ok(!html.includes('display:flex') && !html.includes('display:grid'))
  assert.match(html, /^<!doctype html>/)
})
