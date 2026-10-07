import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = dirname(fileURLToPath(import.meta.url))
const sourceRepository = 'https://github.com/optomtr/bms-planspec.git'
const log = (message) => console.log(`[plan-editor] ${message}`)
const safeEnv = () => ({ PATH: process.env.PATH, HOME: '/tmp', LANG: 'C.UTF-8',
  CI: 'true', NODE_ENV: 'development', npm_config_update_notifier: 'false' })

export function validateOptions(options) {
  if (!options || typeof options !== 'object') throw new Error('Missing app configuration')
  if (typeof options.plan_editor_secret !== 'string'
    || !/^[\x21-\x7e]{32,256}$/.test(options.plan_editor_secret)) {
    throw new Error('Set plan_editor_secret to 32-256 printable characters without spaces; use the same secret in ERP')
  }
  if (typeof options.github_token !== 'string' || !/^[A-Za-z0-9_]*$/.test(options.github_token)) {
    throw new Error('github_token must be a GitHub access token')
  }
  if (typeof options.source_branch !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(options.source_branch)
    || options.source_branch.includes('..') || options.source_branch.includes('//')) {
    throw new Error('source_branch must be a valid branch or tag name')
  }
  if (typeof options.update_on_start !== 'boolean') throw new Error('update_on_start must be true or false')
  return options
}

export function run(command, args, { cwd, env = safeEnv(), timeout = 120000 } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    // Command output is not logged: dependency scripts and Git can echo credentials.
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-4096) })
    child.stderr.resume()
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.once('error', (error) => { clearTimeout(timer); fail(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) done(output.trim())
      else fail(new Error(`${command} failed (${code === null ? 'timeout or signal' : `exit ${code}`})`))
    })
  })
}

export async function activeRelease(dataDir) {
  try {
    const active = JSON.parse(await readFile(join(dataDir, 'editor-runtime', 'active.json'), 'utf8'))
    if (!/^[a-f0-9]{40}$/.test(active.revision)) throw new Error('Invalid cached revision')
    const directory = join(dataDir, 'editor-runtime', 'releases', active.revision)
    for (const file of ['dist/index.html', 'server/index.mjs']) {
      if (!(await stat(join(directory, file))).isFile()) throw new Error('Incomplete cached release')
    }
    return { ...active, directory }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function prepareRelease(dataDir, options, { execute = run, repository = sourceRepository } = {}) {
  const current = await activeRelease(dataDir)
  if (current && !options.update_on_start) {
    log(`Updates disabled; using ${current.revision.slice(0, 12)}`)
    return current
  }
  const runtime = join(dataDir, 'editor-runtime')
  await mkdir(join(runtime, 'releases'), { recursive: true, mode: 0o700 })
  for (const name of await readdir(runtime)) {
    if (/^staging-[A-Za-z0-9]+$/.test(name)) {
      await rm(join(runtime, name), { recursive: true, force: true })
    }
  }
  const staging = await mkdtemp(join(runtime, 'staging-'))
  try {
    if (!options.github_token) throw new Error('Set github_token with read-only Contents access to optomtr/bms-planspec')
    const checkout = join(staging, 'source')
    log(`Checking editor source (${options.source_branch})`)
    await execute('git', ['clone', '--depth', '1', '--single-branch', '--branch', options.source_branch,
      '--', repository, checkout], { env: { ...safeEnv(), GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: join(appDir, 'askpass.cjs'), EDITOR_GITHUB_TOKEN: options.github_token } })
    const revision = await execute('git', ['rev-parse', 'HEAD'], { cwd: checkout })
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid source revision')
    if (current?.revision === revision) {
      log(`Editor is up to date (${revision.slice(0, 12)})`)
      return current
    }
    log('Installing editor dependencies; the first start may take several minutes')
    await execute('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: checkout, timeout: 600000 })
    log('Checking and building the editor')
    await execute('npm', ['run', 'test:server'], { cwd: checkout, timeout: 120000 })
    await execute('npm', ['run', 'build'], { cwd: checkout, timeout: 600000 })
    const candidate = join(staging, 'release')
    await mkdir(candidate)
    await cp(join(checkout, 'dist'), join(candidate, 'dist'), { recursive: true })
    await cp(join(checkout, 'server'), join(candidate, 'server'), { recursive: true })
    for (const file of ['dist/index.html', 'server/index.mjs']) {
      if (!(await stat(join(candidate, file))).isFile()) throw new Error('Build did not produce a complete editor')
    }
    const directory = join(runtime, 'releases', revision)
    // An interrupted prior install may have left an unactivated release.
    await rm(directory, { recursive: true, force: true })
    await rename(candidate, directory)
    const active = { revision, branch: options.source_branch, installedAt: new Date().toISOString() }
    const pointer = join(staging, 'active.json')
    await writeFile(pointer, JSON.stringify(active), { mode: 0o600 })
    await rename(pointer, join(runtime, 'active.json'))
    // Keep the active and previous release without growing backups on every update.
    try {
      for (const name of await readdir(join(runtime, 'releases'))) {
        if (/^[a-f0-9]{40}$/.test(name) && name !== revision && name !== current?.revision) {
          await rm(join(runtime, 'releases', name), { recursive: true, force: true })
        }
      }
    } catch { log('Unable to remove old cached releases; the new editor remains active') }
    log(`Editor installed (${revision.slice(0, 12)})`)
    return { ...active, directory }
  } catch (error) {
    log(`Update unavailable: ${error.message}`)
    if (!current) throw error
    log(`Starting last working editor (${current.revision.slice(0, 12)}); projects are unchanged`)
    return current
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function main() {
  const dataDir = '/data'
  const options = validateOptions(JSON.parse(await readFile(join(dataDir, 'options.json'), 'utf8')))
  const release = await prepareRelease(dataDir, options)
  const child = spawn(process.execPath, [join(release.directory, 'server/index.mjs')], {
    cwd: release.directory, stdio: 'inherit', env: { ...safeEnv(), NODE_ENV: 'production',
      PORT: '4174', PLAN_EDITOR_DATA_DIR: dataDir, PLAN_EDITOR_SECRET: options.plan_editor_secret },
  })
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal))
  child.once('error', () => { log('Unable to start editor server'); process.exitCode = 1 })
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGTERM' ? 0 : 1) })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { log(error.message); process.exitCode = 1 })
}
