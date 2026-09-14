/**
 * 自测:验证插件纯逻辑(互呼协调器 / 状态文档 / 契约 lint)的行为一致性。
 * 运行: node selftest.mjs
 */
import {
  RelayCoordinator,
  extractRelayMarks,
  buildDocument,
  readSection,
  countOpenTodos,
  replaceSection,
  buildProfileTable,
  roleOf,
  renderLedger,
  hashText,
  summarize,
  parseSkillFrontmatter,
  classifySpec,
  lintOpenApi,
  lintGraphql,
  lintProto,
  lintGeneric,
  lintApiFile,
  lintApiFiles,
  summarizeLint,
  apiGuide,
  apiChecklist,
  gateDecision,
  isActiveGate,
  GATE_LABELS,
  VERSION,
  withStateName,
  classifyRootError,
  pathsRegion,
  templateDumpFindings,
  verifyConfirmers,
  parsePackageVersion,
} from './lib/feature.js'
/**
 * 命名空间导入:**新增导出**必须走这里,不许加进上面的具名导入表。
 *
 * ESM 的具名导入在缺少该符号的模块版本上会在**加载期**直接抛错 —— 整文件崩,
 * 新断言就无法表现为一条干净的失败。走命名空间时缺符号拿到的是 `undefined`,
 * 可以用 `typeof fn === 'function' && …` 干净地判定。
 *
 * 功能本体在 `lib/feature.js`(`lib/index.js` 是常驻入口 / 总开关),这份自测测的始终是功能本体。
 */
import * as libmod from './lib/feature.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let PASS = 0
let FAIL = 0
const failures = []

