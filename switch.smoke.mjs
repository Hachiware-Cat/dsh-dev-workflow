/**
 * 总开关卡片(lib/client.js 浏览器半侧)冒烟:在假浏览器 + 假 Cordis ctx 里**真正加载
 * 那份懒加载 bundle**,走一遍 `apply` → 注册设置分区 → 渲染卡片 → 点开关写设置,
 * 把"设置分区能出现、开关能读能写"这件事在没有 GUI 的情况下验证掉。
 *
 * 运行:`node switch.smoke.mjs`。全部通过退出码 0。
 */
import assert from 'node:assert/strict'

let failures = 0
let checks = 0

/**
 * 断言并计数(异步体也兜住,断言失败不会变成 unhandled rejection)。
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

// ── 假浏览器 ────────────────────────────────────────────────────────────────
const styleTags = []
globalThis.document = {
  querySelector(selector) {
    const wanted = /data-plugin-css="([^"]+)"/.exec(selector)?.[1]
    return styleTags.find(tag => tag.dataset.pluginCss === wanted) ?? null
  },
  createElement() {
    return { dataset: {}, textContent: '' }
  },
  head: {
    appendChild(element) { styleTags.push(element) },
  },
}

/** 捕获 `window.__ModuleLoader__.load({id, factory})` 的注册。 */
let registration
globalThis.window = {
  __ModuleLoader__: {
    load(value) { registration = value },
  },
}

/** 最小 React 替身:createElement 收成一棵可断言的普通对象树。 */
const ReactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  },
}

/**
 * 假 require:只答 react。
 * @param {string} name - 模块名。
 * @returns {object} 模块替身。
 */
function fakeRequire(name) {
  if (name === 'react') return ReactStub
  throw new Error(`unexpected require(${JSON.stringify(name)})`)
}

await import('./lib/client.js')

await test('bundle 以包名注册(与 package.json 的 name 一致)', () => {
  assert.ok(registration !== undefined, 'window.__ModuleLoader__.load 未被调用')
  assert.equal(registration.id, 'dsh-plugin-dev-workflow')
  assert.equal(typeof registration.factory, 'function')
})

const exported = registration.factory(fakeRequire)

await test('导出 apply / inject / 命名空间常量', () => {
  assert.equal(typeof exported.apply, 'function')
  assert.deepEqual(exported.inject, ['slots', 'locale', 'settingsScope'])
  assert.equal(exported.NS, 'devWorkflow')
  assert.equal(exported.SETTINGS_NS, 'dev-workflow')
  assert.equal(exported.SECTION_ORDER, 130, '排在皮肤分区(120)之后')
})

