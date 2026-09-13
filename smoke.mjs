/**
 * smoke.mjs — 不依赖 DSH 的端到端冒烟测试。
 *
 * selftest.mjs 只测纯函数;本文件用 mock ctx 真实驱动插件的 apply(),
 * 四条能力全跑一遍:
 *   - 私有状态落盘到 $DSH_HOME/dev-workflow/state.json(并验证 DSH_HOME 解析)
 *   - relay 自动投递(用真 AbortSignal)、去重、失败回滚
 *   - profile 切换后角色集真的收敛
 *   - 进程重启后的等待图作废对账
 * 运行: node smoke.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apply, buildProfileTable, VERSION } from './lib/feature.js'
/**
 * 命名空间导入:可选符号(`extractRelayMarksAll`、`discoverApiSpecs` …)一律从这里取。
 * ESM 的具名导入在缺符号时会在**加载期**直接抛错、整文件崩 ——
 * 那样一条缺失的符号会变成"整套件加载失败",而不是一条干净的失败断言。
 * 取用处的写法是 `typeof fn === 'function' && …`。
 */
import * as libmod from './lib/feature.js'

let PASS = 0
let FAIL = 0
const failures = []
function check(name, cond, detail) {
  if (cond) PASS += 1
  else { FAIL += 1; failures.push(`${name}${detail ? ` — ${detail}` : ''}`) }
}

// 临时目录默认落在 cwd 下;从**安装位置**复跑时安装目录不可写,用
// DSH_SMOKE_TMP 指一个可写位置即可(配套 DSH_WF_PRESETS 指预设目录,同源校验才跑得了)。
const TMP = process.env.DSH_SMOKE_TMP
  ? path.resolve(process.env.DSH_SMOKE_TMP)
  : path.join(process.cwd(), '.smoke-tmp')
fs.rmSync(TMP, { recursive: true, force: true })
const HOME = path.join(TMP, 'home')
const ROOT = path.join(TMP, 'proj')
fs.mkdirSync(path.join(ROOT, 'docs', 'workflow'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'docs', 'workflow', '.active'), 'active\n', 'utf8')
process.env.DSH_HOME = HOME

const statePath = path.join(HOME, 'dev-workflow', 'state.json')
const parentAgent = { id: 'session-main', session: { header: { cwd: ROOT, agentPreset: 'standard' } } }
const childAgent = { id: 'child-be', session: { header: { cwd: ROOT, parentSession: 'session-main', agentPreset: 'standard' } } }
/**
 * 活 agent 注册表提到模块级,并由 startContinuable 真实登记产出的子会话:
 * 真 DSH 里 startContinuable 的 childId 一定查得到,而且 header.parentSession 指向发起者;
 * mock 若不建这层关系,「绑定验活」在 mock 里永远看不到活人 ——
 * 那条断言就永远判定失效,反而测不出真实行为。
 */
const live = { 'session-main': parentAgent, 'child-be': childAgent }

const sent = []
const subagents = {
  list: () => ['spawn', 'fork'],
  async sendMessage(sender, targetId, content, options) {
    const realSignal = !!options && !!options.signal && options.signal.constructor && options.signal.constructor.name === 'AbortSignal'
    sent.push({ senderId: String(sender.id), targetId: String(targetId), text: content[0].text, realSignal })
    if (String(targetId) === 'dead-agent') {
      const err = new Error('subagent "dead-agent" is unavailable')
      err.code = 'NOT_RESUMABLE'
      throw err
    }
    return `msg-${sent.length}`
  },
  async startContinuable(spec) {
    subagents._specs.push(spec)
    subagents._seq = (subagents._seq || 0) + 1
    // 默认沿用 `child-<角色>`(老断言依赖它);`_unique=true` 时带序号 ——
    // 现实里每个子会话 id 都是唯一的,某些用例(反查角色绑定)需要这个真实性。
    const suffix = subagents._unique ? `-${subagents._seq}` : ''
    const childId = `child-${spec.label}${suffix}`
    // 登记进活 agent 表 + 记住父会话(绑定验活与 scheduler-proxy 都依赖这两条)
    const req = spec.request || {}
    const ph = (req.parent && req.parent.session && req.parent.session.header) || {}
    live[childId] = {
      id: childId,
      session: { header: { cwd: ph.cwd, parentSession: String(req.parent ? req.parent.id : ''), agentPreset: ph.agentPreset } },
    }
    return { childId, messageId: `spawn-msg-${spec.label}${suffix}` }
  },
  _specs: [],
  _seq: 0,
  _unique: false,
}

function mockCtx(extra) {
  const tools = []
  const handlers = {}
  // 把 logger 收下来:ready 行是部署期唯一的自证(deploy.ps1 读它做版本比对),
  // mock 若把它丢进空函数,"这一版到底带不带某项能力"在离线套件里就无从断言。
  const logs = []
  const services = Object.assign({
    agents: { get: (id) => live[String(id)], list: () => Object.values(live), currentInitiator: () => parentAgent },
    subagents,
    agentPresets: { list: async () => [{ id: 'wf-pm', name: 'dev-workflow 项目经理' }, { id: 'wf-be', name: 'dev-workflow 后端' }] },
    shell: { cwd: () => ROOT },
  }, extra || {})
  return {
    tools: { register: (t) => { tools.push(t); return () => {} } },
    get: (n) => services[n],
    on: (n, fn) => { handlers[n] = (handlers[n] || []).concat([fn]); return () => {} },
    effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} },
    logger: { info: (...a) => { logs.push(a.map((x) => String(x)).join(' ')) }, warn: (...a) => { logs.push(a.map((x) => String(x)).join(' ')) } },
    _tools: tools,
    _logs: logs,
    _handlers: handlers,
    _tool: (name) => tools.find((t) => t.name === name),
  }
}

const exec = { agent: parentAgent, signal: new AbortController().signal }

/**
 * 无损 JSON 校验:DSH 对工具返回值做这层校验,带 undefined / 活对象 / 循环引用
 * 会让整次调用失败(实机见过 "returned invalid output: value is not lossless JSON")。
 * mock 里没有运行时校验,所以在这里自己补上 —— 否则这类 bug 只会在生产暴露。
 */
function losslessProblem(value, pathStr, seen) {
  if (value === undefined) return `${pathStr} = undefined`
  const t = typeof value
  if (t === 'function') return `${pathStr} 是函数`
  if (t === 'symbol' || t === 'bigint') return `${pathStr} 是 ${t}`
  if (value === null || t !== 'object') return ''
  const proto = Object.getPrototypeOf(value)
  const isArray = Array.isArray(value)
  if (!isArray && proto !== Object.prototype && proto !== null) {
    return `${pathStr} 不是纯 JSON 对象(${(value.constructor && value.constructor.name) || 'unknown'})`
  }
  if (seen.has(value)) return `${pathStr} 存在循环引用`
  seen.add(value)
  const keys = isArray ? value.map((_, i) => i) : Object.keys(value)
  for (const k of keys) {
    const p = losslessProblem(value[k], `${pathStr}${isArray ? `[${k}]` : `.${k}`}`, seen)
    if (p) { seen.delete(value); return p }
  }
  seen.delete(value)
  return ''
}

async function runAs(ctx, agent, name, args) {
  const value = await ctx._tool(name).execute(args, { agent, signal: new AbortController().signal })
  const problem = losslessProblem(value, name, new Set())
  check(`无损JSON:${name}`, problem === '', problem)
  return value
}

const run = (ctx, name, args) => runAs(ctx, parentAgent, name, args)

/**
 * **不许用 `fs.cpSync(dir, dest, { recursive: true })`**:目标目录落在工作区之外时,
 * 递归 cpSync 会直接抛 `EIO, Access is denied`(errno 5, syscall 'cp',路径是**目标目录**);
 * 有时更狠 —— 让 node **fail-fast**(0xC0000409,连已缓冲的输出都不 flush)。
 * 换成三步走的手工递归拷贝:mkdirSync + readdirSync + copyFileSync —— 行为等价,到处都能跑
 * (这几个 API 在沙箱下都验证过)。
 */
function copyTree(src, dest) {
  const st = fs.statSync(src)
  if (!st.isDirectory()) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest); return }
  fs.mkdirSync(dest, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dest, e.name)
    if (e.isDirectory()) copyTree(s, d)
    else if (e.isFile()) fs.copyFileSync(s, d)
  }
}

/**
 * 造一份"插件包临时副本"(`lib/feature.js` + `package.json`,可选把真包 `skills/` 一起拷进去),
 * 返回**同一进程内**动态 import 出来的全新模块实例。
 *
 * 为什么必须这样:参考件缓存、技能 frontmatter 都是**模块级/apply 级**的一次性状态,真包那份
 * 在本进程里早就定型了;而要造"参考件读不到"只能靠换目录 —— 随包的
 * `skills/api-architect/references/`(openapi-spec.yaml sha256 `598395EC915E9ECD…`)是**交付资产,
 * 不是测试的草稿纸**:临时改名 / 改写随包件的做法一律不采用,整包拷一份最省心也最安全。
 */
async function makePkgCopy(name, opts) {
  const dir = path.join(TMP, name)
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.copyFileSync(fileURLToPath(new URL('./lib/feature.js', import.meta.url)), path.join(dir, 'lib', 'feature.js'))
  fs.copyFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), path.join(dir, 'package.json'))
  if (opts && opts.skills) copyTree(fileURLToPath(new URL('./skills', import.meta.url)), path.join(dir, 'skills'))
  const mod = await import(pathToFileURL(path.join(dir, 'lib', 'feature.js')).href)
  return { dir, mod }
}

// ── 1. 注册与私有状态落盘────────────────────────────────────────────
{
  const ctx = mockCtx()
  apply(ctx, {})
  const names = ctx._tools.map((t) => t.name).sort()
  check('1.1 七个工具全部注册', names.join(',') === 'api_contract,relay,relay_spawn,workflow_state_load,workflow_state_save,workflow_state_status,workflow_state_use', names.join(','))
  check('1.2 插件在临时 DSH_HOME 下落盘成功', fs.existsSync(statePath), statePath)
  const st = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  check('1.3 状态文件结构正确', st.version === 1 && !!st.boot && typeof st.projects === 'object', Object.keys(st).join(','))
  check('1.4 落点跟随 $DSH_HOME(不污染真实 ~/.dsh)', statePath.indexOf(HOME) === 0)
}

// ── 2. 激活门 + 状态文档──────────────────────────────
{
  const ctx = mockCtx()
  apply(ctx, {})
  const st = await run(ctx, 'workflow_state_status', { root: ROOT })
  check('2.1 已激活项目 status=active', st.status === 'active' && st.gate === 'active', st.status)
  check('2.2 带出当前 profile', st.profileId === 'standard', st.profileId)

  const saved = await run(ctx, 'workflow_state_save', { root: ROOT, role: 'arch', nextStep: '④ 质检员', projectName: 'smoke' })
  check('2.3 渲染状态文档全文', saved.status === 'rendered' && saved.documentText.indexOf('② 架构师 ✅') !== -1)
  check('2.4 落盘指令指向项目内文件', String(saved.persistInstruction).indexOf(path.join(ROOT, 'docs', 'workflow', '流程状态.md')) !== -1)
  check('2.5 状态保存计入台账', saved.ledgerPending >= 1, String(saved.ledgerPending))

  const inactive = await run(ctx, 'workflow_state_status', { root: path.join(TMP, 'nope') })
  // gate 细分成了 none/off/file/remembered/state-doc;未激活 = gate 'none'
  check('2.6 未激活项目隐身', inactive.status === 'inactive' && inactive.gate === 'none', `${inactive.status}/${inactive.gate}`)
  check('2.7 未激活时告诉模型"零设置即可开工"', inactive.autoStart === true && String(inactive.note).indexOf('不需要建任何文件') !== -1, inactive.note)
  // 自洽性断言:status 报的落盘次数读的是内存计数,文件里是上次序列化时的值,两者必须相等。
  const stJson2 = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const relaySt = await run(ctx, 'relay', { action: 'status', root: ROOT })
  const mWrites = /已写 (\d+) 次/.exec(String(relaySt.stateHealth))
  check('2.8 落盘次数自洽(status 值 === 文件值,不重复计数)',
    !!mWrites && Number(mWrites[1]) === Number(stJson2.lifetime && stJson2.lifetime.storeWrites),
    `status=${mWrites && mWrites[1]} file=${stJson2.lifetime && stJson2.lifetime.storeWrites}`)
}

// ── 3. profile:列表 / 切换 / 角色集真的收敛 ──────────────────────────────
{
  const ctx = mockCtx()
  apply(ctx, {})
  const listed = await run(ctx, 'relay', { action: 'profile', root: ROOT })
  check('3.1 profile 列表含三个内置档案', Array.isArray(listed.profileView.available) && listed.profileView.available.length === 3, JSON.stringify(listed.profileView.available && listed.profileView.available.map((p) => p.id)))
  check('3.2 当前档案=standard 五角色', listed.profileView.current === 'standard' && listed.profileView.roles.join(',') === 'pm,arch,be,fe,qa')

  const bad = await run(ctx, 'relay', { action: 'send', root: ROOT, from: 'pm', to: 'be', msg: 'x', profile: 'nope' })
  check('3.3 未知 profile 回退 standard 且不崩', bad.status !== 'invalid' || !!bad.profileView, bad.status)

  const sw = await run(ctx, 'relay', { action: 'profile', root: ROOT, profile: 'lean3' })
  check('3.4 切到 lean3 成功', sw.status === 'switched' && sw.profileView.roles.join(',') === 'pm,be,qa', sw.status)

  const noArch = await run(ctx, 'relay', { action: 'send', root: ROOT, from: 'pm', to: 'arch', msg: '架构请评审' })
  check('3.5 三角色档案里 @arch 被拒(角色集真收敛)', noArch.status === 'role_not_in_profile', noArch.status)

  const ok = await run(ctx, 'relay', { action: 'send', root: ROOT, from: 'pm', to: 'be', msg: '后端请开工' })
  check('3.6 档案内角色可互呼', ok.status !== 'role_not_in_profile' && ok.status !== 'invalid', ok.status)

  await run(ctx, 'relay', { action: 'profile', root: ROOT, profile: 'standard' })
  const back = await run(ctx, 'relay', { action: 'status', root: ROOT })
  check('3.7 切回 standard 生效', back.profileView.current === 'standard', back.profileView.current)
  check('3.8 切换被记住(状态文件里存了项目→档案)', JSON.parse(fs.readFileSync(statePath, 'utf8')).activeProfiles[ROOT] === 'standard')
}

// ── 4. 自动投递 + 去重 ─────────────────────────────────────────
{
  const ctx = mockCtx()
  apply(ctx, {})
  const spawned = await run(ctx, 'relay_spawn', { role: 'be', root: ROOT, prompt: '待命' })
  check('4.1 派出角色并登记 durable id', spawned.status === 'spawned' && spawned.agentId === 'child-be', spawned.status)
  check('4.2 人格被显式注入', spawned.personaInjected === true && spawned.personaChars > 40, String(spawned.personaChars))
  check('4.3 如实报告继承的父会话 preset', spawned.inheritedPreset === 'standard', spawned.inheritedPreset)

  sent.length = 0
  const r1 = await run(ctx, 'relay', { action: 'send', root: ROOT, from: 'pm', to: 'be', msg: '表结构请确认', release: true })
  check('4.4 自动投递成功', r1.status === 'done' && r1.delivery && r1.delivery.ok === true, JSON.stringify(r1.delivery))
  check('4.5 投递给目标角色的 durable id', sent.length === 1 && sent[0].targetId === 'child-be', JSON.stringify(sent))
  check('4.6 用的是真 AbortSignal', sent[0].realSignal === true)
  check('4.7 消息带【互呼】前缀', sent[0].text.indexOf('【互呼】') === 0, sent[0].text.slice(0, 8))
  check('4.8 coordination=proceed 且提示无需 send_message', r1.coordination === 'proceed' && JSON.stringify(r1.nextActions).indexOf('无需再调 send_message') !== -1)

  const r2 = await run(ctx, 'relay', { action: 'send', root: ROOT, from: 'pm', to: 'be', msg: '表结构请确认' })
  check('4.9 60 秒内重复互呼被去重(不重复投递)', r2.status === 'duplicate' && sent.length === 1, `${r2.status}/${sent.length}`)

  const r3 = await run(ctx, 'relay', { action: 'send', root: ROOT, from: 'pm', to: 'be', msg: '另一件事,内容不同' })
  check('4.10 内容不同则照常投递', r3.status === 'done' && sent.length === 2, `${r3.status}/${sent.length}`)
}

// ── 5. 投递失败必须回滚等待关系并如实记账 ────────────────────────────────
{
  const ctx = mockCtx()
  apply(ctx, {})
  await run(ctx, 'relay_spawn', { role: 'qa', root: ROOT })
  const r = await run(ctx, 'relay', { action: 'send', root: ROOT, from: 'pm', to: 'qa', msg: '请复测', targetAgentId: 'dead-agent' })
  check('5.1 投递失败不谎报成功', r.delivery && r.delivery.ok === false && r.coordination === 'halted', JSON.stringify(r.delivery))
  check('5.2 失败原因与错误码如实带出', String(r.delivery.reason).indexOf('unavailable') !== -1 && r.delivery.code === 'NOT_RESUMABLE', JSON.stringify(r.delivery))
  const st = await run(ctx, 'relay', { action: 'status', root: ROOT })
  check('5.3 失败后等待关系已释放(不留悬挂等待)', JSON.stringify(st.waitingView) === '{}', JSON.stringify(st.waitingView))
  check('5.4 投递失败计数递增', st.deliveryStats.deliveryFailures === 1, JSON.stringify(st.deliveryStats))
  check('5.5 给出可执行的补救指令', JSON.stringify(r.nextActions).indexOf('relay_spawn') !== -1 && JSON.stringify(r.nextActions).indexOf('不要改用 send_message') !== -1)

  // 投递统计与最后错误必须**分项目** —— 进程级全局量会让未开工的项目也报出
  // 别的项目的失败数/路径/错误。
  check('5.6 本项目统计带最后错误(分项目)', String(st.projectActivityView).indexOf('本项目') === 0 && String(st.projectActivityView).indexOf('失败 1') !== -1 && String(st.projectActivityView).indexOf('最后错误=') !== -1, String(st.projectActivityView))
  check('5.7 全局口径被显式标注(不再冒充本项目)', String(st.activityView).indexOf('进程累计(全部项目)') === 0 && (st.activityView.indexOf('最后错误') === -1 || st.activityView.indexOf('全局口径') !== -1), String(st.activityView))
  {
    const otherDir = path.join(TMP, 'other-proj')
    fs.mkdirSync(path.join(otherDir, 'docs', 'workflow'), { recursive: true })
    fs.writeFileSync(path.join(otherDir, 'docs', 'workflow', '.active'), 'active\n', 'utf8')
    const stOther = await run(ctx, 'relay', { action: 'status', root: otherDir })
    check('5.8 别的项目看不到本项目的失败数(不再跨项目污染)', stOther.deliveryStats.deliveryFailures === 0 && stOther.deliveryStats.deliveries === 0, JSON.stringify(stOther.deliveryStats))
    check('5.9 全局量仍可查(量在,只是不冒充本项目)', stOther.deliveryStatsGlobal.deliveryFailures >= 1, JSON.stringify(stOther.deliveryStatsGlobal))
  }
}

// ── 6. 熔断 / 仲裁 / 台账(编排语义不能被投递改造破坏)────────────────────
{
  const ctx = mockCtx()
  apply(ctx, {})
  const wb = await run(ctx, 'relay_spawn', { role: 'fe', root: ROOT })
  check('6.0 fe 已派出', wb.status === 'spawned', wb.status)
  const results = []
  for (let i = 0; i < 5; i += 1) {
    const r = await run(ctx, 'relay', { action: 'send', root: ROOT, from: 'fe', to: 'be', msg: `第${i}次确认`, release: true })
    results.push(r.status)
  }
  check('6.1 前五次全部 done', results.join(',') === 'done,done,done,done,done', results.join(','))
  // 显式传 project(人读标签)不得另开一个计数桶:按它分桶会让同一项目里出现
  // [platform6@F:\…] 与 [l-platform] 两种键,上限实际翻倍。
  // 用另一对角色(arch→fe)单独做,并在下面 fe→be 的熔断之前清掉它造出的仲裁事件。
  {
    const d7 = []
    for (let i = 0; i < 5; i += 1) {
      const r = await run(ctx, 'relay', { action: 'send', root: ROOT, from: 'arch', to: 'fe', msg: `同项目第 ${i} 条`, project: i % 2 === 0 ? '自报的项目名' : 'standard@别的路径', release: true })
      d7.push(r.status)
    }
    const d7sixth = await run(ctx, 'relay', { action: 'send', root: ROOT, from: 'arch', to: 'fe', msg: '同项目第 6 条', project: '第三个标签' })
    check('6.2b 换 project 标签不换桶(交替标签仍按 5 次熔断)', d7.join(',') === 'done,done,done,done,done' && d7sixth.status === 'limit', `${d7.join(',')}/${d7sixth.status}`)
    const stD7 = await run(ctx, 'relay', { action: 'status', root: ROOT })
    check('6.2c 熔断计数里该角色对只有一个桶', stD7.counters.filter((c) => c.from === 'arch' && c.to === 'fe').length === 1 && stD7.counters.filter((c) => c.from === 'arch' && c.to === 'fe')[0].used === 5, JSON.stringify(stD7.counters))
    await run(ctx, 'relay', { action: 'arbitrate', root: ROOT })
  }
  const sixth = await run(ctx, 'relay', { action: 'send', root: ROOT, from: 'fe', to: 'be', msg: '第6次确认' })
  check('6.2 第六次熔断', sixth.status === 'limit', sixth.status)
  check('6.3 熔断时不投递', sixth.delivery === null || sixth.delivery === undefined, JSON.stringify(sixth.delivery))
  const arb = await run(ctx, 'relay', { action: 'arbitrate', root: ROOT })
  check('6.4 熔断事件进仲裁队列并可取出', arb.count === 1 && arb.events[0].reason === 'limit', JSON.stringify(arb.events))
  // 被熔断/死锁拦下的**正文必须随事件一起保存** —— 否则仲裁等于把内容永久丢掉。
  check('6.4b 仲裁事件保留被拦下的正文(否则内容不可取回)',
    typeof arb.events[0].msg === 'string' && arb.events[0].msg.length > 0,
    JSON.stringify(String(arb.events[0].msg || '(无正文)')).slice(0, 120))
  const st = await run(ctx, 'relay', { action: 'status', root: ROOT })
  check('6.5 取出后队列清空', st.arbitrationPending === 0 && st.ledgerRows >= 6, `${st.arbitrationPending}/${st.ledgerRows}`)
}

// ── 7. 协作台账渲染与投影降级───────────────────────────────────────
{
  const ctx = mockCtx()
  apply(ctx, {})
  await run(ctx, 'relay_spawn', { role: 'be', root: ROOT })
  await run(ctx, 'relay', { action: 'send', root: ROOT, from: 'pm', to: 'be', msg: '台账用例' })
  const led = await run(ctx, 'relay', { action: 'ledger', root: ROOT })
  check('7.1 台账全文可渲染', led.status === 'ok' && led.ledgerText.indexOf('# 协作台账') === 0, led.status)
  check('7.2 台账含互呼记录', led.ledgerText.indexOf('台账用例') !== -1)
  check('7.3 无 fs 服务时降级为落盘指令(不静默丢数据)', !!led.persistInstruction && String(led.persistInstruction).indexOf('协作台账.md') !== -1, String(led.persistInstruction).slice(0, 40))
}

// ── 8. 重启对账:等待图作废、台账与计数保留 ──────────────────────────────
{
  const ctxA = mockCtx()
  apply(ctxA, {})
  await run(ctxA, 'relay_spawn', { role: 'be', root: ROOT })
  // 制造一个悬挂等待:不投递(noDeliver),于是 waiting 里留下 pm→be
  const left = await run(ctxA, 'relay', { action: 'send', root: ROOT, from: 'pm', to: 'be', msg: '悬挂等待用例', noDeliver: true })
  check('8.1 noDeliver 模式仍登记等待关系', left.status === 'done' && left.coordination === 'proceed', left.status)

  // 模拟进程重启:全新的 ctx,同一个 DSH_HOME
  const ctxB = mockCtx()
  apply(ctxB, {})
  const st = await run(ctxB, 'relay', { action: 'status', root: ROOT })
  check('8.2 重启后等待图被作废(不再假装还在等)', JSON.stringify(st.waitingView) === '{}', JSON.stringify(st.waitingView))
  check('8.3 作废的等待被记录而非静默丢弃', Array.isArray(st.staleWaiting) && st.staleWaiting.some((w) => w.role === 'pm'), JSON.stringify(st.staleWaiting))
  check('8.4 台账跨重启保留', st.ledgerRows > 0, String(st.ledgerRows))
  check('8.5 角色绑定跨重启保留', !!st.roleView.be && st.roleView.be.agentId === 'child-be', JSON.stringify(st.roleView))
}

// ── 9. 双计数(短板 ③)──────────────────────────────────────────────────
{
  const ctx = mockCtx()
  apply(ctx, {})
  const around = ctx._handlers['tools/execute'][0]
  const after = ctx._handlers['tools/post-execute'][0]
  let duringInFlight = -1
  const p = around({ name: 'read' }, async () => {
    const st = await run(ctx, 'relay', { action: 'status', root: ROOT })
    duringInFlight = Number(/在飞=(\d+)/.exec(st.activityView)[1])
    return { ok: true }
  })
  await p
  await after({ name: 'read' }, { isError: false }, async () => ({ kind: 'accept' }))
  const st2 = await run(ctx, 'relay', { action: 'status', root: ROOT })
  check('9.1 执行期间能读到"在飞=1"', duringInFlight === 1, String(duringInFlight))
  check('9.2 完成后在飞归零', /在飞=0/.test(st2.activityView), st2.activityView)
  check('9.3 已完成计数照常递增', /工具调用\(已完成\)=[1-9]/.test(st2.activityView), st2.activityView)
}

// ── 10. 只读角色工具收敛 ────────────────────────────────────────────────
{
  const ctx = mockCtx()
  apply(ctx, {})
  const qa = await run(ctx, 'relay_spawn', { role: 'qa', root: ROOT, force: true })
  check('10.1 qa 默认只读(profile 里标了)', qa.readonly === true)
  const sw = await run(ctx, 'relay', { action: 'profile', root: ROOT, profile: 'review' })
  check('10.2 review 档案两位角色都只读', sw.profileView.roles.join(',') === 'arch,qa')
  const arch = await run(ctx, 'relay_spawn', { role: 'arch', root: ROOT, force: true })
  check('10.3 review 档案下 arch 也是只读', arch.status === 'spawned' && arch.readonly === true, `${arch.status}/${arch.readonly}`)
}

// ── 11. 其余 action 分支(状态查询类,防手滑)────────────────────────────
{
  const ctx = mockCtx()
  apply(ctx, {})
  // 显式切回 standard:上面第 10 节把项目档案切成了 review,而档案是"按项目记住"的
  await run(ctx, 'relay', { action: 'profile', root: ROOT, profile: 'standard' })
  const prov = await run(ctx, 'relay', { action: 'providers', root: ROOT })
  check('11.1 providers 列出 spawn/fork', prov.providers.join(',') === 'spawn,fork', JSON.stringify(prov.providers))

  const pre = await run(ctx, 'relay', { action: 'presets', root: ROOT })
  // 预设是可选入口:装了一半也不报错,只是如实列出已装/未装
  check('11.2 presets 对照本 profile 的五个预设', Array.isArray(pre.expected) && pre.expected.length === 5 && pre.status === 'ok', `${pre.status}/${pre.expected && pre.expected.length}`)
  check('11.3 presets 如实列出已装/未装', String(pre.note).indexOf('已安装 2/5') !== -1 && String(pre.note).indexOf('未安装:') !== -1, String(pre.note))

  const use = await run(ctx, 'workflow_state_use', { root: ROOT, stateName: 'alpha' })
  check('11.4 use 切到 流程状态-alpha.md', String(use.targetPath).indexOf('流程状态-alpha.md') !== -1, String(use.targetPath))

  // 切回主状态文件时,回传的必须是**磁盘现有内容**(空模板被 write 下去会把真实进度整份清空)。
  // 所以 fixture 必须**先落盘再调 use**,否则这条只在"主文件本来就不存在"的环境里跑,测不到东西。
  const MAIN_REL = path.join(ROOT, 'docs', 'workflow', '流程状态.md')
  fs.writeFileSync(MAIN_REL, '# 流程状态:smoke\n\n## 当前进度\n- 已完成:① 项目经理 ✅\n\n## 待办\n- [ ] 甲\n- [ ] 乙\n', 'utf8')
  const useBack = await run(ctx, 'workflow_state_use', { root: ROOT })
  check('11.5 use 空参切回主状态文件', String(useBack.targetPath).indexOf('流程状态.md') !== -1 && String(useBack.targetPath).indexOf('alpha') === -1, String(useBack.targetPath))
  check('11.5b use 空参回传磁盘现有内容(不是空模板)', String(useBack.documentText).indexOf('① 项目经理 ✅') !== -1 && String(useBack.documentText).indexOf('- [ ] 乙') !== -1 && useBack.existingState === true, `existingState=${useBack.existingState} len=${String(useBack.documentText || '').length}`)
  check('11.5c use 空参的正文与磁盘逐字节一致(照抄不会清空进度)', useBack.documentText === fs.readFileSync(MAIN_REL, 'utf8'), 'documentText 与磁盘不一致')

  const load = await run(ctx, 'workflow_state_load', { root: ROOT })
  check('11.6 load 读回进度与待办', load.status === 'loaded' && load.todoOpen === 2, `${load.status}/${load.todoOpen}`)
  check('11.7 load 带出 profile', load.profileId === 'standard', load.profileId)

  // ── 多流程并行不只是"能读":stateName 要能通过参数传入并落盘,`.active` 里的 stateName= 也要被读到 ——
  // 否则子流程状态只能手抄。
  const subSave = await run(ctx, 'workflow_state_save', { root: ROOT, role: 'be', nextStep: '③ 后端开发', stateName: 'beta' })
  check('11.8 save 带 stateName 落到 流程状态-beta.md', String(subSave.targetPath).indexOf('流程状态-beta.md') !== -1, String(subSave.targetPath))
  check('11.9 save 回带 stateName', subSave.stateName === 'beta', String(subSave.stateName))
  check('11.10 save 的落盘指示指向子流程文件并提示同步 .active', String(subSave.persistInstruction).indexOf('流程状态-beta.md') !== -1 && String(subSave.persistInstruction).indexOf('stateName=beta') !== -1, String(subSave.persistInstruction))
  check('11.11 save 到子流程文件时主流程文件未被触碰', fs.readFileSync(MAIN_REL, 'utf8').indexOf('① 项目经理 ✅') !== -1 && !fs.existsSync(path.join(ROOT, 'docs', 'workflow', '流程状态-beta.md')), '主文件被动过或插件越权写盘')

  // 激活门里的 stateName=(workflow_state_use 的落盘指示就是往那儿写)必须被 status/load/save 四条路径一致认。
  fs.writeFileSync(path.join(ROOT, 'docs', 'workflow', '.active'), 'active\nstateName=alpha\n', 'utf8')
  fs.writeFileSync(path.join(ROOT, 'docs', 'workflow', '流程状态-alpha.md'), '# 流程状态:alpha\n\n## 待办\n- [ ] 丙\n- [ ] 丁\n- [ ] 戊\n', 'utf8')
  const gateLoad = await run(ctx, 'workflow_state_load', { root: ROOT })
  check('11.12 门里的 stateName 被 load 认(不再是"切了读不回")', String(gateLoad.targetPath).indexOf('流程状态-alpha.md') !== -1 && gateLoad.todoOpen === 3, `${gateLoad.targetPath}/${gateLoad.todoOpen}`)
  const gateSave = await run(ctx, 'workflow_state_save', { root: ROOT, role: 'fe' })
  check('11.13 门里的 stateName 被 save 认(子流程状态不再只能手抄)', String(gateSave.targetPath).indexOf('流程状态-alpha.md') !== -1, String(gateSave.targetPath))
  const gateStatus = await run(ctx, 'workflow_state_status', { root: ROOT })
  check('11.14 status 与 load/save 同口径', String(gateStatus.targetPath).indexOf('流程状态-alpha.md') !== -1 && gateStatus.stateName === 'alpha', `${gateStatus.targetPath}/${gateStatus.stateName}`)
  fs.writeFileSync(path.join(ROOT, 'docs', 'workflow', '.active'), 'active\n', 'utf8')
  const backMain = await run(ctx, 'workflow_state_status', { root: ROOT })
  check('11.15 门里 stateName 清掉后回到主文件(切换是双向的)', String(backMain.targetPath).indexOf('流程状态.md') !== -1 && String(backMain.targetPath).indexOf('alpha') === -1, String(backMain.targetPath))
}

// ── 12. 等待关系的三条释放路径(修 v1.0.0「只进不出」缺陷)────────────────
{
  // 本节换一个全新的 DSH_HOME:等待图/熔断窗口/角色绑定都在插件状态里,
  // 沿用上面的状态会让本节的互呼撞上前面用掉的配额(测试隔离,不是产品行为)。
  process.env.DSH_HOME = path.join(TMP, 'home2')
  const ctx = mockCtx()
  apply(ctx, {})
  await run(ctx, 'relay_spawn', { role: 'be', root: ROOT, force: true })
  const qa = await run(ctx, 'relay_spawn', { role: 'qa', root: ROOT, force: true })
  check('12.0 qa 已就绪', qa.status === 'spawned', qa.status)

  // 1) 回复闭合
  const ask = await run(ctx, 'relay', { action: 'send', root: ROOT, from: 'pm', to: 'be', msg: '契约请确认' })
  check('12.1 提问投递成功且进入等待', ask.status === 'done' && ask.coordination === 'proceed', `${ask.status}/${ask.coordination}`)
  const st1 = await run(ctx, 'relay', { action: 'status', root: ROOT })
  check('12.2 等待图登记 pm→be', !!st1.waitingView.pm && st1.waitingView.pm.to === 'be', JSON.stringify(st1.waitingView))

  // 由**子会话自己**回覆(真实方向:角色 → 它的父会话=调度者/pm)
  const reply = await runAs(ctx, childAgent, 'relay', { action: 'send', root: ROOT, from: 'be', to: 'pm', msg: '契约确认无误' })
  check('12.3 回覆不再被判成死锁环', reply.status === 'done', `${reply.status}/${reply.abort || ''}`)
  check('12.4 回覆闭合被如实报告', reply.replyClosed === 'pm', String(reply.replyClosed))
  const st2 = await run(ctx, 'relay', { action: 'status', root: ROOT })
  check('12.5 pm 的等待已释放,改为 be 等 pm', st2.waitingView.pm === undefined && !!st2.waitingView.be && st2.waitingView.be.to === 'pm', JSON.stringify(st2.waitingView))

  const again = await run(ctx, 'relay', { action: 'send', root: ROOT, from: 'pm', to: 'qa', msg: '请复测' })
  check('12.6 闭合后 pm 能继续互呼', again.status === 'done', `${again.status}/${again.abort || ''}`)

  // 2) 显式释放
  const rel = await run(ctx, 'relay', { action: 'release', root: ROOT, from: 'be' })
  check('12.7 release 释放指定角色的等待', rel.status === 'released' && rel.waitingView.be === undefined, `${rel.status}/${JSON.stringify(rel.waitingView)}`)
  const rel2 = await run(ctx, 'relay', { action: 'release', root: ROOT, from: 'be' })
  check('12.8 重复 release 是 noop(不报错)', rel2.status === 'noop', rel2.status)
  const relBad = await run(ctx, 'relay', { action: 'release', root: ROOT })
  check('12.9 release 缺参数给出明确错误', relBad.status === 'invalid', relBad.status)

  // 3) 超时释放
  const ctxT = mockCtx()
  apply(ctxT, { profiles: { standard: { relay: { waitTimeoutMs: 1 } } } })
  await run(ctxT, 'relay_spawn', { role: 'fe', root: ROOT, force: true })
  const w1 = await run(ctxT, 'relay', { action: 'send', root: ROOT, from: 'pm', to: 'fe', msg: '超时用例', noDeliver: true })
  check('12.10 超时用例已建立等待', w1.status === 'done', w1.status)
  await new Promise((resolve) => { setTimeout(resolve, 25) })
  const w2 = await run(ctxT, 'relay', { action: 'send', root: ROOT, from: 'arch', to: 'be', msg: '触发清扫', noDeliver: true })
  check('12.11 过期等待被自动释放并记账', w2.status === 'done' && Array.isArray(w2.expiredWaits) && w2.expiredWaits.length === 1, JSON.stringify(w2.expiredWaits))
  const stT = await run(ctxT, 'relay', { action: 'status', root: ROOT })
  check('12.12 释放后 pm 不再占位', stT.waitingView.pm === undefined, JSON.stringify(stT.waitingView))
  const led = await run(ctxT, 'relay', { action: 'ledger', root: ROOT })
  check('12.13 台账记下回复闭合与超时释放', led.ledgerText.indexOf('等待闭合') !== -1 && led.ledgerText.indexOf('超时释放') !== -1)
  check('12.14 noDeliver 的台账不谎报"已转发"', led.ledgerText.indexOf('已判定') !== -1 && led.ledgerText.indexOf('✅ 已转发') === -1)
}