function check(name, cond, detail) {
  if (cond) {
    PASS += 1
  } else {
    FAIL += 1
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── 1. @relay 标记提取(对照 Python 版 1 节 5 断言)─────────────────────────
check('1.1 末尾@relay提取', JSON.stringify(extractRelayMarks('契约已定稿,请确认。\n@relay:be 表结构请确认')) === JSON.stringify({ to: 'be', msg: '表结构请确认' }))
check('1.2 中间@relay不算', extractRelayMarks('@relay:be 问题\n后面还有内容') === null)
check('1.3 空文本返回null', extractRelayMarks('') === null)
check('1.4 语法非法的角色名返回null(本函数只管语法,成员校验交给 profile)', extractRelayMarks('@relay:1bad! 入侵') === null)
// 角色集不写死在本函数里:自定义档案的新角色(如 platform6 的 dba)也要能用
// `@relay:<角色>` 回话。本函数只做语法提取,成员校验在调用处按 profile 判定。
check('1.4b 自定义档案的角色名可被提取',
  JSON.stringify(extractRelayMarks('@relay:dba 表结构请确认')) === JSON.stringify({ to: 'dba', msg: '表结构请确认' }))
check('1.5 多行最后一行合法', JSON.stringify(extractRelayMarks('结论如下\n详见附录\n@relay:arch 架构请评审')) === JSON.stringify({ to: 'arch', msg: '架构请评审' }))
check('1.6 空白行结尾仍取最后一个非空行', JSON.stringify(extractRelayMarks('结论文本\n\n@relay:qa 请复测\n\n')) === JSON.stringify({ to: 'qa', msg: '请复测' }))

// ── 2. 死锁环检测(对照 2 节 4 断言)────────────────────────────────────────
{
  const c = new RelayCoordinator()
  c.waiting = { arch: 'be' }
  check('2.1 A等B时B呼A成环', c.checkDeadlock('be', 'arch') === true)

  c.waiting = { arch: 'be', be: 'fe', fe: 'arch' }
  check('2.2 三角环A→B→C→A', c.checkDeadlock('arch', 'be') === true)

  c.waiting = { arch: 'be' }
  check('2.3 无环:be呼fe', c.checkDeadlock('be', 'fe') === false)

  c.waiting = {}
  check('2.4 空等待图无环', c.checkDeadlock('pm', 'qa') === false)
}

// ── 3. breakWaitChain 拆环(对照 3 节 2 断言)──────────────────────────────
{
  const c = new RelayCoordinator()
  c.waiting = { arch: 'be', be: 'fe' }
  const cleared = c.breakWaitChain('be', 'arch')
  check('3.1 拆环清掉闭合边arch→be', JSON.stringify(cleared) === JSON.stringify(['arch']), JSON.stringify(cleared))
  check('3.2 拆环后等待图只余be→fe', JSON.stringify(c.waiting) === JSON.stringify({ be: 'fe' }), JSON.stringify(c.waiting))
}

// ── 4. 滑动窗口熔断 5 次上限(对照 4 节 5 断言)────────────────────────────
{
  const c = new RelayCoordinator()
  const sent = []
  const wb = (role, text) => { sent.push({ role, text }); return true }
  const results = []
  for (let i = 0; i < 5; i += 1) {
    const r = c.tryRelay('be', 'fe', `第${i}次确认`, 'proj1', wb)
    results.push(r.status)
    delete c.waiting.be // 模拟流完成
  }
  check('4.1 前5次全部done', results.join(',') === 'done,done,done,done,done', results.join(','))
  const r6 = c.tryRelay('be', 'fe', '第6次确认', 'proj1', wb)
  check('4.2 第6次触发limit熔断', r6.status === 'limit', r6.status)
  const forwarded = sent.filter((s) => s.role === 'fe').length
  check('4.3 目标未收到第6条转发', forwarded === 5, `转发给fe共${forwarded}条`)
  check('4.4 熔断通知发回发起方', sent.some((s) => s.text.indexOf('互呼熔断') !== -1))
  check('4.5 熔断事件进仲裁队列(reason=limit)', r6.arbitration && r6.arbitration.reason === 'limit', JSON.stringify(r6.arbitration))
}

// ── 5. 忙等守卫 + 每对独立计数(对照 4.5 节 3 断言)────────────────────────
{
  const c = new RelayCoordinator()
  c.waiting = { pm: 'arch' }
  const sent = []
  const wb = (role, text) => { sent.push({ role, text }); return true }
  const rb = c.tryRelay('pm', 'fe', '第二次互呼', 'proj1', wb)
  check('5.1 已在等待返回busy', rb.status === 'busy', rb.status)
  check('5.2 waiting未被覆盖', JSON.stringify(c.waiting) === JSON.stringify({ pm: 'arch' }), JSON.stringify(c.waiting))
  // busy 时正文照样送达,只有等待图不改写 —— 所以通知文案是【互呼并线】,
  // 不能写成「本次互呼未发出」。
  check('5.3 busy时通知发起方并说明已并线送达', sent.some((s) => s.text.indexOf('【互呼并线】') === 0 && s.text.indexOf('已并线送达') !== -1), JSON.stringify(sent.map((s) => s.text.slice(0, 12))))
  check('5.4 busy不再丢弃正文:目标照常收到', sent.some((s) => s.role === 'fe' && s.text.indexOf('第二次互呼') !== -1), JSON.stringify(sent.map((s) => s.role)))
  check('5.5 busy也计入滑动窗口', Object.keys(c.relayTs).some((k) => k.indexOf('\u0000') !== -1 && c.relayTs[k].length === 1), JSON.stringify(c.relayTs))
}

// ── 6. 死锁熔断全链路(对照 5 节 5 断言)──────────────────────────────────
{
  const c = new RelayCoordinator()
  c.waiting = { arch: 'be' }
  const sent = []
  const wb = (role, text) => { sent.push({ role, text }); return true }
  const r = c.tryRelay('be', 'arch', '契约请确认', 'proj2', wb)
  check('6.1 死锁熔断status=deadlock', r.status === 'deadlock', r.status)
  // 6.2 守的不变量是:正文没有被转发出去(它进仲裁队列),而不是目标什么都收不到 ——
  // 拆环会额外给被解绑的节点发一条【互呼熔断】通知,所以断言按这个意图收窄。
  check('6.2 目标未收到正文转发(只可能收到拆环通知)',
    !sent.some((s) => s.role === 'arch' && s.text.indexOf('契约请确认') !== -1)
    && sent.filter((s) => s.role === 'arch').every((s) => s.text.indexOf('【互呼熔断】') === 0),
    JSON.stringify(sent))
  check('6.3 发起方收到熔断通知', sent.some((s) => s.role === 'be' && s.text.indexOf('死锁') !== -1))
  check('6.4 死锁事件进仲裁队列(reason=deadlock)', r.arbitration && r.arbitration.reason === 'deadlock', JSON.stringify(r.arbitration))
  check('6.5 熔断后等待图已拆', JSON.stringify(c.waiting) === '{}', JSON.stringify(c.waiting))
}

// ── 7. write_back 失败路径(对照 8 节 2 断言)─────────────────────────────
{
  const c = new RelayCoordinator()
  const wbFail = () => false
  const r = c.tryRelay('pm', 'qa', '问答', 'proj3', wbFail)
  check('7.1 目标失活返回no_reply', r.status === 'no_reply', r.status)
  check('7.2 失败后等待图不残留', JSON.stringify(c.waiting) === '{}', JSON.stringify(c.waiting))
}

// ── 8. 三元组 key:异对/异项目独立计数(对照 4.5 节后段)──────────────────
{
  const c = new RelayCoordinator()
  const wb = () => true
  for (let i = 0; i < 5; i += 1) {
    c.tryRelay('pm', 'fe', `fe第${i}次`, 'proj1', wb)
    delete c.waiting.pm
  }
  const rFe6 = c.tryRelay('pm', 'fe', 'fe第6次', 'proj1', wb)
  check('8.1 同对第6次熔断', rFe6.status === 'limit', rFe6.status)
  const rQa1 = c.tryRelay('pm', 'qa', 'qa第1次', 'proj1', wb)
  check('8.2 异对不受影响', rQa1.status === 'done', rQa1.status)
  delete c.waiting.pm // 8.2 成功会登记等待,复现测试须先释放(否则被忙等守卫拦下)
  const rProj = c.tryRelay('pm', 'fe', '异项目', 'proj2', wb)
  check('8.3 异项目不受影响', rProj.status === 'done', rProj.status)
}

// ── 9. 注入消息前缀契约(对照 9 节)───────────────────────────────────────
{
  const c = new RelayCoordinator()
  const sent = []
  const wb = (role, text) => { sent.push({ role, text }); return true }
  c.tryRelay('pm', 'qa', '问题', 'p', wb)
  check('9.1 转发消息以【互呼】开头', sent[0].text.indexOf('【互呼】') === 0, sent[0].text.slice(0, 8))

  const c2 = new RelayCoordinator()
  c2.waiting = { arch: 'be' }
  const sent2 = []
  c2.tryRelay('be', 'arch', 'x', 'p', (r, t) => { sent2.push({ role: r, text: t }); return true })
  check('9.2 死锁通知以【互呼熔断】开头', sent2[0].text.indexOf('【互呼熔断】') === 0, sent2[0].text.slice(0, 8))

  const c3 = new RelayCoordinator()
  c3.waiting = { pm: 'arch' }
  const sent3 = []
  c3.tryRelay('pm', 'fe', 'x', 'p', (r, t) => { sent3.push({ role: r, text: t }); return true })
  // 忙等通知必须按真实投递结果措辞(失败时不得声称已送达),而结果只能在转发投递之后
  // 才知道 —— 排第一与不说谎时序互斥。取舍:放弃次序要求,保住语义正确
  // (次序只是观感;谎报送达会真丢消息)。因此只要求通知出现,不要求它排第一。
  check('9.3 忙等通知以【互呼并线】开头(不要求排第一:文案须等投递结果)', sent3.some((s) => s.text.indexOf('【互呼并线】') === 0), JSON.stringify(sent3.map((s) => s.text.slice(0, 10))))
  check('9.4 忙等时目标也能收到正文(并线)', sent3.some((s) => s.role === 'fe' && s.text.indexOf('【互呼】') === 0), JSON.stringify(sent3.map((s) => s.role)))
}

// ── 10. 状态文档合并(落盘链路的纯函数)─────────────────
{
  const base = buildDocument(null, { projectName: 't' })
  check('10.1 空文档生成含全部小节', ['当前进度', '产出文件', '待办', '契约修订台账', '遗留风险'].every((s) => base.indexOf(`## ${s}`) !== -1))

  const one = buildDocument(base, { role: 'arch', nextStep: '④ 质检员' })
  check('10.2 role 写入当前进度', one.indexOf('② 架构师 ✅') !== -1)
  check('10.3 nextStep 写入', one.indexOf('④ 质检员') !== -1)

  const two = buildDocument(one, { role: 'be', todos: ['甲', '乙'] })
  check('10.4 二次渲染不重复 更新: 行', (two.match(/^更新:/gm) || []).length === 1, String((two.match(/^更新:/gm) || []).length))
  check('10.5 合并保留上一步进度以外的旧小节', two.indexOf('## 产出文件') !== -1)
  check('10.6 未完成待办计数正确', countOpenTodos(readSection(two, '待办')) === 2, String(countOpenTodos(readSection(two, '待办'))))

  const three = buildDocument(two, { contractRevision: { content: 'API 加字段', affected: 'be/fe', confirmedBy: '@be' } })
  check('10.7 契约台账追加一行', readSection(three, '契约修订台账').indexOf('API 加字段') !== -1)
  check('10.8 小节标题前有空行(排版)', /\n\n## 待办/.test(three), JSON.stringify(three.slice(three.indexOf('## 待办') - 4, three.indexOf('## 待办') + 6)))
  check('10.9 无三连空行', three.indexOf('\n\n\n') === -1)

  // 只给 nextStep(不给 role)也要生效 —— 否则整段被忽略,kickoff 的初始文档写着模板里的硬编码
  const onlyNext = buildDocument(null, { nextStep: '② 架构师 出设计' })
  check('10.11 只给 nextStep 也能改写「下一步」', onlyNext.indexOf('- 下一步:② 架构师 出设计') !== -1 && onlyNext.indexOf('- 当前角色:(无)') !== -1, onlyNext.split('\n').slice(3, 7).join(' | '))
  const noNext = buildDocument(onlyNext, { nextStep: '③ 后端开发' })
  check('10.12 重复只给 nextStep 不重复追加行', (noNext.match(/^- 下一步:/gm) || []).length === 1, String((noNext.match(/^- 下一步:/gm) || []).length))
  check('10.13 给了 role 时行为不变(仍整段重写)', buildDocument(null, { role: 'arch' }).indexOf('② 架构师 ✅') !== -1)

  const sec = replaceSection('# T\n\n## 甲\n- 1\n\n## 乙\n- 2\n', '甲', '- 改')
  check('10.10 replaceSection 只改目标小节', readSection(sec, '甲') === '- 改' && readSection(sec, '乙') === '- 2', JSON.stringify(sec))
}

// ── 11. profile 表与角色归一化(多 profile 的数据底座)─────────
{
  const table = buildProfileTable(null, null)
  check('11.1 内置三 profile 齐全', ['standard', 'lean3', 'review'].every((id) => table[id]), Object.keys(table).join(','))
  check('11.2 standard 五角色顺序', table.standard.roles.map((r) => r.id).join(',') === 'pm,arch,be,fe,qa', table.standard.roles.map((r) => r.id).join(','))
  check('11.3 每个角色都有人格文本(子会话人格的注入源)', table.standard.roles.every((r) => r.persona && r.persona.length > 40), String(table.standard.roles[0].persona.length))
  check('11.4 preset 与 wf-* 对应', table.standard.roles.every((r) => r.preset === `wf-${r.id}`), table.standard.roles.map((r) => r.preset).join(','))
  check('11.5 review 双角色只读', table.review.roles.every((r) => r.readonly === true) && table.review.roles.length === 2, JSON.stringify(table.review.roles.map((r) => [r.id, r.readonly])))
  check('11.6 lean3 角色集与协调者', table.lean3.roles.map((r) => r.id).join(',') === 'pm,be,qa' && table.lean3.coordinator === 'pm', table.lean3.roles.map((r) => r.id).join(','))
  check('11.7 review 熔断上限独立(8 次)', table.review.relay.limit === 8 && table.standard.relay.limit === 5, `${table.review.relay.limit}/${table.standard.relay.limit}`)

  const merged = buildProfileTable({ standard: { label: '我的五角色', roles: ['pm', 'qa'] } }, null)
  check('11.8 用户 profile 覆盖角色集', merged.standard.roles.map((r) => r.id).join(',') === 'pm,qa', merged.standard.roles.map((r) => r.id).join(','))
  check('11.9 覆盖 label 后人格仍在(增量合并)', merged.standard.label === '我的五角色' && merged.standard.roles[0].persona.indexOf('项目经理') !== -1)

  const custom = buildProfileTable({ mini: { label: '迷你', roles: [{ id: 'qa', readonly: false, persona: '你是迷你质检。' }], coordinator: 'qa' } }, null)
  check('11.10 新 profile 可自定义角色对象', custom.mini.roles.length === 1 && custom.mini.roles[0].readonly === false && custom.mini.roles[0].persona === '你是迷你质检。', JSON.stringify(custom.mini.roles))
  check('11.11 roleOf 命中/未命中', roleOf(table.standard, 'qa').id === 'qa' && roleOf(table.standard, 'nope') === undefined)

  // 只覆盖部分字段时,角色集必须原样保留(否则标准档案会塌成对象、角色全部失效)
  const partial = buildProfileTable(null, { standard: { relay: { limit: 3 } } })
  check('11.12 只覆盖 relay 不丢角色集', partial.standard.roles.map((r) => r.id).join(',') === 'pm,arch,be,fe,qa', partial.standard.roles.map((r) => typeof r.id).join(','))
  check('11.13 只覆盖 relay 时覆盖生效', partial.standard.relay.limit === 3 && partial.standard.relay.windowMs === 600000, `${partial.standard.relay.limit}/${partial.standard.relay.windowMs}`)
  check('11.14 只覆盖 label 时角色集仍在', buildProfileTable(null, { lean3: { label: 'L3' } }).lean3.roles.length === 3)
  check('11.15 内置档案的 qa 仍标记只读', partial.standard.roles.filter((r) => r.readonly).map((r) => r.id).join(',') === 'qa')

  // 自定义档案不得继承 standard 的 label/desc —— 否则会回显成前后矛盾的一行
  // (label 写自定义的角色集、desc 还是 standard 的五个角色)。
  const six = buildProfileTable({ platform6: { label: '平台六角色(大项目)', roles: ['pm', 'arch', 'be', 'fe', 'dba', 'qa'] } }, null)
  check('11.16 自定义档案不继承 standard 的 desc', six.platform6.desc === '', JSON.stringify(six.platform6.desc))
  check('11.17 自定义档案 label 用自己的', six.platform6.label === '平台六角色(大项目)', six.platform6.label)
  check('11.18 自定义角色集原样保留(含 dba)', six.platform6.roles.map((r) => r.id).join(',') === 'pm,arch,be,fe,dba,qa', six.platform6.roles.map((r) => r.id).join(','))
  check('11.19 内置档案自己的 desc 仍在', buildProfileTable(null, null).standard.desc.indexOf('完整流程') !== -1, buildProfileTable(null, null).standard.desc)
  check('11.20 自定义档案里同名内置角色仍继承人格', six.platform6.roles.filter((r) => r.id === 'arch')[0].persona.indexOf('架构') !== -1, six.platform6.roles.filter((r) => r.id === 'arch')[0].persona.slice(0, 20))
}

// ── 12. profile 级熔断限额真正生效(不写死常量)───────────────────────────
{
  const c = new RelayCoordinator(2, 600000)
  const wb = () => true
  const r1 = c.tryRelay('pm', 'qa', '甲', 'p', wb); delete c.waiting.pm
  const r2 = c.tryRelay('pm', 'qa', '乙', 'p', wb); delete c.waiting.pm
  const r3 = c.tryRelay('pm', 'qa', '丙', 'p', wb)
  check('12.1 limit=2 时第 3 次熔断', r1.status === 'done' && r2.status === 'done' && r3.status === 'limit', `${r1.status},${r2.status},${r3.status}`)
  check('12.2 熔断事件带 reason=limit', r3.arbitration && r3.arbitration.reason === 'limit')
}

// ── 13. 快照/恢复(重启不清空的纯逻辑部分)────────────────────────────────
{
  const c = new RelayCoordinator(5, 600000)
  const wb = () => true
  for (let i = 0; i < 5; i += 1) { c.tryRelay('be', 'fe', `第${i}次`, 'proj1', wb); delete c.waiting.be }
  c.markWait('arch', 'be', '契约请确认')
  const snap = c.snapshot()
  check('13.1 快照保留 waiting 原形', JSON.stringify(snap.waiting) === JSON.stringify({ arch: 'be' }), JSON.stringify(snap.waiting))
  check('13.2 快照带 waitMeta 元数据', snap.waitMeta.arch && snap.waitMeta.arch.to === 'be' && !!snap.waitMeta.arch.ts, JSON.stringify(snap.waitMeta))

  const c2 = new RelayCoordinator(5, 600000).hydrate(snap)
  check('13.3 hydrate 恢复等待图', JSON.stringify(c2.waiting) === JSON.stringify({ arch: 'be' }), JSON.stringify(c2.waiting))
  const again = c2.tryRelay('be', 'fe', '第6次', 'proj1', wb)
  check('13.4 熔断计数跨恢复不清零(窗口内仍是第6次)', again.status === 'limit', again.status)

  c2.release('arch')
  check('13.5 release 同时清掉 waitMeta', c2.waiting.arch === undefined && c2.waitMeta.arch === undefined, JSON.stringify(c2.waitMeta))

  // 熔断计数的分桶键只能有一个 —— 台账标签(project)换了不能再开一个新桶,
  // 否则同一项目里 10 分钟上限实际能发到约 2 倍。
  const c3 = new RelayCoordinator(2, 600000)
  const same = { bucket: 'standard@F:\\p\\l-platform' }
  const a1 = c3.tryRelay('pm', 'be', '一', 'l-platform', wb, same)
  delete c3.waiting.pm
  const a2 = c3.tryRelay('pm', 'be', '二', 'platform6@F:\\p\\l-platform', wb, same)
  delete c3.waiting.pm
  const a3 = c3.tryRelay('pm', 'be', '三', 'l-platform', wb, same)
  check('13.6 标签不同但桶相同 → 计数共享(第 3 次熔断)', a1.status === 'done' && a2.status === 'done' && a3.status === 'limit', `${a1.status},${a2.status},${a3.status}`)
  check('13.7 事件里仍保留人读标签', a3.arbitration && a3.arbitration.project === 'l-platform', JSON.stringify(a3.arbitration))
  check('13.8 桶只有一条(不因标签分裂)', Object.keys(c3.relayTs).length === 1, JSON.stringify(Object.keys(c3.relayTs)))
}

// ── 14. 协作台账渲染(人读一侧)──────────────────────────────────────────
{
  const rows = [
    { ts: '2026-01-01 10:00:00', from: 'pm', to: 'arch', summary: '含|管道符的摘要', status: '✅ 已转发', note: 'ok' },
    { ts: '2026-01-01 10:05:00', from: 'be', to: 'qa', summary: '第二条', status: '🔴 熔断-超限', note: '升级仲裁' },
  ]
  const doc = renderLedger(rows, { project: 'demo', profile: 'standard', stateFile: 'docs/workflow/流程状态.md', limit: 5, windowMs: 600000 })
  check('14.1 含标题与表头', doc.indexOf('# 协作台账:demo') === 0 && doc.indexOf('| 时间 | 发起 | 目标 | 摘要 | 状态 | 备注 |') !== -1)
  check('14.2 新→旧排序', doc.indexOf('第二条') < doc.indexOf('管道符'), '顺序错了')
  check('14.3 管道符被转义(不撑破表格)', doc.indexOf('含\\|管道符的摘要') !== -1)
  check('14.4 元信息含 profile 与限额', doc.indexOf('profile=standard') !== -1 && doc.indexOf('5次/10分钟') !== -1)
  const empty = renderLedger([], {})
  check('14.5 空台账给占位行', empty.indexOf('(暂无)') !== -1)
  const many = []
  for (let i = 0; i < 205; i += 1) many.push({ ts: 't', from: 'pm', to: 'qa', summary: `第${i}`, status: 's', note: '' })
  check('14.6 渲染不因行数崩溃', renderLedger(many, {}).split('\n').length > 200)
}

// ── 15. 去重哈希(同一互呼不重复投递)────────────────────────────────────
check('15.1 同文本同哈希', hashText('表结构请确认') === hashText('表结构请确认'))
check('15.2 异文本异哈希', hashText('表结构请确认') !== hashText('表结构请确认 '))
check('15.3 稳定可重复', hashText('abc') === hashText('abc') && hashText('') === hashText(''))

// ── 16. 技能 frontmatter 解析(api-architect 并入的技能侧)─────────
{
  const SKILL_MD = fileURLToPath(new URL('./skills/api-architect/SKILL.md', import.meta.url))
  const raw = fs.readFileSync(SKILL_MD, 'utf8')
  const parsed = parseSkillFrontmatter(raw)
  check('16.1 随包 SKILL.md 存在且 name 正确', parsed.attrs.name === 'api-architect', String(parsed.attrs.name))
  check('16.2 description 折行被并成一行', String(parsed.attrs.description).length > 60 && String(parsed.attrs.description).indexOf('OpenAPI') !== -1, String(parsed.attrs.description).slice(0, 60))
  check('16.3 whenToUse 解析出来', /api_contract|架构师/.test(String(parsed.attrs.whenToUse)), String(parsed.attrs.whenToUse).slice(0, 40))
  check('16.4 version 解析出来', /^\d+\.\d+\.\d+$/.test(String(parsed.attrs.version)), String(parsed.attrs.version))
  check('16.5 body 剥掉了 frontmatter', parsed.body.trim().indexOf('# API Architect') === 0, parsed.body.trim().slice(0, 30))
  check('16.6 无 frontmatter 时原样返回', parseSkillFrontmatter('# t\n').body === '# t\n' && Object.keys(parseSkillFrontmatter('# t\n').attrs).length === 0)
  const inline = parseSkillFrontmatter('---\nname: x\ndescription: "带空的 值"\n---\nbody\n')
  check('16.7 引号值去引号', inline.attrs.description === '带空的 值', JSON.stringify(inline.attrs))
}

// ── 17. OpenAPI lint(纯 JS 契约校验)─────────────────────────────
{
  const good = [
    'openapi: 3.1.0',
    'info:',
    '  title: Demo',
    '  version: 1.0.0',
    'servers:',
    '  - url: https://api.example.com/v1',
    'paths:',
    '  /users:',
    '    get:',
    '      operationId: listUsers',
    '      responses:',
    "        '200':",
    '          description: ok',
    "        '400':",
    '          description: bad',
    'components:',
    '  securitySchemes:',
    '    bearerAuth:',
    '      type: http',
  ].join('\n')
  const g = lintOpenApi('api/openapi.yaml', good)
  check('17.1 合规 spec 零 ERROR 零 WARN', g.length === 0, JSON.stringify(g))

  const bad = ['swagger: "2.0"', 'paths:', '  /getUsers:', '    get: {}', '    post: {}'].join('\n')
  const b = lintOpenApi('openapi.yaml', bad)
  const lv = (arr, level) => arr.filter((f) => f.level === level)
  check('17.2 Swagger 2.0 → WARN', lv(b, 'warn').some((f) => f.rule === 'openapi-version'), JSON.stringify(b.map((f) => f.rule)))
  check('17.3 缺 info → ERROR', lv(b, 'error').some((f) => f.rule === 'openapi-info'))
  check('17.4 缺 servers → WARN', lv(b, 'warn').some((f) => f.rule === 'openapi-servers'))
  check('17.5 缺 securitySchemes → WARN', lv(b, 'warn').some((f) => f.rule === 'openapi-security'))
  check('17.6 缺 operationId → WARN', lv(b, 'warn').some((f) => f.rule === 'openapi-operationid'))
  check('17.7 动词化 URL → ERROR', lv(b, 'error').some((f) => f.rule === 'openapi-verb-url'))
  check('17.8 POST 无幂等键 → WARN', lv(b, 'warn').some((f) => f.rule === 'openapi-idempotency'))
  check('17.9 该 spec 判 fail(2 ERROR)', lv(b, 'error').length === 2 && summarizeLint(b).verdict === 'fail', `${lv(b, 'error').length}/${summarizeLint(b).verdict}`)
  check('17.10 findings 带 fix 建议', b.every((f) => !f.level || f.fix), JSON.stringify(b.filter((f) => !f.fix)))
  check('17.11 动词化 URL 带行号', lv(b, 'error').some((f) => f.rule === 'openapi-verb-url' && f.line === 3), JSON.stringify(lv(b, 'error')))

  const no4xx = lintOpenApi('a.yaml', 'openapi: 3.0.0\ninfo:\n  title: t\n  version: 1\nservers:\n  - url: https://x/v1\nsecuritySchemes: {}\npaths:\n  /u:\n    get:\n      operationId: a\n      responses:\n        "200": {}')
  check('17.12 无 4xx → WARN', no4xx.some((f) => f.rule === 'openapi-4xx'), JSON.stringify(no4xx.map((f) => f.rule)))
}

// ── 18. GraphQL / proto lint(同上,纯 JS)───────────────────────────────
{
  const gql = 'type User { id: ID! }\ntype UserConnection { nodes: [User!]! }\ntype Mutation { createUser(input: X): Payload }\n'
  const g = lintGraphql('schema.graphql', gql)
  check('18.1 缺 type Query → ERROR', g.some((f) => f.level === 'error' && f.rule === 'graphql-query'))
  check('18.2 Connection 缺 PageInfo → WARN', g.some((f) => f.rule === 'graphql-pageinfo'))
  check('18.3 Mutation 无 errors → WARN', g.some((f) => f.rule === 'graphql-mutation-errors'))
  const g2 = lintGraphql('s.graphql', 'scalar DateTime\ntype Query { now: DateTime }\n')
  check('18.4 声明过的标量不再告警', g2.length === 0, JSON.stringify(g2))
  const g3 = lintGraphql('s.graphql', 'type Query { now: DateTime }\n')
  check('18.5 未声明标量 → WARN', g3.some((f) => f.rule === 'graphql-scalar'), JSON.stringify(g3))

  const p1 = 'syntax = "proto3";\nmessage Foo {\n  string a = 0;\n}\n'
  const p = lintProto('a.proto', p1)
  check('18.6 缺 package → ERROR', p.some((f) => f.level === 'error' && f.rule === 'proto-package'))
  check('18.7 消息字段号 0 → ERROR', p.some((f) => f.level === 'error' && f.rule === 'proto-field-zero'), JSON.stringify(p))
  check('18.8 缺 go_package → WARN', p.some((f) => f.rule === 'proto-go-package'))
  const p2 = 'syntax = "proto3";\npackage demo.api;\noption go_package = "example.com/demo;demo";\nmessage E {\n  enum Color {\n    UNKNOWN = 0;\n  }\n}\n'
  const p2f = lintProto('b.proto', p2)
  check('18.9 enum 里的 0 合法(花括号栈判定)', p2f.length === 0, JSON.stringify(p2f))
  const p3 = lintProto('c.proto', 'message X { int32 a = 0; }')
  check('18.10 单行消息里的 0 也能抓到', p3.some((f) => f.rule === 'proto-field-zero'), JSON.stringify(p3))
}

// ── 19. 契约分类与汇总口径(与原脚本语义对齐)──────────────────────────────
{
  check('19.1 分类:OpenAPI 按内容', classifySpec('a.yaml', 'openapi: 3.1.0\ninfo:\n  title: t') === 'openapi')
  check('19.2 分类:proto 按扩展名', classifySpec('a.proto', 'message X {}') === 'proto')
  check('19.3 分类:graphql 按内容/扩展名', classifySpec('s.graphql', 'type Query { a: Int }') === 'graphql' && classifySpec('x.txt', 'type Query { a: Int }') === 'graphql')
  check('19.4 分类:普通 yaml 归 generic', classifySpec('ci.yaml', 'jobs:\n  a: 1') === 'generic')
  check('19.5 分类:不认识的不猜', classifySpec('a.md', '# hi') === 'unknown')
  check('19.6 ERROR>0 → fail', summarizeLint([{ level: 'error' }]).verdict === 'fail')
  check('19.7 WARN>5 → pass_with_warnings', summarizeLint(new Array(6).fill({ level: 'warn' })).verdict === 'pass_with_warnings')
  check('19.8 WARN≤5 → pass', summarizeLint([{ level: 'warn' }, { level: 'info' }]).verdict === 'pass')

  const withV = 'openapi: 3.1.0\ninfo:\n  title: t\n  version: 1.0.0\nservers:\n  - url: https://x/v1\nsecuritySchemes: {}\npaths:\n  /users:\n    get:\n      operationId: l\n      responses:\n        "400": {}\n'
  const agg = lintApiFiles([{ rel: 'api/openapi.yaml', text: withV }])
  check('19.9 聚合出 files/kinds', agg.files.length === 1 && agg.kinds.openapi === 1, JSON.stringify(agg.files))
  check('19.10 有 /v1/ → 不报版本化 info', agg.findings.filter((f) => f.rule === 'versioning').length === 0, JSON.stringify(agg.findings))
  const agg2 = lintApiFiles([{ rel: 'api/openapi.yaml', text: 'openapi: 3.0.0\ninfo:\n  title: t\n  version: 1.0.0\n' }])
  check('19.11 无版本化 → info 一条', agg2.findings.filter((f) => f.rule === 'versioning').length === 1, JSON.stringify(agg2.findings))
  check('19.12 空输入不炸', lintApiFiles(null).findings.length === 0 && lintApiFiles([]).files.length === 0)

  check('19.13 硬编码主机 → WARN', lintGeneric('api/config.yaml', 'base: http://localhost:8080').some((f) => f.rule === 'hardcoded-host'))
  check('19.14 文件名含 dev/local 时豁免', lintGeneric('api/dev.config.yaml', 'base: http://localhost:8080').length === 0)
  check('19.15 lintApiFile 按分类分派', lintApiFile('a.proto', 'message X {}').every((f) => f.file === 'a.proto'))

  // 空集不算通过:一个契约都没有却报 PASS,等于把没人可判说成了通过。
  check('19.16 一个契约都没有 → no_specs(不是 pass)', lintApiFiles([]).verdict === 'no_specs' && lintApiFiles(null).verdict === 'no_specs', lintApiFiles([]).verdict)
  check('19.17 有契约时不会被 no_specs 覆盖', lintApiFiles([{ rel: 'a.yaml', text: 'openapi: 3.1.0\ninfo:\n  title: t\n' }]).verdict !== 'no_specs')
  check('19.18 只有 generic 候选(yaml 配置)也算 no_specs', lintApiFiles([{ rel: 'ci.yaml', text: 'jobs:\n  a: 1\n' }]).verdict === 'no_specs', lintApiFiles([{ rel: 'ci.yaml', text: 'jobs:\n  a: 1\n' }]).verdict)

  // ── 模板原文假装成"本项目的契约"必须被拦下 ────────────────────────────
  // 包内参考件原样落盘到 docs/api/openapi.yaml 时:标题还是 User Service API、路径还是 /users、
  // base URL 还是 api.example.com —— 可机读的规则里必须有一条问:这是不是本项目的契约。
  const tplPath = fileURLToPath(new URL('./skills/api-architect/references/openapi-spec.yaml', import.meta.url))
  const tplText = fs.readFileSync(tplPath, 'utf8')
  const dump = lintApiFiles([{ rel: 'docs/api/openapi.yaml', text: tplText }])
  check('19.19 模板原文落盘 → 归属校验 ERROR(不再无条件 PASS)', dump.verdict === 'fail' && dump.findings.some((f) => f.rule === 'vendor-template'), JSON.stringify({ verdict: dump.verdict, rules: dump.findings.map((f) => f.rule) }))
  check('19.20 归属校验给出可执行的修法', dump.findings.filter((f) => f.rule === 'vendor-template').every((f) => f.file === 'docs/api/openapi.yaml' && !!f.fix))

  // 反向:真按项目改写过的 spec 不得被误杀(端点/标题/模型全换,只保留 OpenAPI 通用结构)
  const ownSpec = [
    'openapi: 3.1.0', 'info:', '  title: 订单服务 API', '  version: 2.0.0',
    'servers:', '  - url: https://api.acme.internal/v2',
    'paths:', '  /orders:', '    get:', '      operationId: listOrders',
    '      parameters:', '        - name: page_size', '          in: query', '          schema:', '            type: integer',
    '      responses:', "        '200':", '          description: 订单列表', '          content:', '            application/json:',
    '              schema:', "                $ref: '#/components/schemas/OrderPage'",
    'components:', '  schemas:', '    OrderPage:', '      type: object', '      properties:',
    '        order_no:', '          type: string', '        total_amount:', '          type: integer',
    '        created_at:', '          type: string', '          format: date-time',
  ].join('\n')
  check('19.21 已改写为本项目的 spec 不误报归属', !lintApiFiles([{ rel: 'docs/api/orders.yaml', text: ownSpec }]).findings.some((f) => f.rule === 'vendor-template'), JSON.stringify(lintApiFiles([{ rel: 'docs/api/orders.yaml', text: ownSpec }]).findings.map((f) => f.rule)))
  check('19.22 短 spec 不误报(通用关键字凑不满阈值)', !lintApiFiles([{ rel: 'a.yaml', text: withV }]).findings.some((f) => f.rule === 'vendor-template'))

  // ── lint 记录必须带指纹 —— 否则"lint ERROR 0"不保证是对同一份文件成立的 ──
  const d1 = lintApiFiles([{ rel: 'docs/api/openapi.yaml', text: withV }])
  check('19.23 lint 结果带逐文件 sha256 与整批指纹', /^[0-9a-f]{64}$/.test(String(d1.digest)) && /^[0-9a-f]{64}$/.test(String(d1.files[0].sha256)) && d1.files[0].bytes > 0, JSON.stringify({ digest: String(d1.digest).slice(0, 8), file: d1.files[0] }))
  const d2 = lintApiFiles([{ rel: 'docs/api/openapi.yaml', text: withV.replace('title: t', 'title: t2') }])
  check('19.24 文件被改写 → 指纹必变(旧结论自动作废)', d1.digest !== d2.digest)
  check('19.25 只改注释也算改写(指纹对字节负责)', lintApiFiles([{ rel: 'a.yaml', text: withV }]).digest !== lintApiFiles([{ rel: 'a.yaml', text: `${withV}# 注\n` }]).digest)
}

// ── 20. 状态文档的「API 契约」小节(落盘面)──────────────────
{
  const doc0 = buildDocument(null, { projectName: 't' })
  check('20.1 默认模板含 API 契约小节', doc0.indexOf('## API 契约') !== -1, doc0.slice(0, 120))
  const doc1 = buildDocument(doc0, { apiSpecs: ['docs/api/openapi.yaml | 类型=openapi | 版本=/v1 | lint=ERROR 0'] })
  check('20.2 字符串条目写入小节', readSection(doc1, 'API 契约').indexOf('docs/api/openapi.yaml') !== -1, readSection(doc1, 'API 契约'))
  const doc2 = buildDocument(doc1, { apiSpecs: [{ path: 'docs/api/a.proto', kind: 'proto', versioning: 'header', lint: 'ERROR 0' }] })
  check('20.3 对象条目拼成一行', readSection(doc2, 'API 契约').indexOf('类型=proto') !== -1 && readSection(doc2, 'API 契约').indexOf('版本=header') !== -1, readSection(doc2, 'API 契约'))
  check('20.4 summarize 带出 apiSpecs', summarize(doc2).apiSpecs.indexOf('a.proto') !== -1, summarize(doc2).apiSpecs)
  check('20.5 改契约小节不动别的小节', readSection(doc2, '当前进度').indexOf('① 项目经理') !== -1 && doc2.indexOf('## 待办') !== -1)
  check('20.6 guide/checklist 文案非空', apiGuide().indexOf('api_contract') !== -1 && apiChecklist().indexOf('api_contract action=lint') !== -1)
}

// ── 21. 激活门判定表(文件 / 记忆 / 状态文档三选一 + 显式关闭)───────────────
{
  check('21.1 .active 内容 active → file', gateDecision({ fileExists: true, fileText: 'active\n' }) === 'file')
  check('21.2 .active 带 stateName/profile 仍算 file', gateDecision({ fileExists: true, fileText: 'active\nstateName=x\nprofile=lean3\n' }) === 'file')
  check('21.3 .active 写 off → off(显式关闭)', gateDecision({ fileExists: true, fileText: 'off\n' }) === 'off')
  check('21.4 off 大小写/前后空格都认', gateDecision({ fileExists: true, fileText: '  OFF  ' }) === 'off' && gateDecision({ fileExists: true, fileText: 'inactive' }) === 'off')
  check('21.5 off 优先于插件记忆', gateDecision({ fileExists: true, fileText: 'off', remembered: true, stateDocExists: true }) === 'off')
  check('21.6 无文件但插件记忆 → remembered', gateDecision({ remembered: true }) === 'remembered')
  check('21.7 无文件无记忆但已有流程状态文档 → state-doc(跨机器自愈)', gateDecision({ stateDocExists: true }) === 'state-doc')
  check('21.8 三无 → none', gateDecision({}) === 'none' && gateDecision(null) === 'none')
  check('21.9 文件优先于记忆(来源可分辨)', gateDecision({ fileExists: true, fileText: 'active', remembered: true }) === 'file')
  check('21.10 isActiveGate 只认 none/off 为关闭', isActiveGate('file') && isActiveGate('remembered') && isActiveGate('state-doc') && !isActiveGate('none') && !isActiveGate('off'))
  check('21.11 GATE_LABELS 五种情形都有中文说明', ['file', 'remembered', 'state-doc', 'off', 'none'].every((k) => typeof GATE_LABELS[k] === 'string' && GATE_LABELS[k].length > 2), JSON.stringify(GATE_LABELS))
}

// ── 22. 纯逻辑回归(版本自证 / state.file 插名 / statSync 分类)────────────────
{
  // 版本自证。deploy.ps1 拿 VERSION 与宿主日志里的 ready 行比对,
  // 而「磁盘版本」读的是随包 package.json —— 两者必须一致,否则部署当天就会误报。
  const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'))
  check('22.1 VERSION 与随包 package.json 一致', VERSION === pkg.version, `VERSION=${VERSION} pkg=${pkg.version}`)
  check('22.2 VERSION 形如 x.y.z', /^\d+\.\d+\.\d+$/.test(VERSION), VERSION)

  // 自定义 state.file(不含「流程状态」字样)时,插入 stateName 不能静默失效 ——
  // 按固定字样做字符串替换匹配不上就原样返回,子流程会全写进同一份文件。
  check('22.3 默认名 → 流程状态-<名>.md', withStateName('docs/workflow/流程状态.md', 'alpha') === 'docs/workflow/流程状态-alpha.md')
  check('22.4 自定义名 → 插在扩展名之前',
    withStateName('docs/workflow/state.md', 'alpha') === 'docs/workflow/state-alpha.md',
    withStateName('docs/workflow/state.md', 'alpha'))
  check('22.5 无扩展名 → 追加在末尾', withStateName('docs/workflow/state', 'alpha') === 'docs/workflow/state-alpha')

  // statSync 失败的分类:盘符未挂载 / 网络盘断连 / 杀软占用这类一次性抖动
  // 不能被当成「已删」而永久清空角色绑定。
  check('22.6 只有 ENOENT/ENOTDIR 算"已删"', classifyRootError('ENOENT') === 'gone' && classifyRootError('ENOTDIR') === 'gone')
  check('22.7 权限/占用/IO/未知错误一律按"暂时读不到"',
    ['EACCES', 'EPERM', 'EBUSY', 'EIO', 'ETIMEDOUT', 'UNKNOWN', ''].every((c) => classifyRootError(c) === 'io'),
    ['EACCES', 'EPERM', 'EBUSY', 'EIO', 'ETIMEDOUT', 'UNKNOWN', ''].map((c) => `${c}:${classifyRootError(c)}`).join(' '))
}

// ── 23. 契约 lint:形态误报与反照抄 ──────────────────────────────────────
{
  const rules = (arr) => arr.map((f) => f.rule)
  const has = (arr, rule) => rules(arr).indexOf(rule) !== -1

  // 客户端操作文档不是 schema —— 不能按 .graphql 扩展名一律套 schema 规则:
  //     「没有 type Query」直接 ERROR,而 ERROR 0 是写进角色人设的硬门槛。
  const opDoc = 'query GetUser($id: ID!) {\n  user(id: $id) { id name }\n}\n'
  check('23.1 操作文档被判 graphql-op(不是 schema)', classifySpec('web/graphql/user.graphql', opDoc) === 'graphql-op',
    classifySpec('web/graphql/user.graphql', opDoc))
  check('23.2 操作文档不再被判 graphql-query ERROR',
    !has(lintApiFile('web/graphql/user.graphql', opDoc), 'graphql-query'), JSON.stringify(rules(lintApiFile('web/graphql/user.graphql', opDoc))))
  const realSchema = 'type User { id: ID! }\ntype Mutation { createUser: User }\n'
  check('23.3 真 schema(有类型定义、缺 Query)仍然报错 —— 不许把误报修成漏报',
    has(lintApiFile('schema.graphql', realSchema), 'graphql-query'), JSON.stringify(rules(lintApiFile('schema.graphql', realSchema))))
  const mixed = 'type Query { me: User }\nquery Me { me { id } }\n'
  check('23.4 类型定义 + 示例操作混排的文件仍按 schema 判',
    classifySpec('schema.graphql', mixed) === 'graphql' && !has(lintApiFile('schema.graphql', mixed), 'graphql-query'))

  // JSON 形态的 OpenAPI:键带引号、值嵌在对象里,规则照样要能认出 securitySchemes / operationId / responses。
  const jsonSpec = JSON.stringify({
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    servers: [{ url: 'https://api.example.com' }],
    security: [{ bearerAuth: [] }],
    paths: { '/users': { get: { operationId: 'listUsers', responses: { 200: { description: 'ok' }, 404: { description: 'nope' } } } } },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
  }, null, 2)
  const jsonOut = lintOpenApi('api.json', jsonSpec)
  check('23.5 JSON spec 的 securitySchemes 被认出来', !has(jsonOut, 'openapi-security'), JSON.stringify(rules(jsonOut)))
  check('23.6 JSON spec 的 operationId 被认出来', !has(jsonOut, 'openapi-operationid'), JSON.stringify(rules(jsonOut)))
  check('23.7 JSON spec 的 responses 被认出来(不再误报缺 4xx)', !has(jsonOut, 'openapi-4xx'), JSON.stringify(rules(jsonOut)))

  // 动词式路径规则只扫 paths 段:描述 / 示例 / $ref 里的 /getXxx 不是路径,不许判 ERROR。
  const descOnly = [
    'openapi: 3.1.0', 'info:', '  title: t', '  version: "1"', 'servers:', '  - url: https://api.example.com',
    'paths:', '  /users:', '    get:', '      operationId: listUsers', '      description: 调用 /getUserById 拿单个用户',
    '      responses:', '        "200":', '          description: ok', '        "404":', '          description: nope',
  ].join('\n')
  check('23.8 描述里的 /getUserById 不再判 ERROR',
    !has(lintOpenApi('a.yaml', descOnly), 'openapi-verb-url'), JSON.stringify(rules(lintOpenApi('a.yaml', descOnly))))
  const verbInPaths = descOnly.replace('  /users:', '  /getUserById:')
  check('23.9 paths 段里真出现动词式路径仍然判 ERROR',
    has(lintOpenApi('a.yaml', verbInPaths), 'openapi-verb-url'), JSON.stringify(rules(lintOpenApi('a.yaml', verbInPaths))))
  const yamlRegion = pathsRegion('paths:\n  /a:\n    get: {}\ninfo:\n  title: t\n')
  check('23.10 pathsRegion 取 YAML 段(到下一个顶格键为止)',
    yamlRegion.indexOf('/a') !== -1 && yamlRegion.indexOf('title') === -1, JSON.stringify(yamlRegion))
  const jsonRegion = pathsRegion('{"paths":{"/a":{"get":{}}},"info":{"title":"t"}}')
  check('23.11 pathsRegion 取 JSON 段(花括号配对)',
    jsonRegion.indexOf('"/a"') !== -1 && jsonRegion.indexOf('"title"') === -1, JSON.stringify(jsonRegion))

  // proto 的 `enum X` 与 `{` 换行写是合法的
  const protoSplit = 'syntax = "proto3";\npackage a.b;\noption go_package = "x";\nenum Color\n{\n  RED = 0;\n}\nmessage M {\n  int32 a = 1;\n}\n'
  check('23.12 enum 换行花括号不再被判"字段号 0"',
    !has(lintProto('a.proto', protoSplit), 'proto-field-zero'), JSON.stringify(rules(lintProto('a.proto', protoSplit))))
  const protoBad = 'syntax = "proto3";\npackage a.b;\noption go_package = "x";\nmessage M {\n  int32 a = 0;\n}\n'
  check('23.13 消息里真出现字段号 0 仍然判 ERROR —— 不许把误报修成漏报',
    has(lintProto('a.proto', protoBad), 'proto-field-zero'), JSON.stringify(rules(lintProto('a.proto', protoBad))))

  // 反照抄要守两个方向,只看「本 spec 有多少行来自模板」一个方向会漏:
  //   ① 模板删到 30 行以下 → 直接跳过;② 照抄后再堆自有内容 → 比值被稀释到 0.85 以下。
  const refPath = fileURLToPath(new URL('./skills/api-architect/references/openapi-spec.yaml', import.meta.url))
  const refText = fs.readFileSync(refPath, 'utf8')
  check('23.14 整份照抄模板 → vendor-template ERROR(守判据本身)',
    has(templateDumpFindings('docs/api/openapi.yaml', refText), 'vendor-template'))
  const padded = refText + '\n' + Array.from({ length: 220 }, (_, i) => `# own note ${i}\n`).join('')
  const paddedFindings = templateDumpFindings('docs/api/openapi.yaml', padded)
  check('23.15 照抄模板后再堆大量自有内容仍判 ERROR(不许被稀释逃过校验)',
    has(paddedFindings, 'vendor-template'), JSON.stringify(paddedFindings.map((f) => f.rule)))
  const ownSpec = [
    'openapi: 3.1.0', 'info:', '  title: 工单平台 API', '  version: "2.3.0"', 'servers:', '  - url: https://tickets.example.com',
    'paths:', '  /tickets:', '    post:', '      operationId: createTicket', '      responses:', '        "201":', '          description: 建单成功',
  ].join('\n')
  check('23.16 正常项目 spec 不误杀',
    !has(templateDumpFindings('docs/api/openapi.yaml', ownSpec), 'vendor-template'),
    JSON.stringify(templateDumpFindings('docs/api/openapi.yaml', ownSpec).map((f) => f.rule)))
}

// ── 24. 状态机语义:死锁判定与拆环通知 ──────────────────────────────────
{
  // 只有「链走回 from」才是真死锁。把 seen 重入也判成环的话,第三方呼入一个不含自己的
  //     环也会被判成「你与 @X 互相等待」(不实),正文被扣进仲裁、中间节点被无声解绑。
  const c = new RelayCoordinator(5, 600000)
  c.waiting = { a: 'b', b: 'a' } // 盘上带来的环,不含 d
  check('24.1 第三方呼入一个**不含自己**的环 → 不判死锁', c.checkDeadlock('d', 'a') === false, String(c.checkDeadlock('d', 'a')))
  const c2 = new RelayCoordinator(5, 600000)
  c2.waiting = { x: 'y' }
  check('24.2 真互等(x 等 y,y 呼 x)仍判死锁', c2.checkDeadlock('y', 'x') === true)
  const c3 = new RelayCoordinator(5, 600000)
  c3.waiting = { m: 'n' } // 普通链,不成环
  check('24.3 普通等待链不误判死锁', c3.checkDeadlock('n', 'm') === true && c3.checkDeadlock('z', 'm') === false)

  // 拆环要**通知被解绑的中间节点**,不许只通知发起方、其余无声解绑
  const c4 = new RelayCoordinator(5, 600000)
  c4.waiting = { a: 'b', b: 'c' } // c→a 时成环:a→b→c→a
  const sent = []
  const wb = (role, text) => { sent.push({ role, text }); return true }
  const r = c4.tryRelay('c', 'a', '这次互呼的正文', 'proj', wb)
  check('24.4 三节点环判死锁并拆干净', r.status === 'deadlock' && JSON.stringify(c4.waiting) === '{}', `${r.status} ${JSON.stringify(c4.waiting)}`)
  check('24.5 被解绑的中间节点收到通知',
    sent.some((s) => s.role === 'a' && s.text.indexOf('已被释放') !== -1)
    && sent.some((s) => s.role === 'b' && s.text.indexOf('已被释放') !== -1),
    JSON.stringify(sent.map((s) => s.role)))
  check('24.6 通知里不含正文(正文进仲裁队列)', !sent.some((s) => s.text.indexOf('这次互呼的正文') !== -1), JSON.stringify(sent))
  check('24.7 拆环结果进了回执与台账口径', Array.isArray(r.deadlockCleared) && r.deadlockCleared.length === 2
    && Array.isArray(r.deadlockNotified) && r.deadlockNotified.length === 2
    && String(r.ledger.note).indexOf('已通知 2 个中间节点') !== -1, JSON.stringify(r.ledger.note))
}

// ── 25. 契约确认人反查 ──────────────────────────────────────────────
{
  // 确认人写成「@arch + @qa(只读复核)」时,若**没向 @qa 发起过该笔复核**,台账不能原样
  // 写成已确认 —— 那样事后无法分辨「计划中的确认人」与「已完成的确认人」。
  const roles = ['pm', 'arch', 'be', 'fe', 'qa']
  const rev = verifyConfirmers('@arch + @qa(只读复核)', {
    roles, ledger: [{ from: 'pm', to: 'arch', summary: '请评审契约' }], roleAgents: { arch: 'a-1' }, waiting: {},
  })
  check('25.1 查不到参与证据的确认人落到 unverified',
    rev.unverified.length === 1 && rev.unverified[0].role === 'qa' && rev.verified.length === 1 && rev.verified[0].role === 'arch',
    JSON.stringify(rev))
  check('25.2 有绑定会话的角色算已验证(派过会话就是参与过)', rev.verified[0].why === '已派会话', JSON.stringify(rev.verified))

  // 台账里有互呼记录也算(不要求当时还活着)
  const revLedger = verifyConfirmers('@qa', { roles, ledger: [{ from: 'qa', to: 'pm', summary: '复核结论' }], roleAgents: {}, waiting: {} })
  check('25.3 台账里有与它的互呼记录即算已验证(绑定会话早没了也一样)',
    revLedger.unverified.length === 0 && revLedger.verified[0].why === '有互呼/投递记录', JSON.stringify(revLedger))

  // 明说"还没确认"的写法不反查 —— 反查是为了抓"冒充已完成",不是为了禁止写计划
  const revPlan = verifyConfirmers('计划:@arch + @qa', { roles, ledger: [], roleAgents: {}, waiting: {} })
  check('25.4 "计划/待确认"写法不反查(不许把它做成"永远报警")',
    revPlan.planned === true && revPlan.unverified.length === 0, JSON.stringify(revPlan))

  // 没写 @ 前缀时的退化认词
  const revPlain = verifyConfirmers('确认人:arch 与 qa', { roles, ledger: [{ from: 'arch', to: 'pm' }], roleAgents: {}, waiting: {} })
  check('25.5 没写 @ 前缀也能认出角色 id(有人写"确认人:架构师 + 质检员")',
    revPlain.mentioned.indexOf('qa') !== -1 && revPlain.unverified.length === 1 && revPlain.unverified[0].role === 'qa', JSON.stringify(revPlain))

  // 台账行必须**就地标注** —— 只写在回执里,后来人翻台账还是看不出这一栏是自证的
  const doc = buildDocument(null, {
    contractRevision: { content: 'REV-0006 订单表加 pay_no', affected: 'be/fe', confirmedBy: '@arch + @qa(只读复核)', verification: rev },
    header: { coordinator: 'pm' },
  })
  const logLine = readSection(doc, '契约修订台账')
  check('25.6 台账行标注 ⚠️ 未验证 并写明原因',
    logLine.indexOf('⚠️ 未验证:@qa') !== -1 && logLine.indexOf('没有与它的互呼') !== -1, logLine)
  check('25.7 已验证的确认人不加 ⚠️ 噪音(反面守卫)',
    logLine.indexOf('⚠️ 未验证:@arch') === -1, logLine)

  const docOk = buildDocument(null, {
    contractRevision: { content: 'REV-0007', affected: 'be', confirmedBy: '@arch', verification: verifyConfirmers('@arch', { roles, ledger: [], roleAgents: { arch: 'a-1' }, waiting: {} }) },
    header: { coordinator: 'pm' },
  })
  check('25.8 全部有证据时台账行不含 ⚠️(不许把反查做成"人人可疑")',
    readSection(docOk, '契约修订台账').indexOf('⚠️') === -1, readSection(docOk, '契约修订台账'))
}

// ── 26. 版本自证的「读不出来」必须可见 ──────────────────────────────────
{
  // 文件在、内容坏了时,版本自证不能**静默失效**(mismatch 恒 false、status 一行不报):
  // 这一层正是给「磁盘新、内存旧」兜底的 —— 所以解析失败必须如实报出来。
  const ok = parsePackageVersion('{"name":"x","version":"1.4.8"}')
  check('26.1 正常 package.json 解析出真实版本', ok.version === '1.4.8' && ok.error === '', JSON.stringify(ok))
  const broken = parsePackageVersion('{"name":"x","version":"1.4.8","description":"含 \" 未转义引号}')
  check('26.2 JSON 坏掉 → 明确报"解析失败"(不许静默降级)',
    broken.version === '' && broken.error.indexOf('解析失败') !== -1, JSON.stringify(broken))
  check('26.3 没有 version 字段也如实说(不许当成"没有这个文件")',
    parsePackageVersion('{"name":"x"}').error.indexOf('没有 version 字段') !== -1, JSON.stringify(parsePackageVersion('{"name":"x"}')))
  check('26.4 空串/非对象不抛异常(读不到文件时由调用方决定沉默)',
    parsePackageVersion('').error !== '' && parsePackageVersion('[]').error !== '', JSON.stringify(parsePackageVersion('[]')))
}

// ── 27. 状态文档写入(围栏 / 多命中 / 待办计数 / BOM)──────────────────────
{
  const docFence = ['# 流程状态', '', '## 示例', '```md', '## 待办', '- [ ] 这是示例里的假待办', '```', '', '## 待办', '- [x] 真的那条'].join('\n')
  const outFence = replaceSection(docFence, '待办', '- [ ] 真待办')
  check('27.1 围栏代码块里的同名小节必须原样保留(不许改写它、连围栏收尾一起删)',
    outFence.indexOf('```md\n## 待办\n- [ ] 这是示例里的假待办\n```') !== -1
    && outFence.indexOf('- [ ] 真待办') !== -1, JSON.stringify(outFence))
  check('27.2 多命中取最后一处(真小节通常在后),被替换的是真小节',
    outFence.indexOf('- [x] 真的那条') === -1 && readSection(outFence, '待办') === '- [ ] 真待办',
    readSection(outFence, '待办'))

  const docSpace = ['# 流程状态', '', '##  待办', '- [ ] 旧的那条'].join('\n')
  const outSpace = replaceSection(docSpace, '待办', '- [ ] 新的那条')
  check('27.3 `##  待办`(多空格)必须被认出来,不得追加第二段、两段并存',
    (outSpace.match(/##\s+待办/g) || []).length === 1 && outSpace.indexOf('- [ ] 旧的那条') === -1,
    JSON.stringify(outSpace))

  const docBom = '\uFEFF# 流程状态\n\n## 待办\n- [ ] a'
  const outBom = buildDocument(docBom, { projectName: '演示项目', todos: ['第一项'] })
  check('27.4 带 BOM 的首行也要能替换成「# 流程状态:项目名」(不许静默失效)',
    outBom.split('\n')[0].indexOf('演示项目') !== -1 && outBom.indexOf('\uFEFF') === -1,
    JSON.stringify(outBom.split('\n')[0]))

  check('27.5 缩进 / `*` / `+` / 有序列表的未完成待办都要计数(不许只认行首 `- [ ]`)',
    countOpenTodos(['- [ ] a', '  - [ ] b', '* [ ] c', '+ [ ] d', '1. [ ] e', '  - [x] f', '普通文字'].join('\n')) === 5,
    String(countOpenTodos(['- [ ] a', '  - [ ] b', '* [ ] c', '+ [ ] d', '1. [ ] e'].join('\n'))))
}

// ── 28. 确认人反查的「没有确认人可核」 ──────────────────────────────
{
  // 只回 {planned, mentioned, verified, unverified} 时,confirmedBy 为空会让 unverified 也是空数组
  // → 调用处只看「没查到没证据的人」就落进最正面那句「确认人参与度已核对」——
  // 一次**根本没人可核**的登记被写成了「核对过了」。所以要有一格专门的标记。
  const confRoles = ['pm', 'arch', 'be', 'fe', 'qa']
  const none = verifyConfirmers('', { roles: confRoles, ledger: [], roleAgents: {}, waiting: {} })
  check('28.1 confirmedBy 为空必须带 empty 标记(缺这一格 → 调用处读成"已核对")',
    none.empty === true && none.unverified.length === 0 && none.mentioned.length === 0 && none.planned === false,
    JSON.stringify(none))
  const some = verifyConfirmers('@arch', { roles: confRoles, ledger: [], roleAgents: { arch: 'a-1' }, waiting: {} })
  check('28.2 反面:真有人可核时 empty 必须是 false(不许把"没人可核"与"核对通过"混成同一格)',
    some.empty === false && some.verified.length === 1 && some.unverified.length === 0,
    JSON.stringify(some))
}

// ── 29. 反照抄的结构比对(数据层:叶子值 / 键路径 / 模板特征串)──────────────
{
  // 只按「本 spec 的有效行 ∩ 参考件的有效行」判归属会漏:YAML 与 JSON 是**同一份数据**的
  // 两种写法 —— 把 `references/openapi-spec.yaml` 序列化成 `openapi.json`,
  // `openapi: 3.1.0` 变成 `"openapi": "3.1.0"`、`- url: …` 变成 `"url": "…"`,逐行**零重合**。
  // 所以要在**数据层比**(叶子值集合 + 键路径集合 + 模板特征串),命中即报**独立 rule**
  // `vendor-template-format`(与行判据 `vendor-template` 分开,排障能一眼区分)。
  const rules29 = (arr) => arr.map((f) => f.rule)
  const has29 = (arr, rule) => rules29(arr).indexOf(rule) !== -1
  const refPath29 = fileURLToPath(new URL('./skills/api-architect/references/openapi-spec.yaml', import.meta.url))
  const refText29 = fs.readFileSync(refPath29, 'utf8')
  // 参考件的等价 JSON 重建(YAML→JSON 的最小同构转换:结构、键、值、模型名逐条保留)
  const refJson29 = JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'User Service API', version: '1.0.0', description: 'Manages user accounts and profiles' },
    servers: [{ url: 'https://api.example.com/v1', description: 'Production' }],
    paths: {
      '/users': {
        get: {
          operationId: 'listUsers',
          summary: 'List all users',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/UserList' } } } },
          },
        },
        post: {
          operationId: 'createUser',
          summary: 'Create a new user',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateUserRequest' } } } },
          responses: {
            201: { description: 'Created', headers: { Location: { schema: { type: 'string' } } }, content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
            422: { description: 'Validation Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationError' } } } },
          },
        },
      },
      '/users/{userId}': {
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        get: {
          operationId: 'getUser',
          summary: 'Get user by ID',
          responses: {
            200: { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
            404: { description: 'Not Found' },
          },
        },
      },
    },
    components: {
      schemas: {
        User: { type: 'object', required: ['id', 'email', 'createdAt'], properties: { id: { type: 'string', format: 'uuid' }, email: { type: 'string', format: 'email' }, name: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } },
        CreateUserRequest: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' }, name: { type: 'string', minLength: 1, maxLength: 100 } } },
        UserList: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/User' } }, meta: { type: 'object', properties: { nextCursor: { type: 'string' }, hasMore: { type: 'boolean' } } } } },
        ValidationError: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string', enum: ['VALIDATION_ERROR'] }, message: { type: 'string' }, details: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, issue: { type: 'string' } } } } } } } },
      },
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    },
    security: [{ bearerAuth: [] }],
  }, null, 2)
  const compactJson29 = JSON.stringify(JSON.parse(refJson29))
  const dump29 = (rel, text) => templateDumpFindings(rel, text)
  const jsonOut29 = dump29('docs/api/openapi.json', refJson29)
  check('29.1 同一份模板改存成 JSON(缩进)→ 命中 vendor-template-format(逐行零重合,整条归属校验被"换个格式"绕过)',
    has29(jsonOut29, 'vendor-template-format'), JSON.stringify(rules29(jsonOut29)))
  const compactOut29 = dump29('docs/api/openapi.json', compactJson29)
  check('29.2 紧凑单行 JSON 同样命中(这时连"行"都不存在,行判据在这份文本上永远不可能生效)',
    has29(compactOut29, 'vendor-template-format'), JSON.stringify(rules29(compactOut29)))

  // 反向守卫:按项目自己改写的 JSON spec(标题/端点/模型名/字段全是自己的)一律不许报 ——
  // 判据要求 0.85 的**值**重合,且至少要 3 条"长且带 ASCII 大写"的模板特征串原样出现。
  const ownJson29 = JSON.stringify({
    openapi: '3.1.0',
    info: { title: '工单平台 API', version: '2.3.0', description: '内部工单系统的对外接口' },
    servers: [{ url: 'https://tickets.corp.example.cn/api' }],
    paths: {
      '/tickets': {
        get: {
          operationId: 'listTickets',
          summary: '列出工单',
          parameters: [{ name: 'pageSize', in: 'query', schema: { type: 'integer', default: 25 } }],
          responses: { 200: { description: '成功', content: { 'application/json': { schema: { $ref: '#/components/schemas/TicketPage' } } } } },
        },
        post: { operationId: 'createTicket', summary: '建单', responses: { 201: { description: '已创建' } } },
      },
      '/tickets/{ticketId}': {
        get: { operationId: 'getTicket', summary: '工单详情', responses: { 200: { description: '成功' }, 404: { description: '不存在' } } },
      },
    },
    components: {
      schemas: {
        Ticket: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, subject: { type: 'string' }, status: { type: 'string', enum: ['open', 'closed'] }, assignee: { type: 'string' } } },
        TicketPage: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Ticket' } }, total: { type: 'integer' } } },
      },
    },
  }, null, 2)
  const ownOut29 = dump29('docs/api/openapi.json', ownJson29)
  check('29.3 反向守卫:按项目改写的 JSON spec 不报(不许把"换个序列化格式"做成"见 JSON 就报")',
    !has29(ownOut29, 'vendor-template-format') && !has29(ownOut29, 'vendor-template'), JSON.stringify(rules29(ownOut29)))

  // 反向守卫的另一半:只改了少数值、标题/端点/模型名仍是模板原文的"半改写稿" —— 这正是要抓的
  // (相对口径:本 spec 的叶子值几乎全来自这一份参考件 + 模板特征串原样出现 ≥4 条)。
  const halfJson29 = JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'User Service API', version: '1.0.0', description: 'Manages user accounts and profiles' },
    servers: [{ url: 'https://api.example.com/v1', description: 'Production' }],
    paths: {
      '/users': {
        get: {
          operationId: 'listUsers', summary: 'List all users',
          responses: { 200: { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/UserList' } } } } },
        },
      },
    },
    components: { schemas: { UserList: { type: 'object', properties: { data: { type: 'array' } } } } },
    security: [{ bearerAuth: [] }],
  }, null, 2)
  const halfOut29 = dump29('docs/api/openapi.yaml', halfJson29)
  check('29.4 半改写稿(标题/端点/模型名还是模板原文,只填了少量自有值)→ 命中',
    has29(halfOut29, 'vendor-template-format'),
    `classify=${classifySpec('docs/api/openapi.yaml', halfJson29)} rules=${JSON.stringify(rules29(halfOut29))}`)

  // 回归:YAML 整份照抄走的是**旧的行判据**,不许因为加了结构比对就把它丢了(rule 名也不许变)
  const yamlOut29 = dump29('docs/api/openapi.yaml', refText29)
  check('29.5 回归:YAML 整份照抄仍走行判据 vendor-template(加结构比对不许把老判据换掉或改名)',
    has29(yamlOut29, 'vendor-template'), JSON.stringify(rules29(yamlOut29)))

  // 解析失败 = 这一层不生效并**退回行判据**,绝不许抛异常(带注释/半截的 spec 在现实里到处都是)
  let threw29 = ''
  let badJson29 = []
  try { badJson29 = dump29('docs/api/openapi.json', '{ "openapi": "3.1.0", ') } catch (e) { threw29 = String((e && e.message) || e) }
  check('29.6 坏 JSON 不抛异常,且这一层不生效(解析不出来 = 不报,不做"猜着报")',
    threw29 === '' && !has29(badJson29, 'vendor-template-format'), `${threw29 || '(未抛异常)'} ${JSON.stringify(rules29(badJson29))}`)
}

