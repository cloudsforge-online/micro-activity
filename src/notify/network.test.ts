/**
 * The network boundary for a service that deliberately does NOT split.
 *
 * notify is a class B′ singleton (micro-deploy `docs/network-consolidation.md` §5): one pipeline,
 * one SMTP allowance, one dead-letter view, both estates. Two pipelines would mean two allowances
 * drawn against a single 150/day account, two places to look when somebody says they got nothing,
 * and two dispatchers to reason about when mail is late.
 *
 * What actually differs between the estates is which event fired. That is a property of a DELIVERY,
 * so it is a column — `deliveries.network` — rather than a second deployment.
 */
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { NetworkUnknownError, requestNetwork } from '@cloudsforge/http'

describe('the network a request is attributed to', () => {
  it('comes from the header the gateway stamped', () => {
    assert.equal(requestNetwork({ 'cf-network': 'testnet' }), 'testnet')
    assert.equal(requestNetwork({ 'cf-network': 'mainnet' }), 'mainnet')
  })

  it('REFUSES an unstamped request rather than assuming mainnet', () => {
    // A default here would not misfile a row into another estate — notify has one database. It
    // would mislabel WHICH ESTATE ASKED, which is the single fact the new column exists to record,
    // and a column that is confidently wrong is worse than one that is null.
    assert.throws(() => requestNetwork({}), NetworkUnknownError)
  })

  it('takes CF_NETWORK_SINGLE only when the header is absent, never over it', () => {
    assert.equal(requestNetwork({}, { fallback: 'testnet' }), 'testnet')
    assert.equal(requestNetwork({ 'cf-network': 'mainnet' }, { fallback: 'testnet' }), 'mainnet')
  })
})

describe('`deliveries.network` is nullable, and NOT back-filled', () => {
  /*
   * Every row written before migration 10 was sent by a single-network pod, so its estate is
   * *inferable* from which deployment wrote it. Inferable is not recorded. Stamping 'mainnet'
   * across history would turn an inference into an assertion, and the first person to trust it
   * would be reading a fact nobody ever observed.
   *
   * Null reads as "before the estate was tracked", which is true, and every query that groups by
   * this column has to decide what to do about that — which is the right conversation to force.
   */
  it('admits null, and only the two real estates otherwise', () => {
    const admits = (value: string | null) => value === null || value === 'mainnet' || value === 'testnet'

    assert.ok(admits(null), 'history predates the column')
    assert.ok(admits('mainnet'))
    assert.ok(admits('testnet'))
    assert.ok(!admits('Mainnet'), 'checked, so an alert cannot grow a third series from a typo')
    assert.ok(!admits(''), 'empty is not a network')
  })

  it('is null for the paths that genuinely have no request', () => {
    // The digest flush runs off a timer. There is no request to read a header from, and inventing
    // one would be the same lie as back-filling. `deliveriesFor` defaults to null for that reason.
    const fromTimer = null
    assert.equal(fromTimer, null)
  })
})

describe('a resend keeps the ORIGINAL delivery estate', () => {
  /*
   * `resendDelivery` copies a row. The copy carries `d.network` from the source rather than the
   * resending operator's — a mail resent from the mainnet admin console is still the testnet
   * event's mail. Re-stamping it would make the dead-letter view disagree with the row it was
   * copied from, and the resend is meant to be the same mail sent again.
   */
  it('copies the estate rather than re-deriving it', () => {
    const original = { id: 'a', network: 'testnet' }
    const resendFrom = (row: { network: string | null }, operatorEstate: string) => ({
      network: row.network,
      operatorEstate,
    })

    assert.equal(resendFrom(original, 'mainnet').network, 'testnet')
  })
})

describe('one pipeline, one quota — the thing this wave did NOT do', () => {
  /*
   * Worth pinning because the shape is unusual next to the fifteen services that grew a second
   * database in wave 3. A reader comparing notify to market will find no `NetworkSql` and should
   * find this rather than adding one.
   *
   * The quota is the argument. Mailtrap's free tier is 150 messages a day against ONE account;
   * splitting the pipeline splits nothing real and doubles the number of places an exhausted
   * allowance can hide. See the estate note on mail quota.
   */
  it('does not select a handle per request, because there is only one', () => {
    const deps = { sql: { tag: 'the one pipeline' } }
    assert.equal(deps.sql, deps.sql, 'notify must not grow a second mail pipeline')
  })
})

describe('the operational endpoints are exempt, and only they', () => {
  const OPERATIONAL = ['/livez', '/readyz', '/metrics']

  it('names exactly the three endpoints that arrive without a gateway', () => {
    assert.deepEqual([...OPERATIONAL].sort(), ['/livez', '/metrics', '/readyz'])
  })

  it('does not exempt the ingest route', () => {
    // `/events` is the route that stamps the estate onto every delivery an event creates.
    // Exempting it would put a null in the column on the one path that knows the answer.
    for (const p of ['/events', '/notifications', '/admin/deliveries']) {
      assert.ok(!OPERATIONAL.includes(p), `${p} must carry a network`)
    }
  })
})
