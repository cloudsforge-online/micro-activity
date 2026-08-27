/**
 * Templates: substitution, the missing-parameter behaviour, and the link.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  REDACTED,
  TEMPLATES,
  TEMPLATE_IDS,
  describeNotification,
  redactSecretParams,
  renderTemplate,
  templateFor,
} from './templates.ts'
import { DEFAULT_LOCALE, LOCALES, resolveLocale } from './model.ts'

const BASE = 'https://app.cloudsforge.test'

test('every template has text for every declared locale', () => {
  for (const id of TEMPLATE_IDS) {
    const template = templateFor(id)
    for (const locale of LOCALES) {
      const text = template.text[locale]
      assert.ok(text, `${id} has no ${locale} text`)
      assert.ok(text.subject.length > 0, `${id} has an empty subject`)
      assert.ok(text.body.length > 0, `${id} has an empty body`)
    }
  }
})

test('every placeholder in a template is a declared parameter', () => {
  // Otherwise a template can reference something no rule supplies, and the catalogue test that
  // checks rules against `params` would pass while the notification still rendered a blank.
  const placeholder = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g
  for (const id of TEMPLATE_IDS) {
    const template = templateFor(id)
    const text = `${template.text[DEFAULT_LOCALE].subject} ${template.text[DEFAULT_LOCALE].body} ${template.path}`
    for (const match of text.matchAll(placeholder)) {
      const name = match[1] ?? ''
      assert.ok(template.params.includes(name), `${id} uses {{${name}}} but does not declare it`)
    }
  }
})

test('a rendered notification substitutes its parameters and builds an absolute link', () => {
  const rendered = renderTemplate(
    TEMPLATES['security.key_exported'],
    { walletLabel: 'Main wallet', at: '2026-07-30 04:12 UTC' },
    'en-GB',
    BASE,
  )
  assert.match(rendered.body, /Main wallet/)
  assert.match(rendered.body, /2026-07-30 04:12 UTC/)
  assert.equal(rendered.link, `${BASE}/settings/security/exports`)
  assert.deepEqual(rendered.missing, [])
})

test('a missing parameter blanks the placeholder and is reported, rather than throwing', () => {
  // A notification with a gap in it is recoverable. A critical notification that threw on the way
  // out of the door is a breach of 04-domain-model §10.3.
  const rendered = renderTemplate(TEMPLATES['security.key_exported'], {}, 'en-GB', BASE)
  assert.deepEqual([...rendered.missing].sort(), ['at', 'walletLabel'])
  assert.doesNotMatch(rendered.body, /\{\{/)
})

test('substitution is single pass, so a parameter value cannot inject another placeholder', () => {
  const rendered = renderTemplate(
    TEMPLATES['security.key_exported'],
    { walletLabel: '{{at}}', at: 'SECRET' },
    'en-GB',
    BASE,
  )
  // The literal `{{at}}` from the value survives; it is not resolved to `SECRET`.
  assert.match(rendered.body, /\{\{at\}\}/)
  assert.equal(rendered.body.includes('SECRET'), true, 'the real {{at}} still resolved')
  assert.equal(rendered.body.match(/SECRET/g)?.length, 1, 'and only once')
})

test('a base URL with a trailing slash joins correctly', () => {
  const withSlash = renderTemplate(TEMPLATES['digest.summary'], {}, 'en-GB', `${BASE}/`)
  const without = renderTemplate(TEMPLATES['digest.summary'], {}, 'en-GB', BASE)
  assert.equal(withSlash.link, without.link)
  assert.equal(without.link, `${BASE}/notifications`)
})

test('an unknown locale falls back rather than failing', () => {
  assert.equal(resolveLocale('de-DE'), DEFAULT_LOCALE)
  assert.equal(resolveLocale(null), DEFAULT_LOCALE)
  assert.equal(resolveLocale('en-GB'), 'en-GB')
})

/**
 * A template that carries a credential has to say so in both directions at once.
 *
 * `secretParams` keeps the value out of every HTTP response; `deliverOn` keeps it off channels
 * where it does not belong. Declaring one without the other is the dangerous half-measure: a
 * verification link redacted out of `GET /notifications` and still HMAC-signed and POSTed to a
 * developer's webhook endpoint has been protected from the account's owner and handed to a third
 * party. So the pairing is a property rather than a convention somebody remembers.
 */