// ── 30. 末行多标记:全部取出 vs 主返回值的形状不变 ──────────────────────
{
  // 只认最后一条 `@relay` 会漏:一条回覆同时招呼两个人(如一段总结末尾写
  // `@relay:qa 请复测` 与 `@relay:arch 请评审`)时,前一条被**静默丢弃**,而回执与渲染
  // 照样写「标记 @arch: …」,写的人以为两个人都收到了 —— 漏掉的那个永远不会回话。
  // `extractRelayMarksAll` 把末行的**全部**标记取出来(顺序即出现顺序);主返回值
  // `extractRelayMarks` 的形状**逐字不许动**(1.1/1.4b/1.5/1.6 就是拿它逐字比的)。
  //
  // ⚠️ 走命名空间导入:缺这个符号的模块上具名导入会在**加载期**抛错、整文件崩。
  const marksAll30 = libmod.extractRelayMarksAll
  const two30 = '总结\n@relay:qa 请复测 @relay:arch 请评审'
  const all30 = typeof marksAll30 === 'function' ? marksAll30(two30) : null
  check('30.1 新增导出 extractRelayMarksAll 存在且是函数',
    typeof marksAll30 === 'function', typeof marksAll30)
  check('30.2 末行两条 @relay → 全部取出,顺序即出现顺序,正文各自切对',
    Array.isArray(all30) && all30.length === 2
    && `${all30[0].to}=${all30[0].msg}|${all30[1].to}=${all30[1].msg}` === 'qa=请复测|arch=请评审',
    JSON.stringify(all30))
  // ⚠️ 口径:末行**多标记**时主返回值只能取最后一条 —— 把行首那条与后面那条一起吞进正文
  //    会与回执「只转发了最后一条 @arch」自相矛盾。所以这一条断言的是**新契约**(主返回值 =
  //    extractRelayMarksAll 的最后一条 = 回执点名的那一条,三者一致);
  //    既有契约逐字不变的守卫是 1.1/1.4b/1.5/1.6 与下面的单标记 30.4。
  const last30 = extractRelayMarks(two30)
  check('30.3 末行两条时主返回值 = **最后一条**(与 extractRelayMarksAll 的最后一条、与回执"只转发了最后一条 @arch"三者一致)',
    JSON.stringify(last30) === JSON.stringify({ to: 'arch', msg: '请评审' }) && Object.keys(last30).join(',') === 'to,msg',
    JSON.stringify(last30))
  const one30 = typeof marksAll30 === 'function' ? marksAll30('结论\n@relay:be 表结构请确认') : null
  check('30.4 单标记时长度 1,且元素与主返回值是同一份内容(不许给单标记也塞个别扭形状害老调用方)',
    Array.isArray(one30) && one30.length === 1
    && JSON.stringify(one30[0]) === JSON.stringify(extractRelayMarks('结论\n@relay:be 表结构请确认')),
    JSON.stringify(one30))
  const crlf30 = typeof marksAll30 === 'function' ? marksAll30('总结\r\n@relay:qa 请复测 @relay:arch 请评审\r\n\r\n') : null
  check('30.5 CRLF + 尾部空行:仍只认最后一个非空行,两条照样全部取出(Windows 上的现实写法)',
    Array.isArray(crlf30) && crlf30.length === 2 && crlf30[1].to === 'arch', JSON.stringify(crlf30))

  // 既有口径不许被「多标记」这层碰坏:只在最后一个非空行找、只做语法校验
  const mid30 = typeof marksAll30 === 'function' ? marksAll30('@relay:be 问题\n后面还有内容') : 'no-entry'
  const empty30 = typeof marksAll30 === 'function' ? marksAll30('') : 'no-entry'
  const custom30 = typeof marksAll30 === 'function' ? marksAll30('x\n@relay:dba 表结构请确认') : null
  check('30.6 既有口径不许被碰坏:正文中间的标记仍不算、空文本仍返回 null、自定义档案的角色名仍被认',
    mid30 === null && empty30 === null && Array.isArray(custom30) && custom30.length === 1 && custom30[0].to === 'dba',
    `${JSON.stringify(mid30)}/${JSON.stringify(empty30)}/${JSON.stringify(custom30)}`)
}