// ── 13. api-architect 技能注册 + api_contract 工具─────────────────
{
  const skills = {
    _providers: [],
    _invalidations: 0,
    registerProvider(create) {
      const p = create({ invalidate: () => { skills._invalidations += 1 } })
      skills._providers.push(p)
      return () => { const i = skills._providers.indexOf(p); if (i >= 0) skills._providers.splice(i, 1) }
    },
  }
  const ctx = mockCtx({ skills })
  apply(ctx, {})

  // 13.a 技能注册(provider 形态)
  const sp = skills._providers[0]
  check('13.1 技能提供者已注册且名字是插件名', !!sp && sp.name === 'dev-workflow', sp ? sp.name : '(未注册)')
  const hidden = await sp.list({ cwd: path.join(TMP, 'not-active') })
  check('13.2 未激活项目里技能隐身(激活门)', hidden.candidates.length === 0 && hidden.complete === true, JSON.stringify(hidden.candidates))
  const shown = await sp.list({ cwd: ROOT })
  // 这条的口径是"激活项目里技能**现身**",写成对"一份还是十九份"都成立的断言 ——
  // 免得断言挂在**既有 id** 上(既有用例不许被改坏)。
  // 候选集到底该有哪 19 份,由第 40 节逐条守。
  check('13.3 激活项目里技能现身(至少 api-architect;角色联动技能同批出现)',
    shown.candidates.length >= 1 && shown.candidates.some((c) => c.name === 'api-architect'),
    JSON.stringify(shown.candidates.map((c) => c.name)))
  check('13.4 候选带 resourceBase 与 rank', !!shown.candidates[0].resourceBase && shown.candidates[0].resourceBase.path.indexOf('api-architect') !== -1 && shown.candidates[0].rank === 60, JSON.stringify(shown.candidates[0].resourceBase))
  const def = await sp.get(shown.candidates[0], { cwd: ROOT })
  check('13.5 get 回正文且剥掉 frontmatter', def.content.indexOf('# API Architect') !== -1 && def.content.indexOf('name: api-architect') === -1, String(def.content).slice(0, 40))
  check('13.6 声明为模型可调用', def.invocation && def.invocation.modelInvocable === true, JSON.stringify(def.invocation))
  check('13.7 只读提供者不写文件(只是投影)', typeof def.content === 'string' && def.content.length > 500, String(def.content.length))

  // 技能可见性不能"只认调用方 cwd":角色子会话的 cwd 继承调度者(≠ 项目根),只认 cwd 会让随包技能
  // 对角色永远不可见,而 relay status 按项目根算、照样报「可见」—— 自相矛盾。
  {
    const schedCwd = path.join(TMP, 'scheduler-cwd')
    fs.mkdirSync(schedCwd, { recursive: true })
    const qa = await run(ctx, 'relay_spawn', { role: 'qa', root: ROOT })
    live[qa.agentId].session.header.cwd = schedCwd
    const viaSched = await sp.list({ cwd: schedCwd })
    check('13.7b 角色子会话的 cwd(≠项目根)也能看见技能', viaSched.candidates.some((c) => c.name === 'api-architect'), JSON.stringify(viaSched.candidates.map((c) => c.name)))
    const strangerCwd = path.join(TMP, 'stranger-cwd')
    fs.mkdirSync(strangerCwd, { recursive: true })
    const stranger = await sp.list({ cwd: strangerCwd })
    check('13.7c 没派过角色的陌生 cwd 仍然隐身(不误开)', stranger.candidates.length === 0, JSON.stringify(stranger.candidates))
    live[qa.agentId].session.header.cwd = ROOT
  }

  // 13.b api_contract 工具
  const guide = await run(ctx, 'api_contract', { root: ROOT, action: 'guide' })
  check('13.8 guide 给范式与后续动作', guide.status === 'ok' && guide.text.indexOf('REST') !== -1 && guide.text.indexOf('api_contract action=lint') !== -1)
  check('13.9 guide 报出技能当前可见', guide.skillVisible === true && guide.skillName === 'api-architect', JSON.stringify([guide.skillVisible, guide.skillName]))

  const tpl = await run(ctx, 'api_contract', { root: ROOT, action: 'template', kind: 'openapi' })
  check('13.10 openapi 模板取到全文', tpl.status === 'ok' && tpl.documentText.indexOf('openapi:') !== -1 && tpl.documentText.length > 500, `${tpl.status}/${String(tpl.documentText).length}`)
  check('13.11 模板给出落盘目标与指令', tpl.targetPath.indexOf('docs') !== -1 && tpl.targetPath.indexOf('openapi.yaml') !== -1 && !!tpl.persistInstruction, tpl.targetPath)
  const tplProto = await run(ctx, 'api_contract', { root: ROOT, action: 'template', kind: 'proto' })
  check('13.12 proto 模板取到全文', tplProto.status === 'ok' && tplProto.documentText.indexOf('syntax = "proto3"') !== -1, String(tplProto.documentText).slice(0, 40))
  const tplBad = await run(ctx, 'api_contract', { root: ROOT, action: 'template', kind: 'nope' })
  check('13.13 未知模板给可用清单', tplBad.status === 'invalid_kind' && tplBad.note.indexOf('openapi') !== -1, tplBad.note)

  const chk = await run(ctx, 'api_contract', { root: ROOT, action: 'checklist' })
  check('13.14 checklist 出核对表', chk.status === 'ok' && chk.text.indexOf('api_contract action=lint') !== -1 && chk.text.indexOf('Idempotency-Key') !== -1)

  // 13.c lint 端到端(真扫盘)
  fs.mkdirSync(path.join(ROOT, 'docs', 'api'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'docs', 'api', 'openapi.yaml'), [
    'openapi: 3.1.0', 'info:', '  title: demo', '  version: 1.0.0', 'servers:', '  - url: https://api.example.com/v1',
    'paths:', '  /users:', '    get:', '      operationId: listUsers', '      responses:', '        "200": {}', '        "400": {}',
  ].join('\n'), 'utf8')
  const lint1 = await run(ctx, 'api_contract', { root: ROOT, action: 'lint' })
  check('13.15 lint 扫到契约且判定 PASS', lint1.status === 'ok' && lint1.specs.length === 1 && lint1.errors === 0 && lint1.verdict === 'pass', JSON.stringify({ n: lint1.specs.length, e: lint1.errors, v: lint1.verdict }))
  check('13.16 契约列表带类型', lint1.specs[0].kind === 'openapi', JSON.stringify(lint1.specs))

  fs.writeFileSync(path.join(ROOT, 'docs', 'api', 'bad.yaml'), ['swagger: "2.0"', 'paths:', '  /getUsers:', '    get: {}'].join('\n'), 'utf8')
  const lint2 = await run(ctx, 'api_contract', { root: ROOT, action: 'lint' })
  check('13.17 坏 spec 抓到 ERROR 并判 fail', lint2.errors > 0 && lint2.verdict === 'fail', `${lint2.errors}/${lint2.verdict}`)
  check('13.18 findings 带文件与修法', lint2.findings.every((f) => f.file && f.message) && lint2.findings.some((f) => f.fix), JSON.stringify(lint2.findings.slice(0, 2)))
  check('13.19 未清零时明确说别写进文档', lint2.note.indexOf('ERROR') !== -1, lint2.note)

  const st = await run(ctx, 'api_contract', { root: ROOT, action: 'status' })
  check('13.20 status 回上次 lint 结论', st.apiLint && st.apiLint.verdict === 'fail' && st.specs.length === 2, JSON.stringify(st.apiLint))
  check('13.21 status 不重跑 lint(只报现状)', st.errors === undefined, String(st.errors))

  const badAct = await run(ctx, 'api_contract', { root: ROOT, action: 'nope' })
  check('13.22 未知 action 给明确错误', badAct.status === 'invalid_action' && badAct.note.indexOf('guide') !== -1, badAct.note)

  // 13.c-2 端到端:模板原文不得无条件 PASS;lint 结论必须带可核对的指纹
  {
    const SPEC_REL = path.join(ROOT, 'docs', 'api', 'openapi.yaml')
    fs.writeFileSync(SPEC_REL, tpl.documentText, 'utf8')
    const lintTpl = await run(ctx, 'api_contract', { root: ROOT, action: 'lint' })
    check('13.22b 模板原文落盘 → 归属校验命中 ERROR(不再无条件 PASS)', lintTpl.errors > 0 && lintTpl.verdict === 'fail' && lintTpl.findings.some((f) => f.rule === 'vendor-template'), JSON.stringify({ e: lintTpl.errors, v: lintTpl.verdict, rules: lintTpl.findings.map((f) => f.rule) }))
    check('13.22c lint 结果带逐文件 sha256 与整批指纹', /^[0-9a-f]{64}$/.test(String(lintTpl.specDigest)) && lintTpl.specs.some((s) => /^[0-9a-f]{64}$/.test(String(s.sha256)) && s.bytes > 0), JSON.stringify({ digest: String(lintTpl.specDigest).slice(0, 8), specs: lintTpl.specs }))

    // 换成本项目自己的 spec:归属校验必须放行(不误杀),指纹随内容变
    fs.rmSync(path.join(ROOT, 'docs', 'api', 'bad.yaml'), { force: true })
    const OWN = [
      'openapi: 3.1.0', 'info:', '  title: 订单服务 API', '  version: 2.0.0',
      'servers:', '  - url: https://api.acme.internal/v2',
      'paths:', '  /orders:', '    get:', '      operationId: listOrders',
      '      parameters:', '        - name: page_size', '          in: query', '          schema:', '            type: integer',
      '      responses:', "        '200':", '          description: 订单列表', '          content:', '            application/json:',
      '              schema:', "                $ref: '#/components/schemas/OrderPage'",
      'components:', '  schemas:', '    OrderPage:', '      type: object', '      properties:',
      '        order_no:', '          type: string', '        total_amount:', '          type: integer',
    ].join('\n')
    fs.writeFileSync(SPEC_REL, OWN, 'utf8')
    const lintOwn = await run(ctx, 'api_contract', { root: ROOT, action: 'lint' })
    check('13.22d 改写为本项目的 spec 不被误杀', lintOwn.errors === 0 && !lintOwn.findings.some((f) => f.rule === 'vendor-template'), JSON.stringify({ e: lintOwn.errors, v: lintOwn.verdict, rules: lintOwn.findings.map((f) => f.rule) }))

    const stSame = await run(ctx, 'api_contract', { root: ROOT, action: 'status' })
    check('13.22e 指纹未变时不报漂移', stSame.specDrift === false && stSame.apiLint.digest === lintOwn.specDigest && stSame.specDigest === lintOwn.specDigest, JSON.stringify({ drift: stSame.specDrift, a: String(stSame.apiLint.digest).slice(0, 8), b: String(lintOwn.specDigest).slice(0, 8) }))

    // 契约被整体换掉后,上一次的「✅ PASS」必须自己作废
    fs.writeFileSync(SPEC_REL, `${OWN}\n# 悄悄改一行\n`, 'utf8')
    const stDrift = await run(ctx, 'api_contract', { root: ROOT, action: 'status' })
    check('13.22f 契约被改写 → status 报指纹漂移并作废旧结论', stDrift.specDrift === true && String(stDrift.note).indexOf('不是同一批文件') !== -1, stDrift.note)
    const driftText = ctx._tool('api_contract').output.render({}, stDrift).map((b) => b.text).join('\n')
    check('13.22g 漂移在渲染文本里可见(不只在 JSON 字段里)', driftText.indexOf('契约指纹漂移') !== -1, driftText.split('\n').filter((l) => l.indexOf('指纹') !== -1).join(' | '))
  }

  // 13.d 接线:流程状态小节 + relay status 视图
  const saved = await run(ctx, 'workflow_state_save', { root: ROOT, role: 'arch', nextStep: '③ 后端开发', apiSpecs: ['docs/api/openapi.yaml | 类型=openapi | 版本=/v1 | lint=ERROR 0'] })
  check('13.23 apiSpecs 落到「API 契约」小节', saved.documentText.indexOf('docs/api/openapi.yaml') !== -1 && saved.documentText.indexOf('## API 契约') !== -1)
  const relayStatus = await run(ctx, 'relay', { root: ROOT, action: 'status' })
  check('13.24 relay status 带 API 契约视图', !!relayStatus.apiView && String(relayStatus.apiView.lint).indexOf('ERROR') !== -1, JSON.stringify(relayStatus.apiView))
  const wfStatus = await run(ctx, 'workflow_state_status', { root: ROOT })
  check('13.25 workflow_state_status 报技能可见性', String(wfStatus.apiSkill).indexOf('api-architect') !== -1, String(wfStatus.apiSkill))
  // 插件不落盘:这里模拟会话把 BEGIN/END 之间的全文 write 下去,再验证 load 能读回
  fs.writeFileSync(path.join(ROOT, 'docs', 'workflow', '流程状态.md'), saved.documentText, 'utf8')
  const wfLoad = await run(ctx, 'workflow_state_load', { root: ROOT })
  check('13.26 workflow_state_load 带出 apiSpecs', String(wfLoad.apiSpecs).indexOf('openapi.yaml') !== -1, `${wfLoad.status}/${String(wfLoad.apiSpecs)}`)

  // 13.e 只读角色的白名单必须含 api_contract
  // (qa 在 standard 档案里就是只读角色,人设里又被要求跑 lint/checklist —— 这里守住它)
  {
    const qaSpecs = subagents._specs.filter((s) => s.label === 'qa')
    const qaSpec = qaSpecs[qaSpecs.length - 1]
    check('13.27 只读角色被收敛了工具集', !!qaSpec && !!qaSpec.request.toolFilter, JSON.stringify(qaSpec && qaSpec.request.toolFilter))
    const allow = (qaSpec && qaSpec.request.toolFilter && qaSpec.request.toolFilter.allow) || []
    check('13.28 只读白名单含 api_contract', allow.indexOf('api_contract') !== -1, allow.join(','))
    check('13.29 只读白名单含 skill(要能加载 api-architect)', allow.indexOf('skill') !== -1)
    check('13.30 只读白名单不含写类工具', ['write', 'edit', 'pwsh', 'workflow_state_save'].every((t) => allow.indexOf(t) === -1), allow.join(','))
  }

  // 13.f 空集不算通过(真实 qa 子会话里发现的漏洞)
  {
    const ctx2 = mockCtx()
    const emptyDir = path.join(TMP, 'empty-proj')
    fs.mkdirSync(path.join(emptyDir, 'docs', 'workflow'), { recursive: true })
    fs.writeFileSync(path.join(emptyDir, 'docs', 'workflow', '.active'), 'active\n', 'utf8')
    apply(ctx2, {})
    const le = await runAs(ctx2, { id: 'empty', session: { header: { cwd: emptyDir } } }, 'api_contract', { root: emptyDir, action: 'lint' })
    check('13.27 一个契约都没有 → no_specs', le.verdict === 'no_specs' && le.specs.length === 0, `${le.verdict}/${le.specs.length}`)
    check('13.28 空集时 note 明确"不算通过"', String(le.note).indexOf('不算通过') !== -1, le.note)
    const text = ctx2._tool('api_contract').output.render({}, le).map((b) => b.text).join('\n')
    check('13.29 渲染成"无契约可校验(不算通过)"', text.indexOf('无契约可校验') !== -1 && text.indexOf('✅ PASS') === -1, text.split('\n').filter((l) => l.indexOf('结论') !== -1).join(''))
  }

  // 13.g 关闭开关
  const ctxOff = mockCtx({ skills: { _providers: [], registerProvider: () => () => {} } })
  apply(ctxOff, { enableApi: false })
  check('13.30 enableApi=false 时不注册 api_contract', ctxOff._tools.every((t) => t.name !== 'api_contract'), ctxOff._tools.map((t) => t.name).join(','))
  const ctxMode = mockCtx({ skills })
  apply(ctxMode, { apiSkill: 'always' })
  const always = await skills._providers[skills._providers.length - 1].list({ cwd: path.join(TMP, 'not-active') })
  check('13.31 apiSkill=always 时未激活项目也现身', always.candidates.length === 1, JSON.stringify(always.candidates.length))
  const ctxNoSkills = mockCtx()
  apply(ctxNoSkills, {})
  check('13.32 skills 服务缺失时不炸(工具仍在)', ctxNoSkills._tools.length === 7, String(ctxNoSkills._tools.length))
}

// ── 14. 「同源」不变量:wf-* 预设的人格文本 == 插件 PERSONAS ────────────────
//
// 代码注释里写着"二者同源"。改了 PERSONAS 却忘了改预设,角色的两条入口就会说两套话
// (人工以 wf-* 开会话 vs 插件 relay_spawn 出的子会话),所以这里把它变成可回归的断言。
{
  const presetsDir = process.env.DSH_WF_PRESETS
    ? path.resolve(process.env.DSH_WF_PRESETS)
    : path.join(process.cwd(), '..', 'dev-workflow-presets')
  if (!fs.existsSync(presetsDir)) {
    console.log('(跳过同源校验:人工入口预设目录不存在 —— wf-* 预设默认不再安装,人格只在 PERSONAS 一处维护)')
  } else {
    function presetPersona(file) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
      const i = lines.findIndex((l) => /^\s+prefix: \|-/.test(l))
      if (i === -1) return null
      const out = []
      for (let k = i + 1; k < lines.length; k += 1) {
        if (/^ {6}\S/.test(lines[k])) out.push(lines[k].slice(6))
        else break
      }
      return out.join('\n')
    }
    const table = buildProfileTable(null, null)
    for (const role of ['pm', 'arch', 'be', 'fe', 'qa']) {
      const file = path.join(presetsDir, `wf-${role}`, 'agent.cordis.yml')
      if (!fs.existsSync(file)) { check(`14.${role} 预设文件存在`, false, file); continue }
      const preset = presetPersona(file)
      const persona = table.standard.roles.filter((r) => r.id === role)[0].persona
      check(`14.${role} 预设人格与 PERSONAS 同源`, preset === persona,
        preset === persona ? '' : `预设 ${String(preset).length} 字 vs 插件 ${String(persona).length} 字`)
    }
  }
}

// ── 15. 预设是可选项(wf-* 默认不再安装)───────────────────────────
{
  // 一个都没装:不是缺件,status 仍 ok,note 要说清"不影响流程"
  const ctx = mockCtx({ agentPresets: { list: async () => [] } })
  apply(ctx, {})
  const p = await run(ctx, 'relay', { action: 'presets', root: ROOT })
  check('15.1 未装预设时 status=ok(不再报 incomplete)', p.status === 'ok', `${p.status} | ${p.note}`)
  check('15.2 note 说明"可选、不影响流程"', p.note.indexOf('可选') !== -1 && p.note.indexOf('persona') !== -1, p.note)
  check('15.3 仍列出 5 个期望 id 供核对', Array.isArray(p.expected) && p.expected.length === 5, String(p.expected && p.expected.length))

  const st = await run(ctx, 'relay', { action: 'status', root: ROOT })
  const text = ctx._tool('relay').output.render({}, st).map((b) => b.text).join('\n')
  const presetLines = text.split('\n').filter((l) => l.indexOf('预设') !== -1)
  check('15.4 未装预设时不再刷 ❌(渲染层)', text.indexOf('❌') === -1, presetLines.join(' | '))
  check('15.5 渲染成"未安装(可选)"一行', presetLines.some((l) => l.indexOf('角色预设:未安装(可选') !== -1), presetLines.join(' | '))

  // 装了但组合坏了:这才真的影响人工开会话,必须报出来
  const ctxBroken = mockCtx({ agentPresets: { list: async () => [{ id: 'wf-qa', name: '坏预设', broken: 'plugin missing' }] } })
  apply(ctxBroken, {})
  const pb = await run(ctxBroken, 'relay', { action: 'presets', root: ROOT })
  check('15.6 装了但组合坏 → incomplete', pb.status === 'incomplete' && pb.note.indexOf('组合有误') !== -1, `${pb.status} | ${pb.note}`)
  const stb = await run(ctxBroken, 'relay', { action: 'status', root: ROOT })
  const textB = ctxBroken._tool('relay').output.render({}, stb).map((b) => b.text).join('\n')
  check('15.7 坏预设被渲染成"组合有误"', textB.indexOf('⚠️ 组合有误') !== -1, textB.split('\n').filter((l) => l.indexOf('wf-qa') !== -1).join(' | '))

  // 装齐了(旧行为)仍然正常
  const full = ['pm', 'arch', 'be', 'fe', 'qa'].map((r) => ({ id: `wf-${r}`, name: `dev-workflow ${r}` }))
  const ctxFull = mockCtx({ agentPresets: { list: async () => full } })
  apply(ctxFull, {})
  const pf = await run(ctxFull, 'relay', { action: 'presets', root: ROOT })
  check('15.8 五个都装了仍报已安装', pf.status === 'ok' && pf.note.indexOf('已安装 5/5') !== -1, pf.note)
}

// ── 16. 免文件激活(首用自动激活,不需要用户建 .active)──────────────
{
  const freshDir = path.join(TMP, 'fresh-proj')
  fs.mkdirSync(path.join(freshDir, 'docs', 'workflow'), { recursive: true })
  const freshAgent = { id: 'session-fresh', session: { header: { cwd: freshDir } } }
  const ctx = mockCtx()
  apply(ctx, {})

  const st0 = await runAs(ctx, freshAgent, 'workflow_state_status', { root: freshDir })
  check('16.1 新项目未激活,但告诉模型"零设置可开工"', st0.status === 'inactive' && st0.gate === 'none' && st0.autoStart === true, `${st0.status}/${st0.gate}`)
  check('16.2 未激活时不生成任何文件', !fs.existsSync(path.join(freshDir, 'docs', 'workflow', '流程状态.md')))

  const sp = await runAs(ctx, freshAgent, 'relay_spawn', { role: 'pm', root: freshDir })
  check('16.3 首次 relay_spawn 即自动激活', sp.status === 'spawned' && sp.activated === true, `${sp.status}/${sp.activated}`)
  check('16.4 激活不需要 .active 文件', !fs.existsSync(path.join(freshDir, 'docs', 'workflow', '.active')))
  const st1 = await runAs(ctx, freshAgent, 'workflow_state_status', { root: freshDir })
  check('16.5 之后 status=active,并报出激活来源', st1.status === 'active' && String(st1.gateSource).indexOf('插件记忆') !== -1, `${st1.status}/${st1.gateSource}`)
  // 注意:第 12 节把 DSH_HOME 换成了 home2,所以这里按当前 DSH_HOME 重新算路径
  const statePathNow = path.join(process.env.DSH_HOME, 'dev-workflow', 'state.json')
  const storeRaw = JSON.parse(fs.readFileSync(statePathNow, 'utf8'))
  check('16.6 激活记忆落进插件私有状态', !!storeRaw.activeProjects && !!storeRaw.activeProjects[freshDir], JSON.stringify(storeRaw.activeProjects))
  check('16.7 记忆里带原因', String((storeRaw.activeProjects[freshDir] || {}).reason).indexOf('relay_spawn:pm') !== -1, JSON.stringify(storeRaw.activeProjects))

  const ctx2 = mockCtx()
  apply(ctx2, {}) // 模拟重启:新进程、同一个 DSH_HOME
  const st2 = await runAs(ctx2, freshAgent, 'workflow_state_status', { root: freshDir })
  check('16.8 重启后激活记忆仍在', st2.status === 'active' && String(st2.gateSource).indexOf('插件记忆') !== -1, st2.gateSource)

  fs.writeFileSync(path.join(freshDir, 'docs', 'workflow', '.active'), 'off\n', 'utf8')
  const st3 = await runAs(ctx2, freshAgent, 'workflow_state_status', { root: freshDir })
  check('16.9 .active=off 显式关闭(压过记忆)', st3.status === 'inactive' && st3.gate === 'off', `${st3.status}/${st3.gate}`)
  const offKick = await runAs(ctx2, freshAgent, 'relay', { action: 'kickoff', root: freshDir, goal: '不该开工' })
  check('16.10 关闭状态下 kickoff 被拒', offKick.status === 'inactive', offKick.status)
  const offSave = await runAs(ctx2, freshAgent, 'workflow_state_save', { root: freshDir, role: 'pm' })
  check('16.11 关闭状态下 save 不生成文档', offSave.status === 'inactive' && offSave.documentText === undefined, offSave.status)
  fs.rmSync(path.join(freshDir, 'docs', 'workflow', '.active'))

  const healDir = path.join(TMP, 'heal-proj')
  fs.mkdirSync(path.join(healDir, 'docs', 'workflow'), { recursive: true })
  fs.writeFileSync(path.join(healDir, 'docs', 'workflow', '流程状态.md'), '# 流程状态\n', 'utf8')
  const heal = await runAs(ctx2, freshAgent, 'workflow_state_status', { root: healDir })
  check('16.12 已有流程状态文档即视为激活(跨机器自愈)', heal.status === 'active' && String(heal.gateSource).indexOf('流程状态文档') !== -1, `${heal.status}/${heal.gateSource}`)

  const saveDir = path.join(TMP, 'save-proj')
  fs.mkdirSync(path.join(saveDir, 'docs', 'workflow'), { recursive: true })
  const sv = await runAs(ctx2, freshAgent, 'workflow_state_save', { root: saveDir, role: 'pm', nextStep: '② 架构师' })
  check('16.13 直接 save 也会自动激活并出文档', sv.status === 'rendered' && sv.documentText.indexOf('② 架构师') !== -1, sv.status)
  const svSt = await runAs(ctx2, freshAgent, 'workflow_state_status', { root: saveDir })
  check('16.14 save 之后项目进入 active', svSt.status === 'active', svSt.status)
}

// ── 17. 一句话开工 relay action=kickoff────────────────────────────
{
  const koDir = path.join(TMP, 'kickoff-proj')
  fs.mkdirSync(path.join(koDir, 'docs', 'workflow'), { recursive: true })
  const agent = { id: 'session-ko', session: { header: { cwd: koDir } } }
  const ctx = mockCtx()
  apply(ctx, {})

  const r1 = await runAs(ctx, agent, 'relay', { action: 'kickoff', root: koDir, goal: '做一个任务清单 API' })
  check('17.1 一次调用派齐五角色', r1.status === 'started' && r1.spawned.length === 5, `${r1.status}/${JSON.stringify(r1.spawned.map((s) => s.role))}`)
  check('17.2 协调者第一个派(回话入口先就位)', r1.spawned[0].role === 'pm' && r1.coordinator === 'pm', JSON.stringify(r1.spawned.map((s) => s.role)))
  check('17.3 qa 按档案收敛为只读', r1.spawned.filter((s) => s.role === 'qa')[0].readonly === true, JSON.stringify(r1.spawned))
  check('17.4 生成初始流程状态文档', typeof r1.documentText === 'string' && r1.documentText.indexOf('## 待办') !== -1 && r1.documentText.indexOf('① 项目经理 理需求') !== -1, String(r1.documentText).slice(0, 60))
  check('17.5 给出落盘指令', String(r1.persistInstruction).indexOf('流程状态.md') !== -1, r1.persistInstruction)
  check('17.6 报出自动激活', r1.autoActivated === true, String(r1.autoActivated))
  check('17.7 需求写进待办', String(r1.documentText).indexOf('任务清单 API') !== -1)
  const koSt = await runAs(ctx, agent, 'workflow_state_status', { root: koDir })
  check('17.8 kickoff 之后项目是 active', koSt.status === 'active', koSt.status)

  const r2 = await runAs(ctx, agent, 'relay', { action: 'kickoff', root: koDir, goal: '再来一次' })
  check('17.9 重复 kickoff 不重派(幂等)', r2.status === 'already' && r2.skipped.length === 5 && r2.spawned.length === 0, `${r2.status}/${JSON.stringify(r2.skipped.map((s) => s.role))}`)

  const koDir2 = path.join(TMP, 'kickoff-proj2')
  fs.mkdirSync(path.join(koDir2, 'docs', 'workflow'), { recursive: true })
  const r3 = await runAs(ctx, agent, 'relay', { action: 'kickoff', root: koDir2, roles: ['be', '未知角色'] })
  check('17.10 roles 收窄 + 协调者自动补上', r3.roles.join(',') === 'pm,be' && r3.coordinatorAdded === true, JSON.stringify(r3.roles))
  check('17.11 不属于 profile 的角色被如实忽略', r3.rejectedRoles.join(',') === '未知角色', JSON.stringify(r3.rejectedRoles))
  check('17.12 真只派了两个角色', r3.spawned.length === 2, String(r3.spawned.length))

  const r4 = await runAs(ctx, agent, 'relay', { action: 'kickoff', root: koDir2, profile: 'lean3', roles: ['qa'] })
  check('17.13 换档案派该档案的角色集(协调者自动补)', r4.profileId === 'lean3' && r4.roles.join(',') === 'pm,qa', JSON.stringify(r4.roles))
  check('17.14 档案切换后角色绑定独立计数', r4.spawned.length === 2, String(r4.spawned.length))

  // 已有状态文档时不覆盖:补写后重跑
  fs.writeFileSync(path.join(koDir, 'docs', 'workflow', '流程状态.md'), '# 流程状态\n\n## 待办\n- [ ] 已有内容\n', 'utf8')
  const r5 = await runAs(ctx, agent, 'relay', { action: 'kickoff', root: koDir, force: true })
  check('17.15 已有状态文档 → 不覆盖,只回 existingState', r5.existingState === 'docs/workflow/流程状态.md' && r5.documentText === undefined, `${String(r5.existingState)}/${String(r5.documentText).slice(0, 20)}`)
  check('17.16 force=true 时重派(跳过逻辑可绕过)', r5.spawned.length === 5, String(r5.spawned.length))

  // 渲染层:开工回执要能一眼看懂
  const text = ctx._tool('relay').output.render({}, r1).map((b) => b.text).join('\n')
  check('17.17 回执列出每个角色的 agentId', text.indexOf('开工:profile=standard') !== -1 && text.indexOf('@pm') !== -1 && text.indexOf('child-pm') !== -1, text.split('\n').slice(0, 6).join(' | '))
  check('17.18 回执带初始流程状态文档', text.indexOf('-----BEGIN 流程状态.md-----') !== -1)
  // 回执必须有 spawned/skipped/failed 三段计数 —— 能从计数直接判出"重派还是跳过"
  check('17.19 回执分三段并带计数', text.indexOf('spawned(5):') !== -1 && text.indexOf('skipped(0):') !== -1 && text.indexOf('failed(0):') !== -1, text.split('\n').slice(0, 8).join(' | '))
  const text2 = ctx._tool('relay').output.render({}, r2).map((b) => b.text).join('\n')
  check('17.20 跳过时三段计数如实', text2.indexOf('spawned(0):') !== -1 && text2.indexOf('skipped(5):') !== -1, text2.split('\n').slice(0, 8).join(' | '))

  // 整段 goal 原文不得塞进「待办」首条(一条待办能到 600 字)
  const longGoal = `${'很长的需求描述'.repeat(40)}\n第二行还有内容`
  const koDir3 = path.join(TMP, 'kickoff-proj3')
  fs.mkdirSync(path.join(koDir3, 'docs', 'workflow'), { recursive: true })
  const r6 = await runAs(ctx, agent, 'relay', { action: 'kickoff', root: koDir3, goal: longGoal })
  const todoLine = String(r6.documentText).split('\n').filter((l) => l.indexOf('- [ ] ① 项目经理 理需求') !== -1)[0] || ''
  check('17.21 待办首条被截断(不撑成一段话)', todoLine.length > 0 && todoLine.length < 100 && todoLine.indexOf('…') !== -1, `${todoLine.length} 字:${todoLine.slice(0, 60)}`)
  check('17.22 goal 原文仍完整回传(没丢信息)', r6.goal === longGoal && r6.goal.length > 200, String(r6.goal && r6.goal.length))
}

// ── 18. 子会话 root 反查 / 开场白带项目根 / nextStep 单独生效 / deactivate ──
{
  const projDir = path.join(TMP, 'root-proj')
  fs.mkdirSync(path.join(projDir, 'docs', 'workflow'), { recursive: true })
  // 调度者 cwd 与项目根**故意不同** —— 这正是最容易踩到的坑
  const otherCwd = path.join(TMP, 'other-cwd')
  fs.mkdirSync(otherCwd, { recursive: true })
  const sched = { id: 'session-sched', session: { header: { cwd: otherCwd } } }
  const ctx = mockCtx()
  apply(ctx, {})
  subagents._unique = true // 反查靠 id 唯一性,这里让 mock 贴近现实

  const sp = await runAs(ctx, sched, 'relay_spawn', { role: 'pm', root: projDir })
  check('18.1 项目根≠调度者 cwd 时开场白补上项目根', sp.status === 'spawned' && sp.rootHint === true, `${sp.status}/${sp.rootHint}`)
  const lastSpec = subagents._specs[subagents._specs.length - 1]
  const promptText = String(lastSpec.request.prompt[0].text)
  check('18.2 开场白含【项目根】与 root= 指引', promptText.indexOf('【项目根】') !== -1 && promptText.indexOf(`root=${projDir}`) !== -1, promptText.slice(-90))

  // 子会话(cwd 继承调度者)不带 root 调工具 → 应自动反查到被登记的那个项目
  const child = { id: sp.agentId, session: { header: { cwd: otherCwd, parentSession: 'session-sched' } } }
  const st = await runAs(ctx, child, 'workflow_state_status', {})
  check('18.3 子会话不带 root 也落到正确项目(反查角色绑定)', st.root === projDir && st.status === 'active', `${st.root}/${st.status}`)
  const outsider = await runAs(ctx, { id: 'not-a-role', session: { header: { cwd: otherCwd } } }, 'workflow_state_status', {})
  check('18.4 非角色会话仍按 cwd 解析(没被误伤)', outsider.root === otherCwd && outsider.status === 'inactive', `${outsider.root}/${outsider.status}`)

  const sv = await runAs(ctx, sched, 'workflow_state_save', { root: projDir, nextStep: '② 架构师 出设计' })
  check('18.5 只给 nextStep 也写进「当前进度」', sv.documentText.indexOf('- 下一步:② 架构师 出设计') !== -1 && sv.documentText.indexOf('- 当前角色:(无)') !== -1, sv.documentText.split('\n').slice(3, 7).join(' | '))
  check('18.5a 调度者自己写走主会话落盘路径', sv.persistVia === 'session-write', String(sv.persistVia))

  // 子会话判定不能只靠 header.parentSession:角色子会话还有一条更强的信号 ——
  // 它的 id 就在本项目的角色绑定表里。只认前者会把落盘指示发给"永远看不到这条结果"的会话。
  const childNoParent = { id: sp.agentId, session: { header: { cwd: otherCwd } } }
  const svChild = await runAs(ctx, childNoParent, 'workflow_state_save', { root: projDir, nextStep: '② 架构师' })
  check('18.5b 没有 parentSession 的角色子会话仍按子会话给指示', svChild.persistVia === 'relay-to-coordinator' && String(svChild.persistInstruction).indexOf('relay action=send') !== -1, `${svChild.persistVia} | ${String(svChild.persistInstruction).slice(0, 60)}`)
  const outsiderSave = await runAs(ctx, { id: 'not-a-role', session: { header: { cwd: otherCwd } } }, 'workflow_state_save', { root: projDir })
  check('18.5c 非角色会话不被误判成子会话', outsiderSave.persistVia === 'session-write', String(outsiderSave.persistVia))

  // deactivate 必须同时解掉等待图(只解绑角色会留下 `arch→pm` 的假等待)
  await runAs(ctx, sched, 'relay', { action: 'send', root: projDir, from: 'arch', to: 'pm', msg: '悬挂等待用例', noDeliver: true })
  const stWait = await runAs(ctx, sched, 'relay', { action: 'status', root: projDir })
  check('18.5d 前置:等待图里留下一条等待', Object.keys(stWait.waitingView).length === 1 && stWait.waitingView.arch && stWait.waitingView.arch.to === 'pm', JSON.stringify(stWait.waitingView))

  const stateNow = path.join(process.env.DSH_HOME, 'dev-workflow', 'state.json')
  const before = JSON.parse(fs.readFileSync(stateNow, 'utf8'))
  check('18.6 前置:项目已在开工记忆里', !!(before.activeProjects || {})[projDir], JSON.stringify(Object.keys(before.activeProjects || {})))
  const de = await runAs(ctx, sched, 'relay', { action: 'deactivate', root: projDir })
  check('18.7 deactivate 撤销开工记忆', de.status === 'deactivated', `${de.status} | ${de.note}`)
  const after = await runAs(ctx, sched, 'workflow_state_status', { root: projDir })
  check('18.8 撤销后项目回到隐身', after.status === 'inactive' && after.gate === 'none', `${after.status}/${after.gate}`)
  const de2 = await runAs(ctx, sched, 'relay', { action: 'deactivate', root: projDir })
  check('18.9 重复 deactivate 是 noop', de2.status === 'noop', de2.status)
  check('18.10 deactivate 解掉等待图并如实回执', Array.isArray(de.releasedWaits) && de.releasedWaits.length === 1 && de.releasedWaits[0].role === 'arch' && de.releasedWaits[0].to === 'pm', JSON.stringify(de.releasedWaits))
  const stateAfterDe = JSON.parse(fs.readFileSync(stateNow, 'utf8'))
  const slotAfterDe = Object.values(stateAfterDe.projects).filter((s) => s.root === projDir)[0]
  check('18.11 等待图已落盘清空(不是只在内存里)', !!slotAfterDe && JSON.stringify(slotAfterDe.waiting || {}) === '{}', JSON.stringify(slotAfterDe && slotAfterDe.waiting))
}

