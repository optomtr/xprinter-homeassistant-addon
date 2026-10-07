import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeRelease, prepareRelease, requireErpGate, run, validateOptions } from '../bootstrap.mjs'

const options = { plan_editor_secret: 'test-secret-not-for-production-123456',
  github_token: 'github_pat_test', source_branch: 'main', update_on_start: true }
const oldRevision = 'a'.repeat(40)
const newRevision = 'b'.repeat(40)

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'plan-addon-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function seed(directory, revision = oldRevision) {
  const runtime = join(directory, 'editor-runtime')
  const release = join(runtime, 'releases', revision)
  await mkdir(join(release, 'dist'), { recursive: true })
  await mkdir(join(release, 'server'), { recursive: true })
  await writeFile(join(release, 'dist/index.html'), 'old editor')
  await writeFile(join(release, 'server/index.mjs'), 'old server')
  await writeFile(join(runtime, 'active.json'), JSON.stringify({ revision, branch: 'main' }))
  return release
}

function builder({ revision = newRevision, failure, incomplete = false } = {}) {
  const calls = []
  const execute = async (command, args, settings = {}) => {
    calls.push({ command, args, settings })
    if (failure && args.includes(failure)) throw new Error('simulated failure')
    if (args.includes('rev-parse')) return revision
    if (args.includes('build')) {
      await mkdir(join(settings.cwd, 'dist'), { recursive: true })
      await mkdir(join(settings.cwd, 'server'), { recursive: true })
      await writeFile(join(settings.cwd, 'dist/index.html'), 'new editor')
      if (!incomplete) await writeFile(join(settings.cwd, 'server/index.mjs'), 'new server')
    }
    return ''
  }
  return { calls, execute }
}

test('validates secrets, token, branch and boolean without revealing credentials', () => {
  assert.equal(validateOptions(options), options)
  for (const bad of [null, {}, { ...options, plan_editor_secret: 'short' },
    { ...options, plan_editor_secret: `${options.plan_editor_secret}\n` },
    { ...options, github_token: 'token\nsecret' }, { ...options, source_branch: '--config' },
    { ...options, source_branch: '../../data' }, { ...options, update_on_start: 'true' }]) {
    assert.throws(() => validateOptions(bad), (error) => !error.message.includes(options.plan_editor_secret))
  }
  validateOptions({ ...options, github_token: '', source_branch: 'release/v1.0.0' })
})

test('first install tests/builds source, only Git receives token, promotes complete release', async (t) => {
  const directory = await temporary(t)
  const fake = builder()
  const result = await prepareRelease(directory, options, fake)
  assert.equal(result.revision, newRevision)
  assert.equal((await activeRelease(directory)).revision, newRevision)
  assert.equal(await readFile(join(result.directory, 'dist/index.html'), 'utf8'), 'new editor')
  assert.deepEqual(fake.calls.map((call) => call.args[0]), ['clone', 'rev-parse', 'ci', 'run', 'run'])
  const clone = fake.calls[0]
  assert.ok(clone.args.includes('https://github.com/optomtr/bms-planspec.git'))
  assert.ok(!clone.args.join(' ').includes(options.github_token))
  assert.equal(clone.settings.env.EDITOR_GITHUB_TOKEN, options.github_token)
  for (const call of fake.calls.slice(1)) {
    assert.equal(call.settings.env?.EDITOR_GITHUB_TOKEN, undefined)
    assert.equal(call.settings.env?.PLAN_EDITOR_SECRET, undefined)
  }
  assert.equal((await readdir(join(directory, 'editor-runtime'))).some((name) => name.startsWith('staging-')), false)
})

test('unchanged revision skips expensive install/build', async (t) => {
  const directory = await temporary(t)
  await seed(directory)
  const fake = builder({ revision: oldRevision })
  assert.equal((await prepareRelease(directory, options, fake)).revision, oldRevision)
  assert.equal(fake.calls.length, 2)
})