// ── 31. 跳过覆盖面的三个纯函数(覆盖面 / 留痕 / 单条描述)──────────────────
{
  // 有候选被跳过时,回执上写「⚠️ 有 N 个候选被**跳过**」、下一行却写
  // 「结论:✅ PASS | ERROR 0 / WARN 0」—— 而那条结论只覆盖 M/(M+N) 个候选,
  // 读的人很容易当成"API 门槛已过"。判定必须跟着**覆盖面**走。
  //
  // 跳过留痕只列前 3 条(`slice(0,3) + '…'`,第 4 条起永久不可见),
  // 而且给的建议是「若契约明明在,请用 paths 精确指路」—— 这句对 oversize **是错的**:
  // ① `paths` 是**追加**(默认候选目录 ∪ paths),不是收窄;② size 守卫在 `push()` 里
  // 无条件生效,精确指到那个超限文件上它照样被跳过。
  //
  // 这一层由三个纯函数承担:`apiSkipCoverage`(结构化覆盖面)/ `apiSkipNote`(留痕全文,
  // 按 reason 分组、列全、给"能救/不能救"分支建议)/ `skipEntryText`(单条可读描述)。
  // 这里做**离线边界**断言;render 层的真实回执文本在 smoke 35/36 组。
  //
  // ⚠️ 走命名空间导入:缺这三个符号的模块上,具名导入会在**加载期**抛错、整文件崩
  // (见文件头的说明)。缺符号时这一组应当表现为一串**干净的失败**,而不是崩。
  const covOf = libmod.apiSkipCoverage
  const noteOf = libmod.apiSkipNote
  const entryOf = libmod.skipEntryText

  check('31.1 五个新导出都在(apiSkipCoverage / apiSkipNote / skipEntryText / apiSkipBreakdown / apiCoverageText)',
    typeof covOf === 'function' && typeof noteOf === 'function' && typeof entryOf === 'function'
    && typeof libmod.apiSkipBreakdown === 'function' && typeof libmod.apiCoverageText === 'function',
    `${typeof covOf}/${typeof noteOf}/${typeof entryOf}/${typeof libmod.apiSkipBreakdown}/${typeof libmod.apiCoverageText}`)

  // ⚠️ 31.2/31.8/31.9 钉的是口径 v2:跳过计数按「**处**」算,
  //    并且**嵌套的 depth 只算一处**(理由与取舍见 lib/feature.js 的 apiSkipCoverage 注释)。
  //    本组夹具故意保留一对嵌套 depth(api/nested/a 覆盖 api/nested/a/b):按条数会算 2,
  //    按「处」只算 1 —— 折叠行为本身在 31.13/31.14 单独钉住。
  const skip31 = [
    { rel: 'api/big.yaml', reason: 'oversize', size: 2831155, limit: 524288 },
    { rel: 'api/nested/a', reason: 'depth', limit: 2 },
    { rel: 'api/nested/a/b', reason: 'depth', limit: 2 },
    { rel: 'api/secret.yaml', reason: 'unreadable', error: 'EACCES' },
    { rel: 'api/weird.bin', reason: 'binary' },
  ]
  const cov31 = typeof covOf === 'function' ? covOf(skip31, 3) : null
  check('31.2 apiSkipCoverage:covered/skipped/total 三者自洽;files/regions 分开报、相加等于 skipped;reasons 四类如实(oversize 1 / depth 1【嵌套已折叠】/ unreadable 1 / other 1)',
    !!cov31 && cov31.covered === 3 && cov31.skipped === 4 && cov31.total === 7
    && cov31.files === 3 && cov31.regions === 1 && cov31.exactTotal === false
    && cov31.reasons.oversize === 1 && cov31.reasons.depth === 1 && cov31.reasons.unreadable === 1 && cov31.reasons.other === 1
    && cov31.reasons.oversize + cov31.reasons.depth + cov31.reasons.unreadable + cov31.reasons.other === cov31.skipped
    && cov31.total === cov31.covered + cov31.skipped
    && cov31.files + cov31.regions === cov31.skipped,
    JSON.stringify(cov31))

  // 形状与归一:上层的 walk 可能给出缺字段的条目(`depth` 没有 size/error、非对象元素
  // 来自"以后有人往里塞了别的东西")—— 归一在这里一次做掉,渲染层就不必到处判空。
  const covBad31 = typeof covOf === 'function' ? covOf([{ rel: 42, reason: '' }, null, 'x', { rel: 'api/only-reason.yaml', reason: 'oversize' }], 0) : null
  check('31.3 entries 形状与归一:五键齐全(rel/reason/size/limit/error),缺的归一为 null,rel 转字符串、reason 缺省记 other,非对象条目被丢弃',
    !!covBad31 && covBad31.entries.length === 2
    && Object.keys(covBad31.entries[0]).join(',') === 'rel,reason,size,limit,error'
    && covBad31.entries[0].rel === '42' && covBad31.entries[0].reason === 'other'
    && covBad31.entries[0].size === null && covBad31.entries[0].limit === null && covBad31.entries[0].error === null
    && covBad31.entries[1].rel === 'api/only-reason.yaml' && covBad31.entries[1].reason === 'oversize'
    && covBad31.skipped === 2,
    JSON.stringify(covBad31))

  // 去重口径:`paths` 与默认候选目录**重叠**时(默认已扫 `api/`,
  // 又传 paths:["api"]),同一个候选会被 walk 两遍 —— 把同一个 rel|reason 记两次会把分母撑大、
  // 把覆盖面说小(实际 2 个候选被跳过会报成 4 个 → 只覆盖 1/5)。
  const dup31 = typeof covOf === 'function' ? covOf([
    { rel: 'api/x.yaml', reason: 'oversize', size: 600 * 1024, limit: 512 * 1024 },
    { rel: 'api/x.yaml', reason: 'oversize', size: 600 * 1024, limit: 512 * 1024 },
    { rel: 'api/x.yaml', reason: 'depth', limit: 2 },
  ], 1) : null
  check('31.4 去重:同一个 rel|reason 被走两遍不许把分母撑大(按 rel|reason 保留首次出现;同一个文件因**不同**原因被跳过仍算两条)',
    !!dup31 && dup31.skipped === 2 && dup31.total === 3 && dup31.entries.length === 2
    && dup31.reasons.oversize === 1 && dup31.reasons.depth === 1,
    JSON.stringify(dup31))

  const e31 = (o) => (typeof entryOf === 'function' ? entryOf(o) : 'no-entry')
  const fmts31 = [
    e31({ rel: 'api/a.yaml', reason: 'oversize', size: 614400, limit: 524288 }),
    e31({ rel: 'api/b.yaml', reason: 'oversize', size: 2831155, limit: 524288 }),
    e31({ rel: 'api/c.yaml', reason: 'oversize', size: 1024, limit: 524288 }),
    e31({ rel: 'api/d.yaml', reason: 'oversize', size: 10240, limit: 524288 }),
    e31({ rel: 'api/e.yaml', reason: 'oversize', size: 0, limit: 524288 }),
    e31({ rel: 'api/f.yaml', reason: 'oversize', limit: 524288 }),
  ]
  check('31.5 skipEntryText(oversize):写成"多大 > 多大上限",字节数按 B/KB/MB 三档可读(边界:1024 → 1.0 KB、10240 → 10 KB、缺 size → 0 B 而不是 NaN/undefined)',
    fmts31[0] === 'api/a.yaml(600 KB > 512 KB)'
    && fmts31[1] === 'api/b.yaml(2.7 MB > 512 KB)'
    && fmts31[2] === 'api/c.yaml(1.0 KB > 512 KB)'
    && fmts31[3] === 'api/d.yaml(10 KB > 512 KB)'
    && fmts31[4] === 'api/e.yaml(0 B > 512 KB)'
    && fmts31[5] === 'api/f.yaml(0 B > 512 KB)',
    fmts31.join(' | '))

  const shapes31 = [
    e31({ rel: 'api/nested/a', reason: 'depth', limit: 2 }),
    e31({ rel: 'api/nested/a/b', reason: 'depth' }),
    e31({ rel: 'api/s.yaml', reason: 'unreadable', error: 'EACCES' }),
    e31({ rel: 'api/s.yaml', reason: 'unreadable' }),
    e31({ rel: 'api/w.bin', reason: 'binary' }),
  ]
  check('31.6 skipEntryText(depth / unreadable / other)三种形状:深度带上限(缺 limit 回落到默认 2)、读失败带错误码(没有就不编)、其它原因原样入括号',
    shapes31[0] === 'api/nested/a(深度 > 2)'
    && shapes31[1] === 'api/nested/a/b(深度 > 2)'
    && shapes31[2] === 'api/s.yaml(读失败:EACCES)'
    && shapes31[3] === 'api/s.yaml(读失败)'
    && shapes31[4] === 'api/w.bin(binary)',
    shapes31.join(' | '))

  const noteNone31 = typeof noteOf === 'function' ? noteOf(null) : 'no-entry'
  const noteEmpty31 = typeof noteOf === 'function' ? noteOf(typeof covOf === 'function' ? covOf([], 3) : null, 3) : 'no-entry'
  check('31.7 apiSkipNote 零跳过 → 空串(边界:一条都没跳过时不许印一行空话;"传 null"与"空数组"都得是空串)',
    noteNone31 === '' && noteEmpty31 === '', `${JSON.stringify(noteNone31)}/${JSON.stringify(noteEmpty31)}`)

  const note31 = typeof noteOf === 'function' ? String(noteOf(cov31)) : ''
  const lines31 = note31.split('\n')
  const sum31 = lines31[0] || ''
  check('31.8 总述行(口径 v2):跳过按**处**报、构成拆成"几个文件 + 几棵子树",而且**不给分数**(分母里有未知数) —— 只读这一行就该知道这条结论只覆盖一部分候选',
    sum31.indexOf('跳过 4 处(3 个文件 + 1 棵未展开的子树)') !== -1
    && sum31.indexOf('只覆盖 3 个已扫到的候选') !== -1
    && sum31.indexOf('子树内容未知') !== -1
    && sum31.indexOf('不算完整通过') !== -1
    && sum31.indexOf('/7') === -1 && sum31.indexOf('%') === -1,
    sum31 || '(没有总述行)')

  const grp31 = (kw) => lines31.filter((l) => l.indexOf(kw) !== -1)[0] || ''
  const oversize31 = grp31('(oversize)')
  const depth31 = grp31('(depth)')
  check('31.9 分组多行 + 建议按 reason 分支:oversize 组明说"paths 精确指路对它无效"、depth 组明说"精确指到文件可以补进结论";这句错建议「若契约明明在…」不许再出现',
    oversize31.indexOf(': 1 个') !== -1 && oversize31.indexOf('**paths 精确指路对它无效**') !== -1
    && depth31.indexOf(': 1 棵') !== -1 && depth31.indexOf('**用 paths 精确指到"文件"可以把它补进结论**') !== -1
    && depth31.indexOf('不是收窄') !== -1
    && note31.indexOf('api/big.yaml(2.7 MB > 512 KB)') !== -1
    && note31.indexOf('api/nested/a/b(深度 > 2)') !== -1
    && note31.indexOf('若契约明明在') === -1,
    `${oversize31.slice(0, 60)} || ${depth31.slice(0, 60)}`)

  // 反面守卫:只出现**真的存在**的那些组。否则就是"永远给四类建议"的噪音。
  const onlyOver31 = typeof covOf === 'function' ? covOf([{ rel: 'api/only.yaml', reason: 'oversize', size: 600 * 1024, limit: 512 * 1024 }], 2) : null
  const noteOnly31 = typeof noteOf === 'function' ? String(noteOf(onlyOver31)) : ''
  check('31.10 反面:只跳过 oversize 时,不许出现 depth / unreadable / other 的组头(组按数据里真有的 reason 打,不做"永远报警")',
    noteOnly31.indexOf('(oversize)') !== -1
    && noteOnly31.indexOf('(depth)') === -1
    && noteOnly31.indexOf('读取失败(unreadable)') === -1
    && noteOnly31.indexOf('其它原因(other)') === -1,
    noteOnly31.split('\n').join(' | ').slice(0, 160))

  const many31 = typeof covOf === 'function'
    ? covOf(Array.from({ length: 7 }, (_, i) => ({ rel: `api/cap${i + 1}.yaml`, reason: 'oversize', size: 600 * 1024, limit: 512 * 1024 })), 1)
    : null
  const noteCap31 = typeof noteOf === 'function' ? String(noteOf(many31, 2)) : ''
  const capEntries31 = noteCap31.split('\n').filter((l) => l.indexOf('      - ') === 0)
  check('31.11 perGroupMax 生效:每组最多列 N 条,超出的如实报「另有 N 个同类条目」(不静默消失、也不无限刷屏)',
    capEntries31.length === 3
    && capEntries31[0].indexOf('api/cap1.yaml') !== -1 && capEntries31[1].indexOf('api/cap2.yaml') !== -1
    && capEntries31[2].indexOf('另有 5 个同类条目') !== -1
    && noteCap31.indexOf('api/cap3.yaml') === -1,
    capEntries31.join(' | '))

  const noteDef31 = typeof noteOf === 'function' ? String(noteOf(many31)) : ''
  check('31.12 默认每组上限 6 与边界:7 条同类列 6 条 + 「另有 1 个」;perGroupMax 传 0 / 负数回落到默认 6(不许读成"一条都不列");数据面 entries 仍是全量 7 条',
    noteDef31.indexOf('api/cap6.yaml') !== -1 && noteDef31.indexOf('api/cap7.yaml') === -1
    && noteDef31.indexOf('另有 1 个同类条目') !== -1
    && !!many31 && many31.entries.length === 7
    && String(noteOf(many31, 0)) === noteDef31
    && String(noteOf(many31, -3)) === noteDef31,
    `默认=${noteDef31.split('\n').filter((l) => l.indexOf('      - ') === 0).length} 条条目 / entries=${many31 ? many31.entries.length : 'n/a'}`)

  // ── 口径 v2:跳过计数按「**处**」算,嵌套的 depth 只算一处 ──────────────────
  // 同一片未展开的深子树会被**祖先目录**(从项目根起的 walk:它在根下已是第 3 层)与
  // **自身目录**(从 `api` 起的 walk:从这里数才是第 3 层)各记一次 —— 回执说「跳过 3」,
  // 而**真实未扫到的候选是 2 个**。判定方向保守(只会更严、不会假通过),但计数错在两处:
  //   ① 同一片区域被算两次;
  //   ② 反过来,把「1 棵子树」当「1 个候选」塞进分母又是**高估**(一棵装着 50 份契约的子树算 1 个)。
  // 口径:折叠嵌套(留最深)+ 计数单位明确成「处」(文件 / 未展开子树),并且**只有分母精确时
  // 才给分数**(`exactTotal`)—— 见 lib/feature.js 的 apiSkipCoverage / apiCoverageText。
  const covR24 = (list, covered) => (typeof covOf === 'function' ? covOf(list, covered) : null)

  // ① 折叠:祖先那条被折掉,留下**最深**的那条(它才是"要补进结论该指哪儿")
  const nest24 = covR24([
    { rel: 'api/nested/a', reason: 'depth', limit: 2 },
    { rel: 'api/nested/a/b', reason: 'depth', limit: 2 },
  ], 1)
  check('31.13 口径 v2 折叠:同一条链上的嵌套 depth **只算一处**,且留下的是最深的那条 rel(祖先那条是过近似 —— 基址更深的 walk 已经把它上层的文件扫过了)',
    !!nest24 && nest24.skipped === 1 && nest24.regions === 1 && nest24.total === 2
    && nest24.entries.length === 1 && nest24.entries[0].rel === 'api/nested/a/b',
    JSON.stringify(nest24))

  // ② 兄弟子树**不许**被误折(互不为祖先 = 各自都是没被展开的地方)
  const sib24 = covR24([
    { rel: 'api/nested/a', reason: 'depth', limit: 2 },
    { rel: 'api/nested/a/b', reason: 'depth', limit: 2 },
    { rel: 'api/nested/a/d', reason: 'depth', limit: 2 },
  ], 1)
  check('31.14 口径 v2 反面(锚):**兄弟**子树各自保号 —— 只折祖先、不折兄弟',
    !!sib24 && sib24.skipped === 2 && sib24.regions === 2
    && sib24.entries.map((e) => e.rel).join(',') === 'api/nested/a/b,api/nested/a/d',
    JSON.stringify(sib24))

  // ③ exactTotal:只有"文件级"跳过时,分母才是精确候选数 —— 分数只在这种情况下有意义
  const onlyOver24 = covR24([{ rel: 'api/big.yaml', reason: 'oversize', size: 600 * 1024, limit: 512 * 1024 }], 1)
  check('31.15 exactTotal 口径:只有文件级跳过(oversize/unreadable)→ exactTotal=true、total 是精确候选数;只要有一棵子树 → false(分母里有未知数)',
    !!onlyOver24 && onlyOver24.exactTotal === true && onlyOver24.regions === 0 && onlyOver24.files === 1 && onlyOver24.total === 2
    && !!nest24 && nest24.exactTotal === false && nest24.files === 0,
    `onlyOver=${JSON.stringify(onlyOver24)} nest=${JSON.stringify(nest24)}`)

  // ④ 覆盖面文本(全文件唯一出处):精确时给分数,有子树时**不给**
  const txtOf = libmod.apiCoverageText
  const t24 = [
    typeof txtOf === 'function' && onlyOver24 ? txtOf(onlyOver24) : 'no-text',
    typeof txtOf === 'function' && nest24 ? txtOf(nest24) : 'no-text',
    typeof txtOf === 'function' && nest24 ? txtOf(nest24, true) : 'no-text',
  ]
  check('31.16 apiCoverageText:全是文件跳过 → 精确分数「1/2 个候选(50%)」;有子树 → 不给分数,改说"已扫到的 M 个候选 + 另有 S 处未扫到,子树内容未知";短写法给面板用',
    t24[0] === '1/2 个候选(50%)'
    && t24[1] === '1 个已扫到的候选(另有 1 处未扫到,子树内容未知)'
    && t24[2] === '1 个候选,跳过 1 处',
    t24.join(' | '))

  // ⑤ 构成短句
  const bdOf = libmod.apiSkipBreakdown
  const bd24 = typeof bdOf === 'function'
    ? [bdOf(cov31), bdOf(nest24), bdOf(onlyOver24)]
    : ['no', 'no', 'no']
  check('31.17 apiSkipBreakdown:如实拼"几个文件 + 几棵子树"(只有一类时不带 0 的那半边,不留"+ 0 个"这种废话)',
    bd24[0] === '3 个文件 + 1 棵未展开的子树' && bd24[1] === '1 棵未展开的子树' && bd24[2] === '1 个文件',
    bd24.join(' | '))

  // ⑥ 归一:同一个目录的三种写法算一条(`paths` 与默认候选目录重叠时同一目标被 walk 两遍)
  const norm24 = covR24([
    { rel: 'api\\nested\\a', reason: 'depth', limit: 2 },
    { rel: './api/nested/a', reason: 'depth', limit: 2 },
    { rel: 'api/nested/a/', reason: 'depth', limit: 2 },
  ], 1)
  check('31.18 归一去重:同一个目录的三种写法(反斜杠 / `./` 前缀 / 结尾斜杠)算**一条**,保留首次出现的那个 rel 原样输出',
    !!norm24 && norm24.skipped === 1 && norm24.entries.length === 1 && norm24.entries[0].rel === 'api\\nested\\a',
    JSON.stringify(norm24))

  // ⑦ 老记录兼容:早先落盘的 slot.apiLint.coverage 没有 exactTotal/regions
  const legacy24 = typeof txtOf === 'function' ? txtOf({ covered: 1, skipped: 2, total: 3 }) : 'no-text'
  check('31.19 老记录兼容:早先写进 slot.apiLint.coverage 的记录没有 exactTotal/regions → 按老写法渲染「1/3」,不拿新口径改写历史结论,也不假装它是新口径算出来的',
    legacy24 === '1/3', legacy24)

  check('31.20 depth 组的单位是"棵"而不是"个":一棵未展开的子树里面有几个候选是未知数 —— 说成"N 个"就是把未知数说成了已知数',
    depth31.indexOf(': 1 棵 ——') !== -1,
    depth31.slice(0, 80) || '(没有 depth 组)')
}