await test('样式注入一次,类名前缀带插件标识', () => {
  assert.equal(styleTags.length, 1)
  assert.equal(styleTags[0].dataset.plugin, 'dsh-plugin-dev-workflow')
  assert.match(styleTags[0].textContent, /\.dwsw_switch\{/)
  assert.match(styleTags[0].textContent, /var\(--dsw-alias-brand-primary/)
})

// ── 假客户端 ctx + 假设置面 ────────────────────────────────────────────────
const localeRegistrations = []
const slotInjects = []
const slotRegistrations = []
const scopeListeners = []
const writes = []
const scopeState = {
  value: { enabled: true }, base: { enabled: true }, user: {}, revision: 3,
  writable: true, status: 'ready', mode: 'host',
}

const binder = {
  bind(spec) {
    assert.equal(spec.namespace, 'dev-workflow')
    return {
      getSnapshot: () => scopeState,
      subscribe(listener) { scopeListeners.push(listener); return () => {} },
      async set(field, value) {
        writes.push([field, value])
        scopeState.value = { ...scopeState.value, [field]: value }
        for (const listener of scopeListeners) listener()
      },
    }
  },
}

const ctx = {
  get(name) { return name === 'settingsScope' ? binder : undefined },
  effect(factory) {
    const dispose = factory()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: {
    register(ns, dictionaries) { localeRegistrations.push({ ns, dictionaries }) },
    bind(ns) {
      const entry = localeRegistrations.find(row => row.ns === ns)
      return key => entry?.dictionaries.zh[key] ?? key
    },
  },
  slots: {
    inject(name, factory) { slotInjects.push(name); return factory() },
    register(options, Component) { slotRegistrations.push({ options, Component }); return () => {} },
  },
}

exported.apply(ctx)

await test('注册 zh/en 文案', () => {
  assert.equal(localeRegistrations.length, 1)
  assert.equal(localeRegistrations[0].ns, 'devWorkflow')
  assert.equal(typeof localeRegistrations[0].dictionaries.zh.title, 'string')
  assert.equal(typeof localeRegistrations[0].dictionaries.en.title, 'string')
})

await test('英文文案齐备(每个 zh 键都有 en)', () => {
  const { zh, en } = localeRegistrations[0].dictionaries
  assert.deepEqual(Object.keys(zh).filter(key => typeof en[key] !== 'string'), [])
})

await test('向 settings.section 注册一级分区(id / 顺序 / 文案 / 文案命名空间)', () => {
  assert.deepEqual(slotInjects, ['settings.section'])
  assert.equal(slotRegistrations.length, 1)
  const { options } = slotRegistrations[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'dev-workflow')
  assert.equal(options.order, 130)
  assert.equal(options.locale, 'devWorkflow')
  assert.equal(typeof options.label, 'function')
  assert.equal(options.label(), 'dev-workflow 预设')
})

/** 把元素树摊平成数组。 */
function flatten(node) {
  if (Array.isArray(node)) return node.flatMap(flatten)
  if (node === null || node === undefined || typeof node !== 'object') return [node]
  return [node, ...flatten(node.children)]
}

/** 收集树里的全部文本。 */
function textOf(node) {
  return flatten(node).filter(child => typeof child === 'string').join('\n')
}

/** 按类型找元素。 */
function findAll(node, type) {
  return flatten(node).filter(child => typeof child === 'object' && child !== null && child.type === type)
}

const { options, Component } = slotRegistrations[0]
const injected = options.inject()
const t = ctx.locale.bind('devWorkflow')

await test('注入面给出 store 与 setEnabled', () => {
  assert.equal(typeof injected.store.subscribe, 'function')
  assert.equal(typeof injected.store.getSnapshot, 'function')
  assert.equal(typeof injected.setEnabled, 'function')
})

let tree = Component({ t, ...injected })

await test('卡片渲染:标题 + 开关 + 提示 + 状态行', () => {
  const text = textOf(tree)
  assert.match(text, /dev-workflow 预设/)
  assert.match(text, /启用 dev-workflow 预设/)
  assert.match(text, /关闭后停用 dev-workflow 的功能:7 个工具/)
  assert.match(text, /不删任何文件/, '卡片说明必须写明不删文件')
  assert.match(text, /dev-workflow 预设已启用。/)
  assert.match(text, /功能已挂载,7 个工具与 24 份随包技能可用/)
  const switches = findAll(tree, 'button').filter(node => node.props.role === 'switch')
  assert.equal(switches.length, 1)
  assert.equal(switches[0].props['aria-checked'], true)
  assert.equal(switches[0].props.disabled, false)
  assert.equal(findAll(switches[0], 'span').length >= 1, true, '开关有滑块')
})

await test('卡片结构与皮肤同一套(ul > li > 头部 + 主体)', () => {
  assert.equal(tree.type, 'ul')
  assert.match(tree.props.className, /dwsw_sectionList/)
  const card = tree.children[0]
  assert.equal(card.type, 'li')
  assert.match(card.props.className, /dwsw_pluginCard/)
})

await injected.setEnabled(false)

await test('关闭开关:写 settings 命名空间的 enabled=false,卡片同步翻面', () => {
  assert.deepEqual(writes, [['enabled', false]])
  assert.equal(injected.store.getSnapshot().enabled, false)
  tree = Component({ t, ...injected })
  const text = textOf(tree)
  assert.match(text, /dev-workflow 预设已关闭\(插件已停用,未删任何文件\)/)
  assert.match(text, /已从名册移出/)
  assert.match(text, /7 个工具与随包技能都已注销,功能模块也不会被 import/)
  assert.match(text, /仍在磁盘上/, '关闭态必须说明文件没被删')
  const switches = findAll(tree, 'button').filter(node => node.props.role === 'switch')
  assert.equal(switches[0].props['aria-checked'], false)
  assert.match(switches[0].props.className, /dwsw_switch(?!\w)/)
})

await injected.setEnabled(true)

await test('重新打开:写回 true,文案回到启用态', () => {
  assert.deepEqual(writes, [['enabled', false], ['enabled', true]])
  tree = Component({ t, ...injected })
  assert.match(textOf(tree), /dev-workflow 预设已启用。/)
})

await test('设置面未就绪时开关置灰并说明原因', () => {
  scopeState.status = 'loading'
  scopeState.writable = false
  for (const listener of scopeListeners) listener()
  const pendingTree = Component({ t, ...injected })
  const switches = findAll(pendingTree, 'button').filter(node => node.props.role === 'switch')
  assert.equal(switches[0].props.disabled, true)
  assert.match(textOf(pendingTree), /设置通道尚未就绪/)
  scopeState.status = 'ready'
  scopeState.writable = true
  for (const listener of scopeListeners) listener()
})

console.log(`\n${checks - failures}/${checks} 通过`)
if (failures > 0) process.exit(1)