test('a template that declares a secret parameter also declares where it may be delivered', () => {
  for (const id of TEMPLATE_IDS) {
    const template = templateFor(id)
    if (!template.secretParams || template.secretParams.length === 0) continue

    for (const name of template.secretParams) {
      assert.ok(template.params.includes(name), `${id} redacts {{${name}}}, which it does not declare`)
    }
    const channels = template.deliverOn ?? []
    assert.ok(channels.length > 0, `${id} carries a credential and may be delivered anywhere`)
    assert.equal(
      channels.includes('webhook'),
      false,
      `${id} would sign a single-use credential and POST it to a third party's endpoint`,
    )
  }
})

test('a secret parameter is redacted visibly, and nothing beside it is touched', () => {
  // Replaced rather than deleted: an absent key reads as "the producer never sent it", which is a
  // different fact and one somebody would go and investigate.
  const redacted = redactSecretParams('account.verify_email', {
    handle: 'alice',
    verifyUrl: 'https://app.cloudsforge.test/verify/this-is-not-a-real-token',
  })
  assert.equal(redacted['verifyUrl'], REDACTED)
  assert.equal(redacted['handle'], 'alice')
  assert.equal(JSON.stringify(redacted).includes('this-is-not-a-real-token'), false)

  // A template with nothing to hide is returned untouched, and an id no build knows redacts
  // nothing — the same degradation `messageFor` makes for a template a deploy has removed.
  const plain = { walletLabel: 'Main wallet' }
  assert.deepEqual(redactSecretParams('security.key_exported', plain), plain)
  assert.deepEqual(redactSecretParams('a.template.that.was.deleted', plain), plain)
})

/* ------------------------------------------------------------------ describeNotification */

test('a described notification carries the template subject and a relative path', () => {
  // The words come from here rather than from a copy in a bundle: hub-api composes a
  // `notifications` tile from this response and the SPA renders `title` without knowing what a
  // template is (micro-org #415).
  const described = describeNotification(
    'security.key_exported',
    { walletLabel: 'Main wallet', at: '2026-07-30 04:12 UTC' },
    'en-GB',
  )
  assert.equal(described.title, 'A private key left the platform')
  // Relative, and it stays relative: the reader's origin is the reader's business, which is the
  // same rule hub-api applies to its own deep links.
  assert.equal(described.href, '/settings/security/exports')
})

test('a notification whose path IS a credential is described with no link at all', () => {
  // `account.verify_email` declares `path: '{{verifyUrl}}'` and `verifyUrl` as a secret parameter,
  // so by the time a row reaches a reader `store.ts` has already replaced that value. Substituting
  // it anyway would emit `/[redacted]` — a dead link on the most important notification the
  // platform sends, presented as a working one.
  const described = describeNotification(
    'account.verify_email',
    { handle: 'alice', verifyUrl: REDACTED },
    'en-GB',
  )
  assert.equal(described.title, 'Confirm your email address')
  assert.equal(described.href, null)
  assert.equal(JSON.stringify(described).includes(REDACTED), false)
})

test('a template a deploy has removed degrades to its id rather than throwing', () => {
  // The same degradation `messageFor` makes for a pending delivery: a template can be removed
  // while rows referencing it remain, and the correct answer is a slightly ugly notification.
  const described = describeNotification('a.template.that.was.deleted', {}, 'en-GB')
  assert.equal(described.title, 'a.template.that.was.deleted')
  assert.equal(described.href, null)
})

test('a described notification with missing parameters blanks them and still has a title', () => {
  const described = describeNotification('account.registered', {}, 'en-GB')
  assert.equal(described.title, 'Welcome to CloudsForge')
  assert.doesNotMatch(described.title, /\{\{/)
  assert.equal(described.href, '/')
})

test('the security templates say what to do, not just what happened', () => {
  // Wording is a design decision here, not decoration: a notification that reports a fact the
  // user cannot act on has told them nothing useful at the moment they most need help.
  // `security.session_revoked` replaced `security.password_changed`, whose rule named a topic no
  // producer emits: identity revokes the sessions and says why rather than announcing the change.
  for (const id of ['security.new_device', 'security.session_revoked', 'security.key_exported'] as const) {
    const body = TEMPLATES[id].text['en-GB'].body
    assert.match(body, /If (this|that) was not you/, `${id} does not tell the user what to do`)
  }
})