// ── 19. 绑定验活 / 台账投影 / 惰性 GC 等修复逐条验证 ──────────────────────────────────────
{
  // 19.1~19.3 绑定验活:换过调度者(resume / fork / 重启新会话)的绑定必须自动重派
  const liveDir = path.join(TMP, 'liveness-proj')
  fs.mkdirSync(path.join(liveDir, 'docs', 'workflow'), { recursive: true })
  const ctxL = mockCtx()
  apply(ctxL, {})
  const schedA = { id: 'sched-A', session: { header: { cwd: liveDir } } }
  const schedB = { id: 'sched-B', session: { header: { cwd: liveDir } } }
  const first = await runAs(ctxL, schedA, 'relay_spawn', { role: 'pm', root: liveDir })
  check('19.1 首个调度者派出成功', first.status === 'spawned' && first.staleRebind === null, `${first.status}/${JSON.stringify(first.staleRebind)}`)
  const sameSched = await runAs(ctxL, schedA, 'relay_spawn', { role: 'pm', root: liveDir })
  check('19.2 同一调度者重复派仍是 exists(不误伤)', sameSched.status === 'exists', sameSched.status)
  const otherSched = await runAs(ctxL, schedB, 'relay_spawn', { role: 'pm', root: liveDir })
  check('19.3 换调度者 → 失效绑定自动重派(不再是 exists 蒙混)', otherSched.status === 'spawned'
    && otherSched.staleRebind && String(otherSched.staleRebind.reason).indexOf('另一个父会话') !== -1,
  `${otherSched.status}/${JSON.stringify(otherSched.staleRebind)}`)
  const otherSched2 = await runAs(ctxL, schedB, 'relay_spawn', { role: 'pm', root: liveDir })
  check('19.4 重派后新绑定稳定(exists)', otherSched2.status === 'exists', otherSched2.status)

  // 19.5~19.7 BUG-1 readonly 拦截:只读角色不得借 relay 派角色 / 改激活态
  const roDir = path.join(TMP, 'readonly-proj')
  fs.mkdirSync(path.join(roDir, 'docs', 'workflow'), { recursive: true })
  const ctxR = mockCtx()
  apply(ctxR, {})
  const archSpawn = await runAs(ctxR, schedA, 'relay_spawn', { role: 'arch', root: roDir, profile: 'review' })
  check('19.5 review 档案的 arch 是只读', archSpawn.status === 'spawned' && archSpawn.readonly === true, `${archSpawn.status}/${archSpawn.readonly}`)
  const archChild = live[archSpawn.agentId]
  const denied = await runAs(ctxR, archChild, 'relay', { action: 'kickoff', root: roDir, goal: '偷偷开工' })
  check('19.6 只读角色 kickoff 被拦', denied.status === 'readonly_denied', `${denied.status}/${String(denied.note).slice(0, 40)}`)
  const deniedDe = await runAs(ctxR, archChild, 'relay', { action: 'deactivate', root: roDir })
  check('19.7 只读角色 deactivate 被拦', deniedDe.status === 'readonly_denied', deniedDe.status)
  const allowedStatus = await runAs(ctxR, archChild, 'relay', { action: 'status', root: roDir })
  check('19.8 只读角色仍可用 status(没封死)', allowedStatus.status === 'ok', allowedStatus.status)

  // 19.9~19.11 deactivate 必须同时解绑,否则重派会被"已登记"挡住
  const deDir = path.join(TMP, 'deact-proj')
  fs.mkdirSync(path.join(deDir, 'docs', 'workflow'), { recursive: true })
  const ctxD = mockCtx()
  apply(ctxD, {})
  await runAs(ctxD, schedA, 'relay_spawn', { role: 'be', root: deDir })
  const d1 = await runAs(ctxD, schedA, 'relay', { action: 'deactivate', root: deDir })
  check('19.9 deactivate 同时解绑角色', d1.status === 'deactivated' && d1.releasedRoles.join(',') === 'be', `${d1.status}/${JSON.stringify(d1.releasedRoles)}`)
  const d2 = await runAs(ctxD, schedA, 'relay', { action: 'deactivate', root: deDir })
  check('19.10 重复 deactivate 仍是 noop', d2.status === 'noop', `${d2.status}/${JSON.stringify(d2.releasedRoles)}`)
  const respawn = await runAs(ctxD, schedA, 'relay_spawn', { role: 'be', root: deDir })
  check('19.11 解绑后可干净重派', respawn.status === 'spawned', respawn.status)

  // 19.12~19.14 BUG-6 "fs 服务不可用"不得永久污染否定缓存
  const fsDir = path.join(TMP, 'fs-proj')
  fs.mkdirSync(path.join(fsDir, 'docs', 'workflow'), { recursive: true })
  let fsAttempts = 0
  const writtenTo = []
  let fsReady = false
  const fsSvc = {
    resolve: async (p) => p,
    writeText: async (target, text) => { fsAttempts += 1; writtenTo.push({ target, len: String(text).length }) },
  }
  const ctxF = mockCtx({ fs: fsSvc })
  const origGet = ctxF.get
  ctxF.get = (n) => (n === 'fs' && !fsReady ? undefined : origGet(n))
  apply(ctxF, {})
  await runAs(ctxF, schedA, 'relay_spawn', { role: 'qa', root: fsDir })
  const l1 = await runAs(ctxF, schedA, 'relay', { action: 'ledger', root: fsDir })
  check('19.12 fs 未就绪 → 退回落盘指令(不静默丢数据)', l1.status === 'ok' && !!l1.persistInstruction && l1.ledgerText.indexOf('# 协作台账') === 0, l1.ledgerStatus)
  fsReady = true
  const l2 = await runAs(ctxF, schedA, 'relay', { action: 'ledger', root: fsDir })
  check('19.13 fs 就绪后**立刻重试并成功**', fsAttempts === 1 && String(l2.ledgerStatus).indexOf('已由插件直接写入') !== -1, `${fsAttempts}/${l2.ledgerStatus}`)
  const l3 = await runAs(ctxF, schedA, 'relay', { action: 'ledger', root: fsDir })
  check('19.14 直写成功不再重复回全文(省掉双倍 token)', l3.ledgerText === undefined && fsAttempts === 2, `${String(l3.ledgerText).slice(0, 20)}/${fsAttempts}`)
  check('19.15 两条落盘路径统一为覆盖写(不再是追加快照)', writtenTo.length === 2 && writtenTo[1].len === writtenTo[0].len, JSON.stringify(writtenTo.map((w) => w.len)))

  // 19.16~19.17 BUG-4 stateName 净化
  const snDir = path.join(TMP, 'statename-proj')
  fs.mkdirSync(path.join(snDir, 'docs', 'workflow'), { recursive: true })
  const ctxS = mockCtx()
  apply(ctxS, {})
  await runAs(ctxS, schedA, 'relay_spawn', { role: 'be', root: snDir })
  const sn = await runAs(ctxS, schedA, 'workflow_state_use', { root: snDir, stateName: '../../evil$&x' })
  check('19.16 stateName 被净化(不逃出 docs/workflow)', sn.targetPath.indexOf('..') === -1 && sn.targetPath.indexOf('docs') !== -1, sn.targetPath)
  check('19.17 净化后的名字仍可辨认', sn.targetPath.indexOf('evil') !== -1 && sn.targetPath.indexOf('流程状态-') !== -1, sn.targetPath)

  // 19.18~19.20 BUG-2 默认文档按档案现算,不再指向不存在的角色
  const rvDir = path.join(TMP, 'review-doc-proj')
  fs.mkdirSync(path.join(rvDir, 'docs', 'workflow'), { recursive: true })
  const ctxV = mockCtx()
  apply(ctxV, {})
  const ko = await runAs(ctxV, schedA, 'relay', { action: 'kickoff', root: rvDir, profile: 'review', roles: ['arch'], goal: '评审一下' })
  check('19.18 review 档案全只读 → 明说没人能落盘(BUG-5)', ko.readonlyProfile === true && String(ko.persistInstruction).indexOf('只读档案') !== -1, String(ko.persistInstruction).slice(0, 30))
  const sv2 = await runAs(ctxV, schedA, 'workflow_state_save', { root: rvDir, profile: 'review' })
  check('19.19 review 文档不指向不存在的 ① 项目经理', sv2.documentText.indexOf('① 项目经理') === -1 && sv2.documentText.indexOf('② 架构师') !== -1, sv2.documentText.split('\n').slice(3, 6).join(' | '))
  check('19.20 产出文件不再预填两份不存在的 .md', sv2.documentText.indexOf('需求清单:docs/workflow/项目经理.md') === -1, String(sv2.documentText).slice(0, 200))
  check('19.21 standard 档案仍是 ① 项目经理(行为不变)', buildProfileTable(null, null).standard.coordinator === 'pm')

  // 19.22~19.23 台账入库只存投影,全文进边车。
  // 注意:这里必须用**隔离的 DSH_HOME** 读文件。smoke 里每个 block 都会 apply() 一次,
  // 而每个插件实例各持一份内存 store、各自 saveStore() 整份覆盖同一个 state.json ——
  // 多个实例并存时盘上是谁最后写的就是谁的。
  const lgDir = path.join(TMP, 'ledger-proj')
  fs.mkdirSync(path.join(lgDir, 'docs', 'workflow'), { recursive: true })
  const isoHome = path.join(TMP, 'iso-home')
  fs.mkdirSync(isoHome, { recursive: true })
  const homeBefore = process.env.DSH_HOME
  process.env.DSH_HOME = isoHome
  const ctxG = mockCtx()
  apply(ctxG, {})
  await runAs(ctxG, schedA, 'relay_spawn', { role: 'be', root: lgDir })
  const longMsg = '长消息正文测试。'.repeat(50)
  await runAs(ctxG, schedA, 'relay', { action: 'send', root: lgDir, from: 'pm', to: 'be', msg: longMsg })
  // send 路径本身不落盘(靠 post-execute 每 25 次刷一次),这里用一次会 saveStore 的动作强制刷新
  await runAs(ctxG, schedA, 'workflow_state_save', { root: lgDir, nextStep: '触发落盘' })
  const isoState = path.join(isoHome, 'dev-workflow', 'state.json')
  const snapG = JSON.parse(fs.readFileSync(isoState, 'utf8'))
  const slotG = Object.values(snapG.projects).find((p) => p.root === lgDir)
  const rowG = slotG ? (slotG.ledger || []).find((r) => r.summaryLen === longMsg.length) : undefined
  check('19.22 台账入库是投影不是全文', !!rowG && rowG.summary.length <= 120 && rowG.summaryTruncated === true && rowG.summaryLen === longMsg.length,
    rowG ? `len=${rowG.summary.length}/${rowG.summaryLen}` : `没找到该行;slots=${Object.values(snapG.projects).map((p) => `${String(p.root).split(path.sep).pop()}:${(p.ledger || []).length}`).join('|')} 期望 summaryLen=${longMsg.length}`)
  const sidecarDir = path.join(isoHome, 'dev-workflow', 'ledger')
  const sidecarFiles = fs.existsSync(sidecarDir) ? fs.readdirSync(sidecarDir) : []
  const sidecarHit = !!rowG && sidecarFiles.some((f) => fs.readFileSync(path.join(sidecarDir, f), 'utf8').indexOf(rowG.summaryHash) !== -1)
  check('19.23 全文转存到插件私有边车(可按哈希回查)', sidecarFiles.length > 0 && sidecarHit, JSON.stringify(sidecarFiles))
  // 19.24 状态文件不该再被消息全文撑大:23 行全文占 83.9%
  const wholeState = fs.readFileSync(isoState, 'utf8')
  check('19.24 状态文件里不出现超长正文(投影生效)', wholeState.indexOf(longMsg.slice(0, 200)) === -1 && wholeState.length < 20000, `字节=${wholeState.length}`)
  process.env.DSH_HOME = homeBefore

  // 19.25~19.26 的两个洞:惰性 GC 不落盘、以及"永不被访问"的槽无人回收
  const sweepRoot = path.join(TMP, 'sweep-proj')
  fs.mkdirSync(path.join(sweepRoot, 'docs', 'workflow'), { recursive: true })
  const sweepHome = path.join(TMP, 'sweep-home')
  fs.mkdirSync(sweepHome, { recursive: true })
  const homeBefore2 = process.env.DSH_HOME
  process.env.DSH_HOME = sweepHome
  const ctxW = mockCtx()
  apply(ctxW, {})
  await runAs(ctxW, schedA, 'relay_spawn', { role: 'be', root: sweepRoot })
  fs.rmSync(sweepRoot, { recursive: true, force: true })
  // 走一次该槽(触发惰性 GC),然后**只读文件**看它到底落盘没有
  await runAs(ctxW, schedA, 'relay', { action: 'deactivate', root: sweepRoot })
  const sweepState = path.join(sweepHome, 'dev-workflow', 'state.json')
  const sw1 = JSON.parse(fs.readFileSync(sweepState, 'utf8'))
  const swSlot = Object.values(sw1.projects).find((p) => p.root === sweepRoot)
  check('19.25 目录消失后惰性 GC **就地落盘**',
    !!swSlot && Object.keys(swSlot.roleAgents || {}).length === 0 && swSlot.rootMissing === true,
    swSlot ? `bindings=${Object.keys(swSlot.roleAgents || {}).length} rootMissing=${swSlot.rootMissing}` : '无槽')

  // apply 时的全量清扫:回收一个**永远不会被访问**的死槽(模拟两个独立沙盒的处境)
  const orphanHome = path.join(TMP, 'orphan-home')
  fs.mkdirSync(path.join(orphanHome, 'dev-workflow'), { recursive: true })
  const orphanState = path.join(orphanHome, 'dev-workflow', 'state.json')
  const ghostRoot = path.join(TMP, 'ghost-proj-never-exists')
  fs.writeFileSync(orphanState, JSON.stringify({
    version: 1, boot: '', updatedAt: '', activeProfiles: {}, activeProjects: {}, dedupe: {}, lifetime: {},
    projects: {
      [`standard@${ghostRoot}`]: { root: ghostRoot, profile: 'standard', roleAgents: { pm: 'ghost-1', qa: 'ghost-2' }, ledger: [] },
    },
  }), 'utf8')
  process.env.DSH_HOME = orphanHome
  const ctxO = mockCtx()
  apply(ctxO, {})
  const orphanAfter = JSON.parse(fs.readFileSync(orphanState, 'utf8'))
  const oSlot = orphanAfter.projects[`standard@${ghostRoot}`]
  check('19.26 apply 时的全量清扫回收从未被访问的死槽,并在 status 里如实回报',
    !!oSlot && Object.keys(oSlot.roleAgents || {}).length === 0
    && oSlot.reclaimed && oSlot.reclaimed.by === 'sweep-on-boot' && oSlot.reclaimed.bindings === 2,
    oSlot ? JSON.stringify(oSlot.reclaimed) : '无槽')
  const oSt = await runAs(ctxO, schedA, 'relay', { action: 'status', root: ghostRoot })
  check('19.27 清扫结果出现在 status 回执里(不是静默清数据)',
    Array.isArray(oSt.bootSweep) && oSt.bootSweep.length === 1 && oSt.bootSweep[0].bindings === 2,
    JSON.stringify(oSt.bootSweep))
  process.env.DSH_HOME = homeBefore2
}

// ── 20. 版本自证 / 开关 / 熔断 / 文案口径回归──────────────────────────────────────────
{
  const sched20 = { id: 'sched-20', session: { header: { cwd: ROOT } } }
  const newProj = (name, withActive) => {
    const p = path.join(TMP, name)
    fs.mkdirSync(path.join(p, 'docs', 'workflow'), { recursive: true })
    if (withActive) fs.writeFileSync(path.join(p, 'docs', 'workflow', '.active'), 'active\n', 'utf8')
    return p
  }
  const isoHome20 = (name, stateObj) => {
    const h = path.join(TMP, name)
    fs.mkdirSync(path.join(h, 'dev-workflow'), { recursive: true })
    if (stateObj) fs.writeFileSync(path.join(h, 'dev-workflow', 'state.json'), JSON.stringify(stateObj), 'utf8')
    return h
  }
  const readState20 = (h) => JSON.parse(fs.readFileSync(path.join(h, 'dev-workflow', 'state.json'), 'utf8'))
  const home0 = process.env.DSH_HOME

  const proj20 = newProj('p20', false)

  // 20.1~20.2 版本自证
  process.env.DSH_HOME = isoHome20('p20-home')
  const ctxV = mockCtx()
  apply(ctxV, {})
  const stV = await runAs(ctxV, sched20, 'relay', { action: 'status', root: proj20 })
  check('20.1 relay status 自报**本进程已加载**的版本', stV.version === VERSION && stV.versions && stV.versions.loaded === VERSION,
    JSON.stringify(stV.versions))
  check('20.2 版本与磁盘 package.json 一致(测试环境无漂移)', stV.versions.mismatch === false, JSON.stringify(stV.versions))
  const apiInactive = await runAs(ctxV, sched20, 'api_contract', { action: 'status', root: proj20 })
  // 未激活文案不许重复成「未激活(未激活)」
  check('20.3 未激活文案不再重复成 未激活(未激活)', apiInactive.skillHiddenReason === '未激活', String(apiInactive.skillHiddenReason))

  // 20.4~20.5 两个开关互不牵连
  const ctxNoRelay = mockCtx()
  apply(ctxNoRelay, { enableRelay: false })
  check('20.4 enableRelay=false 不再连带关掉 api_contract',
    ctxNoRelay._tools.map((t) => t.name).join(',') === 'api_contract', ctxNoRelay._tools.map((t) => t.name).join(','))
  const ctxNoApi = mockCtx()
  apply(ctxNoApi, { enableApi: false })
  check('20.5 enableApi=false 只关 api_contract,relay 与状态工具仍在',
    ctxNoApi._tools.map((t) => t.name).sort().join(',') === 'relay,relay_spawn,workflow_state_load,workflow_state_save,workflow_state_status,workflow_state_use',
    ctxNoApi._tools.map((t) => t.name).join(','))

  // 20.6~20.7 未知 action / 字符串布尔
  const badAction = await runAs(ctxV, sched20, 'relay', { action: 'deactivatee', root: proj20, from: 'pm', to: 'be', msg: '这不该被投出去' })
  check('20.6 未知 action 报 invalid_action',
    badAction.status === 'invalid_action' && String(badAction.note).indexOf('send') !== -1, `${badAction.status}:${badAction.note}`)
  const strBool = await runAs(ctxV, sched20, 'relay', { action: 'send', root: proj20, from: 'pm', to: 'be', msg: '字符串布尔用例', noDeliver: 'true' })
  check('20.7 noDeliver:"true"(字符串)也算 true',
    !!strBool.delivery && strBool.delivery.via === 'off', JSON.stringify(strBool.delivery))

  // 20.8 失败的投递不占熔断额度
  const projN9 = newProj('p20n9', true)
  process.env.DSH_HOME = isoHome20('p20n9-home')
  const ctxN9 = mockCtx()
  apply(ctxN9, {})
  let nLimit = 0
  let nNoReply = 0
  for (let i = 0; i < 6; i += 1) {
    // be 没有任何 agent 绑定 → 每次都投递失败;失败的投递不占熔断额度
    const r = await runAs(ctxN9, sched20, 'relay', { action: 'send', root: projN9, from: 'pm', to: 'be', msg: `失败投递压测 #${i}` })
    if (r.status === 'limit') nLimit += 1
    if (r.status === 'no_reply') nNoReply += 1
  }
  const stN9 = await runAs(ctxN9, sched20, 'relay', { action: 'status', root: projN9 })
  const bucketN9 = (stN9.counters || []).find((c) => c.from === 'pm' && c.to === 'be')
  check('20.8 连续 6 次投递失败仍未熔断',
    nLimit === 0 && nNoReply === 6 && (!bucketN9 || bucketN9.used === 0),
    `limit=${nLimit} no_reply=${nNoReply} used=${bucketN9 ? bucketN9.used : '(无桶)'}`)

  // 20.9 清掉的旧桶必须落盘
  const projPrune = newProj('p20prune', false)
  const oldBucket = `pm\u0000be\u0000${path.basename(projPrune)}`
  const pruneHome = isoHome20('p20prune-home', {
    version: 1, boot: '', updatedAt: '', activeProfiles: {}, activeProjects: {}, dedupe: {}, lifetime: {},
    projects: {
      [`standard@${projPrune}`]: { root: projPrune, profile: 'standard', relayTs: { [oldBucket]: [Date.now()] }, roleAgents: {}, ledger: [] },
    },
  })
  process.env.DSH_HOME = pruneHome
  const ctxPrune = mockCtx()
  apply(ctxPrune, {})
  await runAs(ctxPrune, sched20, 'relay', { action: 'status', root: projPrune })
  const pruned = readState20(pruneHome)
  const prunedSlot = pruned.projects[`standard@${projPrune}`]
  check('20.9 旧桶清完**落盘**',
    !!prunedSlot && Object.keys(prunedSlot.relayTs || {}).length === 0 && !!prunedSlot.bucketPruned && prunedSlot.bucketPruned.dropped === 1,
    prunedSlot ? `relayTs=${JSON.stringify(Object.keys(prunedSlot.relayTs || {}))} pruned=${JSON.stringify(prunedSlot.bucketPruned)}` : '无槽')

  // 20.10 落盘次数跨重启续接
  const writesHome = isoHome20('p20writes-home', {
    version: 1, boot: '', updatedAt: '', projects: {}, activeProfiles: {}, activeProjects: {}, dedupe: {},
    lifetime: { stateSaves: 0, relayCalls: 0, spawns: 0, toolCalls: 0, deliveries: 0, deliveryFailures: 0, storeWrites: 41 },
  })
  process.env.DSH_HOME = writesHome
  const ctxW2 = mockCtx()
  apply(ctxW2, {})
  const stW2 = await runAs(ctxW2, sched20, 'relay', { action: 'status', root: proj20 })
  const mW2 = /已写 (\d+) 次/.exec(String(stW2.stateHealth))
  check('20.11 落盘次数从盘上续接',
    !!mW2 && Number(mW2[1]) >= 42, `status=${mW2 && mW2[1]} 期望>=42`)

  // 20.12~20.14 读不出来 / 内容坏掉,都不能静默覆盖
  const lockHome = isoHome20('p20lock-home')
  const lockDir = path.join(lockHome, 'dev-workflow', 'state.json')
  fs.mkdirSync(lockDir) // 目录冒充文件 → readFileSync 抛 EISDIR(非 ENOENT)
  process.env.DSH_HOME = lockHome
  const ctxLock = mockCtx()
  apply(ctxLock, {})
  const stLock = await runAs(ctxLock, sched20, 'relay', { action: 'status', root: proj20 })
  check('20.12 状态文件读不出来时**锁存不落盘**',
    String(stLock.stateHealth).indexOf('锁存') !== -1 && fs.statSync(lockDir).isDirectory(), String(stLock.stateHealth).slice(0, 120))

  const badHome = isoHome20('p20bad-home')
  const badFile = path.join(badHome, 'dev-workflow', 'state.json')
  const brokenJson = '{"version":1,"projects":{"standard@X":{"root":"X","roleAgents":{"pm":"keep-me"}}'
  fs.writeFileSync(badFile, brokenJson, 'utf8')
  process.env.DSH_HOME = badHome
  const ctxBad = mockCtx()
  apply(ctxBad, {})
  const badFiles = fs.readdirSync(path.join(badHome, 'dev-workflow')).filter((f) => /^state\.json\.bad-\d{14}$/.test(f))
  check('20.13 坏状态文件被**隔离留证**',
    badFiles.length === 1 && fs.readFileSync(path.join(badHome, 'dev-workflow', badFiles[0]), 'utf8') === brokenJson,
    JSON.stringify(fs.readdirSync(path.join(badHome, 'dev-workflow'))))
  const stBad = await runAs(ctxBad, sched20, 'relay', { action: 'status', root: proj20 })
  check('20.14 隔离这件事在 status 里如实可见', String(stBad.stateHealth).indexOf('解析失败') !== -1, String(stBad.stateHealth).slice(0, 120))

  // 20.15 lint 记录没存指纹时,不许宣称"与磁盘一致"
  const apiProj = newProj('p20api', false)
  fs.mkdirSync(path.join(apiProj, 'docs', 'api'), { recursive: true })
  fs.writeFileSync(path.join(apiProj, 'docs', 'api', 'openapi.yaml'), [
    'openapi: 3.0.3',
    'info:',
    '  title: p20',
    '  version: 1.0.0',
    'paths:',
    '  /ping:',
    '    get:',
    '      operationId: ping',
    '      responses:',
    "        '200':",
    '          description: ok',
  ].join('\n'), 'utf8')
  const apiHome = isoHome20('p20api-home', {
    version: 1, boot: '', updatedAt: '', activeProfiles: {}, activeProjects: {}, dedupe: {}, lifetime: {},
    projects: {
      [`standard@${apiProj}`]: {
        root: apiProj, profile: 'standard', roleAgents: {}, ledger: [],
        apiLint: { at: '2026-09-12 14:18:11', root: apiProj, files: 1, errors: 0, warnings: 0, verdict: 'pass' },
      },
    },
  })
  process.env.DSH_HOME = apiHome
  const ctxApi = mockCtx()
  apply(ctxApi, {})
  const stApi = await runAs(ctxApi, sched20, 'api_contract', { action: 'status', root: apiProj })
  check('20.15 旧记录没存指纹 → specDrift=null 且文案说"没存指纹"',
    stApi.specDrift === null && stApi.specDriftUnknown === true && String(stApi.note).indexOf('没存指纹') !== -1,
    `drift=${JSON.stringify(stApi.specDrift)} note=${String(stApi.note).slice(0, 80)}`)

  // 20.16 `.active` 单行同时写 stateName= 与 profile= 时不许把 profile 吃进文件名
  const projM6 = newProj('p20m6', false)
  fs.writeFileSync(path.join(projM6, 'docs', 'workflow', '.active'), 'active stateName=alpha profile=lean3\n', 'utf8')
  process.env.DSH_HOME = isoHome20('p20m6-home')
  const ctxM6 = mockCtx()
  apply(ctxM6, {})
  const savedM6 = await runAs(ctxM6, sched20, 'workflow_state_save', { root: projM6, role: 'pm' })
  const pathM6 = String(savedM6.targetPath || savedM6.persistInstruction || '')
  check('20.16 单行 .active 的 stateName 解析到空白为止',
    pathM6.indexOf('流程状态-alpha.md') !== -1 && pathM6.indexOf('profile') === -1, pathM6.slice(0, 160))

  // 20.17 自定义档案的 state.file 不含"流程状态"时,stateName 仍要生效
  const projM7 = newProj('p20m7', true)
  const m7Home = isoHome20('p20m7-home')
  fs.writeFileSync(path.join(m7Home, 'dev-workflow', 'profiles.json'), JSON.stringify({
    cust: {
      label: '自定义两角色', coordinator: 'pm',
      roles: [{ id: 'pm' }, { id: 'be' }],
      state: { file: 'docs/workflow/state.md', ledger: 'docs/workflow/ledger.md' },
    },
  }), 'utf8')
  process.env.DSH_HOME = m7Home
  const ctxM7 = mockCtx()
  apply(ctxM7, {})
  const savedM7 = await runAs(ctxM7, sched20, 'workflow_state_save', { root: projM7, role: 'pm', profile: 'cust', stateName: 'alpha' })
  const pathM7 = String(savedM7.targetPath || savedM7.persistInstruction || '')
  check('20.17 自定义 state.file(不含"流程状态")下 stateName 仍生效',
    pathM7.indexOf('state-alpha.md') !== -1, pathM7.slice(0, 160))

  // 20.18~20.21 绑定属于**另一个父会话**时,必须在发之前就判定出来:
  // 否则会一路投递到 DSH 归属校验上撞 UNAUTHORIZED,记成普通"投递失败",绑定继续留在表里 →
  // 每次重发都再撞一次,三次之后正文改走"并线",直到熔断 —— 内容再没送达过。
  live['other-parent-be'] = { id: 'other-parent-be', session: { header: { cwd: ROOT, parentSession: 'some-other-session' } } }
  const projD18 = newProj('p20d18', true)
  const d18Home = isoHome20('p20d18-home', {
    version: 1, boot: '', updatedAt: '', activeProfiles: {}, activeProjects: {}, dedupe: {}, lifetime: {},
    projects: {
      [`standard@${projD18}`]: {
        root: projD18, profile: 'standard', ledger: [], relayTs: {},
        roleAgents: { pm: 'sched-20', be: 'other-parent-be' },
      },
    },
  })
  process.env.DSH_HOME = d18Home
  const ctxD18 = mockCtx()
  apply(ctxD18, {})
  const sentD18 = await runAs(ctxD18, sched20, 'relay', { action: 'send', root: projD18, from: 'pm', to: 'be', msg: '这条不该被投出去' })
  check('20.18 绑定属于另一个父会话 → 发之前判定 staleBinding',
    !!sentD18.delivery && sentD18.delivery.staleBinding === true && sentD18.delivery.via === 'stale-binding',
    JSON.stringify(sentD18.delivery))
  check('20.19 回执明确"正文未送达"+ 给出重派补救',
    !!sentD18.staleBinding && sentD18.staleBinding.role === 'be'
    && sentD18.staleBinding.owner === 'some-other-session'
    && String(sentD18.abort).indexOf('没有送达') !== -1
    && (sentD18.nextActions || []).some((t) => t.indexOf('relay_spawn role=be') !== -1),
    JSON.stringify(sentD18.staleBinding) + ' | ' + String(sentD18.abort))
  const d18State = readState20(d18Home)
  const d18Slot = d18State.projects[`standard@${projD18}`]
  check('20.20 失效绑定被就地清理并计入"失效重派"',
    !!d18Slot && !(d18Slot.roleAgents || {}).be && (d18Slot.stat || {}).staleRebinds === 1,
    d18Slot ? `agents=${JSON.stringify(Object.keys(d18Slot.roleAgents || {}))} staleRebinds=${(d18Slot.stat || {}).staleRebinds}` : '无槽')
  const sentD18b = await runAs(ctxD18, sched20, 'relay', { action: 'send', root: projD18, from: 'pm', to: 'be', msg: '清理后的第二次' })
  // 清理后走的是 no_reply 分支:诊断落在 abort 里(而不是 delivery),文案是"没有已登记的 agent 会话"
  check('20.21 清理后再发 → 报"没有已登记的 agent 会话"(可照做的诊断,而不是 UNAUTHORIZED)',
    sentD18b.status === 'no_reply' && String(sentD18b.abort).indexOf('没有已登记的 agent 会话') !== -1
    && String(sentD18b.abort).indexOf('relay_spawn 派出') !== -1,
    `${sentD18b.status} | ${String(sentD18b.abort)}`)
  delete live['other-parent-be']

  // 20.22 自己也在等待时,回覆仍要闭合对方的等待
  //   旧条件要求"回覆者自己没在等别人"(`waiting[from] === undefined`),于是
  //   A→B 之后 B 又问了 C,B 回来答复 A 时 **A 的等待不会被闭合** —— 一直挂到 15 分钟懒超时,
  //   期间 A 的每次互呼都只走"并线",status 的等待图与事实不符。
  const projM1 = newProj('p20m1', true)
  process.env.DSH_HOME = isoHome20('p20m1-home')
  const ctxM1 = mockCtx()
  apply(ctxM1, {})
  // noDeliver=true 让"编排判定"照常记账(投递失败会 release 等待,就构造不出前置状态了)
  await runAs(ctxM1, sched20, 'relay', { action: 'send', root: projM1, from: 'pm', to: 'be', msg: 'pm 问 be', noDeliver: 'true' })
  await runAs(ctxM1, sched20, 'relay', { action: 'send', root: projM1, from: 'be', to: 'fe', msg: 'be 问 fe(于是 be 自己也在等)', noDeliver: 'true' })
  const replyM1 = await runAs(ctxM1, sched20, 'relay', { action: 'send', root: projM1, from: 'be', to: 'pm', msg: 'be 回覆 pm', noDeliver: 'true' })
  const stM1 = await runAs(ctxM1, sched20, 'relay', { action: 'status', root: projM1 })
  check('20.22 回覆者自己也在等待时,对方的等待照样闭合',
    replyM1.replyClosed === 'pm' && !(stM1.waitingView || {}).pm,
    `replyClosed=${JSON.stringify(replyM1.replyClosed)} waiting=${JSON.stringify(stM1.waitingView)}`)

  // 20.23 另一个实例写过同一个 state.json 时,不许整份覆盖:
  //   只做原子替换(临时名带 pid)但没有 re-read/merge/锁的话,
  //   后写者会把前者的 projects / activeProjects / roleAgents / ledger 整份抹掉。
  const projM5 = newProj('p20m5', true)
  const m5Home = isoHome20('p20m5-home')
  process.env.DSH_HOME = m5Home
  const ctxM5 = mockCtx()
  apply(ctxM5, {})
  const st5Path = path.join(m5Home, 'dev-workflow', 'state.json')
  const st5 = JSON.parse(fs.readFileSync(st5Path, 'utf8'))
  st5.boot = '999-other-instance' // 冒充"另一个实例"写的
  st5.projects['standard@X:\\foreign-project'] = {
    root: 'X:\\foreign-project', profile: 'standard', updatedAt: '2099-01-01 00:00:00', roleAgents: { pm: 'foreign-pm' }, ledger: [],
  }
  fs.writeFileSync(st5Path, JSON.stringify(st5), 'utf8')
  await runAs(ctxM5, sched20, 'workflow_state_save', { root: projM5, role: 'pm' }) // 触发一次落盘
  const mergedM5 = JSON.parse(fs.readFileSync(st5Path, 'utf8'))
  const stM5 = await runAs(ctxM5, sched20, 'relay', { action: 'status', root: projM5 })
  check('20.23 外来写入被**槽级合并**而不是整份覆盖',
    !!mergedM5.projects['standard@X:\\foreign-project']
    && !!mergedM5.projects[`standard@${projM5}`]
    && !!stM5.foreignMerge && stM5.foreignMerge.slotsAdded >= 1,
    `外来的槽在=${!!mergedM5.projects['standard@X:\\foreign-project']} 本地的槽在=${!!mergedM5.projects[`standard@${projM5}`]} foreignMerge=${JSON.stringify(stM5.foreignMerge)}`)

  // 20.24 的反面:自己**上一个进程**写的 boot 不算外来写入
  //   (不然每次启动那一刻都会报一次假的并发告警)
  const nmHome = isoHome20('p20nommerge-home', {
    version: 1, boot: '777-previous-boot', updatedAt: '2026-09-12 17:00:00', activeProfiles: {}, activeProjects: {}, dedupe: {}, lifetime: {},
    projects: { [`standard@${projM5}`]: { root: projM5, profile: 'standard', updatedAt: '2026-09-12 17:00:00', roleAgents: {}, ledger: [] } },
  })
  process.env.DSH_HOME = nmHome
  const ctxNM = mockCtx()
  apply(ctxNM, {})
  const stNM = await runAs(ctxNM, sched20, 'relay', { action: 'status', root: projM5 })
  check('20.24 反面:启动时读到的"上一个进程的 boot"不算外来写入(不许每次启动都报并发)',
    stNM.foreignMerge === null && !!stNM.stateHealth, JSON.stringify(stNM.foreignMerge))

  process.env.DSH_HOME = home0
}

// ── 21. 确认人反查 / roleView / 版本自证 / 环境约束─────────────
{
  const sched21 = { id: 'sched-21', session: { header: { cwd: ROOT } } }
  const newProj21 = (name) => {
    const p = path.join(TMP, name)
    fs.mkdirSync(path.join(p, 'docs', 'workflow'), { recursive: true })
    fs.writeFileSync(path.join(p, 'docs', 'workflow', '.active'), 'active\n', 'utf8')
    return p
  }
  const home21 = (name, stateObj) => {
    const h = path.join(TMP, name)
    fs.mkdirSync(path.join(h, 'dev-workflow'), { recursive: true })
    if (stateObj) fs.writeFileSync(path.join(h, 'dev-workflow', 'state.json'), JSON.stringify(stateObj), 'utf8')
    return h
  }
  const home0b = process.env.DSH_HOME

  // 21.1~21.3 确认人反查:调度者把"计划中的确认人"写成"已完成的确认人"属于误报
  const projD29 = newProj21('p21d29')
  process.env.DSH_HOME = home21('p21d29-home', {
    version: 1, boot: '', updatedAt: '', activeProfiles: {}, activeProjects: {}, dedupe: {}, lifetime: {},
    projects: {
      [`standard@${projD29}`]: {
        root: projD29, profile: 'standard', ledger: [{ ts: '2026-09-12 15:00:00', from: 'pm', to: 'arch', summary: '请评审契约', status: '✅ 已转发' }],
        relayTs: {}, roleAgents: { arch: 'seeded-arch' }, // arch 有绑定会话,qa 什么都没有
      },
    },
  })
  const ctxD29 = mockCtx()
  apply(ctxD29, {})
  const stRM0 = await runAs(ctxD29, sched21, 'relay', { action: 'status', root: projD29 })
  const saveD29 = await runAs(ctxD29, sched21, 'workflow_state_save', {
    root: projD29, role: 'pm', nextStep: '等 @qa 复核',
    contractRevision: { content: 'REV-0006 订单表加 pay_no', affected: 'be/fe', confirmedBy: '@arch + @qa(只读复核)' },
  })
  const crD29 = saveD29.contractRevision || {}
  check('21.1 查不到参与证据的确认人进 unverified',
    Array.isArray(crD29.unverified) && crD29.unverified.length === 1 && crD29.unverified[0].role === 'qa'
    && (crD29.verified || []).some((v) => v.role === 'arch'),
    JSON.stringify(crD29.unverified))
  check('21.2 台账行就地标注 ⚠️ 未验证 + 回执给出"先互呼复核再登记"的补救',
    String(saveD29.documentText).indexOf('⚠️ 未验证:@qa') !== -1
    && (crD29.nextActions || []).some((t) => String(t).indexOf('to=qa') !== -1),
    `${String(saveD29.documentText).split('\n').filter((l) => l.indexOf('REV-0006') !== -1)[0] || '(台账行没找到)'} | ${JSON.stringify(crD29.nextActions)}`)
  // 版本自证"读不出来"必须是**可见状态**,不许静默降级
  check('21.2b status 自报版本自证是否成立(healthy 时 error 必须为空)',
    !!stRM0.versions && stRM0.versions.loaded === VERSION && stRM0.versions.error === '' && stRM0.versions.unverifiable === false,
    JSON.stringify(stRM0.versions))

  // 反面守卫:真的先互呼过 @qa,再登记 —— 不许报警
  await runAs(ctxD29, sched21, 'relay', { action: 'send', root: projD29, from: 'pm', to: 'qa', msg: '请复核 REV-0006', noDeliver: 'true' })
  const saveD29b = await runAs(ctxD29, sched21, 'workflow_state_save', {
    root: projD29, role: 'pm',
    contractRevision: { content: 'REV-0006 复核完成', affected: 'be/fe', confirmedBy: '@arch + @qa' },
  })
  check('21.3 反面:先真的互呼过再登记 → 不再报未验证(不许做成"人人可疑")',
    Array.isArray(saveD29b.contractRevision && saveD29b.contractRevision.unverified)
    && saveD29b.contractRevision.unverified.length === 0
    && String(saveD29b.documentText).indexOf('⚠️ 未验证') === -1,
    JSON.stringify(saveD29b.contractRevision))

  // 21.4 roleView 补口:活着但归属不是当前调度者的绑定必须**单独说出来**
  //     (这种情况发送前必须判 staleBinding —— 但 status 里原先一个字都不提)
  live['rm-ok'] = { id: 'rm-ok', session: { header: { cwd: ROOT, parentSession: 'sched-21' } } }
  live['rm-other'] = { id: 'rm-other', session: { header: { cwd: ROOT, parentSession: 'some-other-session' } } }
  const projRM = newProj21('p21rm')
  process.env.DSH_HOME = home21('p21rm-home', {
    version: 1, boot: '', updatedAt: '', activeProfiles: {}, activeProjects: {}, dedupe: {}, lifetime: {},
    projects: { [`standard@${projRM}`]: { root: projRM, profile: 'standard', ledger: [], relayTs: {}, roleAgents: { arch: 'rm-ok', be: 'rm-other' } } },
  })
  const ctxRM = mockCtx({
    agents: {
      get: (id) => live[String(id)],
      list: () => Object.values(live),
      currentInitiator: () => parentAgent,
      isOwnedBy: (id, caller) => {
        const a = live[String(id)]
        const h = (a && a.session && a.session.header) || {}
        return String(h.parentSession || '') === String((caller && caller.id) || '')
      },
    },
  })
  apply(ctxRM, {})
  const stRM = await runAs(ctxRM, sched21, 'relay', { action: 'status', root: projRM })
  check('21.4 归属与调度者不符的绑定单独成行(必须单列 roleView,不能只报 live/liveOwnedByCaller)',
    Array.isArray(stRM.roleMismatch) && stRM.roleMismatch.length === 1 && stRM.roleMismatch[0].role === 'be'
    && stRM.roleMismatch[0].owner === 'some-other-session' && stRM.schedulerId === 'sched-21',
    JSON.stringify(stRM.roleMismatch))
  check('21.5 roleView 反面:归属正确的绑定不进这一列',
    Array.isArray(stRM.roleMismatch) && !stRM.roleMismatch.some((m) => m.role === 'arch'), JSON.stringify(stRM.roleMismatch))
  delete live['rm-ok']
  delete live['rm-other']

  // 21.6 边车体积要按**全部项目**报 —— 只报本项目时会出现 "status 一行边车都不显示,
  //      而盘上已经有 680 KB(分散在别的项目文件里)"。
  const longMsg = `长正文:${'台'.repeat(400)}`
  await runAs(ctxRM, sched21, 'relay', { action: 'send', root: projRM, from: 'pm', to: 'arch', msg: longMsg, noDeliver: 'true' })
  const stSide = await runAs(ctxRM, sched21, 'relay', { action: 'status', root: projRM })
  check('21.6 status 报边车体积(本项目 + 全部),超 120 字的正文确实转存了边车',
    stSide.ledgerFullSize > 0 && !!stSide.ledgerFullTotal && stSide.ledgerFullTotal.total >= stSide.ledgerFullSize
    && stSide.ledgerFullTotal.files >= 1,
    `本项目=${stSide.ledgerFullSize} 全部=${JSON.stringify(stSide.ledgerFullTotal)}`)

  // 21.7~21.8 环境约束随人格一起注入(角色踩不到"没有 pwsh7"这种坑)
  const spawn21 = await runAs(ctxRM, sched21, 'relay_spawn', { root: projRM, role: 'be', prompt: '环境约束用例' })
  const spec21 = subagents._specs[subagents._specs.length - 1] || {}
  const persona21 = String((spec21.request || {}).persona || '')
  check('21.7 环境约束随 persona 注入(PS 5.1 / PYTHONIOENCODING / 管道 stdio EPERM)',
    persona21.indexOf('PowerShell 5.1') !== -1 && persona21.indexOf('PYTHONIOENCODING') !== -1
    && persona21.indexOf('EPERM') !== -1 && spawn21.envNotesInjected === true,
    `personaChars=${String(spawn21.personaChars)} 含PS5.1=${persona21.indexOf('PowerShell 5.1') !== -1}`)
  check('21.8 人设本体仍在(约束是"追加",不是"顶替")',
    persona21.indexOf('③ 后端开发者') !== -1, persona21.slice(0, 60))

  process.env.DSH_HOME = home0b
}