// ── 32. 跳过记录的计数 / 明细分离 ────────────────────────────────────
{
  // 明细数组被封顶时,`found.skipped` 卡在 20 条 → 回执说「跳过 19 处」(真实 25 处),
  // 而留痕那句「…另有 N 个同类条目(**数据面字段 scanSkipped 里有全量**)」
  // 指向的正是这条**已截断**的数组 —— 照着它去翻 payload 只会看到同样那 20 条,于是合理地
  // 得出「总数就是 20」。数字与指引**同时**不可靠,等于给了一条做不到的建议。
  //
  // 口径:计数不封顶(`skippedTotal`,挂 `found` 与明细数组两处)+ 明细封顶(前 20 条);
  // 有差额 ⇒ `truncated=true`、`exactTotal=false`、所有计数经 `apiSkipCountText` 加 `≥`,
  // 并当场说清「明细就是明细,不是全量」。本组只钉**纯函数**那一半;端到端那一半在 smoke 39。
  const covOf = libmod.apiSkipCoverage
  const noteOf = libmod.apiSkipNote
  const txtOf = libmod.apiCoverageText
  const cntOf = libmod.apiSkipCountText

  check('32.1 新导出 apiSkipCountText 在(跳过计数的**唯一**出口 —— 总述行/扫描行/降级行/note/上次 lint 行/两处面板共六处都经它,改口径才不会再漏掉一两处)',
    typeof cntOf === 'function', typeof cntOf)

  // 夹具形状:明细 20 条(封顶)+ 计数 51 条(25 个深目录被 "." 与 "api" 两处基址各走一遍,
  // 再加祖先那条)—— 计数远大于明细,正是"数不全"的地方。
  const list32 = Array.from({ length: 20 }, (_, i) => ({ rel: `api/nested/a/d${String(i + 1).padStart(2, '0')}`, reason: 'depth', limit: 2 }))
  const cut32 = typeof covOf === 'function' ? covOf(list32, 1, 51) : null
  check('32.2 计数与明细分离:明细 20 条 + 计数 51 → skippedTotal=51 / detailCount=20 / missingDetail=31 / truncated=true',
    !!cut32 && cut32.skippedTotal === 51 && cut32.detailCount === 20 && cut32.missingDetail === 31
    && cut32.truncated === true && cut32.skipped === 20 && cut32.total === 21 && cut32.detailMax === 20,
    JSON.stringify(cut32))

  const onlyOver32 = typeof covOf === 'function' ? covOf([{ rel: 'api/big.yaml', reason: 'oversize', size: 600 * 1024, limit: 512 * 1024 }], 1, 9) : null
  check('32.3 截断时 exactTotal 必为 false —— **即使 regions===0**(分母里少了那 8 条没有明细的,分数就没有根据);宁可说"已扫到的 M 个候选",也不给一个人造分母',
    !!onlyOver32 && onlyOver32.regions === 0 && onlyOver32.truncated === true && onlyOver32.exactTotal === false,
    JSON.stringify(onlyOver32))

  check('32.4 apiSkipCountText:未截断时逐字是数字(与面板一致)、截断时加 `≥`(这个数只是**下界**:没明细的那几条可能是文件、也可能整棵子树);传 null 也不许崩',
    !!cntOf && cntOf(onlyOver32) === '≥1' && cntOf(typeof covOf === 'function' ? covOf(list32, 1, 20) : null) === '20' && cntOf(null) === '0',
    `${cntOf && cntOf(onlyOver32)} / ${cntOf && cntOf(covOf(list32, 1, 20))} / ${cntOf && cntOf(null)}`)

  // 老签名兼容:计数只挂在 `found` 上时,`apiSkipCoverage(found.skipped, found.length)`
  // 这种老调用照样会数出被截断的 20 —— 「老调用方一行不用改」只对形状成立、对数字不成立。
  // 所以计数同时挂在明细数组自己身上。
  const arr32 = list32.slice()
  arr32.skippedTotal = 51
  const auto32 = typeof covOf === 'function' ? covOf(arr32, 1) : null
  const noAuto32 = typeof covOf === 'function' ? covOf(list32.slice(), 1) : null
  check('32.5 老签名兼容(只传两个参数):数组自带 skippedTotal 时自动说真话(51/truncated);数组上没有这个字段时行为与既有口径**逐字一致**(回落到明细条数、不冒充截断)',
    !!auto32 && auto32.skippedTotal === 51 && auto32.truncated === true && auto32.missingDetail === 31
    && !!noAuto32 && noAuto32.skippedTotal === 20 && noAuto32.truncated === false && noAuto32.missingDetail === 0,
    `${JSON.stringify(auto32 && { skippedTotal: auto32.skippedTotal, truncated: auto32.truncated })} | ${JSON.stringify(noAuto32 && { skippedTotal: noAuto32.skippedTotal, truncated: noAuto32.truncated })}`)

  // 反面锚:没有截断的普通场景(1 oversize + 1 棵子树)必须与既有口径**逐字一致** ——
  // 只许改"被截断"这一类,不许顺手改掉已经有证据支撑的措辞。
  const plain32 = typeof covOf === 'function'
    ? covOf([
      { rel: 'api/big1.yaml', reason: 'oversize', size: 600 * 1024, limit: 512 * 1024 },
      { rel: 'api/nested/a', reason: 'depth', limit: 2 },
      { rel: 'api/nested/a/b', reason: 'depth', limit: 2 },
    ], 1, 3)
    : null
  const plainHead32 = typeof noteOf === 'function' ? String(noteOf(plain32)).split('\n')[0] : ''
  check('32.6 反面(锚):未截断时总述行与覆盖面**逐字同既有口径**(「跳过 2 处(1 个文件 + 1 棵未展开的子树)」/ 长写法「1 个已扫到的候选(另有 2 处未扫到,子树内容未知)」/ 短写法「1 个候选,跳过 2 处」)',
    !!plain32 && plain32.truncated === false
    && plainHead32 === '⚠️ 跳过 2 处(1 个文件 + 1 棵未展开的子树):本次结论只覆盖 1 个已扫到的候选(另有 2 处未扫到,子树内容未知) —— **不算完整通过**'
    && (typeof txtOf === 'function' ? txtOf(plain32) : '') === '1 个已扫到的候选(另有 2 处未扫到,子树内容未知)'
    && (typeof txtOf === 'function' ? txtOf(plain32, true) : '') === '1 个候选,跳过 2 处',
    plainHead32.slice(0, 90) || '(没有总述行)')

  const txtLong32 = typeof txtOf === 'function' ? String(txtOf(cut32)) : ''
  const txtShort32 = typeof txtOf === 'function' ? String(txtOf(cut32, true)) : ''
  check('32.7 apiCoverageText 的截断写法:计数带 `≥`、并说清"跳过记录共 N 条 / 其中 M 条没有明细";**不许**出现分数或 `/` 分母(分母里的未知数比子树那种还多一层:连有几处都不知道)',
    txtLong32 === '1 个已扫到的候选(另有 ≥20 处未扫到,子树内容未知;跳过记录共 51 条,其中 31 条没有明细)'
    && txtShort32 === '1 个候选,跳过 ≥20 处(明细截断)'
    && txtLong32.indexOf('%') === -1 && txtLong32.indexOf('/') === -1,
    `${txtLong32} | ${txtShort32}`)

  const note32 = typeof noteOf === 'function' ? String(noteOf(cut32)) : ''
  const lines32 = note32.split('\n')
  check('32.8 截断留痕必须**当场说清**,而且不许指向一个同样没有它们的地方:总述行之后紧跟一行「明细已截断」(共记下 N 条记录 / 只保留前 20 条明细 / 另有 M 条连明细都没有),并点名"数据面 scanSkipped 是**明细**";**截断时不许再出现**「scanSkipped 里有全量」这句做不到的指引',
    lines32[0].indexOf('跳过 ≥20 处(20 棵未展开的子树 —— 只按**已留明细**算)') !== -1
    && (lines32[1] || '').indexOf('  · ⚠️ **明细已截断**') === 0
    && note32.indexOf('本次共记下 51 条跳过记录') !== -1
    && note32.indexOf('记录条数 ≥ 处数') !== -1
    && note32.indexOf('留痕只保留前 20 条明细') !== -1
    && note32.indexOf('另有 31 条**连明细都没有**') !== -1
    && note32.indexOf('`scanSkipped` 是**明细**、同样没有它们') !== -1
    && note32.indexOf('scanSkipped 里有全量') === -1
    && note32.indexOf('它不是全量') !== -1,
    `${(lines32[1] || '').slice(0, 70)} | 含"里有全量"=${note32.indexOf('scanSkipped 里有全量') !== -1}`)

  // 反面锚:**没被源头截断**时的每组上限说辞必须原样保留(既有判据,别被「截断」这层改坏)。
  const cap32 = typeof covOf === 'function'
    ? covOf(Array.from({ length: 7 }, (_, i) => ({ rel: `api/cap${i + 1}.yaml`, reason: 'oversize', size: 600 * 1024, limit: 512 * 1024 })), 1)
    : null
  const noteCap32 = typeof noteOf === 'function' ? String(noteOf(cap32, 2)) : ''
  check('32.9 反面(锚):每组上限的截断与**源头**截断不是一回事 —— 7 条同类只列 2 条且源头没截断时,照旧写「…另有 5 个同类条目(数据面字段 scanSkipped 里有全量)」,也不许出现「明细已截断」',
    noteCap32.indexOf('…另有 5 个同类条目(数据面字段 scanSkipped 里有全量)') !== -1
    && noteCap32.indexOf('明细已截断') === -1
    && !!cap32 && cap32.truncated === false,
    noteCap32.split('\n').filter((l) => l.indexOf('另有') !== -1).join(' | ') || '(没有"另有"行)')

  const edge32 = typeof covOf === 'function' ? [
    covOf(list32, 1, 20),   // 明细恰好 20、计数也是 20 → 没截断(不许误报)
    covOf(list32, 1, 5),    // 计数比明细还小(异常输入)→ 不许造出负数,也不许把明细改小
    covOf(list32, 1, 0),
    covOf(list32, 1, 'x'),  // 计数不是数 → 回落到明细条数
  ] : []
  check('32.10 边界:计数 == 明细(20) ⇒ 不算截断;计数 < 明细 / 计数为 0 / 计数不是数 ⇒ skippedTotal 回落到明细条数、missingDetail=0、truncated=false(异常的输入不许造出"负数条没有明细"这种话)',
    edge32.length === 4
    && edge32.every((c) => c.truncated === false && c.missingDetail === 0 && c.skippedTotal === 20 && c.skipped === 20),
    edge32.map((c) => `${c.skippedTotal}/${c.missingDetail}/${c.truncated}`).join(' | '))
}

