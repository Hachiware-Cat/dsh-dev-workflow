/**
 * 总开关(lib/index.js 入口)自测。
 *
 * 覆盖三件事:
 *   ① 纯函数:路径推导、预设改名搬迁(幂等、拒绝覆盖)、schema、功能模块地址解析;
 *   ② 接线:开关值 → 功能 fiber 的挂载/卸下 + 预设可见性,**两个方向都验**;
 *   ③ 最关键的一条性质:**关闭时功能模块根本不会被 import**(不是"加载了再空转")——
 *      用一个自己记事件的夹具模块当证据。
 *
 * 夹具模块是"功能本体"的替身,免得单测真去 import 那份 40 万字节的实现;门卫用
 * `config.feature` 指到它。夹具在**模块求值**时记 `import`、在 `apply()` 时记 `apply`、
 * 在返回的 disposer 里记 `dispose-effect` —— 于是"有没有加载"这件事是可断言的。
 *
 * 运行:`node switch.selftest.mjs`。全部通过退出码 0。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  DISABLED_DIR, buildSchema, expandHome, featureSpecifier, apply, reconcilePreset, resolvePaths,
} from './lib/index.js'

let failures = 0
let checks = 0

/**
 * 断言并计数。异步体也在这里兜住 —— 断言失败必须记成一条失败,而不是变成
 * 进程末尾的 unhandled rejection(那会绕开计数、让人误以为全绿)。
 * @param {string} label - 断言名。
 * @param {() => void | Promise<void>} body - 断言体。
 * @returns {Promise<void>} 断言完成。
 */