// ── 22. 真两实例 —— 两个**独立模块实例** + 同一个 $DSH_HOME ──
// 注意:在同一模块实例上 apply 两次不行 —— store/storeHealth 是模块级单例,
// 那两个"实例"共用一份内存。这里用 ESM 查询串拿独立实例。
// 那两个"实例"共用一份内存(它的 T1/T3/T4 失败是复现件伪影)。这里用 ESM 查询串拿独立实例。
{
  const HOME_M = path.join(TMP, 'home-multi')
  fs.rmSync(HOME_M, { recursive: true, force: true })
  const prevHomeM = process.env.DSH_HOME
  process.env.DSH_HOME = HOME_M
  const projMA = path.join(TMP, 'multi-a')
  const projMB = path.join(TMP, 'multi-b')
  for (const p of [projMA, projMB]) fs.mkdirSync(path.join(p, 'docs', 'workflow'), { recursive: true })
  const multiState = () => JSON.parse(fs.readFileSync(path.join(HOME_M, 'dev-workflow', 'state.json'), 'utf8'))
  const ctxMA = mockCtx()
  apply(ctxMA, {})
  const modMB = await import(`./lib/feature.js?multi=${Date.now()}`)
  const ctxMB = mockCtx()
  modMB.apply(ctxMB, {})
  const schedM = { id: 'sched-multi', session: { header: { cwd: ROOT } } }

  await runAs(ctxMA, schedM, 'relay_spawn', { root: projMA, role: 'pm', prompt: 'multi-a' })
  await runAs(ctxMB, schedM, 'relay_spawn', { root: projMB, role: 'pm', prompt: 'multi-b' })
  check('22.1 第二实例启动后写别的槽,不得把先写方的槽整份盖掉',
    Object.keys(multiState().projects).length === 2, JSON.stringify(Object.keys(multiState().projects)))

  for (let i = 0; i < 3; i += 1) {
    await runAs(ctxMA, schedM, 'workflow_state_save', { root: projMA, role: 'pm', nextStep: `A${i}` })
    await runAs(ctxMB, schedM, 'workflow_state_save', { root: projMA, role: 'arch', nextStep: `B${i}` })
  }
  const rowsM = ((multiState().projects || {})[`standard@${projMA}`] || {}).ledger || []
  check('22.2 同一槽两实例交错写台账 → 行数取并集',
    rowsM.length === 6, `${rowsM.length} 行`)

  const modMC = await import(`./lib/feature.js?multi=${Date.now()}c`)
  const ctxMC = mockCtx()
  modMC.apply(ctxMC, {})
  const stC = await runAs(ctxMC, schedM, 'relay', { action: 'status', root: projMA })
  check('22.3 反面:实例自己重启(文件已存在)不得误报"另一个实例",且槽一个不少',
    !stC.foreignMerge && Object.keys(multiState().projects).length === 2,
    `foreignMerge=${JSON.stringify(stC.foreignMerge)} 槽数=${Object.keys(multiState().projects).length}`)
  process.env.DSH_HOME = prevHomeM
}

// ── 23. 角色子会话自查不得自报"归属与调度者不符" ──
{
  const HOME_D = path.join(TMP, 'home-d31')
  fs.rmSync(HOME_D, { recursive: true, force: true })
  const prevHomeD = process.env.DSH_HOME
  process.env.DSH_HOME = HOME_D
  const projD = path.join(TMP, 'd31')
  fs.mkdirSync(path.join(projD, 'docs', 'workflow'), { recursive: true })
  fs.mkdirSync(path.join(HOME_D, 'dev-workflow'), { recursive: true })
  fs.writeFileSync(path.join(HOME_D, 'dev-workflow', 'state.json'), JSON.stringify({
    version: 1, boot: '', updatedAt: '', activeProfiles: {}, activeProjects: {}, dedupe: {}, lifetime: {},
    projects: {
      [`standard@${projD}`]: {
        root: projD, profile: 'standard', ledger: [], relayTs: {},
        roleAgents: { arch: 'd31-arch', be: 'd31-be', fe: 'd31-fe' },
      },
    },
  }), 'utf8')
  const schedD = { id: 'sched-d31', session: { header: { cwd: ROOT } } }
  live['d31-arch'] = { id: 'd31-arch', session: { header: { cwd: ROOT, parentSession: 'sched-d31' } } }
  live['d31-be'] = { id: 'd31-be', session: { header: { cwd: ROOT, parentSession: 'sched-d31' } } }
  live['d31-fe'] = { id: 'd31-fe', session: { header: { cwd: ROOT, parentSession: 'other-parent' } } }
  const ctxD = mockCtx({
    agents: {
      get: (id) => live[String(id)],
      list: () => Object.values(live),
      currentInitiator: () => parentAgent,
      isOwnedBy: (id, caller) => {
        const a = live[String(id)]
        const h = (a && a.session && a.session.header) || {}
        return String(h.parentSession || '') === String((caller && caller.id) || '')
      },
    },
  })
  apply(ctxD, {})
  const stOwn = await runAs(ctxD, live['d31-arch'], 'relay', { action: 'status', root: projD })
  check('23.1 角色子会话查 status 时,自己的绑定不得被判"归属与调度者不符"',
    Array.isArray(stOwn.roleMismatch) && !stOwn.roleMismatch.some((m) => m.role === 'arch'),
    JSON.stringify(stOwn.roleMismatch))
  check('23.2 同一视角下,真正属于别的父会话的绑定仍要报出来(反向守卫)',
    Array.isArray(stOwn.roleMismatch) && stOwn.roleMismatch.some((m) => m.role === 'fe' && m.owner === 'other-parent'),
    JSON.stringify(stOwn.roleMismatch))
  const stSchedD = await runAs(ctxD, schedD, 'relay', { action: 'status', root: projD })
  check('23.3 调度者视角下自己的两个子不进这一列,只有外来的 fe 进',
    Array.isArray(stSchedD.roleMismatch) && stSchedD.roleMismatch.length === 1 && stSchedD.roleMismatch[0].role === 'fe',
    JSON.stringify(stSchedD.roleMismatch))
  const textD = ctxD._tool('relay').output.render({}, stOwn).map((b) => b.text).join('\n')
  check('23.4 告警里 id 不再是常量占位符(不许渲染成固定的 session-…)',
    textD.indexOf('session-…') === -1 && textD.indexOf('other-pa') !== -1,
    textD.split('\n').filter((l) => l.indexOf('绑定归属') !== -1).join(' | '))
  delete live['d31-arch']
  delete live['d31-be']
  delete live['d31-fe']
  process.env.DSH_HOME = prevHomeD
}

// ── 24. 自环 / 药方 / paths / 边车名──────────────
{
  const HOME_49 = path.join(TMP, 'home-49')
  fs.rmSync(HOME_49, { recursive: true, force: true })
  const prevHome49 = process.env.DSH_HOME
  process.env.DSH_HOME = HOME_49
  const proj49 = path.join(TMP, 'p49')
  fs.mkdirSync(path.join(proj49, 'docs', 'workflow'), { recursive: true })
  const ctx49 = mockCtx()
  apply(ctx49, {})
  const sched49 = { id: 'sched-49', session: { header: { cwd: ROOT } } }

  const loop = await runAs(ctx49, sched49, 'relay', { action: 'send', root: proj49, from: 'pm', to: 'pm', msg: '自问自答' })
  check('24.1 from === to 自环必须被拦(不许 status=done 还把等待图写成 {pm:"pm"})',
    loop.status === 'invalid' && loop.selfLoop === true, JSON.stringify(loop))
  const stLoop = await runAs(ctx49, sched49, 'relay', { action: 'status', root: proj49 })
  check('24.2 自环被拦后等待图里不得留下 pm→pm',
    !stLoop.waitingView || Object.keys(stLoop.waitingView).length === 0, JSON.stringify(stLoop.waitingView))

  const badRole = await runAs(ctx49, sched49, 'relay', { action: 'send', root: proj49, from: 'pm', to: 'dba', msg: 'x' })
  check('24.3 role_not_in_profile 必须给终止条件(点名含该角色的档)',
    badRole.status === 'role_not_in_profile' && Array.isArray(badRole.profilesWithRole)
    && /含 @dba 的档|没有任何一档含 @dba/.test(String(badRole.note)), String(badRole.note))

  const badPaths = await runAs(ctx49, sched49, 'api_contract', { action: 'lint', root: proj49, paths: ['no-such-dir'] })
  check('24.4 paths 指了不存在的目录,回执必须与"项目没写 spec"区分开',
    badPaths.status === 'ok' && /你给的 paths/.test(String(badPaths.note)) && Array.isArray(badPaths.pathsGiven),
    String(badPaths.note))

  // 24.5 findings 必须 ERROR 在前(按原顺序截断的话,ERROR 可能被 40 条上限挤掉)
  fs.mkdirSync(path.join(proj49, 'docs', 'api'), { recursive: true })
  fs.writeFileSync(path.join(proj49, 'docs', 'api', 'mix.yaml'), [
    'openapi: 3.1.0', 'info:', '  title: mix', '  version: 1.0.0', 'servers:', '  - url: https://api.example.com/v1',
    'paths:', '  /getUserById:', '    get:', '      operationId: getUserById', '      responses:', '        "200": { description: ok }',
  ].join('\n'), 'utf8')
  const lintMix = await runAs(ctx49, sched49, 'api_contract', { action: 'lint', root: proj49 })
  const levels = (lintMix.findings || []).map((f) => f.level)
  check('24.5 findings 里不得出现"warn 排在 error 前面"(截断前必须先排 ERROR)',
    levels.every((lv, i) => i === 0 || !(levels[i - 1] !== 'error' && lv === 'error')), JSON.stringify(levels))

  // 24.6 两个"只在前缀之后才不同"的长项目根,不得共用同一个台账边车文件
  const longBase = path.join(TMP, 'clients', 'very-long-customer-name-'.repeat(3))
  const longA = path.join(longBase, 'alpha')
  const longB = path.join(longBase, 'beta')
  for (const p of [longA, longB]) fs.mkdirSync(path.join(p, 'docs', 'workflow'), { recursive: true })
  const longMsg = `边车区分:${'台'.repeat(200)}`
  await runAs(ctx49, sched49, 'relay', { action: 'send', root: longA, from: 'pm', to: 'arch', msg: longMsg, noDeliver: true })
  await runAs(ctx49, sched49, 'relay', { action: 'send', root: longB, from: 'pm', to: 'arch', msg: longMsg, noDeliver: true })
  const sideDir = path.join(HOME_49, 'dev-workflow', 'ledger')
  const sideFiles = fs.existsSync(sideDir) ? fs.readdirSync(sideDir).filter((f) => f.endsWith('.jsonl')) : []
  check('24.6 长前缀项目的台账边车必须两两独立(不许截到 80 字、共用一个文件)',
    sideFiles.length >= 2, JSON.stringify(sideFiles))

  process.env.DSH_HOME = prevHome49
}

// ── 25. relay 归属与权限 ──────────────────────────────────────────
{
  const mkProj25 = (name) => {
    const p = path.join(TMP, name)
    fs.mkdirSync(path.join(p, 'docs', 'workflow'), { recursive: true })
    fs.writeFileSync(path.join(p, 'docs', 'workflow', '.active'), 'active\n', 'utf8')
    return p
  }
  const mkHome25 = (name, stateObj) => {
    const h = path.join(TMP, name)
    fs.mkdirSync(path.join(h, 'dev-workflow'), { recursive: true })
    if (stateObj) fs.writeFileSync(path.join(h, 'dev-workflow', 'state.json'), JSON.stringify(stateObj), 'utf8')
    return h
  }
  const readState25 = (h) => JSON.parse(fs.readFileSync(path.join(h, 'dev-workflow', 'state.json'), 'utf8'))
  const home0_25 = process.env.DSH_HOME

  // 25.1~25.3 孙代调用者(角色自己派的 helper,深度 3)不得自伤绑定。
  //   归属基准若取"调用者自己的父会话",而绑定的 owner 是**谱系顶端**的主调度者会话,
  //   孙代发 relay 就会得到 status=no_reply、staleRebinds=1、sent 记录为空("正文一条都没发出去"),
  //   而真正的"别人的父会话"才该命中这条。
  const projG3 = mkProj25('p25g3')
  process.env.DSH_HOME = mkHome25('p25g3-home')
  const ctxG3 = mockCtx()
  apply(ctxG3, {})
  const schedG3 = { id: 'sched-g3', session: { header: { cwd: ROOT } } }
  live['sched-g3'] = schedG3
  const spPmG3 = await runAs(ctxG3, schedG3, 'relay_spawn', { root: projG3, role: 'pm', prompt: '孙代用例' })
  const spArchG3 = await runAs(ctxG3, schedG3, 'relay_spawn', { root: projG3, role: 'arch', prompt: '孙代用例' })
  const helperG3 = { id: `${spPmG3.agentId}-helper`, session: { header: { cwd: ROOT, parentSession: String(spPmG3.agentId) } } }
  live[helperG3.id] = helperG3
  const sentBeforeG3 = sent.length
  const sendG3 = await runAs(ctxG3, helperG3, 'relay', { action: 'send', root: projG3, from: 'pm', to: 'arch', msg: '孙代正文:这条必须真的发出去' })
  check('25.1 孙代(角色自己派的 helper)发 relay 不得被判 staleBinding',
    !!sendG3.delivery && sendG3.delivery.ok === true && sendG3.delivery.via === 'scheduler-top-proxy',
    `status=${sendG3.status} delivery=${JSON.stringify(sendG3.delivery)}`)
  const slotG3 = (readState25(process.env.DSH_HOME).projects || {})[`standard@${projG3}`] || {}
  check('25.2 arch 绑定不得被删、staleRebinds 不得增长',
    String((slotG3.roleAgents || {}).arch || '') === String(spArchG3.agentId)
    && Number((slotG3.stat || {}).staleRebinds || 0) === 0,
    `agents=${JSON.stringify(slotG3.roleAgents)} staleRebinds=${(slotG3.stat || {}).staleRebinds}`)
  check('25.3 正文真的投出了 —— 投递身份改走"调度者顶端代理",而不是"一条都没发"',
    sent.slice(sentBeforeG3).some((s) => s.targetId === String(spArchG3.agentId) && s.senderId === 'sched-g3'
      && s.text.indexOf('孙代正文') !== -1),
    JSON.stringify(sent.slice(sentBeforeG3).map((s) => `${s.senderId}→${s.targetId}`)))

  // 25.4~25.5 显式 from 必须等于调用者反查出的角色。
  //   只做"角色名在不在本档"的解析、不与调用者身份比对的话,@be 的会话发 `from=pm to=qa`
  //   会得到 status=done,等待图被写成 {pm:qa},消耗的是 **pm 的熔断额度**。
  const projFG = mkProj25('p25forg')
  process.env.DSH_HOME = mkHome25('p25forg-home')
  const ctxFG = mockCtx()
  apply(ctxFG, {})
  const schedFG = { id: 'sched-forg', session: { header: { cwd: ROOT } } }
  live['sched-forg'] = schedFG
  const spBeFG = await runAs(ctxFG, schedFG, 'relay_spawn', { root: projFG, role: 'be', prompt: '④ 冒名用例' })
  await runAs(ctxFG, schedFG, 'relay_spawn', { root: projFG, role: 'arch', prompt: '④ 冒名用例' })
  const sentBeforeFG = sent.length
  const forgedFG = await runAs(ctxFG, live[String(spBeFG.agentId)], 'relay', { action: 'send', root: projFG, from: 'pm', to: 'arch', msg: '④ 冒名:以 @be 的身份写 from=pm' })
  check('25.4 以 @be 身份显式写 from=pm 必须被拒 forged_from',
    forgedFG.status === 'forged_from' && forgedFG.forgedFrom === true
    && String(forgedFG.callerRole) === 'be' && String(forgedFG.declaredFrom) === 'pm',
    `status=${forgedFG.status} callerRole=${forgedFG.callerRole} declaredFrom=${forgedFG.declaredFrom}`)
  const slotFG = (readState25(process.env.DSH_HOME).projects || {})[`standard@${projFG}`] || {}
  check('25.5 拒绝必须零副作用(等待图未改写 / 台账没多行 / 没有任何投递)',
    Object.keys(slotFG.waiting || {}).length === 0 && (slotFG.ledger || []).length === 0
    && sent.length === sentBeforeFG,
    `waiting=${JSON.stringify(slotFG.waiting)} ledger=${(slotFG.ledger || []).length} 新增投递=${sent.length - sentBeforeFG}`)

  // 25.6 force 必须走 boolTrue(provider 不强制 schema 的 boolean,模型会把 "true" 传成字符串)。
  //   `a.force !== true` 会静默降级成 exists:回执说"需要重派请传 force=true",而调用者刚写的就是它。
  const projFR = mkProj25('p25force')
  process.env.DSH_HOME = mkHome25('p25force-home')
  const ctxFR = mockCtx()
  apply(ctxFR, {})
  const schedFR = { id: 'sched-force25', session: { header: { cwd: ROOT } } }
  live['sched-force25'] = schedFR
  subagents._unique = true
  const spF1 = await runAs(ctxFR, schedFR, 'relay_spawn', { root: projFR, role: 'be', prompt: 'force 第一次' })
  const spF2 = await runAs(ctxFR, schedFR, 'relay_spawn', { root: projFR, role: 'be', prompt: 'force 第二次', force: 'true' })
  subagents._unique = false
  const slotFR = (readState25(process.env.DSH_HOME).projects || {})[`standard@${projFR}`] || {}
  check('25.6 relay_spawn force:"true"(字符串)必须真的重派',
    spF1.status === 'spawned' && spF2.status === 'spawned' && String(spF2.agentId) !== String(spF1.agentId)
    && String((slotFR.roleAgents || {}).be || '') === String(spF2.agentId),
    `第一次=${spF1.status}/${spF1.agentId} 第二次=${spF2.status}/${spF2.agentId} 盘上=${(slotFR.roleAgents || {}).be}`)

  // 25.7~25.9 显式 profile 派活/开工后必须落盘 activeProfiles:
  //   只让 a.profile 参与本次 resolveProfile 的话,派出的角色全被登记进 standard 槽,
  //   子会话第一条互呼必然 role_not_in_profile。
  const projPF = mkProj25('p25prof')
  const homePF = mkHome25('p25prof-home')
  fs.writeFileSync(path.join(homePF, 'dev-workflow', 'profiles.json'), JSON.stringify({
    cust25: {
      label: '自定义档', coordinator: 'pm', roles: [{ id: 'pm' }, { id: 'be' }],
      state: { file: 'docs/workflow/流程状态.md', ledger: 'docs/workflow/协作台账.md' },
    },
  }), 'utf8')
  process.env.DSH_HOME = homePF
  const ctxPF = mockCtx()
  apply(ctxPF, {})
  const schedPF = { id: 'sched-prof25', session: { header: { cwd: ROOT } } }
  live['sched-prof25'] = schedPF
  const spPF = await runAs(ctxPF, schedPF, 'relay_spawn', { root: projPF, role: 'be', profile: 'cust25', prompt: '派活用例' })
  const stPF = readState25(homePF)
  check('25.7 显式传 profile 派活后必须把 activeProfiles[<root>] 落盘',
    spPF.status === 'spawned' && String((stPF.activeProfiles || {})[projPF] || '') === 'cust25',
    `status=${spPF.status} activeProfiles=${JSON.stringify(stPF.activeProfiles)}`)

  const projPF2 = mkProj25('p25prof2')
  const koPF1 = await runAs(ctxPF, schedPF, 'relay', { action: 'kickoff', root: projPF2, profile: 'cust25', goal: 'kickoff 首次' })
  // 模拟"整批角色都已登记"(skipped)路径:把盘上的记录抹掉再重新 apply 一次
  const stPF2a = readState25(homePF)
  delete (stPF2a.activeProfiles || {})[projPF2]
  fs.writeFileSync(path.join(homePF, 'dev-workflow', 'state.json'), JSON.stringify(stPF2a), 'utf8')
  const ctxPF2 = mockCtx()
  apply(ctxPF2, {})
  const koPF2 = await runAs(ctxPF2, schedPF, 'relay', { action: 'kickoff', root: projPF2, profile: 'cust25', goal: 'kickoff 二次' })
  const stPF2 = readState25(homePF)
  check('25.8 kickoff 的 skipped 路径同样要落盘',
    koPF1.status === 'started' && koPF2.status === 'already'
    && String((stPF2.activeProfiles || {})[projPF2] || '') === 'cust25',
    `首次=${koPF1.status} 二次=${koPF2.status} activeProfiles=${JSON.stringify(stPF2.activeProfiles)}`)

  const projPF3 = mkProj25('p25prof3')
  await runAs(ctxPF2, schedPF, 'relay', { action: 'kickoff', root: projPF3, goal: '不传 profile' })
  const stPF3 = readState25(homePF)
  check('25.9 反面 + 正面对照:不传 profile 的 root 一个字节都不写,而传过的那两个仍在',
    !Object.prototype.hasOwnProperty.call(stPF3.activeProfiles || {}, projPF3)
    && String((stPF3.activeProfiles || {})[projPF2] || '') === 'cust25',
    `不传的=${JSON.stringify((stPF3.activeProfiles || {})[projPF3])} 传过的=${JSON.stringify((stPF3.activeProfiles || {})[projPF2])}`)

  // 25.10 作废判据从"进程级 boot"改成"调度者会话级":只比 slot.boot(进程启动 id)时,
  //   Web GUI 里新开会话不重启进程 —— 新会话原样继承上一会话的等待图,
  //   第一次回覆就撞 checkDeadlock 被判死锁环、正文扣进仲裁。
  const projSC = mkProj25('p25sched')
  process.env.DSH_HOME = mkHome25('p25sched-home')
  const ctxSC = mockCtx()
  apply(ctxSC, {})
  const schedOld25 = { id: 'sched-old25', session: { header: { cwd: ROOT } } }
  const schedNew25 = { id: 'sched-new25', session: { header: { cwd: ROOT } } }
  live['sched-old25'] = schedOld25
  live['sched-new25'] = schedNew25
  await runAs(ctxSC, schedOld25, 'relay', { action: 'send', root: projSC, from: 'pm', to: 'arch', msg: '残留等待链', noDeliver: 'true' })
  const stSC = await runAs(ctxSC, schedNew25, 'relay', { action: 'status', root: projSC })
  const slotSC = (readState25(process.env.DSH_HOME).projects || {})[`standard@${projSC}`] || {}
  check('25.10 同一进程内换会话 → 残留等待图就地作废并留痕',
    !(stSC.waitingView || {}).pm && Array.isArray(stSC.staleWaiting)
    && stSC.staleWaiting.some((w) => w.role === 'pm' && w.to === 'arch')
    && !!slotSC.schedulerChanged && String(slotSC.schedulerChanged.to) === 'sched-new25'
    && Number(slotSC.schedulerChanged.cleared || 0) >= 1,
    `waiting=${JSON.stringify(stSC.waitingView)} stale=${JSON.stringify(stSC.staleWaiting)} changed=${JSON.stringify(slotSC.schedulerChanged)}`)

  // 25.11~25.12 超时清扫不能只在 send 路径懒触发(status / ledger 也要释放)。
  //   用一个小 ttl 的自定义档把"超时"在同一进程里复现(不依赖等 15 分钟)。
  const projEX = mkProj25('p25exp')
  const homeEX = mkHome25('p25exp-home')
  fs.writeFileSync(path.join(homeEX, 'dev-workflow', 'profiles.json'), JSON.stringify({
    tiny25: {
      label: '1ms 等待超时档', coordinator: 'pm', roles: [{ id: 'pm' }, { id: 'arch' }],
      relay: { waitTimeoutMs: 1 }, state: { file: 'docs/workflow/流程状态.md', ledger: 'docs/workflow/协作台账.md' },
    },
  }), 'utf8')
  process.env.DSH_HOME = homeEX
  const ctxEX = mockCtx()
  apply(ctxEX, {})
  const schedEX = { id: 'sched-exp25', session: { header: { cwd: ROOT } } }
  live['sched-exp25'] = schedEX
  await runAs(ctxEX, schedEX, 'relay', { action: 'send', root: projEX, profile: 'tiny25', from: 'pm', to: 'arch', msg: '等待超时用例(status)', noDeliver: 'true' })
  await new Promise((r) => setTimeout(r, 30))
  const stEX = await runAs(ctxEX, schedEX, 'relay', { action: 'status', root: projEX, profile: 'tiny25' })
  check('25.11 relay status 也要做超时清扫并报 expiredWaits',
    Array.isArray(stEX.expiredWaits) && stEX.expiredWaits.length === 1
    && String(stEX.expiredWaits[0].role) === 'pm' && !(stEX.waitingView || {}).pm,
    `expired=${JSON.stringify(stEX.expiredWaits)} waiting=${JSON.stringify(stEX.waitingView)}`)
  await runAs(ctxEX, schedEX, 'relay', { action: 'send', root: projEX, profile: 'tiny25', from: 'pm', to: 'arch', msg: '第二条等待关系(ledger)', noDeliver: 'true' })
  await new Promise((r) => setTimeout(r, 30))
  const lgEX = await runAs(ctxEX, schedEX, 'relay', { action: 'ledger', root: projEX, profile: 'tiny25' })
  check('25.12 relay ledger 同样清扫(否则"还在等 @x"会永久留在给人看的台账投影里)',
    Array.isArray(lgEX.expiredWaits) && lgEX.expiredWaits.length === 1 && String(lgEX.expiredWaits[0].to) === 'arch',
    `expired=${JSON.stringify(lgEX.expiredWaits)}`)

  // 25.13~25.15 仲裁队列是 drain 语义,装的是"正文一条都没投出去"的唯一一份:
  //   一条校验都没有的话,review 档里连只读的 @arch/@qa 都能一次取走清空,协调者再取就是空队列。
  const projARB = mkProj25('p25arb')
  const homeARB = mkHome25('p25arb-home', {
    version: 1, boot: '', updatedAt: '', activeProfiles: {}, activeProjects: {}, dedupe: {}, lifetime: {},
    projects: {
      [`standard@${projARB}`]: {
        root: projARB, profile: 'standard', ledger: [], relayTs: {}, waiting: {}, waitMeta: {},
        roleAgents: { pm: 'arb-pm', be: 'arb-be' },
        arbitration: [{ ts: '2026-09-12 20:00:00', reason: '熔断-超限', from: 'pm', to: 'be', msg: '被拦下的正文(唯一一份)' }],
      },
    },
  })
  process.env.DSH_HOME = homeARB
  const ctxARB = mockCtx()
  apply(ctxARB, {})
  const schedARB = { id: 'sched-arb25', session: { header: { cwd: ROOT } } }
  live['sched-arb25'] = schedARB
  live['arb-pm'] = { id: 'arb-pm', session: { header: { cwd: ROOT, parentSession: 'sched-arb25' } } }
  live['arb-be'] = { id: 'arb-be', session: { header: { cwd: ROOT, parentSession: 'sched-arb25' } } }
  const arbBeRes = await runAs(ctxARB, live['arb-be'], 'relay', { action: 'arbitrate', root: projARB })
  check('25.13 非协调者角色取仲裁队列必须 unauthorized',
    arbBeRes.status === 'unauthorized' && !arbBeRes.events,
    `status=${arbBeRes.status} events=${JSON.stringify(arbBeRes.events)}`)
  const slotARB = (readState25(homeARB).projects || {})[`standard@${projARB}`] || {}
  check('25.14 拒绝必须"先判后动"(队列原封不动,那条正文仍在)',
    (slotARB.arbitration || []).length === 1 && String(slotARB.arbitration[0].msg).indexOf('唯一一份') !== -1,
    JSON.stringify(slotARB.arbitration))
  const arbPmRes = await runAs(ctxARB, live['arb-pm'], 'relay', { action: 'arbitrate', root: projARB })
  check('25.15 协调者本人仍能取回,且拿到的正是那条正文(不许把合法路径一起堵死)',
    arbPmRes.status === 'ok' && arbPmRes.count === 1
    && String(((arbPmRes.events || [])[0] || {}).msg || '').indexOf('唯一一份') !== -1,
    `status=${arbPmRes.status} count=${arbPmRes.count}`)

  // 25.16~25.17 reasoningEffort 透传(调用参数 > profile 每角色默认档 > 不写):
  //   只透传 model 时所有角色都继承调度者的 agentReasoningEffort("max")—— @qa 跑 checklist 也按 max 计费。
  const projEF = mkProj25('p25eff')
  const homeEF = mkHome25('p25eff-home')
  fs.writeFileSync(path.join(homeEF, 'dev-workflow', 'profiles.json'), JSON.stringify({
    r25: {
      label: '成本档', coordinator: 'pm',
      roles: [{ id: 'pm' }, { id: 'be', reasoningEffort: 'low' }, { id: 'arch', reasoningEffort: 'high' }, { id: 'fe' }],
      state: { file: 'docs/workflow/流程状态.md', ledger: 'docs/workflow/协作台账.md' },
    },
  }), 'utf8')
  process.env.DSH_HOME = homeEF
  const ctxEF = mockCtx()
  apply(ctxEF, {})
  const schedEF = { id: 'sched-eff25', session: { header: { cwd: ROOT } } }
  live['sched-eff25'] = schedEF
  const spEF = await runAs(ctxEF, schedEF, 'relay_spawn', { root: projEF, role: 'be', profile: 'r25', prompt: 'P8 显式档', reasoningEffort: 'medium' })
  const reqEF = ((subagents._specs[subagents._specs.length - 1] || {}).request) || {}
  check('25.16 reasoningEffort 必须透传到 request.agentOptions(调用参数优先于 profile 默认档)',
    String(spEF.reasoningEffort || '') === 'medium' && !!reqEF.agentOptions
    && String(reqEF.agentOptions.reasoningEffort || '') === 'medium',
    `回执=${JSON.stringify(spEF.reasoningEffort)} agentOptions=${JSON.stringify(reqEF.agentOptions)}`)
  const spEF2 = await runAs(ctxEF, schedEF, 'relay_spawn', { root: projEF, role: 'arch', profile: 'r25', prompt: 'P8 不传参数,回落 profile 默认档' })
  const reqEF2 = ((subagents._specs[subagents._specs.length - 1] || {}).request) || {}
  const spEF3 = await runAs(ctxEF, schedEF, 'relay_spawn', { root: projEF, role: 'fe', profile: 'r25', prompt: 'P8 两级都不设' })
  const reqEF3 = ((subagents._specs[subagents._specs.length - 1] || {}).request) || {}
  check('25.17 不传参数时要回落 profile 里该角色的默认档;两级都不设的角色则完全不写 agentOptions(不许给所有档案平白改成本口径)',
    String(spEF2.reasoningEffort || '') === 'high' && !!reqEF2.agentOptions
    && String(reqEF2.agentOptions.reasoningEffort || '') === 'high'
    && String(spEF3.reasoningEffort || '') === '' && reqEF3.agentOptions === undefined,
    `回落档=${JSON.stringify(spEF2.reasoningEffort)} agentOptions=${JSON.stringify(reqEF2.agentOptions)};两级都不设=${JSON.stringify(spEF3.reasoningEffort)}/${JSON.stringify(reqEF3.agentOptions)}`)

  process.env.DSH_HOME = home0_25
}

// ── 26. 状态工具──────────
{
  const mkProj26 = (name) => {
    const p = path.join(TMP, name)
    fs.mkdirSync(path.join(p, 'docs', 'workflow'), { recursive: true })
    fs.writeFileSync(path.join(p, 'docs', 'workflow', '.active'), 'active\n', 'utf8')
    return p
  }
  const mkHome26 = (name, stateObj) => {
    const h = path.join(TMP, name)
    fs.mkdirSync(path.join(h, 'dev-workflow'), { recursive: true })
    if (stateObj) fs.writeFileSync(path.join(h, 'dev-workflow', 'state.json'), JSON.stringify(stateObj), 'utf8')
    return h
  }
  const readState26 = (h) => JSON.parse(fs.readFileSync(path.join(h, 'dev-workflow', 'state.json'), 'utf8'))
  const home0_26 = process.env.DSH_HOME

  // 26.1~26.2 load 逐节渲染 / save 描述口径
  const projLD = mkProj26('p26load')
  process.env.DSH_HOME = mkHome26('p26load-home')
  fs.writeFileSync(path.join(projLD, 'docs', 'workflow', '流程状态.md'), [
    '# 流程状态:p26', '',
    '## 当前进度', '- 步骤一已完成', '',
    '## 产出文件', '- docs/p26-产出-A.md', '',
    '## API 契约', '- docs/api/openapi.yaml | 类型=openapi', '',
    '## 待办', '- [ ] p26-待办-未完成一', '- [x] p26-待办-已完成一', '',
    '## 契约修订台账', '- 2026-09-12 20:00:00 | REV-2601 订单表加 pay_no | 受影响:be | 确认:@pm', '',
    '## 遗留风险', '- p26-风险-A:未做并发压测', '',
  ].join('\n'), 'utf8')
  const ctxLD = mockCtx()
  apply(ctxLD, {})
  const loadLD = await run(ctxLD, 'workflow_state_load', { root: projLD })
  const textLD = ctxLD._tool('workflow_state_load').output.render({}, loadLD).map((b) => b.text).join('\n')
  check('26.1 load 的 render 必须逐节渲染正文(下面这些 marker 必须都搜得到)',
    textLD.indexOf('标题:') !== -1 && textLD.indexOf('【产出文件】') !== -1 && textLD.indexOf('【API 契约】') !== -1
    && textLD.indexOf('【待办】') !== -1 && textLD.indexOf('【契约修订台账】') !== -1 && textLD.indexOf('【遗留风险】') !== -1
    && textLD.indexOf('p26-产出-A.md') !== -1 && textLD.indexOf('REV-2601') !== -1 && textLD.indexOf('p26-风险-A') !== -1
    && textLD.indexOf('p26-待办-未完成一') !== -1,
    textLD.slice(0, 200).replace(/\n/g, ' ⏎ '))
  const descSave = String(ctxLD._tool('workflow_state_save').description || '')
  check('26.2 save 的描述必须与实现同口径(整段覆盖),不许再写"增量合并"',
    descSave.indexOf('整段覆盖') !== -1 && descSave.indexOf('增量合并') === -1 && descSave.indexOf('追加一行') !== -1,
    descSave.slice(0, 120))

  // 26.3 磁盘优先,currentText 只兜底;被忽略这件事必须说出来。
  //   反过来(currentText 优先于磁盘,还报「合并来源:plugin-fs」)是说的与做的相反。
  fs.writeFileSync(path.join(projLD, 'docs', 'workflow', '流程状态.md'),
    ['# 流程状态:p26', '', '## 遗留风险', '- p26-磁盘新进度(不许被会话里的旧全文盖掉)'].join('\n'), 'utf8')
  const staleText26 = ['# 流程状态:p26', '', '## 遗留风险', '- p26-会话旧全文(不该盖回磁盘)'].join('\n')
  const saveCT = await run(ctxLD, 'workflow_state_save', { root: projLD, role: 'pm', nextStep: 'save/currentText 用例', currentText: staleText26 })
  check('26.3 磁盘读得到时以磁盘为准、currentText 只兜底,且"未被采用"必须说出来',
    saveCT.currentTextIgnored === true && String(saveCT.mergedFrom) === 'plugin-fs'
    && String(saveCT.documentText).indexOf('p26-磁盘新进度') !== -1
    && String(saveCT.documentText).indexOf('p26-会话旧全文') === -1
    && String(saveCT.note).indexOf('未被采用') !== -1,
    `ignored=${saveCT.currentTextIgnored} mergedFrom=${saveCT.mergedFrom} 磁盘marker=${String(saveCT.documentText).indexOf('p26-磁盘新进度') !== -1} 旧全文marker=${String(saveCT.documentText).indexOf('p26-会话旧全文') !== -1}`)

  // 26.4~26.6 save 侧:"没有确认人可核"必须与"核对通过"分开。
  const saveNC = await run(ctxLD, 'workflow_state_save', {
    root: projLD, role: 'pm', contractRevision: { content: 'REV-2602', affected: 'be', confirmedBy: '' },
  })
  check('26.4 confirmedBy 为空必须标 noConfirmer 并说"没有任何参与度可核对"',
    !!saveNC.contractRevision && saveNC.contractRevision.noConfirmer === true
    && String(saveNC.contractRevision.note).indexOf('确认人参与度已核对') === -1
    && String(saveNC.contractRevision.note).indexOf('没有任何参与度可核对') !== -1,
    `noConfirmer=${saveNC.contractRevision && saveNC.contractRevision.noConfirmer} note=${String(saveNC.contractRevision && saveNC.contractRevision.note).slice(0, 70)}`)
  const saveNC2 = await run(ctxLD, 'workflow_state_save', {
    root: projLD, role: 'pm', contractRevision: { content: 'REV-2603', affected: 'be', confirmedBy: '客户验收 + 甲方签字' },
  })
  check('26.5 confirmedBy 里认不出任何角色 id 时也不算"已核对"',
    !!saveNC2.contractRevision && saveNC2.contractRevision.noConfirmer === true
    && String(saveNC2.contractRevision.note).indexOf('认不出任何角色') !== -1,
    `noConfirmer=${saveNC2.contractRevision && saveNC2.contractRevision.noConfirmer} note=${String(saveNC2.contractRevision && saveNC2.contractRevision.note).slice(0, 70)}`)
  const textNC = ctxLD._tool('workflow_state_save').output.render({}, saveNC).map((b) => b.text).join('\n')
  check('26.6 save 的确认人反查结果也要进上下文(只落在 payload 里等于模型一个字都看不到)',
    textNC.indexOf('【契约修订台账登记】REV-2602') !== -1 && textNC.indexOf('没有任何参与度可核对') !== -1,
    textNC.split('\n').filter((l) => l.indexOf('契约修订台账登记') !== -1).join(' | ').slice(0, 160))

  // 26.7~26.8 协调者没派成 / 一个都没派成时,不许报成"开工成功"。
  const projKO = mkProj26('p26kick')
  const projKO2 = mkProj26('p26kick2')
  const homeKO = mkHome26('p26kick-home')
  fs.writeFileSync(path.join(homeKO, 'dev-workflow', 'profiles.json'), JSON.stringify({
    coordbad26: {
      label: '协调者派不出档', coordinator: 'pm',
      roles: [{ id: 'pm', provider: 'no-such-provider' }, { id: 'be' }],
      state: { file: 'docs/workflow/流程状态.md', ledger: 'docs/workflow/协作台账.md' },
    },
    allbad26: {
      label: '全员派不出档', coordinator: 'pm',
      roles: [{ id: 'pm', provider: 'no-such-provider' }, { id: 'be', provider: 'no-such-provider' }],
      state: { file: 'docs/workflow/流程状态.md', ledger: 'docs/workflow/协作台账.md' },
    },
  }), 'utf8')
  process.env.DSH_HOME = homeKO
  const ctxKO = mockCtx()
  apply(ctxKO, {})
  const ko26 = await run(ctxKO, 'relay', { action: 'kickoff', root: projKO, profile: 'coordbad26', goal: '协调者缺席' })
  check('26.7 协调者没派成必须 coordinatorSpawned=false + degraded=true,且警示顶在最前',
    ko26.coordinatorSpawned === false && ko26.degraded === true && !!ko26.coordinatorFailure
    && String(ko26.note).indexOf('协调者 @pm') !== -1 && String(ko26.note).indexOf('没派成') !== -1,
    `coordinatorSpawned=${ko26.coordinatorSpawned} degraded=${ko26.degraded} note=${String(ko26.note).slice(0, 70)}`)
  const ko26b = await run(ctxKO, 'relay', { action: 'kickoff', root: projKO2, profile: 'allbad26', goal: '全员失败' })
  const stKO = readState26(homeKO)
  check('26.8 一个角色都没派成时不许把项目记成"已开工"(不许在派活之前就 markActive)',
    ko26b.status === 'failed' && !(stKO.activeProjects || {})[projKO2],
    `status=${ko26b.status} activeProjects里有它=${!!(stKO.activeProjects || {})[projKO2]}`)

  // 26.9~26.10 按 cwd 兜底推断出来的根必须显式标出来。
  const cwdOnly26 = path.join(TMP, 'p26cwd')
  fs.mkdirSync(path.join(cwdOnly26, 'docs', 'workflow'), { recursive: true })
  const agentNoRoot26 = { id: 'no-root-agent26', session: { header: { cwd: cwdOnly26 } } }
  live['no-root-agent26'] = agentNoRoot26
  const stNoRoot26 = await runAs(ctxKO, agentNoRoot26, 'workflow_state_status', {})
  const stExplicit26 = await runAs(ctxKO, agentNoRoot26, 'workflow_state_status', { root: projKO })
  const textNoRoot26 = ctxKO._tool('workflow_state_status').output.render({}, stNoRoot26).map((b) => b.text).join('\n')
  check('26.9 没传 root → 标 rootInferred/rootSource 并在回执里点出来',
    stNoRoot26.rootInferred === true && String(stNoRoot26.rootSource) === 'agent-cwd'
    && String(stNoRoot26.root) === cwdOnly26 && String(stNoRoot26.note).indexOf('推断') !== -1
    && textNoRoot26.indexOf('本次没传 root') !== -1,
    `root=${stNoRoot26.root} inferred=${stNoRoot26.rootInferred} source=${stNoRoot26.rootSource}`)
  check('26.10 反面:显式传 root 不打这个标 —— 两条路必须给不同结论',
    stExplicit26.rootInferred === undefined && String(stExplicit26.root) === projKO && stNoRoot26.rootInferred === true,
    `显式传=${JSON.stringify(stExplicit26.rootInferred)} 不传=${JSON.stringify(stNoRoot26.rootInferred)}`)

  // 26.11~26.12 占位写法 `(空)` / `(空值)` 一律当"没有 stateName":
  //   把工具自己给的 `stateName=(空)` 当需求名、洗净成 `空_` 拼进文件名,状态文件会分叉成两份,
  //   紧接着 status 报 hasState=false,协调者据权重开一轮流程。
  const projBL = mkProj26('p26blank')
  const blDir = path.join(projBL, 'docs', 'workflow')
  fs.writeFileSync(path.join(blDir, '.active'), 'active stateName=(空)\n', 'utf8')
  fs.writeFileSync(path.join(blDir, '流程状态.md'), ['# 流程状态:主文件', '', '## 遗留风险', '- p26-主文件标记'].join('\n'), 'utf8')
  fs.writeFileSync(path.join(blDir, '流程状态-空_.md'), ['# 流程状态:分叉', '', '## 遗留风险', '- p26-分叉文件标记'].join('\n'), 'utf8')
  const ctxBL = mockCtx()
  apply(ctxBL, {})
  const loadBL = await run(ctxBL, 'workflow_state_load', { root: projBL })
  check('26.11 .active 里写 stateName=(空) 必须回落主状态文件',
    String(loadBL.targetPath || '').indexOf('流程状态-空_') === -1
    && String(loadBL.summary || '').indexOf('p26-主文件标记') !== -1,
    `targetPath=${loadBL.targetPath}`)
  const useBL = await run(ctxBL, 'workflow_state_use', { root: projBL, stateName: '(空)' })
  check('26.12 workflow_state_use stateName=(空) 必须回主文件、指示写 (空值)',
    String(useBL.targetPath || '').indexOf('流程状态-空_') === -1
    && String(useBL.persistInstruction || '').indexOf('(空值)') !== -1,
    `targetPath=${useBL.targetPath} instr=${String(useBL.persistInstruction).slice(0, 60)}`)

  process.env.DSH_HOME = home0_26
}