// ── 33. 随包角色联动技能(表 / 包 / 人设 三方对齐)────────────────────────
//
// 这一节只碰**静态资产**:目录里有什么、frontmatter 写了什么、人设点了什么名。
// 端到端行为(提供者注册、按档案收窄、激活门、mtime 失效)在 smoke 第 40 节。
//
// ⚠️ **数量断言一律用「表与磁盘」互相印证,不写死数字**:写死份数会误伤
// **既有用例**,而既有用例不许被改坏。绝对数字由本节末尾的新 id(33.17~33.19)去钉。
{
  const SKILLS_DIR = fileURLToPath(new URL('./skills', import.meta.url))
  const table = typeof libmod.ROLE_SKILLS === 'object' && Array.isArray(libmod.ROLE_SKILLS) ? libmod.ROLE_SKILLS : null
  const rank = libmod.ROLE_SKILL_RANK
  const roleIds = Array.isArray(libmod.ROLE_IDS) ? libmod.ROLE_IDS : []
  /** 磁盘上的随包技能目录(有 SKILL.md 的才算),以及"除 api-architect 之外"的那批。 */
  const onDisk = fs.readdirSync(SKILLS_DIR).filter((n) => fs.existsSync(path.join(SKILLS_DIR, n, 'SKILL.md')))
  const diskRoleDirs = onDisk.filter((n) => n !== 'api-architect')

  check('33.1 ROLE_SKILLS 表可读,且**表里的份数 == 磁盘上除 api-architect 之外的技能目录数**(少一份 = 声明了没随包;多一份 = 随包了没人声明)',
    Array.isArray(table) && table.length > 0 && table.length === diskRoleDirs.length,
    table ? `表 ${table.length} 份 / 磁盘 ${diskRoleDirs.length} 份` : '(读不到)')

  const names = (table || []).map((s) => String(s.name))
  const nameOk = (n) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n)
  check('33.2 表里每个名字都是合法技能名(kebab-case)且**不重复**(DSH 的技能名有语法约束,重名会让目录里少一条)',
    names.length > 0 && names.every(nameOk) && new Set(names).size === names.length, names.join(','))

  const badRoles = (table || []).filter((s) => !Array.isArray(s.roles) || s.roles.length === 0
    || s.roles.some((r) => roleIds.indexOf(r) === -1))
  check('33.3 每条都声明了角色归属,且角色 id 都在内置角色表里(写错一个 id = 该技能对谁都不出现)',
    roleIds.length === 5 && badRoles.length === 0, badRoles.map((s) => `${s.name}:${(s.roles || []).join('|')}`).join(' '))

  const missingDir = []
  const attrRows = []
  for (const s of (table || [])) {
    const f = path.join(SKILLS_DIR, String(s.name), 'SKILL.md')
    if (!fs.existsSync(f)) { missingDir.push(String(s.name)); continue }
    const text = fs.readFileSync(f, 'utf8')
    attrRows.push({ name: String(s.name), attrs: parseSkillFrontmatter(text).attrs, text })
  }
  check('33.4 表里每一份在包内都有 SKILL.md(声明了却没随包 = 角色点了名也加载不到)',
    attrRows.length > 0 && attrRows.length === diskRoleDirs.length && missingDir.length === 0,
    `读到 ${attrRows.length} 份 / 磁盘 ${diskRoleDirs.length} 份;缺:${missingDir.join(',') || '(无)'}`)

  const nameMismatch = attrRows.filter((r) => String(r.attrs.name || '') !== r.name)
  check('33.5 每份 SKILL.md 的 frontmatter name 与目录名一致(不一致时 `skill` 工具按名找不到它)',
    attrRows.length > 0 && nameMismatch.length === 0, `读到 ${attrRows.length} 份;不一致:${nameMismatch.map((r) => `${r.name}≠${r.attrs.name}`).join(' ') || '(无)'}`)

  const noDesc = attrRows.filter((r) => String(r.attrs.description || '').trim() === '')
  check('33.6 每份都写了 description(技能目录里显示的就是这一行;没写 = 目录里一条没有说明的条目)',
    attrRows.length > 0 && noDesc.length === 0, `读到 ${attrRows.length} 份;缺 description:${noDesc.map((r) => r.name).join(',') || '(无)'}`)

  const noWhen = attrRows.filter((r) => String(r.attrs.whenToUse || '').trim() === '')
  check('33.7 每份都写了 whenToUse(角色按需加载时靠它判断"这时候该不该挂我")',
    attrRows.length > 0 && noWhen.length === 0, `读到 ${attrRows.length} 份;缺 whenToUse:${noWhen.map((r) => r.name).join(',') || '(无)'}`)

  const longDesc = attrRows.filter((r) => String(r.attrs.description || '').length > 120)
  check('33.8 description 控制在 120 字以内(它进的是**每个会话**的技能目录,是按 token 计的开销):最长仍不足 80 字',
    attrRows.length > 0 && longDesc.length === 0, longDesc.map((r) => `${r.name}:${String(r.attrs.description).length}`).join(' ') || `只读到 ${attrRows.length} 份`)

  const badVer = attrRows.filter((r) => String(r.attrs.version || '') !== VERSION)
  check('33.9 随包 SKILL.md 的 version 全 == 插件版本(部署后一眼能看出这批技能是哪一版带来的)',
    attrRows.length > 0 && badVer.length === 0, badVer.map((r) => `${r.name}:${r.attrs.version}`).join(' ') || `只读到 ${attrRows.length} 份`)

  const noHead = attrRows.filter((r) => r.text.indexOf('随包说明') === -1 || r.text.indexOf('工具名对照') === -1)
  check('33.10 每份都带"随包说明 + 工具名对照"头块(文里若留着别的工具链的写法,照着抄会调用失败)',
    attrRows.length > 0 && noHead.length === 0, noHead.map((r) => r.name).join(',') || `只读到 ${attrRows.length} 份`)

  const orphans = onDisk.filter((n) => n !== 'api-architect' && names.indexOf(n) === -1)
  check('33.11 随包目录里**没有孤儿技能**(搬进来却没进表的:它会静静地占着包体积,谁也不加载)',
    onDisk.length === diskRoleDirs.length + 1 && orphans.length === 0, `磁盘 ${onDisk.length} 份;孤儿:${orphans.join(',') || '(无)'}`)

  check('33.12 rank 取值守着一条明确的口径:60(api-architect,与 api_contract 工具同源,必须压过别人)< ROLE_SKILL_RANK(550) < 600(部署自带 bundled 档)—— 角色技能让位给用户/项目自己的同名技能',
    typeof rank === 'number' && rank > 60 && rank < 600, String(rank))

  // 人设 ↔ 表:**双向**对齐(点了名但没随包 / 随包了但没人点名)
  const t33 = buildProfileTable(null, null)
  const personaOf = (r) => String((t33.standard.roles.filter((x) => x.id === r)[0] || {}).persona || '')
  const linkLines = ['pm', 'arch', 'be', 'fe', 'qa'].map(personaOf).join('\n').split('\n').filter((l) => l.indexOf('联动技能') !== -1)
  check('33.13 五个角色的人设里各有一行「联动技能(按需加载)」(角色得先知道有这批技能,才会去 skill 加载)',
    linkLines.length === 5, String(linkLines.length))

  const mentioned = new Set()
  for (const l of linkLines) {
    for (const m of l.matchAll(/`([^`]+)`/g)) {
      const t = String(m[1]).replace(/^skill name=/, '').trim()
      if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t)) mentioned.add(t)
    }
  }
  const notBundled = [...mentioned].filter((n) => onDisk.indexOf(n) === -1)
  check('33.14 人设点名的技能**每一份都随包**(点名了却没随包 = 一句做不到的话;api-architect 也在其中)',
    mentioned.size > 0 && notBundled.length === 0, `点名 ${[...mentioned].join(',')} | 没随包:${notBundled.join(',') || '(无)'}`)

  const neverNamed = names.filter((n) => !mentioned.has(n))
  check('33.15 表里的技能**每一份都被人设点过名**(反向:随包了却没人告诉你什么时候用它,等于白背包体积)',
    names.length > 0 && names.length === diskRoleDirs.length && neverNamed.length === 0,
    neverNamed.join(',') || `表里 ${names.length} 份 / 磁盘 ${diskRoleDirs.length} 份`)

  // 每个角色至少 1 份(否则"按档案收窄"会把某个角色的技能目录收成空)
  const emptyRoles = roleIds.filter((r) => (table || []).every((s) => s.roles.indexOf(r) === -1))
  check('33.16 五个角色每个都至少有一份联动技能(不然收窄后该角色一无所获)',
    emptyRoles.length === 0, emptyRoles.join(','))

  /**
   * ── Python/Django 五件套:绝对数字钉在这里 ──────────────────────────────
   * 上面 33.1~33.16 一律**不写死数字**(要与「表与磁盘」同源,增补技能时只挂新 id);
   * 这里的绝对数字是:23 份角色技能 / 24 份随包技能。
   */
  const NEW5 = ['django-patterns', 'django-security', 'django-tdd', 'python-project-structure', 'python-error-handling']
  const byRole = (r) => (table || []).filter((s) => s.roles.indexOf(r) !== -1).length
  check('33.17 表里 23 份角色技能 / 磁盘 24 份随包技能(补搬的是 Python/Django 五件套)',
    (table || []).length === 23 && diskRoleDirs.length === 23 && onDisk.length === 24,
    `表 ${(table || []).length} / 磁盘 ${diskRoleDirs.length} / 合计 ${onDisk.length}`)
  check('33.18 那五份都在表里、都归 ③ be,并且都真的随包(③ 正文写着「按项目技术栈加载」)',
    NEW5.every((n) => names.indexOf(n) !== -1)
    && NEW5.every((n) => (table || []).some((s) => s.name === n && s.roles.length === 1 && s.roles[0] === 'be'))
    && NEW5.every((n) => fs.existsSync(path.join(SKILLS_DIR, n, 'SKILL.md'))),
    NEW5.map((n) => `${n}:${(table || []).filter((s) => s.name === n).map((s) => s.roles.join('|')).join('') || '(不在表里)'}`).join(' '))
  check('33.19 逐角色份数符合预期(pm 1 / arch 4 / fe 3 / qa 8)',
    byRole('pm') === 1 && byRole('arch') === 4 && byRole('be') === 13 && byRole('fe') === 3 && byRole('qa') === 8,
    `pm ${byRole('pm')} / arch ${byRole('arch')} / be ${byRole('be')} / fe ${byRole('fe')} / qa ${byRole('qa')}`)
}

// ── 34. 预设驱动自动激活 —— 清单归一化 + **门优先级守卫** ───────────────
//
// 「dev-workflow 预设下的会话」会自动把项目记成已开工(其余预设下激活方式不变)。
//
// 实现上**没有新造门档** —— 只是往既有的 `remembered` 档写一笔,与 kickoff 首用同一个档。
// 所以这一节要守两条不变量:
//   ① 清单归一化的口径(缺省 / 显式关 / 单串 / 数组 / 去空白 / 去空项);
//   ② **门优先级不受自动激活影响** —— 显式 `.active` 写 off 必须继续压过 `remembered`。
//      少了 ②,自动激活就变成「用户关不掉的东西」:一个每开一次会话就把自己写回激活态的
//      插件,用户没有任何手段让它停下。
{
  // 缺这个导出时,直接调用会**抛异常中断整套件**,那不是"干净地挂",
  // 所以先探测再退化成恒返回 null 的桩 —— 要的是 34.1 报一条失败,不是崩掉整个 selftest。
  const D = typeof libmod.resolveAutoActivatePresets === 'function'
    ? libmod.resolveAutoActivatePresets
    : () => null

  const cases34 = [
    ['缺省 undefined', undefined, ['dev-workflow']],
    ['缺省 null', null, ['dev-workflow']],
    ['显式关 false', false, []],
    ['显式关 空串', '', []],
    ['显式关 空数组', [], []],
    ['单串', 'dev-workflow', ['dev-workflow']],
    ['单串带空白', '  standard  ', ['standard']],
    ['数组', ['a', 'b'], ['a', 'b']],
    ['数组去空项与空白', [' a ', '', '  ', 'b'], ['a', 'b']],
  ]
  const bad34 = cases34.filter(([, input, want]) => JSON.stringify(D(input)) !== JSON.stringify(want))
  check('34.1 自动激活清单归一化九档口径(缺省 → dev-workflow;false / 空串 / 空数组 → 关掉;单串与数组都收;逐项去空白、丢空项)',
    bad34.length === 0,
    bad34.length === 0
      ? `九档全对:${cases34.map(([label]) => label).join(' / ')}`
      : bad34.map(([label, input, want]) => `${label}: 得 ${JSON.stringify(D(input))} 期望 ${JSON.stringify(want)}`).join(' | '))

  // ② 门优先级守卫 —— 五档逐条比对。这条是"自动激活必须能被用户关掉"的机械保证。
  check('34.2 门优先级不受自动激活影响 —— 显式 `.active` 写 off 仍然压过插件记忆(remembered);五档顺序仍是 off > file > remembered > state-doc > none',
    libmod.gateDecision({ fileExists: true, fileText: 'off\n', remembered: true, stateDocExists: true }) === 'off'
    && libmod.gateDecision({ fileExists: true, fileText: 'active\n', remembered: true }) === 'file'
    && libmod.gateDecision({ fileExists: false, remembered: true, stateDocExists: true }) === 'remembered'
    && libmod.gateDecision({ fileExists: false, remembered: false, stateDocExists: true }) === 'state-doc'
    && libmod.gateDecision({}) === 'none',
    [
      libmod.gateDecision({ fileExists: true, fileText: 'off\n', remembered: true, stateDocExists: true }),
      libmod.gateDecision({ fileExists: true, fileText: 'active\n', remembered: true }),
      libmod.gateDecision({ fileExists: false, remembered: true, stateDocExists: true }),
      libmod.gateDecision({ fileExists: false, remembered: false, stateDocExists: true }),
      libmod.gateDecision({}),
    ].join(' > ') + '(期望 off > file > remembered > state-doc > none)')

  // ③ 预设自动激活落进的仍是既有档位 —— 这解释了为什么技能可见性/档案解析那批老路径一行都不用改。
  check('34.3 预设自动激活落进的是既有的 `remembered` 档(isActiveGate 认它),没有为它新造门档 —— 所以按门判定的老路径(技能可见性 / 档案解析)一行都不用改',
    libmod.isActiveGate('remembered') === true
    && libmod.isActiveGate('off') === false
    && libmod.isActiveGate('none') === false
    && String(libmod.GATE_LABELS.remembered || '').indexOf('插件记忆') !== -1,
    `isActiveGate(remembered)=${libmod.isActiveGate('remembered')} / (off)=${libmod.isActiveGate('off')} / GATE_LABELS.remembered=${libmod.GATE_LABELS.remembered}`)
}

// ── 35. 预设判定 = **Session 投影优先,header 兜底** ──────────────────
//
// 只读 `header.agentPreset` 会看错:header 是**会话创建那一刻**的化石 —— DSH 的 Web 入口先按
// 默认预设建会话(header 写 `cordis`),随后才把用户选的预设作为 `agent-preset/selected`
// 事件追加进会话日志。于是「在 dev-workflow 预设下」这件事在 header 上永远看不见。
//
// 这一节只钉**纯函数口径**(调度路径在 smoke 第 43 节):投影有值就以投影为准,投影没值才落回 header。
{
  // 缺这个导出时先探测 —— 要的是一条干净的失败断言,不是整套件崩掉。
  const R = typeof libmod.resolveSessionPreset === 'function'
    ? libmod.resolveSessionPreset
    : () => null

  const cases35 = [
    ['两侧一致', 'dev-workflow', 'dev-workflow', 'dev-workflow'],
    ['投影 dev-workflow / header cordis(header 是创建时的化石)', 'dev-workflow', 'cordis', 'dev-workflow'],
    ['投影 standard / header dev-workflow(运行时被换走)', 'standard', 'dev-workflow', 'standard'],
    ['投影 null / header dev-workflow(还没提交过选择)', null, 'dev-workflow', 'dev-workflow'],
    ['投影空串 / header dev-workflow', '', 'dev-workflow', 'dev-workflow'],
    ['投影 undefined / header cordis', undefined, 'cordis', 'cordis'],
    ['投影非字符串(123)/ header cordis', 123, 'cordis', 'cordis'],
    ['投影带空白', '  dev-workflow  ', 'cordis', 'dev-workflow'],
    ['两侧都没有', null, undefined, ''],
    ['两侧都是空串', '', '', ''],
  ]
  const bad35 = cases35.filter(([, p, h, want]) => R(p, h) !== want)
  check('35.1 预设判定十档口径(投影优先;投影无值/非字符串才落回 header;两侧去空白)—— "运行时在哪个预设"只认投影,header 是创建时的化石',
    bad35.length === 0,
    bad35.length === 0
      ? `十档全对:${cases35.map(([label]) => label).join(' / ')}`
      : bad35.map(([label, p, h, want]) => `${label}: 得 ${JSON.stringify(R(p, h))} 期望 ${JSON.stringify(want)}`).join(' | '))
}

// ── 36. 各入口命中计数的渲染口径(可观测面)────────────────────────────
//
// 预设命中而门已被别的来源定下时,`autoActivateByPreset()` 在**打日志之前**就 `return false`,
// 于是「四条入口到底通没通」在插件外面一个字都读不到 —— 这一行就是它的可观测面。
//
// 这一节只钉**渲染那一半的纯函数**:四条入口名、三个判定结局、三个「没判成」、最近一笔 ——
// 少报一格就等于又回到「看不见」。调度那一半在 smoke 第 44 节。
{
  // 缺这个导出时先探测 —— 要的是一条干净的失败断言,不是整套件崩掉。
  const F = typeof libmod.formatPresetAutoStats === 'function' ? libmod.formatPresetAutoStats : () => null

  const sample36 = {
    reached: { 'agent/created': 1, 'session/event': 2, 'agent-preset/selected': 0, 'tools/execute': 47 },
    judged: 3,
    judgedVia: { 'agent/created': 1, 'session/event': 1, 'agent-preset/selected': 0, 'tools/execute': 1 },
    activated: 1,
    activatedVia: { 'agent/created': 0, 'session/event': 1, 'agent-preset/selected': 0, 'tools/execute': 0 },
    gateOpen: 1, notInList: 1, noRoot: 0, noAgent: 0, disabled: 0,
    last: '门已定(root=C:/x, gate=file, 预设=dev-workflow)',
  }
  const want36 = '预设自动激活(本进程):到达 agent/created=1 session/event=2 agent-preset/selected=0 tools/execute=47'
    + ' | 判定 3 次(agent/created=1 session/event=1 tools/execute=1)'
    + ' | 结局:激活 1(session/event=1) / 门已定 1 / 不命中清单 1'
    + ' | 没判成:根未就绪 0 / 查不到会话 0 / 清单已关 0'
    + ' | 最近:门已定(root=C:/x, gate=file, 预设=dev-workflow)'
  const got36 = F(sample36)
  check('36.1 入口计数那一行的渲染口径逐字钉住 —— 四条入口(到达)+ 判定次数与入口 + 三个结局 + 三个没判成 + 最近一笔,一格都不许少(少一格就等于又回到"看不见")',
    got36 === want36,
    got36 === want36 ? `逐字一致(${want36.length} 字)` : `得:${String(got36)}\n      期望:${want36}`)

  /**
   * ② 容错:这一行是**排障读数**,不能自己变成新的故障点 ———
   * 缺字段 / 传 undefined / 传垃圾一律按 0 计,且标签照旧齐全。
   */
  let threw36 = ''
  let empty36 = ''
  try {
    empty36 = String(F(undefined))
    F({})
    F({ reached: { 'agent/created': 'x' }, judged: -3, last: 42 })
  } catch (e) { threw36 = String((e && e.message) || e) }
  const labels36 = ['agent/created=', 'session/event=', 'agent-preset/selected=', 'tools/execute=', '判定 0 次', '结局:激活 0 / 门已定 0 / 不命中清单 0', '没判成:根未就绪 0 / 查不到会话 0 / 清单已关 0', '最近:(还没判过)']
  const missing36 = labels36.filter((k) => empty36.indexOf(k) === -1)
  check('36.2 缺字段 / undefined / 垃圾值都不许抛,一律按 0 计 —— 排障读数自己变成故障点是最坏的一种回归',
    threw36 === '' && missing36.length === 0,
    threw36 !== '' ? `抛了:${threw36}` : (missing36.length === 0 ? `八段标签齐全(${empty36.length} 字)` : `缺:${missing36.join(' / ')}`))
}

// ── 44. 需求确认门(② 记账 + ① 上锁的纯逻辑)─────────────────────────────
{
  const R = (v) => libmod.resolveRequirementMode(v)
  check('44.1 档位解析:缺省/on 都是 enforce,track|off 各归各,缺省值认得出',
    R(undefined).mode === 'enforce' && R('').mode === 'enforce' && R('enforce').mode === 'enforce'
    && R('track').mode === 'track' && R('off').mode === 'off' && R(false).mode === 'off'
    && R('TRACK').mode === 'track' && R(undefined).known === true,
    JSON.stringify([R(undefined), R('track'), R('off'), R('nonsense')]))
  check('44.2 认不出的值按 enforce,但 known=false —— 打错字的配置必须看得见,不许静默放行',
    R('enfroce').mode === 'enforce' && R('enfroce').known === false && R('enfroce').raw === 'enfroce',
    JSON.stringify(R('enfroce')))

  const role = (id, extra) => Object.assign({ id }, extra || {})
  check('44.3 受门约束的角色:协调者 / 只读 / @arch 豁免(架构师要在需求阶段在场,pm 人设要求可行性一律互呼它),其余生产角色受约束',
    libmod.requirementGatedRole(role('be'), 'pm') === true
    && libmod.requirementGatedRole(role('fe'), 'pm') === true
    && libmod.requirementGatedRole(role('dba'), 'pm') === true
    && libmod.requirementGatedRole(role('pm'), 'pm') === false
    && libmod.requirementGatedRole(role('qa', { readonly: true }), 'pm') === false
    && libmod.requirementGatedRole(role('arch'), 'pm') === false,
    JSON.stringify(['pm', 'arch', 'be', 'fe', 'dba', 'qa'].map((id) => libmod.requirementGatedRole(role(id, id === 'qa' ? { readonly: true } : {}), 'pm'))))
  check('44.4 档案里的 awaitRequirement 优先于内置口径(逐角色可覆盖)',
    libmod.requirementGatedRole(role('be', { awaitRequirement: false }), 'pm') === false
    && libmod.requirementGatedRole(role('arch', { awaitRequirement: true }), 'pm') === true,
    JSON.stringify([libmod.requirementGatedRole(role('be', { awaitRequirement: false }), 'pm'), libmod.requirementGatedRole(role('arch', { awaitRequirement: true }), 'pm')]))

  const D = (extra) => libmod.requirementDecision(Object.assign({ mode: 'enforce' }, extra || {}))
  check('44.5 六种状态各判各的:off / skipped / approved / drifted / doc_missing / unregistered',
    D({ mode: 'off' }).state === 'disabled'
    && D({ escape: true }).state === 'skipped'
    && D({ approval: { digest: 'aa' }, docExists: true, docDigest: 'aa' }).state === 'approved'
    && D({ approval: { digest: 'aa' }, docExists: true, docDigest: 'bb' }).state === 'drifted'
    && D({ approval: { digest: 'aa' }, docExists: false, docDigest: '' }).state === 'doc_missing'
    && D({}).state === 'unregistered',
    JSON.stringify([D({ mode: 'off' }).state, D({ escape: true }).state, D({ approval: { digest: 'a' }, docExists: true, docDigest: 'a' }).state, D({ approval: { digest: 'a' }, docExists: true, docDigest: 'b' }).state, D({ approval: { digest: 'a' } }).state, D({}).state]))
  check('44.6 上锁只在 enforce 档:track 记而不断,off 连状态都不算;已登记 / 已放行都不锁',
    D({}).locked === true
    && D({ mode: 'track' }).locked === false
    && D({ approval: { digest: 'a' }, docExists: true, docDigest: 'a' }).locked === false
    && D({ escape: true }).locked === false
    && D({ approval: { digest: 'a' }, docExists: true, docDigest: 'b' }).locked === true,
    JSON.stringify([D({}).locked, D({ mode: 'track' }).locked, D({ escape: true }).locked, D({ approval: { digest: 'a' }, docExists: true, docDigest: 'b' }).locked]))
  check('44.7 漂移要把两个指纹都带出来(只报"已漂移"而不给前后指纹,人没法核对改的是不是需求段)',
    D({ approval: { digest: 'aaaa1111' }, docExists: true, docDigest: 'bbbb2222' }).digestWas === 'aaaa1111'
    && D({ approval: { digest: 'aaaa1111' }, docExists: true, docDigest: 'bbbb2222' }).digestNow === 'bbbb2222',
    JSON.stringify(D({ approval: { digest: 'aaaa1111' }, docExists: true, docDigest: 'bbbb2222' })))

  const base = { docPath: 'docs/workflow/项目经理.md', docChars: 120, gatedRoles: ['be', 'fe'] }
  const T = (s) => String(libmod.requirementStateText(Object.assign({}, base, s)))
  check('44.8 同源文案:六种状态都要有自己那句话,且"未登记"必须给出三条出路(主会话登记 / 逃生阀 / 配置降级)',
    T({ state: 'disabled' }).indexOf('记账已关') !== -1
    && T({ state: 'skipped' }).indexOf('approval=skip') !== -1
    && T({ state: 'approved', approval: { by: 'user', at: '2026-01-01 00:00:00', digest: 'abcdef1234567890' } }).indexOf('指纹 abcdef123456') !== -1
    && T({ state: 'drifted', digestWas: 'aaaa', digestNow: 'bbbb' }).indexOf('已漂移') !== -1
    && T({ state: 'doc_missing' }).indexOf('文档读不到') !== -1
    && T({ state: 'unregistered' }).indexOf('requirementApproval={by:"user"}') !== -1
    && T({ state: 'unregistered' }).indexOf('approval=skip') !== -1
    && T({ state: 'unregistered' }).indexOf('track|off') !== -1,
    [T({ state: 'disabled' }), T({ state: 'unregistered' })].join(' ‖ ').slice(0, 220))
  check('44.9 未登记但在 track 档:文案必须明说"不拦"(否则读的人以为流程被卡住了)',
    T({ state: 'unregistered', mode: 'track' }).indexOf('不会被拦') !== -1
    && T({ state: 'unregistered', mode: 'enforce' }).indexOf('会被拦下') !== -1,
    T({ state: 'unregistered', mode: 'track' }))
  check('44.10 自证与有据可查必须分开说:没有证据时文案里就写着"自证",不许只印 by=user',
    T({ state: 'approved', approval: { by: 'user', digest: 'a'.repeat(64) } }).indexOf('自证') !== -1
    && T({ state: 'approved', approval: { by: 'user', digest: 'a'.repeat(64), evidence: 'ask_user_question@2026-01-01 00:00:00' } }).indexOf('ask_user_question@') !== -1,
    T({ state: 'approved', approval: { by: 'user', digest: 'a'.repeat(64) } }))
  check('44.11 认不出的配置值要在文案里点名(打错字的人看这一行就知道)',
    T({ state: 'unregistered', mode: 'enforce', raw: 'enfroce', rawKnown: false }).indexOf('未识别') !== -1,
    T({ state: 'unregistered', mode: 'enforce', raw: 'enfroce', rawKnown: false }))

  // 文档小节 + 渲染进 buildDocument / summarize 的闭环
  const rows = String(libmod.requirementSectionRows(Object.assign({}, base, {
    state: 'approved', approval: { by: 'user', at: '2026-01-01 00:00:00', note: '用户说可以', digest: 'abcdef1234567890' },
  })))
  check('44.12 文档小节:登记后要写清"对象 + 指纹 + 自述 + 证据",并说明该文档一改就作废',
    rows.indexOf('✅ 已登记') !== -1 && rows.indexOf('abcdef123456') !== -1
    && rows.indexOf('用户说可以') !== -1 && rows.indexOf('自动作废') !== -1 && rows.indexOf('自证') !== -1,
    rows.replace(/\n/g, ' ‖ ').slice(0, 200))
  const doc = buildDocument(null, { header: { coordinator: 'pm' }, requirement: Object.assign({}, base, { state: 'unregistered', mode: 'enforce' }) })
  check('44.13 「需求确认」小节默认就在初始模板里,传了视图就整段改写(不是缺一节,让人以为这门不存在)',
    buildDocument(null, { header: { coordinator: 'pm' } }).indexOf('## 需求确认') !== -1
    && doc.indexOf('## 需求确认') !== -1 && doc.indexOf('未登记') !== -1,
    doc.split('\n').filter((l) => l.indexOf('需求确认') !== -1 || l.indexOf('未登记') !== -1).join(' | '))
  check('44.14 summarize 读得回「需求确认」小节(跨会话续跑时"确认到哪一版"不能丢)',
    summarize(doc).requirement.indexOf('未登记') !== -1,
    String(summarize(doc).requirement).slice(0, 80))
}

console.log(`\n${'='.repeat(46)}\n结果: ${PASS} 通过 / ${FAIL} 失败`)
if (failures.length > 0) {
  console.log('\n失败项:')
  for (const f of failures) console.log(`  ❌ ${f}`)
}
process.exit(FAIL ? 1 : 0)