async function test(label, body) {
  checks += 1
  try {
    await body()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 造一个临时沙箱目录。 */
function sandbox() {
  return mkdtempSync(join(tmpdir(), 'dwswitch-'))
}

/** 让门卫的 promise 链跑完(apply 的启动对齐是异步的)。 */
const settle = () => new Promise(resolve => setTimeout(resolve, 40))

/**
 * 造一个"功能本体"夹具模块:模块求值时记 `import`、apply 时记 `apply`、
 * disposer 里记 `dispose-effect`。
 * @param {string} dir - 夹具目录。
 * @returns {string} 夹具模块的绝对路径。
 */
function writeFixture(dir) {
  const file = join(dir, 'fake-feature.mjs')
  writeFileSync(file, `
import { appendFileSync } from 'node:fs'
const LOG = new URL('./events.log', import.meta.url)
appendFileSync(LOG, 'import\\n')
export const name = 'fake-feature'
export const inject = []
export function apply () {
  appendFileSync(LOG, 'apply\\n')
  return () => { appendFileSync(LOG, 'dispose-effect\\n') }
}
`, 'utf8')
  return file
}

/**
 * 读夹具事件日志(模块没被求值时文件不存在 → 空数组)。
 * @param {string} dir - 夹具目录。
 * @returns {string[]} 事件行。
 */
function events(dir) {
  const file = join(dir, 'events.log')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []
}

/**
 * 假宿主 ctx:设置面 + effect + plugin(真的把模块当插件跑,并返回可断言的 fiber)。
 * @param {boolean} enabled - 命名空间里的初始开关值。
 * @returns {object} 假 ctx 及其记录。
 */
function fakeCtx(enabled) {
  const registrations = []
  const watchers = []
  const effects = []
  const fibers = []
  const value = { enabled }
  const scope = {
    get: () => value,
    watch(callback) { watchers.push(callback); return () => {} },
    update: async () => {},
    replace: async () => {},
  }
  return {
    value,
    registrations,
    watchers,
    effects,
    fibers,
    settings: {
      register(ns, schema, options) {
        registrations.push({ ns, schema, options })
        return scope
      },
    },
    get: () => undefined,
    effect(factory, label) {
      const dispose = factory()
      effects.push({ label, dispose: typeof dispose === 'function' ? dispose : () => {} })
      return effects[effects.length - 1].dispose
    },
    plugin(mod) {
      const disposers = []
      const fiber = {
        mod,
        disposed: 0,
        await: async () => {},
        async dispose() {
          this.disposed += 1
          for (const dispose of disposers.reverse()) await dispose?.()
        },
      }
      const child = {
        effect(factory) {
          const dispose = factory()
          if (typeof dispose === 'function') disposers.push(dispose)
          return dispose
        },
      }
      if (typeof mod?.apply === 'function') {
        const returned = mod.apply(child, {})
        if (typeof returned === 'function') disposers.push(returned)
      }
      fibers.push(fiber)
      return fiber
    },
  }
}

console.log('纯函数:')
await test('expandHome / resolvePaths 跟随 DSH_HOME', () => {
  const paths = resolvePaths({ config: {}, env: { DSH_HOME: join(tmpdir(), 'dshenv') } })
  assert.equal(paths.home, join(tmpdir(), 'dshenv'))
  assert.equal(paths.presetRoot, join(tmpdir(), 'dshenv', '.agent-presets'))
  assert.equal(paths.presetDir, join(tmpdir(), 'dshenv', '.agent-presets', 'dev-workflow'))
  assert.equal(paths.hiddenPresetDir, join(tmpdir(), 'dshenv', '.agent-presets', DISABLED_DIR, 'dev-workflow'))
  const overridden = resolvePaths({ config: { presetRoot: join(tmpdir(), 'roots') }, env: { DSH_HOME: 'ignored' } })
  assert.equal(overridden.presetDir, join(tmpdir(), 'roots', 'dev-workflow'))
  assert.equal(expandHome('~').length > 1, true)
})

await test('buildSchema:两种实现都能解析出 enabled(默认 true)', () => {
  const schema = buildSchema()
  assert.equal(typeof schema, 'function')
  assert.equal(schema({}).enabled, true)
  assert.equal(schema({ enabled: false }).enabled, false)
  assert.equal(typeof schema.toJSON, 'function')
})

await test('featureSpecifier:默认指向包内 feature.js,可由 config.feature 覆盖', () => {
  assert.match(featureSpecifier({}), /\/lib\/feature\.js$/)
  const fixture = pathToFileURL(join(tmpdir(), 'x', 'fake.mjs')).href
  assert.equal(featureSpecifier({ feature: join(tmpdir(), 'x', 'fake.mjs') }), fixture)
})

await test('reconcilePreset:关闭搬进 .disabled,打开搬回;内容不动', () => {
  const root = sandbox()
  try {
    const presetRoot = join(root, '.agent-presets')
    mkdirSync(join(presetRoot, 'dev-workflow'), { recursive: true })
    writeFileSync(join(presetRoot, 'dev-workflow', 'preset.yml'), 'name: 工作流模式\n')
    const paths = resolvePaths({ config: { presetRoot }, env: {} })
    assert.equal(reconcilePreset(paths, false), 'preset:hidden')
    assert.equal(existsSync(paths.presetDir), false)
    assert.equal(reconcilePreset(paths, false), 'preset:hidden', '幂等')
    assert.equal(reconcilePreset(paths, true), 'preset:restored')
    assert.equal(readFileSync(join(presetRoot, 'dev-workflow', 'preset.yml'), 'utf8'), 'name: 工作流模式\n')
    assert.equal(reconcilePreset(paths, true), 'preset:visible', '幂等')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('reconcilePreset:缺目录不报错;两处并存时拒绝覆盖', () => {
  const root = sandbox()
  try {
    const presetRoot = join(root, '.agent-presets')
    const paths = resolvePaths({ config: { presetRoot }, env: {} })
    assert.equal(reconcilePreset(paths, true), 'preset:missing')
    assert.equal(reconcilePreset(paths, false), 'preset:missing')
    mkdirSync(join(presetRoot, 'dev-workflow'), { recursive: true })
    mkdirSync(join(presetRoot, DISABLED_DIR, 'dev-workflow'), { recursive: true })
    assert.throws(() => reconcilePreset(paths, false), /拒绝覆盖/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

console.log('接线:')
await test('启动对齐(开)→ 挂载功能 + 预设可见', async () => {
  const root = sandbox()
  try {
    const presetRoot = join(root, '.agent-presets')
    mkdirSync(join(presetRoot, 'dev-workflow'), { recursive: true })
    const fixture = writeFixture(root)
    const ctx = fakeCtx(true)
    apply(ctx, { presetRoot, feature: fixture })
    await settle()

    assert.equal(ctx.registrations.length, 1)
    assert.equal(ctx.registrations[0].ns, 'dev-workflow', '命名空间沿用 dev-workflow(1.7.x 用户的值直接续上)')
    assert.deepEqual(ctx.registrations[0].options.base, { enabled: true })
    assert.equal(ctx.registrations[0].options.applies, 'live')
    assert.equal(ctx.fibers.length, 1, '功能被挂载为子 fiber')
    assert.deepEqual(events(root), ['import', 'apply'])
    assert.equal(existsSync(join(presetRoot, 'dev-workflow')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('关掉 → fiber 释放(跑 disposer)+ 预设搬走;再打开 → 重新 apply + 预设搬回', async () => {
  const root = sandbox()
  try {
    const presetRoot = join(root, '.agent-presets')
    mkdirSync(join(presetRoot, 'dev-workflow'), { recursive: true })
    const fixture = writeFixture(root)
    const ctx = fakeCtx(true)
    apply(ctx, { presetRoot, feature: fixture })
    await settle()

    ctx.value.enabled = false
    ctx.watchers[0]({ enabled: false })
    await settle()
    assert.equal(ctx.fibers[0].disposed, 1, '功能 fiber 被释放一次')
    assert.equal(existsSync(join(presetRoot, DISABLED_DIR, 'dev-workflow')), true, '预设被改名搬走')
    assert.equal(existsSync(join(presetRoot, 'dev-workflow')), false)

    ctx.value.enabled = true
    ctx.watchers[0]({ enabled: true })
    await settle()
    assert.equal(ctx.fibers.length, 2, '重新挂载是一个新 fiber')
    // ESM 缓存:模块只求值一次,apply 每次挂载都跑。
    assert.deepEqual(events(root), ['import', 'apply', 'dispose-effect', 'apply'])

    assert.equal(existsSync(join(presetRoot, 'dev-workflow')), true, '预设搬回原位')

    ctx.watchers[0]({ enabled: true })
    await settle()
    assert.equal(ctx.fibers.length, 2, '幂等:再点一次"开"不会再挂一个')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('启动时就是关 → 功能模块**根本不会被 import**', async () => {
  const root = sandbox()
  try {
    const presetRoot = join(root, '.agent-presets')
    mkdirSync(join(presetRoot, 'dev-workflow'), { recursive: true })
    const fixture = writeFixture(root)
    const ctx = fakeCtx(false)
    apply(ctx, { presetRoot, feature: fixture })
    await settle()

    assert.deepEqual(events(root), [], '夹具模块一次都没被求值(连 import 都没有)')
    assert.equal(ctx.fibers.length, 0)
    assert.equal(existsSync(join(presetRoot, DISABLED_DIR, 'dev-workflow')), true, '预设也是关着的状态')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('入口行被释放 → 功能一起带走(不留孤儿 fiber)', async () => {
  const root = sandbox()
  try {
    const fixture = writeFixture(root)
    const ctx = fakeCtx(true)
    apply(ctx, { presetRoot: join(root, '.agent-presets'), feature: fixture })
    await settle()
    assert.equal(ctx.fibers[0].disposed, 0)
    const disposeEffect = ctx.effects.find(entry => entry.label.includes('unmount feature on dispose'))
    assert.ok(disposeEffect !== undefined, '注册了释放时的清理 effect')
    disposeEffect.dispose()
    await settle()
    assert.equal(ctx.fibers[0].disposed, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('settings 注册失败 → 只记日志、不抛(绝不会拖垮宿主启动)', async () => {
  const ctx = {
    settings: { register() { throw new Error('boom') } },
    get: () => undefined,
    effect: () => () => {},
    plugin: () => { throw new Error('不该走到这里') },
  }
  const original = console.error
  const logged = []
  console.error = (text) => { logged.push(String(text)) }
  try {
    assert.doesNotThrow(() => { apply(ctx, { presetRoot: join(tmpdir(), 'nowhere') }) })
    await settle()
  } finally {
    console.error = original
  }
  assert.equal(logged.some(line => line.includes('接线失败')), true, '留下了日志')
})

console.log(`\n${checks - failures}/${checks} 通过`)
if (failures > 0) process.exit(1)