// ── 27. 参考件缓存:空结果不进缓存 + 按 mtime 失效──
{
  // 参考件缓存有两个坑:
  //   ① **空数组也进缓存** —— 而 `[]` 是真值。首次调用时参考件读不到(插件与 skills/ 分两次部署、
  //      或部署中途来过一次 lint),此后本进程**余生**都返回"参考模板读不到",归属校验**永久失效**,
  //      而人只看得到一句 warning;
  //   ② 读到了也**永不失效** —— 参考件被换掉(升级/手工改),本进程仍拿旧文本比对。
  // 这一组测的是**模块级缓存**,所以要拷一份临时包、动态 import 出全新实例:随包
  // `skills/api-architect/references/` 一个字节都不动(见 makePkgCopy 的说明)。
  const home0_27 = process.env.DSH_HOME
  const { dir: PKG27, mod: mod27 } = await makePkgCopy('p27-pkg', {})
  const rules27 = (arr) => arr.map((f) => f.rule)
  const has27 = (arr, rule) => rules27(arr).indexOf(rule) !== -1
  const refSrc27 = fileURLToPath(new URL('./skills/api-architect/references', import.meta.url))
  const refText27 = fs.readFileSync(path.join(refSrc27, 'openapi-spec.yaml'), 'utf8')
  const dump27 = (text) => mod27.templateDumpFindings('docs/api/openapi.yaml', text)
  // 只认"点名 openapi-spec.yaml 这条参考件"的发现 —— 另外四份参考件(proto/graphql/两份 YAML)
  // 与本组无关,不能借它们的命中来冒充"判据跟着新内容走了"。
  const named27 = (arr, file) => arr.filter((f) => String(f.message || '').indexOf(file) !== -1).map((f) => f.rule)

  // ① 参考件读不到 → 如实报 vendor-template-uncheckable(不是静默 PASS)。
  //    这一条两侧都过,是下面那条的**前置条件断言**:没有"读不到",就无从谈"恢复"。
  const miss27 = dump27(refText27)
  check('27.1 参考件读不到时如实报 vendor-template-uncheckable(不是静默 PASS)',
    has27(miss27, 'vendor-template-uncheckable') && !has27(miss27, 'vendor-template'),
    JSON.stringify(rules27(miss27)))

  // ② 部署完成(目录回来了)→ **同进程内**下一次调用必须恢复归属校验:
  //    空结果一旦进缓存 → 此后余生都走"读不到"分支。
  fs.mkdirSync(path.join(PKG27, 'skills', 'api-architect'), { recursive: true })
  copyTree(refSrc27, path.join(PKG27, 'skills', 'api-architect', 'references'))
  const back27 = dump27(refText27)
  check('27.2 参考件目录回来后**同进程立刻**恢复归属校验',
    has27(back27, 'vendor-template') && !has27(back27, 'vendor-template-uncheckable'),
    JSON.stringify(rules27(back27)))

  // ③④ 参考件被改写 → 判据要跟着**新内容**走(缓存按 references/ 的 mtime+size 失效)。
  //    替换件**补到与原参考件逐字节等长**,于是指纹里唯一变的就是 mtime ——
  //    这样测的才是"按 mtime 失效",而不是"长度变了所以重读"。
  const body27 = [
    'openapi: 3.1.0',
    'info:',
    '  title: 库存中心 API',
    '  version: "9.9.9"',
    '  description: 仓库与批次库存的内部接口',
    'servers:',
    '  - url: https://stock.internal.example.cn/v9',
    'paths:',
    '  /warehouses:',
    '    get:',
    '      operationId: listWarehouses',
    '      summary: 仓库列表',
    '      responses:',
    '        "200":',
    '          description: 成功',
    '  /batches/{batchNo}:',
    '    get:',
    '      operationId: getBatch',
    '      summary: 批次详情',
    '      responses:',
    '        "404":',
    '          description: 不存在',
    'components:',
    '  schemas:',
    '    Warehouse:',
    '      type: object',
    '      properties:',
    '        code:',
    '          type: string',
    '        city:',
    '          type: string',
    '    Batch:',
    '      type: object',
    '      properties:',
    '        batchNo:',
    '          type: string',
    '        quantity:',
    '          type: integer',
  ].join('\n') + '\n'
  const targetBytes27 = Buffer.byteLength(refText27, 'utf8')
  const pad27 = targetBytes27 - Buffer.byteLength(body27, 'utf8')
  // 注释行不进判据(specLines 会剔掉),所以补成一行 '#' 既等长又不改语义
  const newRef27 = body27 + (pad27 > 1 ? `${'#'.repeat(pad27 - 1)}\n` : '\n')
  const refFile27 = path.join(PKG27, 'skills', 'api-architect', 'references', 'openapi-spec.yaml')
  fs.writeFileSync(refFile27, newRef27, 'utf8')
  const future27 = new Date(Date.now() + 60000)
  fs.utimesSync(refFile27, future27, future27)
  check('27.0 前置:替换件与真参考件逐字节等长(于是指纹里唯一变的是 mtime)',
    Buffer.byteLength(newRef27, 'utf8') === targetBytes27 && newRef27 !== refText27,
    `${Buffer.byteLength(newRef27, 'utf8')} vs ${targetBytes27}`)

  const oldNow27 = dump27(refText27)
  check('27.3 参考件被改写后判据跟着新内容走 —— 旧模板文本不再被判"照抄 openapi-spec.yaml"',
    named27(oldNow27, 'openapi-spec.yaml').length === 0 && !has27(oldNow27, 'vendor-template-uncheckable'),
    JSON.stringify(rules27(oldNow27)))
  const newNow27 = dump27(newRef27)
  check('27.4 反面:新参考件的文本被认成"照抄"(缓存真失效了,不是"改完以后一律不报")',
    named27(newNow27, 'openapi-spec.yaml').length > 0, JSON.stringify(rules27(newNow27)))

  process.env.DSH_HOME = home0_27
}

// ── 28. root 未归一:查找时归一、键与显示保持原样──────
{
  // `stateKey(profile.id, root)` 直接拿**原串**当键建槽的话,同一个项目用
  // `F:\AI\Proj\` / `f:\ai\proj` 会各建一个槽 —— 角色绑定/等待图/熔断窗口/台账各算一半,
  // status 报"这个项目没开工"而实际上刚派过角色。
  // 归一化刻意选"**查找时**归一"而不是"把归一化后的串当键写盘":键必须与磁盘上已有的键逐字一致
  // (探针与回归件都按 `standard@<原样路径>` 直查 state.json,改写成小写会让它们全部查空)。
  const home0_28 = process.env.DSH_HOME
  const proj28 = path.join(TMP, 'p28root')
  fs.mkdirSync(path.join(proj28, 'docs', 'workflow'), { recursive: true })
  fs.writeFileSync(path.join(proj28, 'docs', 'workflow', '.active'), 'active\n', 'utf8')
  const home28 = path.join(TMP, 'p28root-home')
  fs.mkdirSync(path.join(home28, 'dev-workflow'), { recursive: true })
  process.env.DSH_HOME = home28
  const ctx28 = mockCtx()
  apply(ctx28, {})
  const sched28 = { id: 'sched-28', session: { header: { cwd: proj28 } } }
  live['sched-28'] = sched28
  const raw28 = proj28                      // 原样
  const tail28 = proj28 + path.sep          // 带尾分隔符
  const case28 = proj28.toUpperCase()       // 全大写(Windows 路径不区分大小写)
  await runAs(ctx28, sched28, 'relay_spawn', { role: 'pm', root: raw28 })
  await runAs(ctx28, sched28, 'relay_spawn', { role: 'be', root: tail28 })
  await runAs(ctx28, sched28, 'relay_spawn', { role: 'fe', root: case28 })
  const st28 = JSON.parse(fs.readFileSync(path.join(home28, 'dev-workflow', 'state.json'), 'utf8'))
  const keys28 = Object.keys(st28.projects || {})
  check('28.1 同一个项目的三种写法(原样 / 带尾分隔符 / 全大写)只落**一个**槽',
    keys28.length === 1, JSON.stringify(keys28))
  const slot28 = st28.projects[keys28[0]] || {}
  check('28.2 键与 slot.root 都保持**用户原样给的**写法(归一化只用于"认得出是同一个项目",不许顺手改写盘上的键与显示路径)',
    keys28[0] === `standard@${raw28}` && String(slot28.root) === raw28,
    `键=${keys28[0]} root=${slot28.root}`)
  check('28.3 三种写法派出的三个角色绑定落在**同一个**槽里("绑定不丢"是这条的用户可见后果)',
    ['pm', 'be', 'fe'].every((r) => !!((slot28.roleAgents || {})[r])), JSON.stringify(slot28.roleAgents))
  const sp28d = await runAs(ctx28, sched28, 'relay_spawn', { role: 'pm', root: case28 })
  check('28.4 换一种写法再派同一个角色 → 认得出"已登记且仍在位"(status=exists),不再白派一个新会话',
    sp28d.status === 'exists', `${sp28d.status}/${sp28d.note || ''}`)
  process.env.DSH_HOME = home0_28
}

// ── 29. spawn 早退必须落盘:失效绑定不许"重启复活"────
{
  // 只 `delete slot.roleAgents[role]`(内存)、落盘全靠后面派活成功那句 `saveStore()` 的话,
  // 这个函数删完之后有**四条早退路径**(subagents 不可用 / 没有已注册 provider /
  // provider 名不认识 / 找不到发起者 agent),任何一条命中就直接 return,**盘上那份旧绑定原封不动** ——
  // 下次进程启动 loadStore 把它读回来:kickoff 又当"已登记"跳过、status 又报"人齐了"。
  const home0_29 = process.env.DSH_HOME
  const proj29 = path.join(TMP, 'p29early')
  fs.mkdirSync(path.join(proj29, 'docs', 'workflow'), { recursive: true })
  fs.writeFileSync(path.join(proj29, 'docs', 'workflow', '.active'), 'active\n', 'utf8')
  const home29 = path.join(TMP, 'p29early-home')
  fs.mkdirSync(path.join(home29, 'dev-workflow'), { recursive: true })
  fs.writeFileSync(path.join(home29, 'dev-workflow', 'state.json'), JSON.stringify({
    version: 1, boot: '', updatedAt: '', activeProfiles: {}, activeProjects: {}, dedupe: {}, lifetime: {},
    projects: {
      [`standard@${proj29}`]: {
        root: proj29, profile: 'standard', ledger: [], relayTs: {},
        // be 的绑定指向一个**已不存在**的 agent → bindingUsable 判失效 → 走"删绑定"那条路
        roleAgents: { be: 'gone-agent-29', qa: 'kept-agent-29' },
        waiting: {}, waitMeta: {}, arbitration: [], staleWaiting: [], updatedAt: '2020-01-01 00:00:00',
      },
    },
  }), 'utf8')
  process.env.DSH_HOME = home29
  // 让 providerNames() 返回空(subagents 服务在,但拿不到任何 provider)→ 删完绑定就地早退
  const ctx29 = mockCtx({ subagents: { startContinuable: subagents.startContinuable } })
  apply(ctx29, {})
  const sched29 = { id: 'sched-29', session: { header: { cwd: proj29 } } }
  live['sched-29'] = sched29
  const out29 = await runAs(ctx29, sched29, 'relay_spawn', { role: 'be', root: proj29 })
  const disk29 = JSON.parse(fs.readFileSync(path.join(home29, 'dev-workflow', 'state.json'), 'utf8'))
  const slot29 = (disk29.projects || {})[`standard@${proj29}`] || {}
  check('29.1 早退路径确实走到了(没有已注册的 subagent provider)',
    out29.status === 'unavailable' && String(out29.note).indexOf('provider') !== -1, `${out29.status}:${out29.note}`)
  check('29.2 失效绑定在**盘上**被清掉(只删内存的话,重启 loadStore 会读回来 → 死绑定复活)',
    !((slot29.roleAgents || {}).be), JSON.stringify(slot29.roleAgents))
  check('29.3 反向守卫:同槽里**别的**绑定不许被顺手删掉(只清失效的那一个)',
    String((slot29.roleAgents || {}).qa || '') === 'kept-agent-29', JSON.stringify(slot29.roleAgents))
  process.env.DSH_HOME = home0_29
}

// ── 30. 空槽 7 天 TTL──────────────────────────────
{
  // `sweepDeadSlots` 若只回收"根目录确实已删"的槽、没有按时间回收的路径,探针项目、建了又删的
  // 临时目录、被 root= 写错的一次性调用留下的槽会永久保留。门槛刻意保守:空槽 + updatedAt 能解析
  // 且早于 7 天 + 根目录不是"暂时读不到" + 不在开工记忆(activeProjects)里,四条**同时**成立才回收。
  const home0_30 = process.env.DSH_HOME
  const mkDir30 = (name) => { const p = path.join(TMP, name); fs.mkdirSync(p, { recursive: true }); return p }
  const fresh30 = mkDir30('p30-fresh')
  const old30 = mkDir30('p30-old')
  const busy30 = mkDir30('p30-busy')
  const unknown30 = mkDir30('p30-unknown')
  const kept30 = mkDir30('p30-remembered')
  const oldTs30 = '2020-01-01 00:00:00' // 远早于 7 天
  const empty30 = (root, extra) => Object.assign({
    root, profile: 'standard', roleAgents: {}, waiting: {}, waitMeta: {}, ledger: [], relayTs: {},
  }, extra || {})
  const home30 = path.join(TMP, 'p30-home')
  fs.mkdirSync(path.join(home30, 'dev-workflow'), { recursive: true })
  fs.writeFileSync(path.join(home30, 'dev-workflow', 'state.json'), JSON.stringify({
    version: 1, boot: '', updatedAt: '', activeProfiles: {}, dedupe: {}, lifetime: {},
    activeProjects: { [kept30]: { at: oldTs30, reason: '开工记忆', boot: 'b' } },
    projects: {
      [`standard@${fresh30}`]: empty30(fresh30, { updatedAt: '2099-01-01 00:00:00' }),
      [`standard@${old30}`]: empty30(old30, { updatedAt: oldTs30 }),
      [`standard@${busy30}`]: empty30(busy30, { updatedAt: oldTs30, roleAgents: { be: 'still-bound' } }),
      [`standard@${unknown30}`]: empty30(unknown30),
      [`standard@${kept30}`]: empty30(kept30, { updatedAt: oldTs30 }),
    },
  }), 'utf8')
  process.env.DSH_HOME = home30
  const ctx30 = mockCtx()
  apply(ctx30, {})
  const st30 = JSON.parse(fs.readFileSync(path.join(home30, 'dev-workflow', 'state.json'), 'utf8'))
  const keys30 = Object.keys(st30.projects || {})
  check('30.1 够老的**空**槽被回收(只有"根目录已删"一条路径的话,探针/临时目录留下的槽永久保留)',
    keys30.indexOf(`standard@${old30}`) === -1, JSON.stringify(keys30))
  check('30.2 有绑定的旧槽保留(只回收空槽 —— 宁留垃圾不删证据)',
    keys30.indexOf(`standard@${busy30}`) !== -1, JSON.stringify(keys30))
  check('30.3 updatedAt 在未来的槽保留(没到 TTL;顺带守住"时钟回拨/未来时间不许当成过期")',
    keys30.indexOf(`standard@${fresh30}`) !== -1, JSON.stringify(keys30))
  check('30.4 没有 updatedAt 的槽保留(时间未知 → 不敢删)',
    keys30.indexOf(`standard@${unknown30}`) !== -1, JSON.stringify(keys30))
  check('30.5 反向守卫:开工记忆(activeProjects)里的项目哪怕空槽且很老也不回收',
    keys30.indexOf(`standard@${kept30}`) !== -1, JSON.stringify(keys30))
  const stView30 = await run(ctx30, 'relay', { action: 'status', root: fresh30 })
  check('30.6 回收必须**报数**(emptySlotSweep 带 root/profile/updatedAt/ageDays)—— "槽怎么少了"要能归因',
    Array.isArray(stView30.emptySlotSweep) && stView30.emptySlotSweep.length === 1
    && String(stView30.emptySlotSweep[0].root) === old30 && Number(stView30.emptySlotSweep[0].ageDays) > 7,
    JSON.stringify(stView30.emptySlotSweep))
  process.env.DSH_HOME = home0_30
}

// ── 31. 多标记的 relay 回执:明说只转发了哪一条 + 给补发动作──
{
  // 只取最后一条标记的话,**前几条被静默丢弃**,而回执与渲染照样写"标记 @arch: …" ——
  // 写了两个标记的人以为两个人都收到了,漏掉的那个永远不会回话,也没人知道它被漏掉了。
  // 行为本身保守不改(一次 send 只投一个目标是既有的"单等待位"设计),但必须**如实说出来**。
  const home0_31 = process.env.DSH_HOME
  const mkProj31 = (name) => {
    const p = path.join(TMP, name)
    fs.mkdirSync(path.join(p, 'docs', 'workflow'), { recursive: true })
    fs.writeFileSync(path.join(p, 'docs', 'workflow', '.active'), 'active\n', 'utf8')
    return p
  }
  const mkHome31 = (name) => {
    const h = path.join(TMP, name)
    fs.mkdirSync(path.join(h, 'dev-workflow'), { recursive: true })
    return h
  }

  // ① 反面守卫:末行只有一条时不许报多标记(不许把这条做成"每次 send 都刷一句告警")
  const proj31a = mkProj31('p31one')
  process.env.DSH_HOME = mkHome31('p31one-home')
  const ctx31a = mockCtx()
  apply(ctx31a, {})
  await run(ctx31a, 'relay_spawn', { role: 'arch', root: proj31a })
  const one31 = await run(ctx31a, 'relay', { action: 'send', root: proj31a, from: 'pm', answer: '结论\n@relay:arch 请评审' })
  check('31.1 反面守卫:末行只有一条标记时不报 multiMark(这是下面几条的锚)',
    one31.status === 'done' && !!one31.mark && one31.mark.to === 'arch'
    && one31.multiMark === undefined && !one31.markDroppedNote,
    `${one31.status}/${JSON.stringify(one31.mark)}/multiMark=${JSON.stringify(one31.multiMark)}`)

  // ② 末行两条:必须报出只转了最后一条、前一条没转发(不许静默丢弃还说"已转发")
  const proj31b = mkProj31('p31two')
  process.env.DSH_HOME = mkHome31('p31two-home')
  const ctx31b = mockCtx()
  apply(ctx31b, {})
  await run(ctx31b, 'relay_spawn', { role: 'arch', root: proj31b })
  const two31 = await run(ctx31b, 'relay', {
    action: 'send', root: proj31b, from: 'pm',
    answer: '总结:@qa 请复测、@arch 请评审\n@relay:qa 请复测 @relay:arch 请评审',
  })
  check('31.2 末行两条标记时回执必须报出**发现了哪几条 / 只转发了哪一条 / 哪一条没转发**',
    !!two31.multiMark && String(two31.mark.to) === 'arch'
    && (two31.multiMark.detected || []).join(',') === 'qa,arch'
    && String(two31.multiMark.forwarded) === 'arch'
    && (two31.multiMark.dropped || []).join(',') === 'qa',
    JSON.stringify(two31.multiMark))
  const note31 = String(two31.markDroppedNote || '')
  check('31.3 文案必须**明说**"只转发了最后一条 @arch""@qa 没有转发"',
    note31.indexOf('只转发了最后一条 @arch') !== -1 && note31.indexOf('@qa') !== -1 && note31.indexOf('没有转发') !== -1,
    note31.slice(0, 170))
  const text31 = ctx31b._tool('relay').output.render({}, two31).map((b) => b.text).join('\n')
  check('31.4 ⑧:这句告警要进**上下文**(渲染),并给一条照做就能补发的动作(只写在 payload 里等于没说)',
    text31.indexOf('只转发了最后一条 @arch') !== -1
    && (two31.nextActions || []).some((t) => String(t).indexOf('补发') !== -1 && String(t).indexOf('to=qa') !== -1),
    `渲染含告警=${text31.indexOf('只转发了最后一条 @arch') !== -1} nextActions=${JSON.stringify(two31.nextActions)}`)
  process.env.DSH_HOME = home0_31
}

// ── 32. 技能资产:frontmatter version 与插件版本对齐并并排显示──
{
  // 技能文本的 `version` 若停在 1.2.0,而插件已经走到 1.5.0,两个数就对不上 ——
  // 排障时无从判断"手上这份技能文本是哪一版插件带过来的";版本号读进来了却**一处都不显示**同样不行。
  const home0_32 = process.env.DSH_HOME
  const proj32 = path.join(TMP, 'p32skill')
  fs.mkdirSync(path.join(proj32, 'docs', 'workflow'), { recursive: true })
  fs.writeFileSync(path.join(proj32, 'docs', 'workflow', '.active'), 'active\n', 'utf8')
  const home32 = path.join(TMP, 'p32skill-home')
  fs.mkdirSync(path.join(home32, 'dev-workflow'), { recursive: true })
  const skillPath32 = fileURLToPath(new URL('./skills/api-architect/SKILL.md', import.meta.url))
  const psf32 = libmod.parseSkillFrontmatter
  const skVer32 = typeof psf32 === 'function' ? String(psf32(fs.readFileSync(skillPath32, 'utf8')).attrs.version || '') : ''
  check('32.1 随包 SKILL.md 的 frontmatter version 与插件版本对齐',
    skVer32 !== '' && skVer32 === VERSION, `技能=${skVer32 || '(读不到)'} 插件=${VERSION}`)
  process.env.DSH_HOME = home32
  const ctx32 = mockCtx()
  apply(ctx32, {})
  const st32 = await run(ctx32, 'relay', { action: 'status', root: proj32 })
  const skillLine32 = String((st32.apiView || {}).skill || '')
  check('32.2 relay status 的 apiView.skill 把技能版本**并排**显示出来(只有"可见/隐藏"的话,版本读进来了却一处不显示)',
    skVer32 !== '' && skillLine32.indexOf(`v${skVer32}`) !== -1 && skillLine32.indexOf('不一致') === -1,
    `apiView.skill=${skillLine32}`)

  // ③ 反面:两边不一致时必须点名(用临时包副本把技能版本改成 0.0.9;随包资产一个字节不动)
  const { dir: PKG32, mod: mod32 } = await makePkgCopy('p32-pkg', { skills: true })
  fs.writeFileSync(path.join(PKG32, 'skills', 'api-architect', 'SKILL.md'), [
    '---', 'name: api-architect', 'description: 假技能文本(供测试替换)', 'version: 0.0.9', '---', '', '# 假技能', '',
  ].join('\n'), 'utf8')
  const home32b = path.join(TMP, 'p32-pkg-home')
  fs.mkdirSync(path.join(home32b, 'dev-workflow'), { recursive: true })
  process.env.DSH_HOME = home32b
  const ctx32b = mockCtx()
  mod32.apply(ctx32b, {})
  const st32b = await run(ctx32b, 'relay', { action: 'status', root: proj32 })
  const skillLine32b = String((st32b.apiView || {}).skill || '')
  check('32.3 反面:技能版本与插件版本不一致时点名(v0.0.9 ≠ 插件版本),不许静默显示一个旧号骗人',
    skillLine32b.indexOf('v0.0.9') !== -1 && skillLine32b.indexOf('不一致') !== -1, `apiView.skill=${skillLine32b}`)
  process.env.DSH_HOME = home0_32
}

// ── 33. api_contract 的**回执文本**必须有"候选被跳过"留痕──
{
  // 数据面把"静默跳过"写进了 `scanSkipped` / `scanSkippedNote`(lint 与 status 两条路径都写了),
  // 但 `API_OUTPUT.render` 只输出 `scanNote` —— **结构化字段在、模型看不见**。
  // 一旦如此:paths 指向的目录里 1 个文件超 512 KB、1 个超 2 层深度(`found.skipped` 有 2 条以上),
  // 而回执一个字都不提 —— "契约明明在,插件却说扫不到"就没法自查。
  const home0_33 = process.env.DSH_HOME
  const normalSpec33 = [
    'openapi: 3.1.0', 'info:', '  title: p33 正常 spec', '  version: "1.0.0"',
    'paths:', '  /orders:', '    post:', '      operationId: createOrder',
    '      responses:', '        "201":', '          description: 建单成功',
  ].join('\n')
  const proj33 = path.join(TMP, 'p33skip')
  fs.mkdirSync(path.join(proj33, 'api', 'nested', 'a', 'b', 'c'), { recursive: true })
  fs.writeFileSync(path.join(proj33, 'api', 'openapi.yaml'), normalSpec33, 'utf8')
  fs.writeFileSync(path.join(proj33, 'api', 'oversize.yaml'), `# 超 512 KB 的候选\n${'x'.repeat(600 * 1024)}`, 'utf8')
  fs.writeFileSync(path.join(proj33, 'api', 'nested', 'a', 'b', 'c', 'openapi.yaml'), normalSpec33, 'utf8')
  const home33 = path.join(TMP, 'p33skip-home')
  fs.mkdirSync(path.join(home33, 'dev-workflow'), { recursive: true })
  process.env.DSH_HOME = home33
  const ctx33 = mockCtx()
  apply(ctx33, {})

  // 数据面(防回归守卫:留痕本身不许被后面的改动弄没)
  const disc33 = libmod.discoverApiSpecs
  const found33 = typeof disc33 === 'function' ? disc33(proj33, ['api']) : { skipped: [] }
  const reasons33 = (found33.skipped || []).map((s) => String(s.reason))
  check('33.1 数据面:超 512 KB 与超 2 层深度的候选都进 found.skipped(防回归守卫)',
    reasons33.indexOf('oversize') !== -1 && reasons33.indexOf('depth') !== -1 && reasons33.length >= 2,
    JSON.stringify((found33.skipped || []).map((s) => `${s.rel}:${s.reason}`)))

  // 显示面(核心):结构化字段在、模型看不见 —— render 里必须有这一行。
  //
  // ⚠️ 本断言按"总述行 + 按 reason 分组的多行"判定(不是单行摘要 + 只列前 3 条):
  //    断言意图是**留痕 + 具体原因 + 反面守卫**,只是改成**跨行**判定 ——
  //    总述行说清跳过数与覆盖面口径,oversize / depth 各自出现在**自己那一行**上。
  const out33 = await run(ctx33, 'api_contract', { action: 'lint', root: proj33, paths: ['api'] })
  const text33 = ctx33._tool('api_contract').output.render({}, out33).map((b) => b.text).join('\n')
  const t33lines = text33.split('\n')
  // ⚠️ 总述行的**措辞**随"有没有未展开的子树"分两种(只有文件跳过 → "有 N 个候选被跳过";
  //    有子树 → "跳过 N 处(…)"),所以不用关键词 `候选被` 去捞它,改用 payload 里那条留痕的**首行**
  //    (它就是渲染进回执的那一行,render 只做 String 直出,不做改写 —— 见 lib/feature.js 的
  //    `if (v.scanSkippedNote)`)。
  const noteHead33 = String(out33.scanSkippedNote || '').split('\n')[0]
  const skipSummary33 = noteHead33 ? t33lines.filter((l) => l === noteHead33) : []
  const oversizeLine33 = t33lines.filter((l) => l.indexOf('(oversize)') !== -1)[0] || ''
  const depthLine33 = t33lines.filter((l) => l.indexOf('(depth)') !== -1)[0] || ''
  check('33.2 显示面(跨行判定):留痕是"总述行 + 按原因分组的行" —— 总述行说清跳过数与覆盖面口径,oversize / depth 各自出现在自己那一行',
    !!out33.scanSkippedNote && noteHead33 !== '' && skipSummary33.length === 1
    && skipSummary33[0].indexOf('跳过') !== -1 && skipSummary33[0].indexOf('只覆盖') !== -1
    && t33lines.some((l) => l.indexOf('覆盖面') !== -1)
    && oversizeLine33 !== '' && oversizeLine33 !== depthLine33 && oversizeLine33.indexOf('个 ——') !== -1
    && depthLine33 !== '' && depthLine33.indexOf('棵 ——') !== -1,
    `payload有留痕=${!!out33.scanSkippedNote} 总述行=${skipSummary33[0] ? skipSummary33[0].slice(0, 70) : '(没有)'} oversize行=${oversizeLine33.slice(0, 50) || '(没有)'} depth行=${depthLine33.slice(0, 50) || '(没有)'}`)

  // 反面守卫:一个候选都没被跳过时不许出现跳过留痕(否则就是"永远报警"的假断言)
  const proj33b = path.join(TMP, 'p33clean')
  fs.mkdirSync(path.join(proj33b, 'api'), { recursive: true })
  fs.writeFileSync(path.join(proj33b, 'api', 'openapi.yaml'), normalSpec33, 'utf8')
  const out33b = await run(ctx33, 'api_contract', { action: 'lint', root: proj33b, paths: ['api'] })
  const text33b = ctx33._tool('api_contract').output.render({}, out33b).map((b) => b.text).join('\n')
  check('33.3 反面:候选一个都没被跳过时,回执里不许出现跳过留痕(不许把这条做成"永远报警";连"跳过"两个字都不该出现)',
    !out33b.scanSkippedNote && text33b.indexOf('候选被') === -1 && text33b.indexOf('跳过') === -1,
    `payload=${JSON.stringify(out33b.scanSkippedNote)} 渲染含跳过=${text33b.indexOf('跳过') !== -1}`)
  process.env.DSH_HOME = home0_33
}

// ── 34. status / ledger 路径的"等待超时释放"必须读得出是**谁**──
{
  // 由来:`sweepExpiredWaits` 返回的是**对象**数组 `{role,to,ageSec}`,而 render 里写的是
  // `v.expiredWaits.join(', ')` —— 只有 send 路径自己先把它转成了字符串。
  // 于是 status / ledger 这两条路径的屏幕上是「等待超时释放:[object Object]」:
  // **释放了谁的等待完全读不出**,而这一行恰恰是"我的等待怎么没了"唯一的解释。
  const home0_34 = process.env.DSH_HOME
  const mkProj34 = (name) => {
    const p = path.join(TMP, name)
    fs.mkdirSync(path.join(p, 'docs', 'workflow'), { recursive: true })
    fs.writeFileSync(path.join(p, 'docs', 'workflow', '.active'), 'active\n', 'utf8')
    return p
  }
  const mkHome34 = (name, profiles) => {
    const h = path.join(TMP, name)
    fs.mkdirSync(path.join(h, 'dev-workflow'), { recursive: true })
    if (profiles) fs.writeFileSync(path.join(h, 'dev-workflow', 'profiles.json'), JSON.stringify(profiles), 'utf8')
    return h
  }
  const render34 = (ctx, out) => ctx._tool('relay').output.render({}, out).map((b) => b.text).join('\n')
  const expireLine34 = (text) => text.split('\n').filter((l) => l.indexOf('等待超时释放') !== -1).join(' | ')

  // 自定义档:等待超时 900ms(默认 15 分钟,测试里根本等不出来)
  const proj34 = mkProj34('p34expire')
  process.env.DSH_HOME = mkHome34('p34expire-home', {
    tiny34: {
      label: '短超时档', desc: '等待超时 900ms',
      coordinator: 'pm', roles: ['pm', 'be'], relay: { waitTimeoutMs: 900 },
    },
  })
  const ctx34 = mockCtx()
  apply(ctx34, {})
  await run(ctx34, 'relay_spawn', { role: 'pm', root: proj34, profile: 'tiny34' })
  await run(ctx34, 'relay_spawn', { role: 'be', root: proj34, profile: 'tiny34' })
  const sent34 = await run(ctx34, 'relay', { action: 'send', root: proj34, profile: 'tiny34', from: 'pm', to: 'be', msg: '等它超时', skipDedupe: true })
  check('34.0 前置:互呼已投出并建立等待关系(pm 等 be)',
    sent34.status === 'done' && !!(sent34.delivery && sent34.delivery.ok), `${sent34.status}/${JSON.stringify(sent34.delivery)}`)
  await new Promise((resolve) => { setTimeout(resolve, 1400) })

  const st34 = await run(ctx34, 'relay', { action: 'status', root: proj34, profile: 'tiny34' })
  check('34.1 数据面:status 路径的超时清扫如实报出被释放的等待(role/to/ageSec 三个字段都在)',
    Array.isArray(st34.expiredWaits) && st34.expiredWaits.length === 1
    && String(st34.expiredWaits[0].role) === 'pm' && String(st34.expiredWaits[0].to) === 'be'
    && typeof st34.expiredWaits[0].ageSec === 'number',
    JSON.stringify(st34.expiredWaits))
  const text34 = render34(ctx34, st34)
  const line34 = expireLine34(text34)
  check('34.2 显示面(核心):回执里读得出"释放了谁的等待"(@pm → @be),且**不许**出现 [object Object]',
    line34.indexOf('@pm') !== -1 && line34.indexOf('@be') !== -1 && text34.indexOf('[object Object]') === -1,
    line34 || '(没有这一行)')

  // ledger 是**另一条**懒触发超时清扫的路径(共用同一个 render),单独再造一次超时来验它 ——
  // 复用第一次的清扫会让 ledger 无事可做,那样这条断言就永远为真(假断言)。
  const sent34b = await run(ctx34, 'relay', { action: 'send', root: proj34, profile: 'tiny34', from: 'pm', to: 'be', msg: '台账路径再超时一次', skipDedupe: true })
  await new Promise((resolve) => { setTimeout(resolve, 1400) })
  const lg34 = await run(ctx34, 'relay', { action: 'ledger', root: proj34, profile: 'tiny34' })
  const lgText34 = render34(ctx34, lg34)
  const lgLine34 = expireLine34(lgText34)
  check('34.3 ledger 路径同样必须读得出是谁(**不许**出现 [object Object];前提是第二次互呼也投出去了)',
    sent34b.status === 'done' && lgLine34.indexOf('@pm') !== -1 && lgLine34.indexOf('@be') !== -1
    && lgText34.indexOf('[object Object]') === -1,
    `${sent34b.status} / ${lgLine34 || '(没有这一行)'}`)

  // 反向守卫:没有超时发生时不许无脑打这一行
  const proj34b = mkProj34('p34nofire')
  process.env.DSH_HOME = mkHome34('p34nofire-home')
  const ctx34b = mockCtx()
  apply(ctx34b, {})
  await run(ctx34b, 'relay_spawn', { role: 'pm', root: proj34b })
  await run(ctx34b, 'relay_spawn', { role: 'be', root: proj34b })
  await run(ctx34b, 'relay', { action: 'send', root: proj34b, from: 'pm', to: 'be', msg: '不超时的对照组' })
  const st34b = await run(ctx34b, 'relay', { action: 'status', root: proj34b })
  const text34b = render34(ctx34b, st34b)
  check('34.4 反面:没有超时发生时回执里不许出现"等待超时释放"这一行(不许无脑打/永远报警)',
    (!Array.isArray(st34b.expiredWaits) || st34b.expiredWaits.length === 0)
    && text34b.indexOf('等待超时释放') === -1,
    `payload=${JSON.stringify(st34b.expiredWaits)} 渲染含=${text34b.indexOf('等待超时释放') !== -1}`)
  process.env.DSH_HOME = home0_34
}

