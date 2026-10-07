import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

// Opt-in real-source test. Requires Docker and BMS_EDITOR_TEST_TOKEN with source read access.
const token = process.env.BMS_EDITOR_TEST_TOKEN
assert.ok(token, 'Set BMS_EDITOR_TEST_TOKEN to a read-only GitHub token')
const output = resolve('output')
await mkdir(output, { recursive: true })
const dataDir = await mkdtemp(join(output, 'plan-editor-smoke-'))
const name = `plan-editor-smoke-${randomBytes(4).toString('hex')}`
const secret = randomBytes(32).toString('hex')
const options = { plan_editor_secret: secret, github_token: token, source_branch: 'main', update_on_start: true }
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
let base

async function ready() {
  const port = docker('port', name, '4174/tcp').split(':').at(-1)
  base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 15 * 60 * 1000
  let last = ''
  while (Date.now() < deadline) {
    const logs = docker('logs', name)
    assert.ok(!logs.includes(token) && !logs.includes(secret), 'Credentials leaked into container logs')
    const safe = logs.split('\n').filter((line) => line.includes('[plan-editor]') || line.includes('listening')).join('\n')
    if (safe !== last) { console.log(safe.slice(last.length)); last = safe }
    try {
      const response = await fetch(`${base}/api/health`)
      if (response.ok && (await response.json()).ok) return
    } catch {}
    assert.equal(docker('inspect', '-f', '{{.State.Running}}', name), 'true', `Container exited: ${logs}`)
    await sleep(2000)
  }
  throw new Error('Editor did not become ready in 15 minutes')
}

const payload = Buffer.from(JSON.stringify({ v: 1, aud: 'bms-plan-editor', projectId: 'addon-smoke',
  projectName: 'Smoke test', user: 'test-admin', canWrite: true, isAdmin: true,
  exp: Date.now() + 60 * 60 * 1000 })).toString('base64url')
const authorization = `Bearer ${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`
const headers = { Authorization: authorization, 'Content-Type': 'application/json' }

try {
  await writeFile(join(dataDir, 'options.json'), JSON.stringify(options), { mode: 0o600 })
  docker('run', '-d', '--name', name, '-p', '127.0.0.1::4174', '-v', `${dataDir}:/data`, 'bms-plan-editor-addon:test')
  await ready()
  const direct = await (await fetch(base)).text()
  assert.ok(!direct.includes('<div id="root">'))
  assert.match(direct, /location.replace\(erpUrl\)/)
  const session = await fetch(`${base}/api/session`, { method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: authorization.slice('Bearer '.length) }) })
  assert.equal(session.status, 200)
  const cookie = session.headers.get('set-cookie').split(';')[0]
  const html = await (await fetch(base, { headers: { Cookie: cookie } })).text()
  assert.ok(html.includes('<div id="root">'))
  const asset = /src="([^"]+\.js)"/.exec(html)?.[1]
  assert.ok(asset)
  assert.equal((await fetch(`${base}${asset}`)).status, 401)
  const script = await fetch(`${base}${asset}`, { headers: { Cookie: cookie } })
  assert.equal(script.status, 200)
  assert.match(script.headers.get('content-type'), /javascript/)
  assert.equal((await fetch(`${base}/api/project`)).status, 401)
  const project = { meta: { name: 'Persistent drawing' }, annotations: [], pdfName: '',
    pageNumber: 1, zoom: 1, pdfDataBase64: null }
  const saved = await fetch(`${base}/api/project`, { method: 'PUT', headers: { ...headers, 'If-Match': '0' },
    body: JSON.stringify(project) })
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).revision, 1)
  const report = await fetch(`${base}/api/reports`, { method: 'POST', headers,
    body: JSON.stringify({ description: 'Container smoke test report' }) })
  assert.equal(report.status, 201)
  const { id } = await report.json()
  const uploaded = await fetch(`${base}/api/reports/${id}/attachments`, { method: 'PUT',
    headers: { Authorization: authorization, 'X-File-Name': 'test-photo.png', 'Content-Type': 'image/png' },
    body: Buffer.from('smoke-test-image') })
  assert.equal(uploaded.status, 201)
  const attachment = await uploaded.json()
  const active = JSON.parse(await readFile(join(dataDir, 'editor-runtime/active.json'), 'utf8'))
  assert.match(active.revision, /^[a-f0-9]{40}$/)
  // A broken repository credential must still start the cached release after restart.
  docker('stop', '--time', '10', name)
  await writeFile(join(dataDir, 'options.json'), JSON.stringify({ ...options, github_token: 'invalid_test_token' }), { mode: 0o600 })
  docker('start', name)
  await ready()
  assert.match(docker('logs', name), /Starting last working editor/)
  const restored = await (await fetch(`${base}/api/project`, { headers })).json()
  assert.deepEqual(restored.project, project)
  assert.equal(restored.revision, 1)
  const download = await fetch(`${base}/api/reports/${id}/attachments/${attachment.id}`, { headers })
  assert.equal(await download.text(), 'smoke-test-image')
  assert.equal((await fetch(`${base}${asset}`)).status, 401)
  console.log('PASS: ERP-only entry, protected UI assets, real source build, project/report persistence and safe fallback restart')
} finally {
  try { docker('rm', '-f', name) } catch {}
  await rm(dataDir, { recursive: true, force: true })
}