test('updates disabled uses cached release without GitHub credentials or network', async (t) => {
  const directory = await temporary(t)
  await seed(directory)
  const fake = builder()
  const result = await prepareRelease(directory, { ...options, github_token: '', update_on_start: false }, fake)
  assert.equal(result.revision, oldRevision)
  assert.equal(fake.calls.length, 0)
})

for (const failure of ['clone', 'ci', 'test:server', 'build']) {
  test(`failed ${failure} preserves active editor, drawings and report files`, async (t) => {
    const directory = await temporary(t)
    const original = await seed(directory)
    await mkdir(join(directory, 'projects'))
    await mkdir(join(directory, 'reports'))
    await writeFile(join(directory, 'projects/drawing.json'), '{"preserved":true}')
    await writeFile(join(directory, 'reports/photo.png'), 'photo content')
    const fake = builder({ failure })
    assert.equal((await prepareRelease(directory, options, fake)).directory, original)
    assert.equal((await activeRelease(directory)).revision, oldRevision)
    assert.equal(await readFile(join(directory, 'projects/drawing.json'), 'utf8'), '{"preserved":true}')
    assert.equal(await readFile(join(directory, 'reports/photo.png'), 'utf8'), 'photo content')
    assert.equal((await readdir(join(directory, 'editor-runtime'))).some((name) => name.startsWith('staging-')), false)
  })
}

test('successful update retains previous release and project data', async (t) => {
  const directory = await temporary(t)
  const previous = await seed(directory)
  const oldest = 'c'.repeat(40)
  await mkdir(join(directory, 'editor-runtime/releases', oldest))
  await mkdir(join(directory, 'editor-runtime/staging-interrupted'))
  await writeFile(join(directory, 'editor-runtime/staging-interrupted/partial'), 'interrupted build')
  assert.equal((await prepareRelease(directory, options, builder())).revision, newRevision)
  assert.equal(await readFile(join(previous, 'dist/index.html'), 'utf8'), 'old editor')
  assert.deepEqual((await readdir(join(directory, 'editor-runtime/releases'))).sort(), [oldRevision, newRevision])
  assert.equal((await readdir(join(directory, 'editor-runtime'))).some((name) => name.startsWith('staging-')), false)
})

test('incomplete build never replaces active pointer', async (t) => {
  const directory = await temporary(t)
  await seed(directory)
  assert.equal((await prepareRelease(directory, options, builder({ incomplete: true }))).revision, oldRevision)
  assert.equal((await activeRelease(directory)).revision, oldRevision)
})

test('first installation cannot silently start without a token or a valid build', async (t) => {
  const directory = await temporary(t)
  await assert.rejects(prepareRelease(directory, { ...options, github_token: '' }, builder()), /Set github_token/)
  await assert.rejects(prepareRelease(directory, options, builder({ failure: 'build' })), /simulated failure/)
  assert.equal(await activeRelease(directory), null)
})

test('invalid cached pointer cannot traverse to a different directory', async (t) => {
  const directory = await temporary(t)
  await seed(directory)
  await writeFile(join(directory, 'editor-runtime/active.json'), '{"revision":"../../private"}')
  await assert.rejects(activeRelease(directory), /Invalid cached revision/)
})

test('startup refuses legacy cached releases without mandatory ERP gate', async (t) => {
  const directory = await temporary(t)
  const release = { directory: await seed(directory) }
  await assert.rejects(requireErpGate(release), /predates mandatory ERP access/)
  await writeFile(join(release.directory, 'server/access.mjs'), 'export const sessionCookie = "test"')
  await requireErpGate(release)
})

test('command runner returns bounded stdout, ignores stderr and reports safe errors', async () => {
  assert.equal(await run(process.execPath, ['-e', 'console.log("ok")']), 'ok')
  await assert.rejects(run(process.execPath, ['-e', 'console.error("private-token");process.exit(3)']),
    (error) => /exit 3/.test(error.message) && !error.message.includes('private-token'))
  await assert.rejects(run(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeout: 30 }), /timeout or signal/)
})
