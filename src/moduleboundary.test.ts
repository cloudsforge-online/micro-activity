/**
 * Each module's credentials are reachable from that module and from nowhere else.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHY THIS FILE EXISTS, AND WHY IT READS SOURCE.**
 *
 * Wave M2 put two services in one process. Before it, the thing keeping
 * `ACTIVITY_INGEST_SECRETS` and `NOTIFY_INGEST_SIGNING_SECRET` from being interchangeable was that
 * they lived in different processes — and the difference between them is not academic:
 *
 *   * activity's key authenticates a write to the canonical record of what happened to a user's
 *     money.
 *   * notify's key authenticates an event that mints a "your key was exported" email to any address
 *     on file — the most convincing phishing message this estate is capable of sending.
 *
 * Neither should be able to do the other's job. `SMTP_PASS` and `NOTIFY_GATEWAY_TOKEN` are in the
 * same position: live credentials that now share a heap with a service that has no business
 * holding them.
 *
 * A process boundary enforced all of that for free. A module boundary does not — one heap, one
 * import graph, and one careless `deps` spread away from an activity handler closing over notify's
 * signing key.
 *
 * **The defect this guards is an OMISSION, and an omission has no behaviour to test.** Nothing
 * observable changes the day somebody adds `ingestSigningSecrets` to activity's `ServerDeps`: every
 * test still passes, every route still answers, and the boundary is simply gone. So this asserts
 * the SHAPE of the source — the same reasoning `notify/topics.test.ts` records for the same class
 * of failure, and the same reasoning that made `ownnetwork.test.ts` a source assertion.
 *
 * **It is written so it cannot pass by finding nothing.** The `the detector is looking at real
 * code` block is what fails when a scanner is pointed at a moved file or a regex stops matching —
 * which is exactly what happened to `notify/catalogue.test.ts`'s producer seam in this very wave,
 * and to `analytics/routeidempotency.test.ts` in the one before it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { createRoutes, type ServerDeps } from './routes.ts'

const SRC = fileURLToPath(new URL('.', import.meta.url))

/** Source with comments blanked. Prose that NAMES a secret must not fail its own guard. */
function code(path: string): string {
  return readFileSync(`${SRC}${path}`, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** Every activity-side source file: `src/*.ts`, tests excluded. `src/notify/**` is NOT one. */
function activitySideFiles(): readonly string[] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()
}

/** Every notify-side source file: `src/notify/*.ts`, tests excluded. */
function notifySideFiles(): readonly string[] {
  return readdirSync(`${SRC}notify`)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()
}

/**
 * Spellings whose presence in ACTIVITY-side code would mean notify's credentials had crossed.
 *
 * Names rather than values, obviously — this file never holds a secret.
 *
 * **IDENTIFIERS, NOT ENGLISH.** A guard listing the bare word `email` would fire on any file that
 * mentioned one, and a guard that fails a service for describing itself is a guard somebody
 * deletes. Every entry below is a spelling that exists only as an identifier in the notify module,
 * and `the words it looks for` pins that each is still real.
 */
const NOTIFY_ONLY = [
  'SmtpConfig',
  'smtpConfigured',
  'ingestSigningSecrets',
  'NOTIFY_INGEST_SIGNING_SECRET',
  'SMTP_PASS',
  'NOTIFY_GATEWAY_TOKEN',
  'postgresNotifyStore',
  'emailAdapter',
]

/**
 * And the same in the other direction: activity's ingest key and its tables must not be nameable
 * from notify.
 *
 * `ingestSecrets` is deliberately NOT on this list even though it is activity's field name, because
 * it is also notify's — both `ServerDeps` spell their own accept-list that way. A term that means
 * two different things in the two modules cannot distinguish them, and a guard built on one is a
 * guard that fires on correct code until somebody deletes it.
 */
const ACTIVITY_ONLY = ['ACTIVITY_INGEST_SECRETS', 'ACTIVITY_DATABASE_URL', 'IngestDeps', 'activity_records']

/** The only file under `src/notify/` an activity-side file may import. */
const THE_SEAM = './notify/module.ts'

describe('notify’s credentials cannot be reached from activity-side code', () => {
  it('no activity-side file imports past the module seam', () => {
    const offenders: string[] = []
    for (const file of activitySideFiles()) {
      for (const match of code(file).matchAll(/from\s+'(\.\/notify\/[^']+)'/g)) {
        if (match[1] !== THE_SEAM) offenders.push(`${file} imports ${match[1]}`)
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `${THE_SEAM} is the only door into the notify module, and it hands back six things none of ` +
        'which names a secret. An import past it is an activity-side file that can now read ' +
        `SMTP_PASS or the notify signing key:\n  ${offenders.join('\n  ')}`,
    )
  })

  it('no activity-side file so much as names one of them in code', () => {
    const offenders: string[] = []
    for (const file of activitySideFiles()) {
      const source = code(file)
      for (const name of NOTIFY_ONLY) {
        if (source.includes(name)) offenders.push(`${file} names ${name}`)
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'an activity-side file names something only the notify module may see. What a handler ' +
        'cannot name it cannot pass to a logger, a metric label or an error body by accident — ' +
        `and that is the entire mechanism:\n  ${offenders.join('\n  ')}`,
    )
  })

  it('and no notify-side file names activity’s ingest key or database', () => {
    // The reverse direction, and it is not symmetry for its own sake. The mount that would have
    // needed both — one `/ingest` accepting either secret — is the thing this wave refused, and
    // this is what stops it being reintroduced one import at a time.
    const offenders: string[] = []
    for (const file of notifySideFiles()) {
      const source = code(`notify/${file}`)
      for (const name of ACTIVITY_ONLY) {
        if (source.includes(name)) offenders.push(`notify/${file} names ${name}`)
      }
    }
    assert.deepEqual(offenders, [], `notify-side code reaching for activity's:\n  ${offenders.join('\n  ')}`)
  })

  it('activity’s ServerDeps declares no field that could carry one', () => {
    // The type is the contract every activity handler closes over. A field here is reachable from
    // every one of them at once, which is why this is the exact line to guard.
    const source = code('routes.ts')
    const at = source.indexOf('export interface ServerDeps')
    assert.notEqual(at, -1, 'ServerDeps must be declared in routes.ts — this guard reads it there')
    const body = source.slice(at, source.indexOf('\n}', at))
    for (const name of NOTIFY_ONLY) {
      assert.ok(!body.includes(name), `ServerDeps declares ${name}; notify's credentials are now in scope for every activity route`)
    }
    assert.ok(!/\bpipeline\b/.test(body), "ServerDeps declares a `pipeline` — notify's PipelineDeps is what reaches SMTP")
    assert.ok(!/\bstore\b/.test(body), "ServerDeps declares a `store` — notify's NotifyStore is what reads its database")
  })

  it('the module seam hands back nothing that names a secret', () => {
    const source = code('notify/module.ts')
    const at = source.indexOf('export interface NotifyModule')
    assert.notEqual(at, -1, 'NotifyModule must be declared in notify/module.ts')
    const body = source.slice(at, source.indexOf('\n}', at))
    const fields = [...body.matchAll(/^\s+(?:readonly\s+)?([A-Za-z][\w]*)[?]?[(:]/gm)].map((m) => m[1])
    assert.deepEqual(
      [...fields].sort(),
      ['beforeScrape', 'probe', 'routes', 'schemaVersion', 'start', 'stop'],
      'the seam returns exactly what the host process needs and nothing else. A field added here is ' +
        'a value the host can then hand anywhere, which is how a scope boundary becomes a convention.',
    )
    for (const field of fields) {
      assert.doesNotMatch(
        field ?? '',
        /smtp|secret|token|credential|pass|key/i,
        `NotifyModule.${field} reads like a credential; the host must never be handed one`,
      )
    }
  })

  it('and what the seam TAKES is four things the host already owns', () => {
    // The other half of the same argument. `HostRuntime` is what activity hands DOWN, and a field
    // there is a value activity has to be holding — so `sql`, `store` or an ingest secret appearing
    // in it would mean the host had built notify's half after all.
    const source = code('notify/module.ts')
    const at = source.indexOf('export interface HostRuntime')
    assert.notEqual(at, -1, 'HostRuntime must be declared in notify/module.ts')
    const body = source.slice(at, source.indexOf('\n}', at))
    const fields = [...body.matchAll(/^\s+(?:readonly\s+)?([A-Za-z][\w]*)[?]?[(:]/gm)].map((m) => m[1])
    assert.deepEqual([...fields].sort(), ['claimingJobs', 'metrics', 'track', 'verifier'])
  })

  it('every activity route handler takes only ctx, so there is no deps parameter to reach through', () => {
    // The seam that makes the rest of this file possible. `handle(ctx, deps)` is what would put the
    // WHOLE process's dependency record in every handler's signature the moment a second module was
    // mounted beside these — see kernel.ts's note on RouteSpec.
    const specs = createRoutes(DEPS)
    assert.ok(specs.length > 5, `expected activity to declare many routes, found ${specs.length}`)
    for (const spec of specs) {
      assert.equal(
        spec.handle.length,
        1,
        `${spec.method} ${spec.path} takes ${spec.handle.length} parameters; a handler takes only ctx`,
      )
    }
  })

  it('activity’s own routes name NO selector, so they take the kernel’s per-network one', () => {
    // The counterpart to `merged.test.ts`'s "every mounted notify route names notify's selector".
    // activity is the host: its routes are meant to resolve from `deps.sql`, which is the one
    // holding a handle per NETWORK. A selector stamped here would pin them to one estate.
    for (const spec of createRoutes(DEPS)) {
      assert.equal(spec.sql, undefined, `${spec.method} ${spec.path} stamps a selector; the host's routes must not`)
    }
  })
})

describe('the two modules consume the IDENTICAL topic set', () => {
  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * **THE FACT THAT MAKES ONE SHARED `/ingest` IMPOSSIBLE RATHER THAN MERELY UNWISE.**
   *
   * The merge plan estimates the two consumed sets at "~84 vs ~86 topics". Measured, they are the
   * same 85 topics, with nothing on either side alone.
   *
   * That is what settles the ingest question. A delivery envelope carries a topic, an id, a key and
   * a payload — it does not carry a DESTINATION. If the two modules consumed different topics, one
   * mount could at least route on the topic. They do not: every event either module accepts is an
   * event the other accepts too, so a single mount holding both secret sets has NO information in
   * the request that could tell the two sinks apart. It would have to fan everything to both — which
   * would start notifying people about topics only the feed subscribes to, and writing feed rows for
   * topics only the mailer cares about — or guess.
   *
   * Asserted rather than remembered, because the day the sets diverge is the day somebody could
   * reasonably reopen the question, and they should find this test rather than the prose.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  it('is 85 topics on both sides, and nothing on either side alone', async () => {
    const { CLASSIFIERS } = await import('./classify.ts')
    const { MAPPED_TOPICS, NON_NOTIFYING_TOPICS } = await import('./notify/catalogue.ts')

    const activityTopics = new Set(Object.keys(CLASSIFIERS))
    const notifyTopics = new Set([...MAPPED_TOPICS, ...Object.keys(NON_NOTIFYING_TOPICS)])

    // The vacuous guard first: two empty sets are also equal.
    assert.ok(activityTopics.size > 50, `activity classifies only ${activityTopics.size} topics`)
    assert.ok(notifyTopics.size > 50, `notify accepts only ${notifyTopics.size} topics`)

    assert.deepEqual(
      [...notifyTopics].filter((topic) => !activityTopics.has(topic)),
      [],
      'a topic notify accepts and activity does not — the sets have diverged, and a mount that ' +
        'routed on the topic would now be conceivable',
    )
    assert.deepEqual(
      [...activityTopics].filter((topic) => !notifyTopics.has(topic)),
      [],
      'a topic activity classifies and notify does not',
    )
    assert.equal(activityTopics.size, notifyTopics.size)
  })
})

describe('the two ingest secrets are read in one place each', () => {
  /*
   * The concrete form of the whole boundary, and the reason `POST /ingest` had to split.
   *
   * One mount accepting either secret would have made each key a credential for both sinks. What
   * makes that impossible in code rather than by agreement is that each variable is read by exactly
   * one file, and neither file is in the other module's import graph.
   */
  it('ACTIVITY_INGEST_SECRETS is named only by activity’s env', () => {
    const holders = allSources().filter(([, source]) => source.includes('ACTIVITY_INGEST_SECRETS'))
    assert.deepEqual(
      holders.map(([name]) => name),
      ['env.ts'],
      'the key that writes the canonical money record must be readable from one file',
    )
  })

  it('NOTIFY_INGEST_SIGNING_SECRET is named only by notify’s env', () => {
    const holders = allSources().filter(([, source]) => source.includes('NOTIFY_INGEST_SIGNING_SECRET'))
    assert.deepEqual(
      holders.map(([name]) => name),
      ['notify/env.ts'],
      'the key that mints a security email must be readable from one file',
    )
  })
})

describe('the detector is looking at real code', () => {
  /*
   * The vacuous-green guards. Every assertion above is of the form "this set is empty", and an
   * empty set is also what a scanner that has stopped finding files reports.
   */
  it('sees the activity-side files', () => {
    const files = activitySideFiles()
    assert.ok(files.length >= 8, `expected many activity-side sources, found ${files.length}`)
    for (const expected of ['index.ts', 'routes.ts', 'server.ts', 'kernel.ts', 'migrator.ts', 'env.ts']) {
      assert.ok(files.includes(expected), `${expected} is not in the scanned set — the scan has lost the source`)
    }
  })

  it('sees the notify-side files, and the two entry-point scripts are gone', () => {
    const files = notifySideFiles()
    // 20 modules: notify's 21, minus `index.ts` and `migrator.ts` — the two entry-point scripts a
    // module in somebody else's process does not have — plus `module.ts`, the seam that replaced
    // them. Asserted as a floor and a list rather than as the number, so adding a file is not a
    // failure and losing the seam is.
    assert.ok(files.length >= 18, `expected the notify module's sources, found ${files.length}`)
    for (const expected of ['module.ts', 'env.ts', 'server.ts', 'pipeline.ts', 'email.ts', 'reserved.ts']) {
      assert.ok(files.includes(expected), `notify/${expected} is not in the scanned set`)
    }
    for (const gone of ['index.ts', 'migrator.ts']) {
      assert.ok(
        !files.includes(gone),
        `notify/${gone} is a second entry point in a merged process — its work belongs to ` +
          'src/index.ts and src/migrator.ts, which is what the seam exists to make possible',
      )
    }
  })

  it('sees the merged composition root, and it is the merged one', () => {
    const source = code('index.ts')
    assert.match(source, /createMergedServer\(/, 'index.ts must mount both route tables')
    assert.match(source, /createNotifyModule\(/, 'index.ts must build the notify module')
  })

  it('finds real credentials on the other side of the boundary', () => {
    // Without this, every assertion above would still pass on the day somebody deleted the mailer
    // entirely — a boundary around nothing.
    const module = code('notify/module.ts')
    assert.match(module, /emailAdapter\(/, 'the seam is where the mail adapter is constructed')
    assert.match(module, /from '\.\/env\.ts'/, "the seam is where notify's env is imported")
    assert.match(code('notify/env.ts'), /SMTP_PASS/, 'notify must still read a mail password')
  })

  it('the words it looks for are the words those credentials are spelled with', () => {
    // A guard whose vocabulary drifts away from the thing it guards is a guard that passes. Every
    // term must still be a real identifier ON THE NOTIFY SIDE — a spelling nothing uses any more
    // forbids nothing, and silently shrinks this file to a list of dead strings.
    const notifySide = notifySideFiles()
      .map((name) => code(`notify/${name}`))
      .join('\n')
    for (const term of NOTIFY_ONLY) {
      assert.ok(
        notifySide.includes(term),
        `'${term}' appears nowhere in the notify module any more — this guard forbids a spelling ` +
          'that no longer exists, which is a guard that cannot fire. Update it to what it is called now.',
      )
    }
    const activitySide = activitySideFiles()
      .map((name) => code(name))
      .join('\n')
    for (const term of ACTIVITY_ONLY) {
      assert.ok(activitySide.includes(term), `'${term}' is no longer an activity-side spelling`)
    }
  })
})

/* ------------------------------------------------------------------ fixtures */

/** Every source file in the process, activity-side and notify-side, keyed by its path from `src/`. */
function allSources(): ReadonlyArray<readonly [string, string]> {
  return [
    ...activitySideFiles().map((name) => [name, code(name)] as const),
    ...notifySideFiles().map((name) => [`notify/${name}`, code(`notify/${name}`)] as const),
  ]
}

/**
 * An activity `ServerDeps` good enough to build the route table. Nothing here is called:
 * `createRoutes` only closes over it, which is precisely the property under test.
 */
const DEPS = {
  lifecycle: {},
  logger: {},
  metrics: {},
  verifier: {},
  sql: {},
  ingest: {},
} as unknown as ServerDeps