// ── 35. 有候选被跳过时,判定必须跟着**覆盖面**走──────────
{
  // 同一条回执上写「⚠️ 有 N 个候选被**跳过**」,下一行却写「结论:✅ PASS | ERROR 0 / WARN 0」——
  // 而那条结论只覆盖 M/(M+N) 个候选,读的人很容易当成"API 门槛已过"。
  // 口径:判定降级为 `pass_with_skips`(**只降"本来通过"的两种**),
  // 结论/扫描/状态/指纹旁一律带覆盖面 M/N,note 改成"**先别写进「API 契约」小节**",
  // 并且这个结论落进 `slot.apiLint.coverage` —— 于是 relay status 的面板上也不会漂白。
  const home0_35 = process.env.DSH_HOME
  const normal35 = [
    'openapi: 3.1.0', 'info:', '  title: p35 正常 spec', '  version: "1.0.0"',
    'paths:', '  /orders:', '    post:', '      operationId: createOrder',
    '      responses:', '        "201":', '          description: 建单成功',
  ].join('\n')
  const oversize35 = (tag) => `# 超 512 KB 的候选 ${tag}\n${'x'.repeat(600 * 1024)}`
  const proj35 = path.join(TMP, 'p35skip')
  fs.mkdirSync(path.join(proj35, 'api', 'nested', 'a', 'b', 'c'), { recursive: true })
  fs.writeFileSync(path.join(proj35, 'api', 'openapi.yaml'), normal35, 'utf8')
  fs.writeFileSync(path.join(proj35, 'api', 'oversize.yaml'), oversize35('p35'), 'utf8')
  fs.writeFileSync(path.join(proj35, 'api', 'nested', 'a', 'b', 'c', 'openapi.yaml'), normal35, 'utf8')
  const home35 = path.join(TMP, 'p35skip-home')
  fs.mkdirSync(path.join(home35, 'dev-workflow'), { recursive: true })
  process.env.DSH_HOME = home35
  const ctx35 = mockCtx()
  apply(ctx35, {})
  const text35Of = (name, out) => ctx35._tool(name).output.render({}, out).map((b) => b.text).join('\n')
  const lines35 = (text, kw) => text.split('\n').filter((l) => l.indexOf(kw) !== -1)

  const out35 = await run(ctx35, 'api_contract', { action: 'lint', root: proj35, paths: ['api'] })
  const cov35 = out35.scanCoverage || {}
  check('35.1 数据面:有候选被跳过且本来是通过 → verdict=pass_with_skips,scanCoverage 自洽(covered+skipped=total、reasons 四类对得上)',
    out35.verdict === 'pass_with_skips' && cov35.skipped >= 1 && cov35.covered >= 1
    && cov35.total === cov35.covered + cov35.skipped
    && !!cov35.reasons && cov35.reasons.oversize === 1 && cov35.reasons.depth >= 1
    && cov35.reasons.oversize + cov35.reasons.depth + cov35.reasons.unreadable + cov35.reasons.other === cov35.skipped,
    `verdict=${out35.verdict} coverage=${JSON.stringify(out35.scanCoverage)}`)

  const text35 = text35Of('api_contract', out35)
  const concl35 = lines35(text35, '结论:')[0] || ''
  // ⚠️ 35.2/35.3/35.4/35.6 四条按"本夹具的跳过里有一棵**未展开的子树**(depth),
  //    它里面有几个候选是未知数"来判:覆盖面**不给分数**,改成"已扫到的 M 个候选 + 另有 S 处未扫到"。
  //    断言意图一字没降级(结论行不再说 PASS、覆盖面必须可见、降级必须摆在明面上),
  //    只是把"分母"这件事说得与事实相符。只有文件跳过、没有子树的那种口径由 35.12 那条锚负责。
  check('35.2 显示面(结论行):不再是「结论:✅ PASS」,而是"只覆盖已扫到的 M 个候选(另有 S 处未扫到,子树内容未知)"并带「覆盖面 …」;有子树时**不许给分数**',
    concl35.indexOf('⚠️ 通过但**只覆盖 ') !== -1
    && concl35.indexOf(`只覆盖 ${cov35.covered} 个已扫到的候选(另有 ${cov35.skipped} 处未扫到,子树内容未知)`) !== -1
    && concl35.indexOf('有跳过') !== -1 && concl35.indexOf('不算完整通过') !== -1
    && concl35.indexOf(`覆盖面 ${cov35.covered} 个已扫到的候选(另有 ${cov35.skipped} 处未扫到,子树内容未知)`) !== -1
    && concl35.indexOf(`${cov35.covered}/${cov35.total}`) === -1
    && text35.indexOf('结论:✅ PASS') === -1,
    concl35 || '(没有结论行)')

  check('35.3 显示面(扫描行):说清"已扫描 M 个候选文件 + 跳过 S 处(几个文件 / 几棵子树)"(只报"候选 1 个文件"的话,被跳过的那几个候选等于不存在)',
    text35.indexOf(`扫描:已扫描 ${cov35.covered} 个候选文件 + 跳过 ${cov35.skipped} 处(`) !== -1
    && text35.indexOf('1 个文件 + 1 棵未展开的子树)→ 契约') !== -1,
    lines35(text35, '扫描:').join(' | ') || '(没有扫描行)')

  check('35.4 显示面(降级行):明说降级到 pass_with_skips 且"不算通过";有子树时**不许报"整体候选 N 个"**(那是未知数),要如实说"整体候选数无法确定"(不许"悄悄降级"、也不许把未知说成已知)',
    lines35(text35, '判定降级').length === 1
    && lines35(text35, '判定降级')[0].indexOf(`已扫描到的 ${cov35.covered} 个候选`) !== -1
    && lines35(text35, '判定降级')[0].indexOf(`跳过 ${cov35.skipped} 处:1 个文件 + 1 棵未展开的子树`) !== -1
    && lines35(text35, '判定降级')[0].indexOf('整体候选数无法确定') !== -1
    && lines35(text35, '判定降级')[0].indexOf(`整体候选 ${cov35.total} 个`) === -1
    && lines35(text35, '判定降级')[0].indexOf('verdict=`pass_with_skips`') !== -1
    && lines35(text35, '判定降级')[0].indexOf('不算通过') !== -1,
    lines35(text35, '判定降级').join(' | ') || '(没有这一行)')

  check('35.5 显示面(note):从"可以写进「API 契约」小节了"改成"**先别写进**",并给两条出口(depth 精确指到文件;oversize 拆小或**显式登记为未校验**)',
    text35.indexOf('**先别写进「API 契约」小节**') !== -1
    && text35.indexOf('可以写进「API 契约」小节了') === -1
    && text35.indexOf('显式登记为未校验') !== -1,
    lines35(text35, '先别写进').join(' | ').slice(0, 120) || '(没有这一行)')

  // 落盘 + 面板:上次 lint 的结论不许在 relay status 上"漂白"成通过
  const store35 = JSON.parse(fs.readFileSync(path.join(home35, 'dev-workflow', 'state.json'), 'utf8'))
  const slot35 = Object.values(store35.projects || {}).filter((s) => s.root === proj35)[0] || {}
  const covDisk35 = (slot35.apiLint || {}).coverage || {}
  const st35 = await run(ctx35, 'relay', { action: 'status', root: proj35 })
  const apiLine35 = lines35(text35Of('relay', st35), 'API 契约:')[0] || ''
  check('35.6 落盘 + 面板:slot.apiLint.coverage 记下覆盖面(含 files/regions/exactTotal),relay status 的「API 契约」行显示 pass_with_skips(覆盖 …) —— 状态面板上不会漂白成"上次 pass",也不给带未知数的分数',
    (slot35.apiLint || {}).verdict === 'pass_with_skips'
    && covDisk35.covered === cov35.covered && covDisk35.skipped === cov35.skipped && covDisk35.total === cov35.total
    && covDisk35.files === cov35.files && covDisk35.regions === cov35.regions && covDisk35.exactTotal === cov35.exactTotal
    && apiLine35.indexOf(`pass_with_skips(覆盖 ${cov35.covered} 个候选,跳过 ${cov35.skipped} 处)`) !== -1,
    `slot.coverage=${JSON.stringify(covDisk35)} | 面板行=${apiLine35.slice(0, 150)}`)

  // 反面守卫(锚:两侧都该过):零跳过时**一个字的降级都不许有** —— 否则就是"永远报警"的假断言
  const proj35b = path.join(TMP, 'p35clean')
  fs.mkdirSync(path.join(proj35b, 'api'), { recursive: true })
  fs.writeFileSync(path.join(proj35b, 'api', 'openapi.yaml'), normal35, 'utf8')
  const out35b = await run(ctx35, 'api_contract', { action: 'lint', root: proj35b, paths: ['api'] })
  const text35b = text35Of('api_contract', out35b)
  check('35.7 反面(锚):零跳过时 verdict 仍是 pass、回执仍是「结论:✅ PASS」,且没有留痕 / 降级行 / 覆盖面 / "先别写进"(这条判据不许把正常项目也说成没通过)',
    out35b.verdict === 'pass' && out35b.scanCoverage === undefined && out35b.scanVerdictNote === undefined
    && text35b.indexOf('结论:✅ PASS') !== -1
    && text35b.indexOf('候选被') === -1 && text35b.indexOf('判定降级') === -1
    && text35b.indexOf('覆盖面') === -1 && text35b.indexOf('先别写进') === -1
    && text35b.indexOf('扫描:候选 1 个文件 → 契约 1 个') !== -1,
    `verdict=${out35b.verdict} coverage=${JSON.stringify(out35b.scanCoverage)} 含留痕=${text35b.indexOf('候选被') !== -1}`)

  // 降级口径的边界:只降"本来通过"的两种 —— `no_specs`(已明说"不算通过")与
  // `fail`(更紧急)保持原判,但**覆盖面照样渲染**(不掩盖"这条结论只覆盖一部分候选")。
  const proj35c = path.join(TMP, 'p35nospec')
  fs.mkdirSync(path.join(proj35c, 'api'), { recursive: true })
  fs.writeFileSync(path.join(proj35c, 'api', 'oversize.yaml'), oversize35('p35nospec'), 'utf8')
  const out35c = await run(ctx35, 'api_contract', { action: 'lint', root: proj35c, paths: ['api'] })
  const text35c = text35Of('api_contract', out35c)
  const tpl35 = await run(ctx35, 'api_contract', { action: 'template', root: proj35, kind: 'openapi' })
  const proj35d = path.join(TMP, 'p35fail')
  fs.mkdirSync(path.join(proj35d, 'api'), { recursive: true })
  fs.writeFileSync(path.join(proj35d, 'api', 'openapi.yaml'), String(tpl35.documentText || ''), 'utf8')
  fs.writeFileSync(path.join(proj35d, 'api', 'oversize.yaml'), oversize35('p35fail'), 'utf8')
  const out35d = await run(ctx35, 'api_contract', { action: 'lint', root: proj35d, paths: ['api'] })
  const text35d = text35Of('api_contract', out35d)
  check('35.8 降级口径边界:no_specs 与 fail 都**保持原判**(不被降级成 pass_with_skips),但覆盖面照样渲染出来',
    out35c.verdict === 'no_specs' && out35c.scanVerdictNote === undefined
    && text35c.indexOf('➖ 无契约可校验(**不算通过**)') !== -1 && text35c.indexOf('覆盖面 0/1') !== -1
    && text35c.indexOf('判定降级') === -1
    && out35d.verdict === 'fail' && out35d.errors > 0 && out35d.scanVerdictNote === undefined
    && text35d.indexOf('结论:❌ FAIL') !== -1 && text35d.indexOf('覆盖面 ') !== -1
    && text35d.indexOf('ERROR 未清零') !== -1 && text35d.indexOf('判定降级') === -1,
    `no_specs: verdict=${out35c.verdict} 含覆盖面=${text35c.indexOf('覆盖面 0/1') !== -1} | fail: verdict=${out35d.verdict} errors=${out35d.errors} 含降级行=${text35d.indexOf('判定降级') !== -1}`)

  // ── 口径:折叠嵌套 + 计数按"**处**" ──────────────────────────────────────────
  // 夹具 p35skip = 1 正常 + 1 oversize + 1 超深件。旧口径报"跳过 3",而**真实未扫到的候选是 2 个**:
  // 同一片未展开的深子树被**祖先目录**(从项目根起的 walk:它在根下已是第 3 层)与**自身目录**
  // (从 `api` 起的 walk:从这里数才是第 3 层)各记一次,`paths` 与默认目录重叠时再记一遍。
  // 反向也错:把"1 棵子树"当"1 个候选"塞进分母 → 子树里装 50 份契约时报"覆盖 8/9(89%)"。
  const rels35 = (out35.scanSkipped || []).map((s) => `${s.rel}:${s.reason}`)
  const raw35 = (typeof libmod.discoverApiSpecs === 'function' ? libmod.discoverApiSpecs(proj35, ['api']).skipped : []).map((s) => `${s.rel}:${s.reason}`)
  check('35.9 折叠口径:显示面里 depth 只剩**最深**那条(api/nested/a/b),祖先 api/nested/a 被折掉;数据面 found.skipped 仍留全量(折叠只发生在"覆盖面"这个口径里)',
    cov35.skipped === 2 && cov35.files === 1 && cov35.regions === 1 && cov35.total === 3
    && rels35.indexOf('api/nested/a/b:depth') !== -1 && rels35.indexOf('api/nested/a:depth') === -1
    && raw35.indexOf('api/nested/a:depth') !== -1 && raw35.length >= 3,
    `payload=${rels35.join(',')} | 数据面=${raw35.join(',')}`)

  // 兄弟子树各自保号(折叠最容易折过头的地方)
  const proj35sib = path.join(TMP, 'p35sib')
  fs.mkdirSync(path.join(proj35sib, 'api', 'nested', 'a', 'b', 'c'), { recursive: true })
  fs.mkdirSync(path.join(proj35sib, 'api', 'nested', 'a', 'd', 'e'), { recursive: true })
  fs.writeFileSync(path.join(proj35sib, 'api', 'openapi.yaml'), normal35, 'utf8')
  fs.writeFileSync(path.join(proj35sib, 'api', 'nested', 'a', 'b', 'c', 'x.yaml'), normal35, 'utf8')
  fs.writeFileSync(path.join(proj35sib, 'api', 'nested', 'a', 'd', 'e', 'y.yaml'), normal35, 'utf8')
  const out35sib = await run(ctx35, 'api_contract', { action: 'lint', root: proj35sib, paths: ['api'] })
  const cov35sib = out35sib.scanCoverage || {}
  const rels35sib = (out35sib.scanSkipped || []).map((s) => s.rel)
  check('35.10 反面(锚):**兄弟**两棵深子树各留一号(只折祖先、不折兄弟)—— depth 原始记录是 a(根 walk)+ a/b、a/d(api walk),折叠后剩 a/b 与 a/d',
    cov35sib.regions === 2 && cov35sib.files === 0 && cov35sib.skipped === 2
    && rels35sib.indexOf('api/nested/a/b') !== -1 && rels35sib.indexOf('api/nested/a/d') !== -1
    && rels35sib.indexOf('api/nested/a') === -1
    && text35Of('api_contract', out35sib).indexOf('跳过 2 处(2 棵未展开的子树)') !== -1
    && text35Of('api_contract', out35sib).indexOf('跳过 2 处(2 棵未展开的子树):本次结论只覆盖 1 个已扫到的候选') !== -1,
    `coverage=${JSON.stringify(cov35sib)} | entries=${rels35sib.join(',')}`)

  // 一棵子树里装着 3 份契约 → 更不许给分数(旧口径会报"覆盖 1/3(33%)",而真实候选数 ≥5 = 高估)
  const proj35many = path.join(TMP, 'p35many')
  fs.mkdirSync(path.join(proj35many, 'api', 'nested', 'a', 'b', 'c'), { recursive: true })
  fs.writeFileSync(path.join(proj35many, 'api', 'openapi.yaml'), normal35, 'utf8')
  fs.writeFileSync(path.join(proj35many, 'api', 'oversize.yaml'), oversize35('p35many'), 'utf8')
  for (const n of ['s1', 's2', 's3']) fs.writeFileSync(path.join(proj35many, 'api', 'nested', 'a', 'b', 'c', `${n}.yaml`), normal35, 'utf8')
  const out35many = await run(ctx35, 'api_contract', { action: 'lint', root: proj35many, paths: ['api'] })
  const text35many = text35Of('api_contract', out35many)
  const cov35many = out35many.scanCoverage || {}
  check('35.11 折叠口径的核心:子树里装 3 份契约时**不许**给分数(把一棵子树当 1 个候选 → 报"覆盖 1/3(33%)",而真实候选数 ≥5)—— 回执里改说"子树内容未知 / 整体候选数无法确定"',
    cov35many.regions === 1 && cov35many.skipped === 2 && cov35many.files === 1
    && text35many.indexOf(`${cov35many.covered}/${cov35many.total}`) === -1
    && text35many.indexOf('整体候选数无法确定') !== -1
    && text35many.indexOf('子树内容未知') !== -1
    && text35many.indexOf('另有 2 处未扫到') !== -1,
    `coverage=${JSON.stringify(cov35many)} 含分数=${text35many.indexOf(`${cov35many.covered}/${cov35many.total}`) !== -1}`)

  // 反面锚:跳过里**只有文件**时,逐字保留原来那句精确分数(不许把正常情形也改成"未知")
  const proj35only = path.join(TMP, 'p35only')
  fs.mkdirSync(path.join(proj35only, 'api'), { recursive: true })
  fs.writeFileSync(path.join(proj35only, 'api', 'openapi.yaml'), normal35, 'utf8')
  fs.writeFileSync(path.join(proj35only, 'api', 'oversize.yaml'), oversize35('p35only'), 'utf8')
  const out35only = await run(ctx35, 'api_contract', { action: 'lint', root: proj35only, paths: ['api'] })
  const text35only = text35Of('api_contract', out35only)
  const cov35only = out35only.scanCoverage || {}
  const head35only = String(out35only.scanSkippedNote || '').split('\n')[0]
  check('35.12 反面(锚):只有文件级跳过(1 oversize)时 exactTotal=true,照样给**精确分数**「只覆盖 1/2 个候选(50%)」,总述行也仍是那句「有 1 个候选被**跳过**」',
    cov35only.exactTotal === true && cov35only.regions === 0
    && head35only.indexOf('⚠️ 有 1 个候选被**跳过**:本次结论只覆盖 1/2 个候选(50%)') === 0
    && text35only.indexOf('只覆盖 1/2 个候选(50%)') !== -1
    && text35only.indexOf('候选总数无法确定') === -1,
    `coverage=${JSON.stringify(cov35only)} 总述行=${head35only.slice(0, 80)}`)
  process.env.DSH_HOME = home0_35
}

// ── 36. 跳过留痕要按 reason **分组 + 列全**,建议要"能救的说能救、救不了的说救不了"──
{
  // 留痕只列**前 3 条**(`slice(0,3) + '…'`,第 4 条起永久不可见)不行,而且那句
  // 「若契约明明在,请用 paths 精确指路」对 oversize **是错的**:
  // ① `paths` 是**追加**(默认候选目录 ∪ paths),不是收窄;② size 守卫对 paths 同样生效 ——
  // 精确指到那个超限文件上它照样被跳过。模型照做一次、回执一字未变,于是以为"这文件扫不到"。
  const home0_36 = process.env.DSH_HOME
  const normal36 = [
    'openapi: 3.1.0', 'info:', '  title: p36 正常 spec', '  version: "1.0.0"',
    'paths:', '  /orders:', '    post:', '      operationId: createOrder',
    '      responses:', '        "201":', '          description: 建单成功',
  ].join('\n')
  const oversize36 = (tag) => `# 超 512 KB 的候选 ${tag}\n${'x'.repeat(600 * 1024)}`
  const proj36 = path.join(TMP, 'p36skip')
  fs.mkdirSync(path.join(proj36, 'api', 'nested', 'a', 'b', 'c'), { recursive: true })
  fs.writeFileSync(path.join(proj36, 'api', 'openapi.yaml'), normal36, 'utf8')
  for (let i = 1; i <= 5; i += 1) fs.writeFileSync(path.join(proj36, 'api', `big${i}.yaml`), oversize36(`p36-${i}`), 'utf8')
  fs.writeFileSync(path.join(proj36, 'api', 'nested', 'a', 'b', 'c', 'openapi.yaml'), normal36, 'utf8')
  const home36 = path.join(TMP, 'p36skip-home')
  fs.mkdirSync(path.join(home36, 'dev-workflow'), { recursive: true })
  process.env.DSH_HOME = home36
  const ctx36 = mockCtx()
  apply(ctx36, {})
  const text36Of = (out) => ctx36._tool('api_contract').output.render({}, out).map((b) => b.text).join('\n')

  const out36 = await run(ctx36, 'api_contract', { action: 'lint', root: proj36, paths: ['api'] })
  const text36 = text36Of(out36)
  const t36 = text36.split('\n')
  const grp36 = (kw) => t36.filter((l) => l.indexOf(kw) !== -1)[0] || ''
  const bigNames36 = ['big1', 'big2', 'big3', 'big4', 'big5'].map((n) => `api/${n}.yaml`)
  check('36.1 列全:5 个超限候选的文件名一个不少(`slice(0,3) + …` 会让 big4 / big5 永久不可见 —— 被跳过的候选必须能被点名)',
    bigNames36.every((n) => text36.indexOf(n) !== -1)
    && text36.indexOf('api/big1.yaml(600 KB > 512 KB)') !== -1
    && text36.indexOf('api/big5.yaml(600 KB > 512 KB)') !== -1,
    `缺=${bigNames36.filter((n) => text36.indexOf(n) === -1).join(',') || '(一个不缺)'}`)

  check('36.2 分组结构:一行总述 + **每组一行**(说清条数)+ 组内逐条;oversize / depth 不再挤在同一行(depth 组的单位是"棵")',
    t36.filter((l) => l.indexOf(String(out36.scanSkippedNote || '').split('\n')[0]) === 0 && l.indexOf('⚠️') === 0).length === 1
    && grp36('(oversize)').indexOf('超过 512 KB 上限(oversize): 5 个') !== -1
    && grp36('(depth)').indexOf('超过 2 层目录深度(depth): 1 棵') !== -1
    && grp36('(oversize)') !== grp36('(depth)')
    && t36.some((l) => l.indexOf('      - api/big5.yaml(600 KB > 512 KB)') !== -1)
    && t36.some((l) => l.indexOf('      - api/nested/a/b(深度 > 2)') !== -1),
    `${grp36('(oversize)').slice(0, 60)} || ${grp36('(depth)').slice(0, 60)}`)

  check('36.3 oversize 组的建议必须说清"**paths 精确指路对它无效**"(size 守卫对 paths 同样生效)—— "请用 paths 精确指路"在这里是做不到的事',
    grp36('(oversize)').indexOf('**paths 精确指路对它无效**') !== -1
    && grp36('(oversize)').indexOf('显式登记为未校验') !== -1,
    grp36('(oversize)').slice(0, 200))

  check('36.4 depth 组的建议必须说清"精确指到**文件**可以把它补进结论",并说明 paths 是**追加**不是收窄(只说"指目录不行"不准确)',
    grp36('(depth)').indexOf('**用 paths 精确指到"文件"可以把它补进结论**') !== -1
    && grp36('(depth)').indexOf('不是收窄') !== -1,
    grp36('(depth)').slice(0, 200))

  check('36.5 旧建议已删除:回执里不许再出现「若契约明明在,请用 paths 精确指路」',
    text36.indexOf('若契约明明在') === -1 && text36.indexOf('请用 paths 精确指路') === -1,
    `含旧句=${text36.indexOf('若契约明明在') !== -1}`)

  // 每组默认上限 6:超出如实报"另有 N 个"(不静默消失,也不无限刷屏);数据面保留全量
  const proj36b = path.join(TMP, 'p36cap')
  fs.mkdirSync(path.join(proj36b, 'api'), { recursive: true })
  fs.writeFileSync(path.join(proj36b, 'api', 'openapi.yaml'), normal36, 'utf8')
  for (let i = 1; i <= 7; i += 1) fs.writeFileSync(path.join(proj36b, 'api', `cap${i}.yaml`), oversize36(`p36-cap-${i}`), 'utf8')
  const out36b = await run(ctx36, 'api_contract', { action: 'lint', root: proj36b, paths: ['api'] })
  const text36b = text36Of(out36b)
  check('36.6 每组上限:7 条同类只列 6 条 + 「…另有 1 个同类条目(数据面字段 scanSkipped 里有全量)」,而 payload.scanSkipped 仍是全量 7 条',
    text36b.indexOf('…另有 1 个同类条目') !== -1
    && text36b.indexOf('api/cap6.yaml') !== -1 && text36b.indexOf('api/cap7.yaml') === -1
    && (out36b.scanSkipped || []).length === 7,
    `列出=${(text36b.match(/api\/cap\d+\.yaml/g) || []).join(',')} payload=${(out36b.scanSkipped || []).length} 条`)

  const paths36 = ((ctx36._tool('api_contract').parameters || {}).properties || {}).paths || {}
  const desc36 = String(paths36.description || '')
  check('36.7 参数说明:api_contract 的 `paths` 必须写明**追加**语义与 512 KB 守卫(否则模型继续把 paths 当收窄手段、继续拿它去救超限文件)',
    desc36.indexOf('**追加**') !== -1 && desc36.indexOf('512 KB') !== -1 && desc36.indexOf('精确指到文件路径也会被跳过') !== -1,
    desc36.slice(0, 200) || '(读不到 paths 说明)')

  // 反面守卫:干净夹具下不许出现任何跳过留痕(尤其不许出现"能救的说能救"那类新建议)
  const proj36c = path.join(TMP, 'p36clean')
  fs.mkdirSync(path.join(proj36c, 'api'), { recursive: true })
  fs.writeFileSync(path.join(proj36c, 'api', 'openapi.yaml'), normal36, 'utf8')
  const out36c = await run(ctx36, 'api_contract', { action: 'lint', root: proj36c, paths: ['api'] })
  const text36c = text36Of(out36c)
  check('36.8 反面(锚):零跳过时不许出现任何跳过留痕或"paths 精确指路对它无效"字样(不许把建议做成"永远报警")',
    text36c.indexOf('候选被') === -1 && text36c.indexOf('paths 精确指路对它无效') === -1
    && text36c.indexOf('若契约明明在') === -1 && text36c.indexOf('个同类条目') === -1,
    `含留痕=${text36c.indexOf('候选被') !== -1}`)
  process.env.DSH_HOME = home0_36
}

// ── 37. 显示面补口:字段写进了 payload、render 却读不到的那批──────────────
{
  // 这些字段都写进了 payload,但 render 里**一个读取点都没有**(或守卫写错 → 那条分支永远
  // 打不出来):「这次动手的是哪个项目根」「台账落在哪」「noDeliver 该把正文发给谁」
  // 「被清掉的是哪一条绑定」「待仲裁队列有几条」「哪个角色缺哪个预设」「协调者到底就位没有」
  // 「解绑了谁 / 解掉哪些等待」「这次开工消息的 id / 环境约束注没注」「回传的是磁盘真内容
  // 还是空模板」「确认人有没有参与证据」「状态文件在不在 / 需求名 / 这个门意味着什么」。
  // 屏幕上全靠猜,模型只能翻 payload 反推。
  //
  // 这些行统一是"**字段在才打**"的条件行,所以这里逐条造**真实触发**、按**渲染文本**
  // 取证;每一段配一条反面守卫(无关动作不许出现这些行),防止写成"永远报警"的假断言。
  const home0_37 = process.env.DSH_HOME
  const mkProj37 = (name, opts) => {
    const o = opts || {}
    const p = path.join(TMP, name)
    fs.mkdirSync(path.join(p, 'docs', 'workflow'), { recursive: true })
    if (o.gate !== null) {
      const head = o.gate || 'active'
      fs.writeFileSync(path.join(p, 'docs', 'workflow', '.active'), `${head}\n${o.stateName ? `stateName=${o.stateName}\n` : ''}`, 'utf8')
    }
    if (o.state) fs.writeFileSync(path.join(p, 'docs', 'workflow', '流程状态.md'), o.state, 'utf8')
    return p
  }
  const proj37 = mkProj37('p37audit', { state: ['# 流程状态:p37', '', '## 遗留风险', '- p37-风险'].join('\n') })
  const proj37empty = mkProj37('p37empty')
  const proj37named = mkProj37('p37named', { stateName: '需求甲' })
  const proj37never = mkProj37('p37never', { gate: null })
  const proj37off = mkProj37('p37off', { gate: 'off' })
  const proj37b = mkProj37('p37spawn')
  const home37 = path.join(TMP, 'p37-home')
  fs.mkdirSync(path.join(home37, 'dev-workflow'), { recursive: true })
  process.env.DSH_HOME = home37
  const ctx37 = mockCtx()
  apply(ctx37, {})
  const T37 = (name, out) => ctx37._tool(name).output.render({}, out).map((b) => b.text).join('\n')
  const cut37 = (text, kw) => text.split('\n').filter((l) => l.indexOf(kw) !== -1).join(' | ')
  const yes37 = (text, kw) => text.indexOf(kw) !== -1

  // ①② 项目根 / kickoff 的三行(协调者就位、可用档、这次的门)
  const ko37 = await run(ctx37, 'relay', { action: 'kickoff', root: proj37, goal: '显示面取证' })
  const koText37 = T37('relay', ko37)
  // kickoff 还有一条**不派活就返回**的路径:`.active` 写了 off 时直接早退 —— 它同样把
  // "这次动手的是哪个根"写在回执里,所以同一个读取点要两条路径都验(否则"根错一位"的
  // 后果会被漏掉一半:早退那句 note 只说"被显式关闭",不说撤的是哪个目录)。
  const koOff37 = await run(ctx37, 'relay', { action: 'kickoff', root: proj37off, goal: '被显式关闭的项目' })
  const koOffText37 = T37('relay', koOff37)
  check('37.1 项目根:kickoff 的两条路径(正常派活 / `.active=off` 早退)都要写出**这次动手的是哪个项目根**(字段只进 payload 的话,根错一位会去派另一个目录的角色,屏幕上却从不出现)',
    yes37(koText37, `项目根:${proj37}`)
    && koOff37.status === 'inactive' && yes37(koOffText37, `项目根:${proj37off}`),
    `${cut37(koText37, '项目根:') || '(正常路径没有这一行)'} ‖ ${cut37(koOffText37, '项目根:') || '(早退路径没有这一行)'}`)
  check('37.2 kickoff:「协调者到底就位没有」「有哪些档可用」「这次的门是怎么判的」三行都要能读出来',
    yes37(koText37, '协调者 @pm:✅ 已就位(唯一的回话入口)')
    && yes37(koText37, '可用 profile:standard, lean3, review')
    && yes37(koText37, '激活门:active(文件 docs/workflow/.active)'),
    [cut37(koText37, '协调者 @'), cut37(koText37, '可用 profile:'), cut37(koText37, '激活门:')].join(' | ').slice(0, 200))
  const pf37 = await run(ctx37, 'relay', { action: 'profile', root: proj37 })
  check('37.3 反面:与"动手改这个项目"无关的动作(profile)不许打「项目根:」—— 它是"这次动了哪个根"的回执,不是每次刷的噪音',
    !yes37(T37('relay', pf37), '项目根:') && pf37.status === 'ok',
    `profile 回执含项目根=${yes37(T37('relay', pf37), '项目根:')}`)

  // ③ 台账行(send)
  const sd37 = await run(ctx37, 'relay', { action: 'send', root: proj37, from: 'pm', to: 'be', msg: '台账行必须可见' })
  const sdText37 = T37('relay', sd37)
  const ledgerPath37 = path.join(proj37, 'docs', 'workflow', '协作台账.md')
  check('37.4 协作台账:send 的回执必须说清"这次互呼后台账有几行、落在哪个文件"(render 里唯一的读取点要求 ledgerStatus / arbitrationPending,而 send 两个字段都不写 → 这条 100% 打不出来)',
    sd37.status === 'done' && sd37.ledgerRows >= 1
    && yes37(sdText37, `协作台账:${sd37.ledgerRows} 行 → relay action=ledger 渲染投影(${ledgerPath37})`),
    cut37(sdText37, '协作台账:') || '(没有这一行)')

  // ④ noDeliver:该发给谁、正文在哪
  const nd37 = await run(ctx37, 'relay', { action: 'send', root: proj37, from: 'arch', to: 'qa', msg: 'noDeliver 目标必须可见', noDeliver: true })
  const ndText37 = T37('relay', nd37)
  const dv37 = nd37.deliver || {}
  check('37.5 noDeliver:回执必须写出**该把正文发给哪个 agent**、正文多少字、正文在哪(否则屏幕上只剩「投递:✗ off noDeliver=true」,收件人只能靠翻 payload)',
    yes37(ndText37, `noDeliver:正文未由插件投出 —— 用 send_message 发给 agent=${dv37.targetAgentId}`)
    && yes37(ndText37, `;正文(${String(dv37.text || '').length} 字)在 payload.deliver.text`),
    cut37(ndText37, 'noDeliver:') || '(没有这一行)')
  check('37.6 反面:正常投递成功的回执不许出现 noDeliver 行 —— 它只在"插件没投出去"时出现',
    !yes37(sdText37, 'noDeliver:正文未由插件投出') && yes37(sdText37, '投递:✓'),
    `正常 send 含 noDeliver=${yes37(sdText37, 'noDeliver:正文未由插件投出')}`)

  // ⑤ 共用的反面:status 走老口径,这些专有行一个都不许冒出来
  const st37 = await run(ctx37, 'relay', { action: 'status', root: proj37 })
  const stText37 = T37('relay', st37)
  check('37.7 反面:relay status 保持老口径(「待仲裁:N 条 | 台账 N 行」),不许出现 send 专有的「协作台账:」,也不许出现「noDeliver:正文未由插件投出」「预设对照」「项目根:」',
    yes37(stText37, '待仲裁:') && yes37(stText37, '台账 ')
    && !yes37(stText37, '协作台账:')
    && !yes37(stText37, 'noDeliver:正文未由插件投出')
    && !yes37(stText37, '预设对照')
    && !yes37(stText37, '项目根:'),
    cut37(stText37, '待仲裁:') || '(没有待仲裁行)')

  // ⑥ presets:逐角色对照表(render 必须读 status 写下的 presetView,而不是 expected/others)
  const pr37 = await run(ctx37, 'relay', { action: 'presets', root: proj37 })
  const prText37 = T37('relay', pr37)
  check('37.8 presets:逐角色对照表必须打出来(哪个角色装了哪个预设 / 哪个没装 / 有没有不属于本 profile 的预设)',
    yes37(prText37, '预设对照(profile=standard,期望 5 个角色):')
    && yes37(prText37, '  @pm wf-pm ✅ 就绪 (dev-workflow 项目经理)')
    && yes37(prText37, '  @qa wf-qa — 未安装(可选)')
    && yes37(prText37, '  不属于本 profile 的预设:(无)'),
    cut37(prText37, '预设对照') + ' ‖ ' + cut37(prText37, '  @').slice(0, 120))
  check('37.9 反面:presets 的对照表不许搬到 status 上(status 走 presetView 老块),presets 也不许反过来打"角色预设"块 —— 两条路径各打各的',
    !yes37(stText37, '预设对照') && yes37(stText37, '角色预设') && !yes37(prText37, '角色预设'),
    `status 含对照表=${yes37(stText37, '预设对照')} / presets 含角色预设块=${yes37(prText37, '角色预设')}`)

  // ⑦ arbitrate 被拒:队列有几条
  const child37 = live['child-be']
  const arb37 = await runAs(ctx37, child37, 'relay', { action: 'arbitrate', root: proj37 })
  const arbText37 = T37('relay', arb37)
  check('37.10 arbitrate 被拒:拒绝回执必须报出队列条数(note 若让调用者"用 status 看「待仲裁:N 条」并把这件事报给协调者",它连有几条都读不到,只能再调一次 status 才敢回话)',
    arb37.status === 'unauthorized'
    && yes37(arbText37, `待仲裁队列:${arb37.pending} 条(**一条都没取走** —— 本动作只放行协调者/调度者)`),
    cut37(arbText37, '待仲裁队列:') || '(没有这一行)')
  const arbOk37 = await run(ctx37, 'relay', { action: 'arbitrate', root: proj37 })
  check('37.11 反面:授权路径(调度者本人取队列)不许出现"一条都没取走"的措辞 —— 那是被拒时的解释,不是成功回执',
    !yes37(T37('relay', arbOk37), '一条都没取走') && yes37(T37('relay', arbOk37), '取出仲裁事件:'),
    cut37(T37('relay', arbOk37), '取出仲裁事件:') || '(没有这一行)')

  // ⑧ relay_spawn 成功:messageId + 环境约束(ENV_NOTES)
  const sp37 = await runAs(ctx37, parentAgent, 'relay_spawn', { role: 'be', root: proj37b })
  const spText37 = T37('relay_spawn', sp37)
  check('37.12 relay_spawn 成功回执:这次开工消息的 id(可与宿主日志对照)+ 环境约束(ENV_NOTES)到底注没注进去 —— 两样只进 payload 的话,屏幕上既没有消息 id 也没有注入回执',
    sp37.status === 'spawned' && !!sp37.messageId
    && yes37(spText37, `messageId=${sp37.messageId}(这次开工消息的 id,可与宿主日志对照)`)
    && yes37(spText37, '环境约束(ENV_NOTES):✓ 已随 persona 注入(平台/沙箱/路径口径)'),
    [cut37(spText37, 'messageId='), cut37(spText37, '环境约束')].join(' | ') || '(没有这两行)')
  const spDup37 = await run(ctx37, 'relay_spawn', { role: 'be', root: proj37b })
  check('37.13 反面:exists 早退(角色已在位)不许出现 messageId / 环境约束行 —— 它这次没派活,不许照抄成功回执',
    spDup37.status === 'exists'
    && !yes37(T37('relay_spawn', spDup37), 'messageId=')
    && !yes37(T37('relay_spawn', spDup37), '环境约束(ENV_NOTES)'),
    `exists 回执含 messageId=${yes37(T37('relay_spawn', spDup37), 'messageId=')}`)

  // ⑨ save:确认人的"好消息"也要出声
  const sv37 = await run(ctx37, 'workflow_state_save', { root: proj37, role: 'pm', nextStep: '显示面取证', contractRevision: { content: 'REV-2301', affected: 'be', confirmedBy: '@be' } })
  check('37.14 save:确认人**有参与证据**时要有"已核对"的好消息(只报坏消息的话,"确实核对过"与"一个确认人都没写"在屏幕上长得一模一样)',
    yes37(T37('workflow_state_save', sv37), '  ✅ 已核对参与证据的确认人:@be(已派会话)'),
    cut37(T37('workflow_state_save', sv37), '已核对参与证据') || '(没有这一行)')
  const svB37 = await run(ctx37, 'workflow_state_save', { root: proj37, role: 'pm', nextStep: '不带修订' })
  check('37.15 反面:这次 save 根本没写 contractRevision → 不许出现"已核对参与证据的确认人"(不许无脑打一行)',
    !yes37(T37('workflow_state_save', svB37), '已核对参与证据的确认人'),
    `含好消息=${yes37(T37('workflow_state_save', svB37), '已核对参与证据的确认人')}`)

  // ⑩ status 的四个字段(hasState / stateName / autoStart / gateReason)
  const stA37 = T37('workflow_state_status', await run(ctx37, 'workflow_state_status', { root: proj37 }))
  const stE37 = T37('workflow_state_status', await run(ctx37, 'workflow_state_status', { root: proj37empty }))
  check('37.16 状态文件:有没有真的状态文件必须写出来(有 → "已有(load/save 都落在它上面)";没有 → "还没有(首次 save 才会生成)")',
    yes37(stA37, '状态文件:已有(load/save 都落在它上面)')
    && yes37(stE37, '状态文件:还没有(首次 save 才会生成)'),
    `${cut37(stA37, '状态文件:')} ‖ ${cut37(stE37, '状态文件:')}`)
  const stN37 = T37('workflow_state_status', await run(ctx37, 'workflow_state_status', { root: proj37named }))
  check('37.17 需求名(stateName):空值要说清"回落到主状态文件",写了名字就显示那个名字(多流程并行时,人得知道自己在读写哪一份)',
    yes37(stA37, '需求名(stateName):(空值 → 主状态文件)') && yes37(stN37, '需求名(stateName):需求甲'),
    `${cut37(stA37, '需求名(stateName):')} ‖ ${cut37(stN37, '需求名(stateName):')}`)
  const stNever37 = T37('workflow_state_status', await run(ctx37, 'workflow_state_status', { root: proj37never }))
  const stOff37 = T37('workflow_state_status', await run(ctx37, 'workflow_state_status', { root: proj37off }))
  check('37.18 autoStart + gateReason:未激活 → "可直接开工:autoStart=true";.active 写了 off → "不会自动激活:autoStart=false";两种门都要给出可读的判定理由',
    yes37(stNever37, '可直接开工:autoStart=true(') && yes37(stNever37, '门判定:未激活(gate=none)')
    && yes37(stOff37, '不会自动激活:autoStart=false(') && yes37(stOff37, '门判定:显式关闭(.active 写了 off)(gate=off)'),
    `${cut37(stNever37, 'autoStart')} ‖ ${cut37(stOff37, 'autoStart')}`)
  const ld37 = T37('workflow_state_load', await run(ctx37, 'workflow_state_load', { root: proj37 }))
  check('37.19 反面:load 不写 hasState / stateName → 不许出现「状态文件:」「需求名(stateName):」(字段在才打,不做"永远打印一行空话")',
    !yes37(ld37, '需求名(stateName):') && !yes37(ld37, '状态文件:') && yes37(ld37, '标题:'),
    `load 含状态文件行=${yes37(ld37, '状态文件:')}`)

  // ⑪ use 空参:回传的是磁盘真内容还是空模板
  const u37 = T37('workflow_state_use', await run(ctx37, 'workflow_state_use', { root: proj37, stateName: '' }))
  const uE37 = T37('workflow_state_use', await run(ctx37, 'workflow_state_use', { root: proj37empty, stateName: '' }))
  check('37.20 use 空参:回传内容到底是"磁盘上的现有全文"还是"空模板"必须写出来(照 persistInstruction 落盘时,回传空模板 = 把真实进度整份清空,同一个字段在 kickoff 分支反而渲染了)',
    yes37(u37, '回传内容:磁盘上的现有状态文件全文(不是空模板;照 persistInstruction 落盘不会清空进度)')
    && yes37(uE37, '⚠️ 回传内容:**空模板**(目标状态文件不存在或读不出来)'),
    `${cut37(u37, '回传内容:').slice(0, 40)} ‖ ${cut37(uE37, '回传内容:').slice(0, 40)}`)
  const uN37 = T37('workflow_state_use', await run(ctx37, 'workflow_state_use', { root: proj37, stateName: '某需求' }))
  check('37.21 反面:带 stateName 的分支不写 existingState → 不许出现「回传内容:」(它只在空参分支打)',
    !yes37(uN37, '回传内容:') && yes37(uN37, 'BEGIN 流程状态.md'),
    `带 stateName 的 use 含回传内容行=${yes37(uN37, '回传内容:')}`)

  // ⑫ 失效绑定:换会话后对旧绑定 send
  const schedB37 = { id: 'sched-37b', session: { header: { cwd: proj37 } } }
  const stale37 = await runAs(ctx37, schedB37, 'relay', { action: 'send', root: proj37, from: 'pm', to: 'be', msg: '换会话后投旧绑定' })
  const staleText37 = T37('relay', stale37)
  const oldId37 = String((stale37.staleBinding || {}).oldAgentId)
  check('37.22 失效绑定:回执必须说出**被清掉的是哪一条绑定**(@be(短 id…))、它的归属与期望调度者、以及"先 relay_spawn 重派"(oldAgentId 不显示的话,人只能从 abort 那句话里读到 owner)',
    stale37.status === 'stale_binding' && oldId37 !== ''
    && yes37(staleText37, `🔁 失效绑定:@be(${oldId37.slice(0, 8)}…)属于另一个父会话 `)
    && yes37(staleText37, 'sched-37b') && yes37(staleText37, '该绑定已清理,先 relay_spawn 重派'),
    cut37(staleText37, '失效绑定:') || '(没有这一行)')
  check('37.23 反面:投递成功的回执不许出现「失效绑定:」—— 那是换会话专有的解释,正常投递打它就是噪音',
    !yes37(sdText37, '失效绑定:'),
    `正常 send 含失效绑定=${yes37(sdText37, '失效绑定:')}`)

  // ⑬ deactivate:解绑了谁 / 解掉哪些等待(0 也如实报,不报告警)+ 项目根的第二条触发路径
  await run(ctx37, 'relay_spawn', { role: 'be', root: proj37 }) // 上面 staleBinding 把 be 的绑定清了,补回来凑满 5 个
  const de37 = await run(ctx37, 'relay', { action: 'deactivate', root: proj37 })
  const deText37 = T37('relay', de37)
  const de2_37 = await run(ctx37, 'relay', { action: 'deactivate', root: proj37 })
  const de2Text37 = T37('relay', de2_37)
  check('37.24 deactivate:回执要说清"解绑了哪几个角色 / 解掉哪些等待"(列表与计数对得上)、这次撤的是哪个项目根;重复 deactivate 的 0 也如实报且不报告警',
    yes37(deText37, `项目根:${proj37}`)
    && de37.releasedRoles.length === 5
    && yes37(deText37, '本次撤销:解绑角色 5 个(@')
    && yes37(deText37, '| 解掉等待 0 条')
    && yes37(de2Text37, '本次撤销:解绑角色 0 个 | 解掉等待 0 条')
    && !yes37(de2Text37, '⚠️ 本次撤销'),
    `${cut37(deText37, '本次撤销:')} ‖ ${cut37(de2Text37, '本次撤销:')}`)

  // ⑭ kickoff 协调者没派成(degraded):必须点名"回话入口没就位"
  const proj37ko = mkProj37('p37ko', { gate: null })
  const home37d = path.join(TMP, 'p37d-home')
  fs.mkdirSync(path.join(home37d, 'dev-workflow'), { recursive: true })
  process.env.DSH_HOME = home37d
  const ctx37d = mockCtx({
    subagents: {
      list: () => ['fork'],
      async sendMessage() { throw new Error('不该被调到') },
      async startContinuable() { throw new Error('provider 崩') },
    },
  })
  apply(ctx37d, {})
  const ko37d = await runAs(ctx37d, parentAgent, 'relay', { action: 'kickoff', root: proj37ko, goal: '协调者缺席' })
  const ko37dText = ctx37d._tool('relay').output.render({}, ko37d).map((b) => b.text).join('\n')
  check('37.25 kickoff 协调者没派成:必须点名"协调者没就位 + degraded=true + 没人能给这批角色派活"并给出补救动作(note 只留失败原因前 80 字的话,"回话入口没就位"这件事谁也读不到)',
    ko37d.degraded === true
    && yes37(ko37dText, '⚠️ 协调者 @pm **没就位**(degraded=true)')
    && yes37(ko37dText, 'relay_spawn 补派')
    && yes37(ko37dText, `项目根:${proj37ko}`),
    cut37(ko37dText, '协调者 @pm **没就位**').slice(0, 120) || '(没有这一行)')
  process.env.DSH_HOME = home0_37
}

// ── 38. 两处"执行不到的死分支" + 同一事件只报一次版本告警 ──────────────
{
  // 两条"执行不到的死分支":
  //   ① `relay` render 的 `if (v.ledger)`:没有任何 relay execute 路径往**顶层** ledger 写。
  //      它读的那个形状是**台账行**:`breakerRow()` 之类助手返回 `res.ledger`,由 send 路径
  //      取走 push 进槽,**从不进 out**。
  //   ② `relay_spawn` render 的 `if (v.staleBinding)`:顶层 staleBinding 只由 **relay** 写,
  //      spawn 侧写的是 `staleRebind`(与 relay 那条管的是两件事)。
  // 两条都违反本文件自己的不变量"render 读的字段必须有写入者",所以删掉:删掉之后机械反查能稳定
  // 报零孤儿 —— 以后新的死渲染行会立刻显形。这里用**渲染层**把它们钉住:喂合成 payload,
  // 渲染结果不许再出现那两行。
  //
  // 同组的 38.3~38.5:relay 的 render 里原本有**两条**几乎同文的"进程内版本 ≠ 磁盘版本"
  // 告警,同一回执上会连打两行 —— 现在只留第一屏那一条,并在 `v.version` 缺失时回落到 `v.versions.loaded`。
  const home0_38 = process.env.DSH_HOME
  const home38 = path.join(TMP, 'p38-home')
  fs.mkdirSync(path.join(home38, 'dev-workflow'), { recursive: true })
  process.env.DSH_HOME = home38
  const ctx38 = mockCtx()
  apply(ctx38, {})
  const R38 = (name, payload) => ctx38._tool(name).output.render({}, payload).map((b) => b.text).join('\n')
  const has38 = (text, kw) => text.split('\n').some((l) => l.indexOf(kw) !== -1)

  const ledText38 = R38('relay', { status: 'send', ledger: { status: '🔴 熔断-超限', note: '窗口内已 9 次(上限 8)' } })
  check('38.1 死分支(一):relay 的 render 不再读顶层 `ledger` —— 那个字段没有任何 relay execute 写入者(台账行走的是 `res.ledger` → rowRef)。合成 payload 也不许再打出「台账:」那一行',
    !has38(ledText38, '台账:') && ledText38.indexOf('熔断-超限') === -1,
    ledText38.split('\n').join(' | ').slice(0, 120))

  const sbPayload38 = { status: 'stale_binding', staleBinding: { role: 'be', oldAgentId: 'agent-12345678-abcdef', owner: 'session-other', expectedScheduler: 'session-main' } }
  const spText38 = R38('relay_spawn', sbPayload38)
  const rlText38 = R38('relay', sbPayload38)
  check('38.2 死分支(二):relay_spawn 的 render 不再读顶层 `staleBinding`(spawn 侧写的是 staleRebind,且派活本身撞不上"归属失效");同一个 payload 在 **relay** 的 render 上照样打出「🔁 失效绑定:」—— 字段本身有含义,删的只是另一个工具里那条执行不到的分支',
    !has38(spText38, '绑定归属失效') && !has38(spText38, '失效绑定')
    && has38(rlText38, '🔁 失效绑定:') && rlText38.indexOf('session-other') !== -1 && rlText38.indexOf('expected') === -1,
    `spawn=${spText38.split('\n').join(' | ').slice(0, 80)} ‖ relay=${rlText38.split('\n').filter((l) => l.indexOf('失效绑定') !== -1).join(' ').slice(0, 100)}`)

  const vmText38 = R38('relay', { status: 'status', version: '1.5.2', versions: { mismatch: true, disk: '9.9.9', loaded: '1.5.2' } })
  const vmLines38 = vmText38.split('\n').filter((l) => l.indexOf('版本不一致') !== -1)
  check('38.3 同一事件只报一次:合成"进程内 ≠ 磁盘"的 payload → 「版本不一致」**恰好 1 行**,且两边版本说得清',
    vmLines38.length === 1
    && vmLines38[0].indexOf('进程内 v1.5.2') !== -1 && vmLines38[0].indexOf('磁盘 package.json v9.9.9') !== -1,
    vmLines38.join(' ‖ ') || '(一行都没有)')

  const vm2Text38 = R38('relay', { status: 'status', versions: { mismatch: true, disk: '9.9.9', loaded: '1.5.2' } })
  check('38.4 回落:payload 里没有 `version` 时,那唯一一条告警回落到 `versions.loaded` —— 不许打出「进程内 vundefined」',
    has38(vm2Text38, '进程内 v1.5.2 ≠ 磁盘 package.json v9.9.9') && vm2Text38.indexOf('vundefined') === -1,
    vm2Text38.split('\n').filter((l) => l.indexOf('版本') !== -1).join(' | ').slice(0, 120))

  const vm3Text38 = R38('relay', { status: 'status', version: '1.5.2', versions: { mismatch: false, disk: '1.5.2', loaded: '1.5.2' } })
  check('38.5 反面(锚):版本一致时一行都不许打(不许把"合并成一行"做成"永远报警")',
    vm3Text38.indexOf('版本不一致') === -1 && vm3Text38.indexOf('版本自证失效') === -1,
    vm3Text38.split('\n').join(' | ').slice(0, 100))
  process.env.DSH_HOME = home0_38
}

// ── 39. 跳过记录的"计数 / 明细"分离────────────────────
{
  // 与 selftest 32 是同一件事的两半:那里钉纯函数,这里走**真的工具 + 真的回执渲染**。
  // 夹具是 25 个各自独立的深目录,明细封顶 20 条,而真实跳过记录远不止 ——
  // 回执报"跳过 19 处"(真实 25 处)不行,更不能指着「数据面字段 scanSkipped 里有全量」这个**并不存在**的地方。
  const home0_39 = process.env.DSH_HOME
  const normal39 = [
    'openapi: 3.1.0', 'info:', '  title: p39 正常 spec', '  version: "1.0.0"',
    'paths:', '  /orders:', '    post:', '      operationId: createOrder',
    '      responses:', '        "201":', '          description: 建单成功',
  ].join('\n')
  const proj39 = path.join(TMP, 'p39cap')
  fs.mkdirSync(path.join(proj39, 'api'), { recursive: true })
  fs.writeFileSync(path.join(proj39, 'api', 'openapi.yaml'), normal39, 'utf8')
  for (let i = 1; i <= 25; i += 1) {
    const d = path.join(proj39, 'api', 'nested', 'a', `d${String(i).padStart(2, '0')}`, 'e')
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'x.yaml'), normal39, 'utf8')
  }
  const home39 = path.join(TMP, 'p39skip-home')
  fs.mkdirSync(path.join(home39, 'dev-workflow'), { recursive: true })
  process.env.DSH_HOME = home39
  const ctx39 = mockCtx()
  apply(ctx39, {})
  const text39Of = (out) => ctx39._tool('api_contract').output.render({}, out).map((b) => b.text).join('\n')

  const out39 = await run(ctx39, 'api_contract', { action: 'lint', root: proj39, paths: ['api'] })
  const text39 = text39Of(out39)
  const t39 = text39.split('\n')
  const cov39 = out39.scanCoverage || {}
  const det39 = out39.scanSkipped || []
  const raw39 = libmod.discoverApiSpecs(proj39, ['api'])

  check('39.1 数据面:计数(不封顶)与明细(封顶)分开 —— 明细 20 条、折叠后的 payload.scanSkipped 19 条(祖先那条 `api/nested/a` 被它下面的 19 棵折掉),而 coverage.skippedTotal 是真实记录数(missingDetail = 差额),`truncated` 如实为 true',
    cov39.detailCount === 20 && det39.length === 19 && cov39.skippedTotal === raw39.skippedTotal
    && cov39.truncated === true && cov39.missingDetail === cov39.skippedTotal - 20 && cov39.missingDetail > 0,
    `明细=${cov39.detailCount} entries=${det39.length} skippedTotal=${cov39.skippedTotal} missingDetail=${cov39.missingDetail}`)

  check('39.2 计数挂**两处**:`found.skippedTotal`(结构化读者)与 `found.skipped.skippedTotal`(明细数组自己)—— 后者让"只把数组传下去"的老调用方也能自动说真话(只挂一处时,那种调用数出来还是被截断的 20)',
    raw39.skipped.length === 20 && raw39.skippedTotal > 20 && raw39.skipped.skippedTotal === raw39.skippedTotal,
    `明细=${raw39.skipped.length} / found.skippedTotal=${raw39.skippedTotal} / 数组上的=${raw39.skipped.skippedTotal}`)

  check('39.3 回执里的计数带 `≥`(下界),并且**旧错数不许再出现**:总述行写「跳过 ≥19 处」、扫描行写「跳过 ≥19 处(… ,只按已留明细算)」,而「跳过 19 处」这种被截断的数与任何 `1/N` 分数都不见了',
    text39.indexOf('⚠️ 跳过 ≥19 处(19 棵未展开的子树 —— 只按**已留明细**算)') !== -1
    && text39.indexOf('扫描:已扫描 1 个候选文件 + 跳过 ≥19 处(19 棵未展开的子树,只按已留明细算)→ 契约 1 个') !== -1
    && text39.indexOf('跳过 19 处') === -1
    && text39.indexOf('只覆盖 1/') === -1
    && text39.indexOf('(33%)') === -1 && text39.indexOf('(25%)') === -1,
    t39.filter((l) => l.indexOf('跳过') !== -1 && l.indexOf('·') !== 0).join(' | ').slice(0, 180))

  check('39.4 留痕必须当场说清截断,而且**不许**再指向一个同样没有它们的地方:出现「明细已截断」与「连明细都没有」,并且**没有**那句做不到的「数据面字段 scanSkipped 里有全量」(改成"有这一批;**它不是全量**")',
    text39.indexOf('**明细已截断**') !== -1
    && text39.indexOf('本次共记下') !== -1 && text39.indexOf('留痕只保留前 20 条明细') !== -1
    && text39.indexOf('**连明细都没有**') !== -1
    && text39.indexOf('scanSkipped 里有全量') === -1
    && text39.indexOf('它不是全量') !== -1
    && text39.indexOf('      - …另有 13 个同类条目') !== -1,
    t39.filter((l) => l.indexOf('明细已截断') !== -1 || l.indexOf('它不是全量') !== -1).join(' | ').slice(0, 200))

  // 反面锚(走真工具):**源头没截断**时,每组上限的旧说辞必须原样保留 ——
  // 7 个超限文件、不传 paths(只走 "." 与 "api" 两遍 → 14 条记录 < 20 上限)。
  const proj39b = path.join(TMP, 'p39capb')
  fs.mkdirSync(path.join(proj39b, 'api'), { recursive: true })
  fs.writeFileSync(path.join(proj39b, 'api', 'openapi.yaml'), normal39, 'utf8')
  for (let i = 1; i <= 7; i += 1) fs.writeFileSync(path.join(proj39b, 'api', `cap${i}.yaml`), `# 超 512 KB ${i}\n${'x'.repeat(600 * 1024)}`, 'utf8')
  const out39b = await run(ctx39, 'api_contract', { action: 'lint', root: proj39b })
  const text39b = text39Of(out39b)
  check('39.5 反面(锚):源头未截断时照旧写「…另有 1 个同类条目(数据面字段 scanSkipped 里有全量)」,不许出现「明细已截断」(两种截断不是一回事:列全上限那条说辞在**这种**情形下是真的)',
    text39b.indexOf('…另有 1 个同类条目(数据面字段 scanSkipped 里有全量)') !== -1
    && text39b.indexOf('明细已截断') === -1
    && (out39b.scanCoverage || {}).truncated === false
    && (out39b.scanSkipped || []).length === 7,
    `entries=${(out39b.scanSkipped || []).length} truncated=${(out39b.scanCoverage || {}).truncated}`)

  const out39s = await run(ctx39, 'api_contract', { action: 'status', root: proj39 })
  const text39s = text39Of(out39s)
  // status 的 note 行一直**硬写** `covered/total` —— 同一屏的另一行(面板/上次 lint)
  // 已经按口径说话,这一行却还在给"分母里有未知数"的分数(明细截断的树上会打出
  // 「判定 pass_with_skips(覆盖 1/20)」)。它必须与面板同源。
  check('39.6 面板 /「上次 lint」/ status 的 note **三处同源**:覆盖面一律走 apiCoverageText,于是重开 status 时既写 `≥19 处未扫到`,note 行也变成「(覆盖 1 个候选,跳过 ≥19 处(明细截断))」—— 再也不许出现硬写的 `覆盖 1/20` 分数',
    text39s.indexOf('≥19 处未扫到') !== -1
    && text39s.indexOf('判定 pass_with_skips(覆盖 1 个候选,跳过 ≥19 处(明细截断))') !== -1
    && text39s.indexOf('覆盖 1/') === -1
    && text39s.indexOf('跳过 19 处') === -1
    && (out39s.apiLint && out39s.apiLint.coverage ? out39s.apiLint.coverage.truncated === true && out39s.apiLint.coverage.missingDetail === out39s.apiLint.coverage.skippedTotal - 20 : false),
    (out39s.apiLint && out39s.apiLint.coverage ? `slot=${JSON.stringify({ skippedTotal: out39s.apiLint.coverage.skippedTotal, truncated: out39s.apiLint.coverage.truncated })}` : '(slot 里没存)')
    + ' || ' + text39s.split('\n').filter((l) => l.indexOf('覆盖') !== -1 || l.indexOf('上次 lint') !== -1).join(' | ').slice(0, 240))
  process.env.DSH_HOME = home0_39
}

// ── 40. 角色联动技能随包 + 按档案角色收窄 + 与角色人设同源 ────────────────
//
// 五个角色文档的「联动技能(按需加载)」一栏点了技能名,而 DSH 的技能目录只认
// 自己注册的提供者 —— 角色在子会话里 `skill name=ponytail` 会**查无此技能**,人设那句话
// 就是一句做不到的话。这些技能文本因此整体搬进插件包。
{
  const home0_40 = process.env.DSH_HOME
  const home40 = path.join(TMP, 'p40-home')
  fs.mkdirSync(path.join(home40, 'dev-workflow'), { recursive: true })
  process.env.DSH_HOME = home40
  const proj40 = path.join(TMP, 'p40proj')
  fs.mkdirSync(path.join(proj40, 'docs', 'workflow'), { recursive: true })
  fs.writeFileSync(path.join(proj40, 'docs', 'workflow', '.active'), 'active\n', 'utf8')

  const SKILLS_DIR = fileURLToPath(new URL('./skills', import.meta.url))
  const skills40 = {
    _providers: [],
    _invalidations: 0,
    registerProvider(create) {
      const p = create({ invalidate: () => { skills40._invalidations += 1 } })
      skills40._providers.push(p)
      return () => { const i = skills40._providers.indexOf(p); if (i >= 0) skills40._providers.splice(i, 1) }
    },
  }
  const ctx40 = mockCtx({ skills: skills40 })
  apply(ctx40, {})
  const sp40 = skills40._providers[0]
  const namesOf = async (cwd) => (await sp40.list({ cwd })).candidates.map((c) => c.name)

  const listed40 = await sp40.list({ cwd: proj40 })
  const names40 = listed40.candidates.map((c) => c.name)
  const disk40 = fs.readdirSync(SKILLS_DIR)
    .filter((n) => fs.existsSync(path.join(SKILLS_DIR, n, 'SKILL.md')))
    .sort()
  // ⚠️ 本节 40.1~40.16 一律**不写死份数**(要用"候选 ↔ 磁盘"互相印证):
  // 写死 19 会把**既有 id** 判红,而规矩是"既有用例不许被改坏"。绝对数字钉在 40.18/40.19。
  check('40.1 随包技能目录与候选**一一对应**(每份 SKILL.md 都有一条候选,多一份少一份都要报)',
    names40.length > 1 && names40.length === disk40.length && names40.slice().sort().join(',') === disk40.join(','),
    `候选 ${names40.length}:${names40.join(',')} | 磁盘 ${disk40.length}`)

  const roleCands40 = listed40.candidates.filter((c) => c.name !== 'api-architect')
  check('40.2 每条角色技能候选:rank=550、带 description、resourceBase 指向**自己**的目录、locator 带名字',
    roleCands40.length === disk40.length - 1 && roleCands40.length > 0
    && roleCands40.every((c) => c.rank === 550 && c.provider === 'dev-workflow'
      && typeof c.description === 'string' && c.description.length > 8
      && c.resourceBase && c.resourceBase.kind === 'directory' && c.resourceBase.path === path.join(SKILLS_DIR, c.name)
      && c.locator && c.locator.name === c.name && c.path === path.join(SKILLS_DIR, c.name, 'SKILL.md')),
    JSON.stringify(roleCands40.slice(0, 2).map((c) => ({ n: c.name, r: c.rank, b: c.resourceBase && c.resourceBase.path }))))

  let ok40 = 0
  const bad40 = []
  for (const c of listed40.candidates) {
    const def = await sp40.get(c, { cwd: proj40 })
    const good = def && typeof def.content === 'string' && def.content.length > 200
      && def.content.indexOf(`name: ${c.name}`) === -1
      && def.path === c.path && def.name === c.name
      && def.resourceBase && def.resourceBase.path === path.join(SKILLS_DIR, c.name)
    if (good) ok40 += 1
    else bad40.push(c.name)
  }
  check('40.3 逐条 get() 都回得出正文(剥掉 frontmatter、路径与资源根都指到自己)',
    ok40 === listed40.candidates.length && ok40 > 1, `${ok40}/${listed40.candidates.length} 失败:${bad40.join(',') || '(无)'}`)

  const ghost40 = await sp40.get({ name: 'no-such-skill', locator: { kind: 'dev-workflow-skill', name: 'no-such-skill' } }, { cwd: proj40 })
  check('40.4 未知技能返回 undefined(不编造正文、不抛)', ghost40 === undefined, String(ghost40))

  // 按档案收窄:lean3 里根本没有 arch/fe 两个角色,它们的技能就不该进目录
  await run(ctx40, 'relay', { action: 'profile', root: proj40, profile: 'lean3' })
  const lean40 = await namesOf(proj40)
  check('40.5 切到 lean3(pm/be/qa)后:arch 专属技能退出目录,be/qa/pm 的仍在 —— 前端三件套**留下**(它们的归属含 qa:④ 前端验收按需挑 1-2 个,与"没有 @fe 角色"不矛盾)',
    !lean40.includes('excalidraw') && !lean40.includes('architecture-diagram')
    && lean40.includes('ponytail') && lean40.includes('systematic-debugging')
    && lean40.includes('requesting-code-review') && lean40.includes('api-docs') && lean40.includes('grill-me')
    && lean40.includes('frontend-design') && lean40.includes('api-architect'),
    lean40.join(','))
  // **收窄后的显示面**必须有断言覆盖 —— 否则它会打出
  // 「21/23 个可见(档案 lean3):pm 1 / **arch 4** / be 13 / fe 3 / qa 8」:arch 在 lean3 里根本不存在,
  // 读者却会合理地把 `arch 4` 读成"4 份 arch 技能可见"。这一条用 lean3 现算的期望值守。
  {
    const tableFor42 = Array.isArray(libmod.ROLE_SKILLS) ? libmod.ROLE_SKILLS : []
    const totalFor42 = tableFor42.length
    const leanRoles42 = ['pm', 'be', 'qa']
    const leanVisible42 = tableFor42.filter((s) => (s.roles || []).some((r) => leanRoles42.indexOf(r) !== -1)).length
    const leanShown42 = leanRoles42
      .filter((r) => tableFor42.some((s) => (s.roles || []).indexOf(r) !== -1))
      .map((r) => `${r} ${tableFor42.filter((s) => (s.roles || []).indexOf(r) !== -1).length}`)
      .join(' / ')
    const stLean42 = await run(ctx40, 'workflow_state_status', { root: proj40 })
    const line42 = String(stLean42.roleSkills)
    check('40.20 lean3 的「角色技能」行只列本档案**真有的角色**,并点名哪些角色不在档案里、有多少份没进目录;不许再出现 arch / fe 的逐角色计数',
      line42.indexOf(`随包角色技能 ${leanVisible42}/${totalFor42} 个可见(档案 lean3):${leanShown42}`) !== -1
      && line42.indexOf('未进目录') !== -1 && line42.indexOf('本档案没有') !== -1
      && line42.indexOf('arch 4') === -1 && line42.indexOf('fe 3') === -1,
      `${line42} | 期望前缀:随包角色技能 ${leanVisible42}/${totalFor42} 个可见(档案 lean3):${leanShown42}`)
  }
  await run(ctx40, 'relay', { action: 'profile', root: proj40, profile: 'review' })
  const rev40 = await namesOf(proj40)
  check('40.6 切到 review(arch/qa,只读双角色)后:be 专属技能退出,arch/qa 的仍在',
    !rev40.includes('spring-boot-crud-patterns') && !rev40.includes('test-driven-development') && !rev40.includes('spike')
    && rev40.includes('excalidraw') && rev40.includes('architecture-diagram')
    && rev40.includes('testing-strategy') && rev40.includes('requesting-code-review'),
    rev40.join(','))
  await run(ctx40, 'relay', { action: 'profile', root: proj40, profile: 'standard' })
  check('40.7 切回 standard 后全部回来(收窄是"当前档案"的函数,不是一次性开关)',
    (await namesOf(proj40)).length === disk40.length, String((await namesOf(proj40)).length))

  // 两把开关:roleSkills 只管角色技能,apiSkill 只管 api-architect
  const offServices = { _providers: [], registerProvider(create) { const p = create({ invalidate: () => {} }); offServices._providers.push(p); return () => {} } }
  const ctxOff40 = mockCtx({ skills: offServices })
  apply(ctxOff40, { roleSkills: 'off' })
  const offNames40 = (await offServices._providers[0].list({ cwd: proj40 })).candidates.map((c) => c.name)
  check('40.8 roleSkills=off 只关角色技能,api-architect 照旧在(两把开关各管一半)',
    offNames40.join(',') === 'api-architect', offNames40.join(','))

  const alwaysServices = { _providers: [], registerProvider(create) { const p = create({ invalidate: () => {} }); alwaysServices._providers.push(p); return () => {} } }
  const ctxAlways40 = mockCtx({ skills: alwaysServices })
  apply(ctxAlways40, { roleSkills: 'always' })
  const noActive40 = path.join(TMP, 'p40-noactive')
  fs.mkdirSync(noActive40, { recursive: true })
  const alwaysNames40 = (await alwaysServices._providers[0].list({ cwd: noActive40 })).candidates.map((c) => c.name)
  check('40.9 roleSkills=always 是逃生阀:未激活项目里角色技能也现身(默认 active 时它们隐身,13.2 守着)',
    alwaysNames40.length === disk40.length - 1 && alwaysNames40.length > 0, String(alwaysNames40.length))

  // 激活门翻转(未激活 → 激活)必须让目录缓存失效,否则"技能目录还是上一次那份"
  const projFlip40 = path.join(TMP, 'p40flip')
  fs.mkdirSync(projFlip40, { recursive: true })
  const beforeFlip40 = await namesOf(projFlip40)
  const invBefore40 = skills40._invalidations
  fs.mkdirSync(path.join(projFlip40, 'docs', 'workflow'), { recursive: true })
  fs.writeFileSync(path.join(projFlip40, 'docs', 'workflow', '.active'), 'active\n', 'utf8')
  const afterFlip40 = await namesOf(projFlip40)
  check('40.10 激活门翻转时主动 invalidate(候选集当场跟着翻,不用重开会话)',
    beforeFlip40.length === 0 && afterFlip40.length === disk40.length && skills40._invalidations > invBefore40,
    `${beforeFlip40.length} → ${afterFlip40.length},invalidate ${invBefore40} → ${skills40._invalidations}`)

  // 正文按 mtime 失效:改 SKILL.md 立刻生效(在临时包副本上改,随包资产一个字节不动)
  const { dir: PKG40, mod: mod40 } = await makePkgCopy('p40-pkg', { skills: true })
  const services40b = { _providers: [], registerProvider(create) { const p = create({ invalidate: () => {} }); services40b._providers.push(p); return () => {} } }
  const ctx40b = mockCtx({ skills: services40b })
  mod40.apply(ctx40b, {})
  const sp40b = services40b._providers[0]
  const probe40 = { name: 'ponytail', locator: { kind: 'dev-workflow-skill', name: 'ponytail' } }
  const first40 = await sp40b.get(probe40, { cwd: proj40 })
  const ponytailFile40 = path.join(PKG40, 'skills', 'ponytail', 'SKILL.md')
  // 没有这份文件时**干净地判红**,不许崩:跳过改写探针,让下面那条断言自己失败。
  let probe40Ran = false
  if (fs.existsSync(ponytailFile40)) {
    probe40Ran = true
    fs.appendFileSync(ponytailFile40, '\n<!-- mtime-probe-40 -->\n', 'utf8')
    const future40 = new Date(Date.now() + 3000)
    fs.utimesSync(ponytailFile40, future40, future40)
  }
  const second40 = await sp40b.get(probe40, { cwd: proj40 })
  check('40.11 技能正文按 mtime 失效:改了 SKILL.md 下一次 get 就是新正文(不用重启宿主)',
    probe40Ran && !!first40 && String(first40.content).indexOf('mtime-probe-40') === -1
    && !!second40 && String(second40.content).indexOf('mtime-probe-40') !== -1,
    probe40Ran
      ? `第一次含探针=${!!first40 && String(first40.content).indexOf('mtime-probe-40') !== -1} / 第二次含探针=${!!second40 && String(second40.content).indexOf('mtime-probe-40') !== -1}`
      : `包里没有 ponytail 这份技能(预期):${ponytailFile40}`)

  // 随包 skills/ 缺失(安装时没拷过去)时必须优雅降级,而不是整行加载失败
  const { mod: mod40c } = await makePkgCopy('p40-noskills', {})
  const services40c = { _providers: [], registerProvider(create) { const p = create({ invalidate: () => {} }); services40c._providers.push(p); return () => {} } }
  const ctx40c = mockCtx({ skills: services40c })
  mod40c.apply(ctx40c, {})
  const noSkills40 = await services40c._providers[0].list({ cwd: proj40 })
  check('40.12 随包 skills/ 缺失时不炸:候选空集 + 工具照常注册(7 个)',
    noSkills40.candidates.length === 0 && noSkills40.complete === true && ctx40c._tools.length === 7,
    `候选 ${noSkills40.candidates.length} / 工具 ${ctx40c._tools.length}`)

  // 人设与随包技能**同源**:人设点名的技能必须真的在包里(否则等于让角色去够一个够不着的东西)
  const table40 = buildProfileTable(null, null)
  const personaOf40 = (r) => String(table40.standard.roles.filter((x) => x.id === r)[0].persona)
  const linkLines40 = ['pm', 'arch', 'be', 'fe', 'qa'].map(personaOf40).join('\n').split('\n').filter((l) => l.indexOf('联动技能') !== -1)
  const mentioned40 = new Set()
  for (const l of linkLines40) {
    for (const m of l.matchAll(/`([^`]+)`/g)) {
      const t = String(m[1]).replace(/^skill name=/, '').trim()
      if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t)) mentioned40.add(t)
    }
  }
  const diskSet40 = new Set(disk40)
  const missing40 = [...mentioned40].filter((n) => !diskSet40.has(n))
  check('40.13 五个角色的人设都写明了「联动技能(按需加载)」一行',
    linkLines40.length === 5, String(linkLines40.length))
  check('40.14 人设点名的技能**一份不少**地随包(点名了却没随包 = 一句做不到的话)',
    mentioned40.size >= 15 && missing40.length === 0,
    `点名 ${mentioned40.size} 个:${[...mentioned40].join(',')} | 缺:${missing40.join(',') || '(无)'}`)

  // 状态面:状态工具与 relay status 都要报得出来(不然"人设说了、目录里没有"只能靠猜)
  // 期望值由**表**现算(不写死数字),份数变化时不用改断言。
  const roleTable40 = Array.isArray(libmod.ROLE_SKILLS) ? libmod.ROLE_SKILLS : []
  const total40 = roleTable40.length
  const beCount40 = roleTable40.filter((s) => (s.roles || []).indexOf('be') !== -1).length
  const qaCount40 = roleTable40.filter((s) => (s.roles || []).indexOf('qa') !== -1).length
  const st40 = await run(ctx40, 'workflow_state_status', { root: proj40 })
  check('40.15 workflow_state_status 报角色技能现状(可见数 + 逐角色分布,与表同源)',
    String(st40.roleSkills).indexOf(`随包角色技能 ${total40}/${total40} 个可见`) !== -1
    && String(st40.roleSkills).indexOf(`be ${beCount40}`) !== -1 && String(st40.roleSkills).indexOf(`qa ${qaCount40}`) !== -1,
    `${String(st40.roleSkills)} | 表 ${total40} 份(be ${beCount40} / qa ${qaCount40})`)
  const relaySt40 = await run(ctx40, 'relay', { action: 'status', root: proj40 })
  const text40 = ctx40._tool('relay').output.render({}, relaySt40).map((b) => b.text).join('\n')
  check('40.16 relay status 渲染出「角色技能」一行',
    !!relaySt40.roleSkillsView && text40.indexOf(`角色技能:随包角色技能 ${total40}/${total40} 个可见`) !== -1,
    text40.split('\n').filter((l) => l.indexOf('角色技能') !== -1).join(' | '))

  // 版本口径:随包 SKILL.md 的 version 全部与插件版本对齐
  const vers40 = disk40.map((n) => String(libmod.parseSkillFrontmatter(fs.readFileSync(path.join(SKILLS_DIR, n, 'SKILL.md'), 'utf8')).attrs.version || ''))
  check('40.17 随包 SKILL.md 的 frontmatter version 全部 == 插件版本(部署后一眼能看出这份技能是哪一版带来的)',
    vers40.length > 0 && vers40.every((v) => v === VERSION), `版本集合:${[...new Set(vers40)].join(',')} 插件:${VERSION}`)

  /**
   * ── Python/Django 五件套 ──────────────────────────────────────────────
   * 上面 40.1~40.17 一律**不写死份数**(以免挂新 id);绝对数字钉在这里。
   */
  const new5_40 = ['django-patterns', 'django-security', 'django-tdd', 'python-project-structure', 'python-error-handling']
  check('40.18 standard 档案下 24 份候选(23 份角色技能 + api-architect),磁盘同样 24 份',
    names40.length === 24 && disk40.length === 24 && names40.indexOf('api-architect') !== -1,
    `候选 ${names40.length} / 磁盘 ${disk40.length}`)
  check('40.19 Python/Django 五件套在候选里,且只在 be 系(不是 qa/fe 的)—— 逐条 get 也回得出正文',
    new5_40.every((n) => names40.indexOf(n) !== -1)
    && (await Promise.all(new5_40.map((n) => sp40.get({ name: n, locator: { kind: 'dev-workflow-skill', name: n } }, { cwd: proj40 }))))
      .every((d) => !!d && typeof d.content === 'string' && d.content.length > 500),
    new5_40.map((n) => `${n}:${names40.indexOf(n) === -1 ? '缺' : '在'}`).join(' '))

  process.env.DSH_HOME = home0_40
}

// ── 41. 技能可见性**一套口径** ────────────────────────────────────────────
//
// 提供者按 `skillRootForCwd(cwd)` 给候选,而状态面按
// 「传入 root 是否活跃」判可见、并按**传入 root 的档案**数份数;两条链在"cwd 不是任何活跃项目根、
// 但它恰好是某个活跃项目角色子会话的 cwd"时分叉。三副面孔:
//   ① 未激活的 root 报「激活:none(未激活)」与「23/23 个可见(档案 standard)」**并列**,
//      而同一 cwd 的真实目录其实按反查到的项目(lean3)收窄;
//   ② 角色子会话被停掉后提供者已返回空集(`ponytail`/`testing-strategy` 双双 unknown),
//      回执照旧报「12/23 个可见(档案 review)」;
//   ③ 派回一个角色子会话,同一个名字**立刻**可用。
// 本节:① 主判据是"**状态行报的份数 == 提供者给的候选数**"(两套判据合一);② 三档情形各一条;
// ③ 反面守卫 —— 活跃项目自己那一行不许被改样。
{
  const home0_41 = process.env.DSH_HOME
  const owner41 = path.join(TMP, 'p41-owner')   // 活跃项目,档案 lean3(pm/be/qa)
  fs.mkdirSync(path.join(owner41, 'docs', 'workflow'), { recursive: true })
  fs.writeFileSync(path.join(owner41, 'docs', 'workflow', '.active'), 'active\n', 'utf8')
  const cwd41 = path.join(TMP, 'p41-cwd')       // **未激活**:只当"调度者 cwd"
  fs.mkdirSync(cwd41, { recursive: true })
  const lone41 = path.join(TMP, 'p41-lone')     // 未激活、且没有任何可查到的角色子会话
  fs.mkdirSync(lone41, { recursive: true })

  // 角色子会话的 cwd == cwd41(现实里角色子会话继承调度者 cwd —— 反查就是为它加的)
  live['a41-be'] = { id: 'a41-be', session: { header: { cwd: cwd41, parentSession: 'session-main' } } }

  const home41 = path.join(TMP, 'p41-home')
  fs.mkdirSync(path.join(home41, 'dev-workflow'), { recursive: true })
  fs.writeFileSync(path.join(home41, 'dev-workflow', 'state.json'), JSON.stringify({
    version: 1, boot: '', updatedAt: '', activeProfiles: { [owner41]: 'lean3' }, activeProjects: {}, dedupe: {}, lifetime: {},
    projects: {
      [`lean3@${owner41}`]: { root: owner41, profile: 'lean3', ledger: [], relayTs: {}, roleAgents: { be: 'a41-be' } },
    },
  }), 'utf8')
  process.env.DSH_HOME = home41

  const skills41 = { _providers: [], registerProvider(create) { const p = create({ invalidate: () => {} }); skills41._providers.push(p); return () => {} } }
  const ctx41 = mockCtx({ skills: skills41 })
  apply(ctx41, {})
  const sp41 = skills41._providers[0]

  const table41 = Array.isArray(libmod.ROLE_SKILLS) ? libmod.ROLE_SKILLS : []
  const leanRoles41 = ['pm', 'be', 'qa']
  const leanVisible41 = table41.filter((s) => (s.roles || []).some((r) => leanRoles41.indexOf(r) !== -1)).length
  const cands41 = (await sp41.list({ cwd: cwd41 })).candidates.map((c) => c.name)
  const roleCands41 = cands41.filter((n) => n !== 'api-architect')

  // ① 未激活的 root,但此 cwd 上有活跃项目的角色子会话 → 报"可见"时**必须写明来路**,
  //    且份数按**反查到的那个项目**的档案算(与提供者同源)。
  //    注:workflow_state_status 在"未激活"分支本来就不渲染这两行(设计如此),所以这一档看 relay 面。
  const relaySt41 = await run(ctx41, 'relay', { action: 'status', root: cwd41 })
  const line41 = String(relaySt41.roleSkillsView)
  check('41.1 未激活的 root 上「角色技能」行的**份数按反查到的项目档案**算(lean3),并写明来路(本 root 未激活 + 与哪个项目的角色子会话同址)—— 不许出现"未激活却说 N/N 个可见"',
    line41.indexOf(`随包角色技能 ${leanVisible41}/${table41.length} 个可见(档案 lean3`) !== -1
    && line41.indexOf('本 root 未激活') !== -1
    && line41.indexOf(`与活跃项目 ${path.basename(owner41)} 的角色子会话同址`) !== -1,
    `${line41} | 期望份数 ${leanVisible41}/${table41.length}(档案 lean3…)`)

  // ①' 最强的一条:状态行报的份数 == 提供者给出的候选数(正面判据 —— 两套判据合一)
  check('41.2 状态行报的"可见份数"与提供者给的候选**逐条对齐**(同一条链,这是正面判据)',
    roleCands41.length === leanVisible41
    && line41.indexOf(`随包角色技能 ${roleCands41.length}/${table41.length} 个可见`) !== -1
    && cands41.indexOf('api-architect') !== -1,
    `提供者 ${roleCands41.length} 份(api-architect 在:${cands41.indexOf('api-architect') !== -1}) | ${line41}`)

  // ①'' 显示面(relay 的 render)也要带上来路:收窄后的显示面必须有断言覆盖
  const text41 = ctx41._tool('relay').output.render({}, relaySt41).map((b) => b.text).join('\n')
  check('41.3 relay 的**显示面**逐字带上来路(渲染行与字段同源,不各说各的)',
    text41.indexOf(`角色技能:${line41}`) !== -1,
    text41.split('\n').filter((l) => l.indexOf('角色技能') !== -1).join(' | '))

  // ② 未激活的 root + 没有可查到的角色子会话 → 如实报"隐藏"(不许报 N/N 个可见)
  const relaySt41b = await run(ctx41, 'relay', { action: 'status', root: lone41 })
  const line41b = String(relaySt41b.roleSkillsView)
  const cands41b = (await sp41.list({ cwd: lone41 })).candidates.map((c) => c.name)
  check('41.4 未激活 root 上**没有**可查到的角色子会话时,状态行如实报「隐藏(本 root 未激活…)」,且与提供者的空集一致',
    line41b.indexOf('隐藏(本 root 未激活') !== -1 && line41b.indexOf('个可见') === -1
    && cands41b.length === 0,
    `${line41b} | 提供者候选 ${cands41b.length}`)

  // ③ 反面守卫:活跃项目自己那一行**不许被改样**(身份是本项目,不带来路子句)
  const st41c = await run(ctx41, 'workflow_state_status', { root: owner41 })
  const line41c = String(st41c.roleSkills)
  check('41.5 活跃项目自己的那一行保持原样(档案直给,不带来路子句)',
    line41c.indexOf(`随包角色技能 ${leanVisible41}/${table41.length} 个可见(档案 lean3):`) !== -1
    && line41c.indexOf('本 root 未激活') === -1,
    line41c)

  delete live['a41-be']
  process.env.DSH_HOME = home0_41
}

// ── 42. 预设驱动自动激活(dev-workflow 预设)────────────────────────────
//
// 需求原话:「在 dev-workflow 预设下自动激活插件,其余预设下激活方式不变」。
//
// 落法:命中清单的会话把它的 cwd 记成一笔 `remembered`(与 kickoff 首用同一个档),
// **不改 gateDecision**。所以这一节要同时钉住两件相反的事 —— 这也是它比一般小节长的原因:
//   · 命中的预设 → 真的自动激活(两条入口各一条断言,它们是两条独立的代码路径);
//   · 不命中 / 显式关 / 配置关 / 已用别的来源激活 → **一点都不许变**(四条反面守卫)。
// 反面守卫不是凑数:第 2 条需求的后半句就是"其余预设下激活方式不变",它必须被机械咬住 ——
// 否则"改了激活方式"这件事在离线套件里只表现为"新功能可用",看不出副作用。
{
  const home0_42 = process.env.DSH_HOME
  const wfRoot = path.join(TMP, 'p42-wf')       // 命中预设;未激活(无 .active、无状态文档)
  const bornRoot = path.join(TMP, 'p42-born')   // 命中预设;只走 agent/created 那条入口
  const stdRoot = path.join(TMP, 'p42-std')     // **对照组**:同一套装置,预设是 standard
  const offRoot = path.join(TMP, 'p42-off')     // 显式 .active=off
  const fileRoot = path.join(TMP, 'p42-file')   // 已有 .active=active(不该被抢功)
  const cfgRoot = path.join(TMP, 'p42-cfg')     // 配置里把自动激活关掉
  for (const d of [wfRoot, bornRoot, stdRoot, offRoot, fileRoot, cfgRoot]) {
    fs.mkdirSync(path.join(d, 'docs', 'workflow'), { recursive: true })
  }
  fs.writeFileSync(path.join(offRoot, 'docs', 'workflow', '.active'), 'off\n', 'utf8')
  fs.writeFileSync(path.join(fileRoot, 'docs', 'workflow', '.active'), 'active\n', 'utf8')

  const freshState42 = JSON.stringify({
    version: 1, boot: '', updatedAt: '', activeProfiles: {}, activeProjects: {}, dedupe: {}, lifetime: {}, projects: {},
  })
  const home42 = path.join(TMP, 'p42-home')
  fs.mkdirSync(path.join(home42, 'dev-workflow'), { recursive: true })
  fs.writeFileSync(path.join(home42, 'dev-workflow', 'state.json'), freshState42, 'utf8')
  process.env.DSH_HOME = home42

  const ctx42 = mockCtx()
  apply(ctx42, {})

  const wfAgent = (id, cwd) => ({ id, session: { header: { cwd, agentPreset: 'dev-workflow' } } })
  const stdAgent = (id, cwd) => ({ id, session: { header: { cwd, agentPreset: 'standard' } } })
  /** 派发一次事件(mock 把 ctx.on 的监听器收在 _handlers;tools/execute 的签名是 (exec, next))。 */
  const fire42 = async (name, payload) => {
    for (const fn of (ctx42._handlers[name] || [])) await fn(payload, async () => 'next')
  }
  const state42 = () => JSON.parse(fs.readFileSync(path.join(home42, 'dev-workflow', 'state.json'), 'utf8'))

  // ① 兜底入口:一次工具派发
  const aWf = wfAgent('a42-wf', wfRoot)
  await fire42('tools/execute', { agent: aWf, name: 'probe' })
  const st42a = await runAs(ctx42, aWf, 'workflow_state_status', { root: wfRoot })
  check('42.1 dev-workflow 预设的会话经 `tools/execute` 兜底入口把当前项目记成已开工 —— 未激活的目录在一次工具派发后即报 active,且激活来源如实写作「预设 dev-workflow(自动激活)」',
    st42a.status === 'active' && String(st42a.gateSource).indexOf('预设 dev-workflow(自动激活)') !== -1,
    `status=${st42a.status} gateSource=${st42a.gateSource}`)

  // ② 主入口:agent/created(会话一发布就判定,这时还没有任何工具调用)
  const aBorn = wfAgent('a42-born', bornRoot)
  await fire42('agent/created', { agent: aBorn })
  const st42b = await runAs(ctx42, aBorn, 'workflow_state_status', { root: bornRoot })
  check('42.2 主入口 `agent/created` 同样生效,且**不需要任何工具调用** —— 会话一发布就把 cwd 记成已开工("连第一份技能目录都是对的"就靠它)',
    st42b.status === 'active' && String(st42b.gateSource).indexOf('预设 dev-workflow(自动激活)') !== -1,
    `status=${st42b.status} gateSource=${st42b.gateSource}`)

  // ③ 反面守卫一:不命中的预设 —— 两条入口都派发,依然不激活
  const aStd = stdAgent('a42-std', stdRoot)
  await fire42('tools/execute', { agent: aStd, name: 'probe' })
  await fire42('agent/created', { agent: aStd })
  const st42c = await runAs(ctx42, aStd, 'workflow_state_status', { root: stdRoot })
  check('42.3 【其余预设不变】standard 预设的会话两条入口都派发也不激活(gate 仍是 none)—— 且回执把"本会话在哪个预设"直接说出来,不让用户对着"未激活"自己猜',
    st42c.status === 'inactive' && st42c.gate === 'none'
    && String(st42c.note).indexOf('standard') !== -1
    && String(st42c.note).indexOf('dev-workflow') !== -1,
    `status=${st42c.status} gate=${st42c.gate} | note 尾=${String(st42c.note).slice(-110)}`)

  // ④ 反面守卫二:显式 `.active` 写 off —— 用户必须保留关掉它的手段
  const aOff = wfAgent('a42-off', offRoot)
  await fire42('tools/execute', { agent: aOff, name: 'probe' })
  await fire42('agent/created', { agent: aOff })
  const st42d = await runAs(ctx42, aOff, 'workflow_state_status', { root: offRoot })
  check('42.4 【显式关闭仍然赢】`.active` 写 off 的目录即便预设命中也不激活(gate=off)—— 自动激活不是"用户关不掉的东西"',
    st42d.status === 'inactive' && st42d.gate === 'off',
    `status=${st42d.status} gate=${st42d.gate}`)

  // ⑤ 反面守卫三:已经用别的来源激活的项目 —— 不许被"抢功"写进插件记忆
  const aFile = wfAgent('a42-file', fileRoot)
  await fire42('tools/execute', { agent: aFile, name: 'probe' })
  const st42e = await runAs(ctx42, aFile, 'workflow_state_status', { root: fileRoot })
  const mem42 = state42().activeProjects || {}
  check('42.5 【不抢功】靠 `.active` 文件激活的项目仍记作"文件"来源,且没有被写进插件记忆 —— 否则排障时分不清这个项目当初是谁开的',
    st42e.status === 'active' && String(st42e.gateSource).indexOf('文件') !== -1
    && mem42[fileRoot] === undefined,
    `gateSource=${st42e.gateSource} | 记忆里有它:${mem42[fileRoot] !== undefined}`)

  // ⑥ 反面守卫四:配置里关掉 —— 行为应完整退回原口径(这是回滚开关)
  const home42b = path.join(TMP, 'p42-home-b')
  fs.mkdirSync(path.join(home42b, 'dev-workflow'), { recursive: true })
  fs.writeFileSync(path.join(home42b, 'dev-workflow', 'state.json'), freshState42, 'utf8')
  process.env.DSH_HOME = home42b
  const ctx42b = mockCtx()
  apply(ctx42b, { autoActivatePresets: false })
  const aCfg = wfAgent('a42-cfg', cfgRoot)
  for (const fn of (ctx42b._handlers['tools/execute'] || [])) await fn({ agent: aCfg, name: 'probe' }, async () => 'next')
  for (const fn of (ctx42b._handlers['agent/created'] || [])) await fn({ agent: aCfg }, async () => 'next')
  const st42f = await runAs(ctx42b, aCfg, 'workflow_state_status', { root: cfgRoot })
  check('42.6 `autoActivatePresets: false` 把这条路径完整关掉(两条入口都派发也不激活)—— 关掉之后不再有任何预设驱动的激活',
    st42f.status === 'inactive' && st42f.gate === 'none',
    `status=${st42f.status} gate=${st42f.gate}`)
  process.env.DSH_HOME = home42

  // ⑦ 每个 agent 只判一次:会话内 `deactivate` 之后不许被顶回去
  await runAs(ctx42, aWf, 'relay', { action: 'deactivate', root: wfRoot })
  await fire42('tools/execute', { agent: aWf, name: 'probe' })
  const st42g = await runAs(ctx42, aWf, 'workflow_state_status', { root: wfRoot })
  check('42.7 同一个会话内 `relay action=deactivate` 之后不会被自动激活顶回去(每个 agent 只判一次)—— 守的是"进入预设时激活一次",不是"持续强制激活"',
    st42g.status === 'inactive' && st42g.gate === 'none',
    `status=${st42g.status} gate=${st42g.gate}`)

  // ⑧ 部署期自证:ready 行必须带 autoActivate(deploy.ps1 读这一行)
  const ready42 = ctx42._logs.filter((l) => l.indexOf('[dev-workflow] v') !== -1 && l.indexOf('ready') !== -1).join('\n')
  check('42.8 ready 行带 `autoActivate=<清单>` —— 这是"这一版到底带不带自动激活"在部署期的唯一自证(没有它,部署脚本只能比对版本号)',
    ready42.indexOf('autoActivate=dev-workflow') !== -1,
    ready42 || '(没抓到 ready 行)')

  process.env.DSH_HOME = home0_42
}

/**
 * 预设时序装置。
 *
 * 为什么值得抽:这一族判据测的不是"某个字段的值",而是**时序** ——
 * "会话建立那一刻的 header/投影"与"之后才提交的预设"是两个不同的时刻。装置要能:
 *   ① 建会话 —— header 与投影**分开**给,且**投影可变**(用来复刻"建立之后才提交预设");
 *   ② 按名字派事件(四条入口的投递面);
 *   ③ 拿工具回执(workflow_state_status / relay);
 *   ④ 读日志与插件私有状态(state.json)。
 * `projections: false` 用来造"老宿主没有 sessionProjections"那一档。
 *
 * ⚠️ 顺序不能变:device 造 home → 写空 state.json → 设 DSH_HOME
 * → mockCtx → apply —— 插件在 apply 期就把 DSH_HOME 读进去了。
 */
function presetDevice(tag, opts) {
  const o = opts || {}
  const home0 = process.env.DSH_HOME
  const fresh = JSON.stringify({
    version: 1, boot: '', updatedAt: '', activeProfiles: {}, activeProjects: {}, dedupe: {}, lifetime: {}, projects: {},
  })
  const home = path.join(TMP, `${tag}-home`)
  fs.mkdirSync(path.join(home, 'dev-workflow'), { recursive: true })
  fs.writeFileSync(path.join(home, 'dev-workflow', 'state.json'), fresh, 'utf8')
  process.env.DSH_HOME = home

  // 投影 mock:`stateOf(session, 'agentPreset')` —— 与真宿主 `ctx.sessionProjections` 的读数面同形。
  const proj = new Map()
  const sessions = {}
  const extra = {
    agents: {
      get: (id) => {
        const s = sessions[String(id)]
        if (s) return { id: String(id), session: s }
        return live[String(id)]
      },
      list: () => Object.values(sessions).map((s) => ({ id: s.id, session: s })),
      currentInitiator: () => parentAgent,
    },
  }
  if (o.projections !== false) {
    extra.sessionProjections = { stateOf: (session, key) => (key === 'agentPreset' ? proj.get(session) : undefined) }
  }
  const ctx = mockCtx(extra)
  apply(ctx, o.config || {})
  return {
    ctx, proj, sessions, home, home0,
    /** 一个干净项目目录(带 docs/workflow,但没有 .active)。 */
    project: (name) => {
      const d = path.join(TMP, `${tag}-${name}`)
      fs.mkdirSync(path.join(d, 'docs', 'workflow'), { recursive: true })
      return d
    },
    /** 建会话:header 与投影**分开**给 —— 真宿主的 header 是创建时的化石,投影才是运行时的。 */
    session: (id, root, headerPreset, projPreset) => {
      const s = { id, header: { cwd: root, agentPreset: headerPreset } }
      sessions[id] = s
      proj.set(s, projPreset)
      return { id, session: s }
    },
    /** "之后提交了另一个预设"这一刻(真宿主里是一条 `agent-preset/selected` 会话事件)。 */
    setPreset: (id, preset) => { proj.set(sessions[id], preset) },
    /** 派发一次事件(mock 把 ctx.on 的监听器收在 _handlers)。 */
    fire: async (name, ...args) => {
      for (const fn of (ctx._handlers[name] || [])) await fn(...args, async () => 'next')
    },
    status: (agent, root) => runAs(ctx, agent, 'workflow_state_status', { root }),
    relay: (agent, args) => runAs(ctx, agent, 'relay', args),
    logs: () => ctx._logs.join('\n'),
    stateText: () => fs.readFileSync(path.join(home, 'dev-workflow', 'state.json'), 'utf8'),
    restore: () => { process.env.DSH_HOME = home0 },
  }
}

// ── 43. 预设判定改走 **Session 投影** ─────────────────────────────────────
//
// DSH 的 Web 入口建会话时**先按默认预设落 header**,随后才把用户选的预设作为
// `agent-preset/selected` 事件追加进会话日志 —— header 从此不再变。只读 header 的话,
// 自动激活在真宿主上一次都不会触发,而且失败是静默的:"不命中也要记"那条优化会把 `cordis`
// 这个**错误答案**缓存成"这个 agent 判过了",兜底入口再也补不上。
//
// 口径照抄 DSH 自己:`@deepseek-ai/dsh-agent-presets` 的 session.js 写着
// "Reconstruction reads the `agentPreset` Session projection, **never the header**"。
// 这一节因此要同时钉住五件事:
//   ① 投影有值 → 以投影为准(header 说什么都不算,正反两面各一条);
//   ② 提交发生在会话建立**之后**时,兜底入口要能重判(缓存键必须带上预设);
//   ③ 事件入口(两条投递形状:`session/event` 与 `agent-preset/selected`)在**零工具调用**下生效;
//   ④ 投影不可用 → 落回 header(老宿主/离线复跑行为不变);
//   ⑤ 两条反面守卫(不命中的预设 / 显式 `.active` 写 off)一条都不许松。
{
  const d43 = presetDevice('p43')
  const mk43 = (name) => d43.project(name)
  const wfRoot43 = mk43('a')       // ① 预设提交在会话建立之后 → 兜底入口补判
  const evRoot43 = mk43('b')       // ② `session/event` 事件入口
  const ev2Root43 = mk43('c')      // ③ `agent-preset/selected` 事件入口(另一条形状)
  const stdRoot43 = mk43('d')      // ④ 反面守卫:投影说 standard
  const hdrRoot43 = mk43('e')      // ⑤ 投影不可用 → 落回 header
  const offRoot43 = mk43('off')    // ⑥ 反面守卫:显式 off 仍然赢
  const okRoot43 = mk43('ok')      // ⑥ 的对照组:同一条事件路径在干净目录上真的激活
  fs.writeFileSync(path.join(offRoot43, 'docs', 'workflow', '.active'), 'off\n', 'utf8')

  const proj43 = d43.proj
  const sessions43 = d43.sessions
  const agent43 = d43.session
  const ctx43 = d43.ctx
  const fire43 = d43.fire
  const st43 = d43.status

  // ① 建立时 header 与投影都是默认预设(真宿主序列的离线复刻),之后投影才被提交
  const aWf43 = agent43('a43-a', wfRoot43, 'cordis', 'cordis')
  await fire43('agent/created', { agent: aWf43 })
  const st43a0 = await st43(aWf43, wfRoot43)
  check('43.1 会话建立那一刻 header 与投影都还是默认预设(`cordis`)→ 不激活 —— 自动激活只认清单里的预设,不认"像预设的东西"',
    st43a0.status === 'inactive' && st43a0.gate === 'none',
    `status=${st43a0.status} gate=${st43a0.gate}`)

  proj43.set(sessions43['a43-a'], 'dev-workflow')   // 模拟 seq=4 那条 `agent-preset/selected`
  await fire43('tools/execute', { agent: aWf43, name: 'probe' })
  const st43a = await st43(aWf43, wfRoot43)
  check('43.1b 预设提交发生在会话建立**之后**时,兜底入口必须按**投影**重判并激活(读 header 得 `cordis`,还会把它缓存成"这个 agent 判过了")',
    st43a.status === 'active' && String(st43a.gateSource).indexOf('预设 dev-workflow(自动激活)') !== -1,
    `status=${st43a.status} gateSource=${st43a.gateSource}`)

  // ② 事件入口之一:`session/event`(真宿主里预设提交就是一条会话事件)—— 零工具调用
  const aEv = agent43('a43-b', evRoot43, 'cordis', 'cordis')
  await fire43('session/event', sessions43['a43-b'], { type: 'agent-preset/selected', data: { agentPreset: 'dev-workflow' } })
  const st43b = await st43(aEv, evRoot43)
  check('43.2 `session/event` 事件入口在**零工具调用**下就把项目记成已开工 —— "连第一份技能目录都是对的"靠的就是它(会话建立 → 预设提交 → 第一次模型请求,中间没有任何工具调用)',
    st43b.status === 'active' && String(st43b.gateSource).indexOf('预设 dev-workflow(自动激活)') !== -1,
    `status=${st43b.status} gateSource=${st43b.gateSource}`)

  const log43 = ctx43._logs.join('\n')
  check('43.2b 自动激活在宿主日志里留痕,且**写明是哪条入口**中的(`session/event` / `agent-preset/selected` / `tools/execute` / `agent/created`)—— 要同时看"记没记"与"哪条路记的"',
    log43.indexOf(`预设自动激活:dev-workflow 预设的会话在 ${evRoot43} 开工(session/event)`) !== -1,
    log43.split('\n').filter((l) => l.indexOf('预设自动激活') !== -1).join(' | ') || '(日志里一条都没有)')

  // ③ 事件入口之二:`agent-preset/selected(sessionId, agentPreset)` —— 服务 re-emit 的那条形状。
  //    这条**只带会话 id**(不带活 Session),所以预设值必须取自事件载荷:提交点之后的投影读数
  //    在监听器顺序上不保证已经落地,靠读数会漏。
  const aEv2 = agent43('a43-c', ev2Root43, 'cordis', 'cordis')
  await fire43('agent-preset/selected', 'a43-c', 'dev-workflow')
  const st43c = await st43(aEv2, ev2Root43)
  check('43.3 `agent-preset/selected(sessionId, preset)` 这条形状也收(值取自事件载荷,不赌投影读数已经落地)—— 两条投递形状都试,是因为哪条到得了插件只有真宿主能回答',
    st43c.status === 'active' && String(st43c.gateSource).indexOf('预设 dev-workflow(自动激活)') !== -1,
    `status=${st43c.status} gateSource=${st43c.gateSource}`)

  // ④ 反面守卫:投影才是权威 —— 创建时 header 写 dev-workflow、运行时被换成 standard 的会话不许激活
  const aStd43 = agent43('a43-d', stdRoot43, 'dev-workflow', 'standard')
  await fire43('agent/created', { agent: aStd43 })
  await fire43('tools/execute', { agent: aStd43, name: 'probe' })
  await fire43('session/event', sessions43['a43-d'], { type: 'agent-preset/selected', data: { agentPreset: 'standard' } })
  const st43d = await st43(aStd43, stdRoot43)
  check('43.4 【以投影为准】创建时 header 写 `dev-workflow`、运行时被换成 `standard` 的会话**不许**激活 —— header 是创建时的化石,DSH 自己的重建口径就是"读投影、绝不读 header"(session.js 原文)',
    st43d.status === 'inactive' && st43d.gate === 'none',
    `status=${st43d.status} gate=${st43d.gate}`)

  // ⑤ 投影不可用 → 落回 header(老宿主 / 离线复跑):行为一字不变
  const d43b = presetDevice('p43b', { projections: false })   // 这一档**不挂** sessionProjections
  const aHdr43 = d43b.session('a43-e', hdrRoot43, 'dev-workflow', undefined)
  await d43b.fire('tools/execute', { agent: aHdr43, name: 'probe' })
  const st43e = await d43b.status(aHdr43, hdrRoot43)
  check('43.5 宿主没组合 `sessionProjections`(老宿主 / 离线复跑)时落回 header —— 不许把已经能用的那条路弄丢',
    st43e.status === 'active' && String(st43e.gateSource).indexOf('预设 dev-workflow(自动激活)') !== -1,
    `status=${st43e.status} gateSource=${st43e.gateSource}`)
  d43b.restore()

  // ⑥ 反面守卫:显式 off 仍然赢 + 对照组(必须两条同时成立,否则"off 赢"可能只是"检测压根没跑"的空过)
  const aOff43 = agent43('a43-off', offRoot43, 'cordis', 'cordis')
  await fire43('session/event', sessions43['a43-off'], { type: 'agent-preset/selected', data: { agentPreset: 'dev-workflow' } })
  const st43f = await st43(aOff43, offRoot43)
  const aOk43 = agent43('a43-ok', okRoot43, 'cordis', 'cordis')
  await fire43('session/event', sessions43['a43-ok'], { type: 'agent-preset/selected', data: { agentPreset: 'dev-workflow' } })
  const st43g = await st43(aOk43, okRoot43)
  check('43.6 【显式关闭仍然赢】同一条事件入口下,`.active` 写 off 的目录 gate=off,而干净目录的同类会话照样激活 —— 两条同时成立才算数',
    st43f.status === 'inactive' && st43f.gate === 'off'
    && st43g.status === 'active' && String(st43g.gateSource).indexOf('预设 dev-workflow(自动激活)') !== -1,
    `off 侧 status=${st43f.status} gate=${st43f.gate} | 对照侧 status=${st43g.status} gateSource=${st43g.gateSource}`)

  // ⑦ `deactivate` 之后不被顶回去:同一个 agent + 同一个预设只判一次(守"进入预设时激活一次",不是持续强制)
  await runAs(ctx43, aWf43, 'relay', { action: 'deactivate', root: wfRoot43 })
  await fire43('tools/execute', { agent: aWf43, name: 'probe' })
  const st43h = await st43(aWf43, wfRoot43)
  check('43.7 不许把"进入预设时激活一次"变成"持续强制激活" —— 同一会话里 `relay action=deactivate` 之后,同一个 agent、同一个预设不再重判',
    st43h.status === 'inactive' && st43h.gate === 'none',
    `status=${st43h.status} gate=${st43h.gate}`)

  d43.restore()
}

// ── 44. 预设自动激活的**可观测面**(门已被别的来源定下时不许一声不响)─────
//
// 新建会话提交 dev-workflow 预设时,若工作区还留着 `.active`(门=file),判定会在
// `gateStateOf(root) !== 'none'` 那一步**如实短路**,而那一行在**打日志之前**。
// 短路是对的(**不抢功**),**沉默不对**:观测者只能先怀疑"事件送不到"。
//
// 这一节钉四件事(时序装置与 43 共用 `presetDevice` —— 同一族判据,同一套 mock):
//   ① 四条入口各自"到达"过几次、判定落在哪个结局 —— 日志与计数两条路都要留痕;
//   ② 门已定(remembered / file / off 三档)时:留痕 + **不抢功**(记忆一字不改、门源不变);
//   ③ 不命中清单:留痕 + 计数 + 判定发生在**取根之前**(结构上不可能记下任何目录),
//      并保留"同一个 agent × 同一个预设不再重判"的语义;
//   ④ 状态面(`workflow_state_status` / `relay action=status`)渲染同一行,而且它是**进程内**的。
{
  const d44 = presetDevice('p44')
  const rNot = d44.project('not')     // ① 不命中清单
  const rAct = d44.project('act')     // ② 干净目录:事件入口激活
  const rFile = d44.project('file')   // ④ `.active` 文件档
  const rOff = d44.project('off')     // ④ `.active` 写 off(用户显式关闭)
  const rTool = d44.project('tool')   // ⑤ tools/execute 兜底入口
  const rLate = d44.project('late')   // ⑦ 根后到
  fs.writeFileSync(path.join(rFile, 'docs', 'workflow', '.active'), 'active\n', 'utf8')
  fs.writeFileSync(path.join(rOff, 'docs', 'workflow', '.active'), 'off\n', 'utf8')

  const ev44 = (id, preset) => d44.fire('session/event', d44.sessions[id], { type: 'agent-preset/selected', data: { agentPreset: preset } })
  const mem44 = () => JSON.parse(d44.stateText()).activeProjects
  /**
   * ⚠️ 取 `presetAuto` 必须**防御性**:没有这个字段时若直接读
   * `out.presetAuto.reached['tools/execute']`,就是 **TypeError 崩掉整套件** ——
   * 测试要的是"**一条干净的失败断言**",不是"崩"(见 selftest 头部那条规矩)。
   */
  const EMPTY_PA44 = { reached: {}, judged: 0, judgedVia: {}, activated: 0, activatedVia: {}, gateOpen: 0, notInList: 0, noRoot: 0, noAgent: 0, disabled: 0, view: '' }
  const pa44 = (out) => Object.assign({}, EMPTY_PA44, (out && out.presetAuto) || {})
  const textOf44 = (tool, out) => d44.ctx._tool(tool).output.render({}, out).map((b) => b.text).join('\n')

  // ① 不命中清单:判定要留痕、要计数,而且**结构上不可能**记下任何目录
  const a1 = d44.session('a44-1', rNot, 'cordis', 'cordis')
  await d44.fire('agent/created', { agent: a1 })
  d44.setPreset('a44-1', 'standard')
  await ev44('a44-1', 'standard')
  const stNot = await d44.status(a1, rNot)
  check('44.1 【不命中的预设】**判定确实跑到了**(日志留下两行 `预设不命中清单`,计数 notInList=2 / judged=2),且**结构上不可能**记下目录 —— 判定发生在取根之前,插件记忆里不许出现这个目录',
    stNot.status === 'inactive' && stNot.gate === 'none'
    && pa44(stNot).notInList === 2 && pa44(stNot).judged === 2 && pa44(stNot).reached['session/event'] === 1
    && d44.logs().indexOf('预设不命中清单:standard 预设的会话不激活') !== -1
    && d44.logs().indexOf('预设不命中清单:cordis 预设的会话不激活') !== -1
    && mem44()[rNot] === undefined,
    `status=${stNot.status} gate=${stNot.gate} notInList=${pa44(stNot).notInList} judged=${pa44(stNot).judged} 记忆里有该目录=${mem44()[rNot] !== undefined}`)

  // ② 干净目录 + `session/event`:零工具调用激活(既有行为不许丢),并写明"谁中的"
  const a2 = d44.session('a44-2', rAct, 'cordis', 'cordis')
  await ev44('a44-2', 'dev-workflow')
  const stAct = await d44.status(a2, rAct)
  check('44.2 干净目录下 `session/event` 仍然零工具调用就激活(既有行为一字不变),计数里"激活"与 `activatedVia` 都写明是 `session/event` 中的',
    stAct.status === 'active' && String(stAct.gateSource).indexOf('预设 dev-workflow(自动激活)') !== -1
    && pa44(stAct).activated === 1 && pa44(stAct).activatedVia['session/event'] === 1
    && d44.logs().indexOf(`预设自动激活:dev-workflow 预设的会话在 ${rAct} 开工(session/event)`) !== -1,
    `status=${stAct.status} gateSource=${stAct.gateSource} activated=${pa44(stAct).activated} via=${JSON.stringify(pa44(stAct).activatedVia)}`)

  // ③ 本体:同一个目录、第二个会话 —— 门已被**记忆**定下 → 留痕 + 真的不抢功
  const mem3a = mem44()[rAct]
  const a3 = d44.session('a44-3', rAct, 'cordis', 'cordis')
  await ev44('a44-3', 'dev-workflow')
  const mem3b = mem44()[rAct]
  const st3 = await d44.status(a3, rAct)
  check('44.3 【本体】门已被插件记忆定下时判定不再一声不响 —— 日志留下 `预设命中但门已定 …(gate=remembered),不抢功`,而且**真的没抢功**:记忆里那一笔的 `at`/`reason` 一字未改、门源仍是原来那条',
    d44.logs().indexOf(`预设命中但门已定:dev-workflow 预设的会话在 ${rAct}(gate=remembered),不抢功(via=session/event`) !== -1
    && pa44(st3).gateOpen === 1
    && !!mem3a && !!mem3b && mem3a.at === mem3b.at && mem3a.reason === mem3b.reason
    && String(st3.gateSource).indexOf('预设 dev-workflow(自动激活)') !== -1,
    `gateOpen=${pa44(st3).gateOpen} 记忆 at ${mem3a && mem3a.at} → ${mem3b && mem3b.at} | gateSource=${st3.gateSource}`)

  // ④ 同一分支覆盖四档:`.active` 文件档(gate=file)与**用户显式关闭**(gate=off)
  const a4 = d44.session('a44-4', rFile, 'cordis', 'cordis')
  await ev44('a44-4', 'dev-workflow')
  const st4 = await d44.status(a4, rFile)
  const a5 = d44.session('a44-5', rOff, 'cordis', 'cordis')
  await ev44('a44-5', 'dev-workflow')
  const st5 = await d44.status(a5, rOff)
  check('44.4 "门已定"这一分支覆盖四档,措辞不撒谎(`.active` 文件档 → `gate=file`;`.active` 写 off 是**用户显式关闭**,不是"门开着")—— 而 off 那一档照样顶得住(状态仍 inactive / gate=off)',
    st4.status === 'active' && String(st4.gateSource).indexOf('文件') !== -1
    && st5.status === 'inactive' && st5.gate === 'off'
    && d44.logs().indexOf('(gate=file),不抢功') !== -1
    && d44.logs().indexOf('(gate=off),不抢功') !== -1
    && pa44(st5).gateOpen === 3,
    `file 侧 status=${st4.status} gateSource=${st4.gateSource} | off 侧 status=${st5.status} gate=${st5.gate} | gateOpen=${pa44(st5).gateOpen}`)

  // ⑤ 兜底入口 `tools/execute` 一样计数:建会话时预设还没提交(不命中),提交后靠工具调用补判
  const a6 = d44.session('a44-6', rTool, 'cordis', 'cordis')
  await d44.fire('tools/execute', { agent: a6, name: 'probe' })
  d44.setPreset('a44-6', 'dev-workflow')
  await d44.fire('tools/execute', { agent: a6, name: 'probe' })
  const st6 = await d44.status(a6, rTool)
  check('44.5 兜底入口 `tools/execute` 一样计数(到达 2 次、判定 2 次:先"不命中 `cordis`"、提交预设后补判成激活)—— "四条入口各命中过几次"从此不必靠翻日志',
    pa44(st6).reached['tools/execute'] === 2 && pa44(st6).judgedVia['tools/execute'] === 2
    && pa44(st6).activatedVia['tools/execute'] === 1
    && st6.status === 'active',
    `到达=${pa44(st6).reached['tools/execute']} 判定=${pa44(st6).judgedVia['tools/execute']} 激活=${pa44(st6).activatedVia['tools/execute']} status=${st6.status}`)

  // ⑥ `agent-preset/selected` 的两种"到了但不判":都不许静默 return,连"到过"都读不出来
  const judged6a = pa44(await d44.status(a6, rTool)).judged
  await d44.fire('agent-preset/selected', 'a44-404', 'dev-workflow')   // 查不到活会话
  await d44.fire('agent-preset/selected', 'a44-2', '')                 // 载荷空预设(连判都不判)
  const st6b = await d44.status(a6, rTool)
  check('44.6 `agent-preset/selected` 两种"到了但不判"都要看得见 —— 查不到活会话记 `noAgent`,空载荷只记"到达"(判定数一动不动):这两种都不许静默 return',
    pa44(st6b).reached['agent-preset/selected'] === 2 && pa44(st6b).noAgent === 1
    && pa44(st6b).judged === judged6a,
    `到达=${pa44(st6b).reached['agent-preset/selected']} noAgent=${pa44(st6b).noAgent} judged ${judged6a} → ${pa44(st6b).judged}`)

  // ⑦ 根还没就绪:只计数、**不记 seen** —— 同一个会话补上根之后必须还能判成
  const a7 = d44.session('a44-7', '', 'dev-workflow', undefined)
  await d44.fire('tools/execute', { agent: a7, name: 'probe' })
  const st7a = await d44.status(a7, rLate)
  a7.session.header.cwd = rLate
  await d44.fire('tools/execute', { agent: a7, name: 'probe' })
  const st7b = await d44.status(a7, rLate)
  check('44.7 根还没就绪时**只计数不记 `seen`** —— 同一个会话补上根之后照样判得成("留给后面重试"的语义不许被可观测性改动弄丢)',
    pa44(st7a).noRoot === 1 && st7a.status === 'inactive'
    && st7b.status === 'active' && String(st7b.gateSource).indexOf('预设 dev-workflow(自动激活)') !== -1,
    `noRoot=${pa44(st7a).noRoot} 补根前 status=${st7a.status} → 补根后 status=${st7b.status} gateSource=${st7b.gateSource}`)

  // ⑧ 状态面两处同源 + 每条判定恰好一行日志 + 计数是进程内的(不落盘)
  const stFinal = await d44.status(a2, rAct)
  const rlFinal = await d44.relay(a3, { action: 'status', root: rAct })
  const view44 = String(pa44(stFinal).view || '')
  const textState44 = textOf44('workflow_state_status', stFinal)
  const textRelay44 = textOf44('relay', rlFinal)
  const judged44 = pa44(stFinal).judged
  const logLines44 = d44.logs().split('\n').filter((l) => l.indexOf('预设不命中清单:') !== -1
    || l.indexOf('预设命中但门已定:') !== -1 || l.indexOf('预设自动激活:') !== -1)
  check('44.8 状态面两处同源(`workflow_state_status` 与 `relay action=status` 渲染同一行)、每条判定**恰好一行日志**(9 = 不命中 3 + 门已定 3 + 激活 3,不多不少)、计数是**进程内**的(state.json 里不许有它)',
    view44.indexOf('预设自动激活(本进程):到达 ') === 0
    && view44 === String(pa44(rlFinal).view || '')
    && textState44.indexOf(view44) !== -1 && textRelay44.indexOf(view44) !== -1
    && logLines44.length === judged44 && judged44 === 9
    && d44.stateText().indexOf('presetAuto') === -1,
    `judged=${judged44} 日志行=${logLines44.length} 落盘=${d44.stateText().indexOf('presetAuto') !== -1 ? '有' : '无'} | ${view44.slice(0, 150)}…`)

  d44.restore()
}

console.log(`\n${'='.repeat(46)}\n冒烟结果: ${PASS} 通过 / ${FAIL} 失败`)
if (failures.length > 0) {
  console.log('\n失败项:')
  for (const f of failures) console.log(`  ❌ ${f}`)
} else {
  fs.rmSync(TMP, { recursive: true, force: true })
  console.log('(临时目录已清理)')
}
process.exit(FAIL ? 1 : 0)
