/**
 * dsh-dev-workflow — host-composition plugin.
 *
 * 把「多角色协作流程」做进 host 面:relay 互呼编排(插件自动投递)、流程状态文档、
 * 多档案(profile)、随包的 api-architect 技能与 api_contract 工具。
 *
 * 设计取向(刻意不做的三件事):
 *   - 不抓屏:角色子会话由 subagents 服务派出,不用伪终端去驱动外部 CLI
 *   - 不轮询外部进程的状态库:改用事件 / turn 信号
 *   - 不起无鉴权的本地守护进程,也不杀进程
 *
 * ── 实机验证过的硬事实 ─────────────────────────────────────────────────────
 * 以下几条都是在本机真实宿主进程里跑出来、不是推断,改动它们会立刻破坏功能:
 *
 *   · sendMessage 必须拿到**真 AbortSignal**。
 *       `subagents.sendMessage(sender, targetId, content, { signal })` 内部走
 *       `query.observeSession(childId, { signal })`;喂一个手搓的假 signal 会让
 *       **非驻留子会话的冷恢复投递**静默失败,报
 *       `NOT_RESUMABLE / subagent "..." is unavailable`。实测:同一个目标
 *       假 signal 失败、真 signal(delivered)成功。故本文件一律用真 signal。
 *   · 插件**无权写工作区文件**。`ctx.get('fs').writeText()` 由插件发起时没有
 *       actor,沙箱一律拒绝(FS_SANDBOX_DENIED,换任何路径都一样)。所以
 *       流程状态.md / 协作台账.md 的**落盘只能交回会话自己的 write 工具**;
 *       插件负责渲染全文。插件私有的 JSON 状态才用 node:fs。
 *   · 子会话人格**继承父会话 preset**,与 relay_spawn 的 preset 参数无关。
 *       本会话 agentPreset=standard,spawn 出的子会话 header.agentPreset
 *       同样是 standard。所以"给角色一份人格"的唯一可靠手段是透传 request.persona
 *       (spawn provider 的 capabilities.persona === true)。
 *   · 插件私有状态可以落盘。静态行是普通 Node ESM,`node:fs` 直接可用
 *       (读宿主文件也走它)。写入 `${DSH_HOME:-~/.dsh}/dev-workflow/` 是
 *       DSH 自己的地盘,不碰工作区、不消费文件策略;apply 时会实测可写性并
 *       在 status 里如实报告(stateOk)。
 *
 *   · 插件**能把技能注册进 DSH 技能目录**。`ctx.skills`(可选服务,`ctx.get('skills')`)
 *       提供两条路:`register(definition)` 静态注册一条 runtime 技能;`registerProvider(create)`
 *       注册**按 cwd 现算**的提供者。两条都在本机真宿主里验过:注册后 `skill` 工具能直接
 *       加载到内容,`resourceBase: {kind:'directory'}` 会渲染成"Base directory for this
 *       skill",模型可据此读 references/。本插件用 provider 形态,以便沿用**激活门**
 *       (没激活的项目里 api-architect 不出现)。
 *
 *       ⚠️ 激活门只挡**技能**(`ctx.skills` 的 provider 形态),挡不住**工具**:
 *       `ctx.tools.register()` 在 apply 时无条件注册 7 个工具(schema 合计 8,518 字节),
 *       每个会话、每个项目,包括从未用过 dev-workflow 的项目,都要背这份开销。
 *       实测手段:用 mock ctx(所有可选服务返回 undefined)跑 apply() 并捕获注册表。
 *       为什么不做成"按项目可见":查过 `tools` 服务契约 —— `register` 没有可见性谓词、
 *       `restrict` 只作用于**调用方 scope**(全局插件拿不到任意未来 agent 的 scope)、
 *       `guard` 只在执行期拒绝但**不移除 schema**(省不到 token)。所以当前契约下
 *       这件事做不了;能做的是给描述瘦身 + 把声明写成实情。
 *       注意:注册走的是调用上下文的层(host 静态行 → 全局层),不是"每个 preset 一层"。
 *
 * ── 邻居约束的真相 ─────────────────────────────────────────────────────────
 * DSH 在**服务层**强制邻接:`sendMessage` 先要求 `agents.get(sender.id) === sender`,
 * 父→子方向还要求 `parentSession === parent.id`。所以兄弟角色之间**物理上**无法
 * 直连。本插件的做法是不消除这条约束,而是把"绕调度者一层"从**模型义务**变成
 * **插件自动**:角色调用 relay → 插件查出它父会话(调度者)的活 agent → 以调度者
 * 身份把消息投进目标角色 inbox。对模型来说就是直呼。
 *
 * 模块形态:loader 的 unwrapExports 接受 ESM default export,插件对象 =
 * `{ name, inject, apply }`。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// ── 常量 ────────────────────────────────────────────────────────────────────

const NAME = 'dev-workflow'

/**
 * 插件必须能**自证跑的是哪一版**。
 *
 * 插件代码在宿主进程启动时载入内存:磁盘上的源码更新后若不重启 DSH,跑的就还是旧的那一份。
 * 而 ready 日志与所有 status 都不带版本号,单看回执无从发现这种"磁盘新、内存旧"。
 *
 * 所以:ready 日志、relay status、workflow_state_status、api_contract 都报这个常量 ——
 * 它与磁盘上那份 package.json 的版本不一致 = 部署了但没重启,而改动要生效必须重启 DSH。
 */
export const VERSION = '0.0.1'

const RELAY_LIMIT = 5
const RELAY_WINDOW_MS = 600000
/** 等待关系超时释放(ms)。没有这条,等待关系就只进不出。 */
const WAIT_TIMEOUT_MS = 900000
/**
 * 正文段**保持 lazy `.+?`** —— 它必须能跨行吞下整段回覆正文
 * (`@relay:be 第一行\n第二行` 是常态,selftest 1.1/1.5 守的就是它),
 * 所以这里只在 `extractRelayMarks` 里对"末行多标记"做二次切分,不改这条正则的语义。
 */
const MARK_RE = /^\s*@relay:([a-zA-Z]+)\s+(.+?)\s*$/
const STATE_VERSION = 1
/** 确认人文案里出现这些词 = 明说"还没确认",不再做参与度反查。 */
const CONTRACT_PLAN_MARKERS = ['计划', '待确认', '待复核', '未确认', '待定']
const LEDGER_MAX = 200
const ARBITRATION_MAX = 100
/**
 * "空槽"多久没被碰过就回收掉。
 * 7 天是刻意保守的门槛 —— 它要清理的是"一次性项目/写错 root 留下的槽"这类垃圾,
 * 而不是"休假一周回来的项目";而且只有**完全空**的槽够格(见 isEmptySlot),
 * 任何绑定/台账/计数都会把它保住。不设环境变量开关:当前还没有配置契约,写死一个数比
 * 引入一个没人会调的旋钮好。
 */
const SWEEP_EMPTY_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 单条仲裁事件保留的正文上限(字符);超出部分转存台账边车。 */
const ARBITRATION_MSG_MAX = 8192
const DEDUPE_MS = 60000

/**
 * 内置 standard 档案的角色 id。
 *
 * 这四处工具 schema 的 `enum`(relay.from/to、relay_spawn.role、workflow_state_save.role)
 * 刻意**不写**这份常量:实测 provider 并不强制 enum,真正能拦下自定义角色的是执行期硬编码
 * (那里只做语法校验、成员校验交给 profile);而 schema 里的 enum 会**误导模型** ——
 * 自定义档案的角色 id 不在表里,模型会以为它非法。所以四处 enum 全部摘掉,只留这份常量作内置参考。
 */
const ROLE_IDS = ['pm', 'arch', 'be', 'fe', 'qa']
export { ROLE_IDS }

const PREFIXES = {
  forward: '【互呼】',
  reply: '【互呼回复】',
  circuit: '【互呼熔断】',
  timeout: '【互呼超时】',
  /**
   * 「【互呼被忽略】」这个语义**静默丢弃正文** —— 连"docs/ 被外部整体删除"这类告警
   * 都会一起丢掉,调度者无从得知。
   * 所以改成「并线送达」:正文本条照样投给目标,只有等待图不被改写。
   * 前缀必须同步改名 —— 文案说"未发出"而实际已送出,是在说谎。
   */
  busy: '【互呼并线】',
}

/**
 * 台账单行入库时的摘要上限。实测:活宿主 23 行台账占 state.json 的 83.9%,
 * 单行最大 4,074 字节(存的是**消息全文**)。渲染侧本来就 slice(0,80),
 * 所以入库只需留够渲染用的量;全文转存到插件私有边车(见 appendLedgerFull)。
 */
/** relay 的合法 action 清单(未知值必须显式报错,不能静默降级成 send)。 */
const RELAY_ACTIONS = ['send', 'status', 'kickoff', 'deactivate', 'release', 'arbitrate', 'profile', 'providers', 'presets', 'ledger']

/**
 * 模型经常把布尔写成字符串("true")。只认 `=== true` 会把
 * `noDeliver:"true"` 当成 false,"只做编排判定、不实际投递"就变成了**真投递**。
 */
function boolTrue(v) {
  return v === true || v === 'true' || v === '1' || v === 1
}

/**
 * 熔断/死锁升级事件改投"主会话"时用的哨兵角色名。
 *
 * standard 档的协调者就是 @pm 本身,所以"@pm 发起的互呼被熔断"与"别人发给 @pm 的
 * 互呼被熔断"这两种日常情形里,直接投给协调者等于把升级整句丢掉 ——
 * 回执/台账却写着"已升级主线程仲裁",而**没有任何一方**收到升级。
 * 协调者是一方时,正确的投递对象是它的父会话(派它的主会话);哨兵由 relay 的
 * writeBack 翻译成"直接投 parentSessionOf(caller)"(见 writeBack 里的同名分支)。
 */
const MAIN_SESSION_ROLE = '(主会话)'

const LEDGER_SUMMARY_MAX = 120
/** 台账全文边车的单文件上限;超过就转一代 .1(只留最近两代)。 */
const LEDGER_FULL_MAX = 2 * 1024 * 1024
/** 台账全文边车目录(插件私有地盘,可写)。 */
const LEDGER_FULL_DIR = 'ledger'

const ACTIVE_REL = 'docs/workflow/.active'
const DEFAULT_STATE_REL = 'docs/workflow/流程状态.md'
const DEFAULT_LEDGER_REL = 'docs/workflow/协作台账.md'

// ── api-architect 并入(技能 + 工具)────────────────────────────────────────
/** 插件包内的技能根(<pkg>/skills)。静态行是普通 ESM,import.meta.url 可用。 */
const SKILLS_ROOT = fileURLToPath(new URL('../skills', import.meta.url))
const API_SKILL_NAME = 'api-architect'
const API_SKILL_DIR = path.join(SKILLS_ROOT, API_SKILL_NAME)
/** spec 的推荐落点(相对项目根)。 */
const API_SPEC_DIR = 'docs/api'
/** 参考件文件名 → 模板种类。 */
const API_TEMPLATES = {
  openapi: ['openapi-spec.yaml', 'openapi.yaml'],
  graphql: ['graphql-schema.graphql', 'schema.graphql'],
  proto: ['grpc-service.proto', 'service.proto'],
  ratelimit: ['rate-limiting.yaml', 'rate-limiting.yaml'],
  security: ['api-security.yaml', 'api-security.yaml'],
}
/** 扫描 spec 的候选目录(相对项目根,深度 ≤ 2)。 */
const API_SCAN_DIRS = ['.', 'api', 'openapi', 'docs', 'docs/api', 'docs/apis', 'proto', 'graphql', 'schema', 'spec', 'specs', 'contracts']
const API_SCAN_SKIP = ['node_modules', '.git', '.github', 'dist', 'build', 'out', 'coverage', '.next', '.venv', 'venv', '__pycache__', '.smoke-tmp', '.dsh']
const API_SCAN_EXT = ['.yaml', '.yml', '.json', '.graphql', '.gql', '.graphqls', '.proto']
const API_SCAN_MAX_FILES = 80
const API_SCAN_MAX_BYTES = 512 * 1024
/** 深度上限。从 walk() 里的字面量提出来 —— 留痕文案要如实说"超过几层",两处必须是同一个数。 */
const API_SCAN_MAX_DEPTH = 2
/**
 * 跳过记录的**明细**上限 —— **计数不封顶,只有明细封顶**。
 *
 * 若计数也跟着明细一起截断,`apiSkipCoverage` 就数不出真实的处数,而留痕却写着
 * 「…另有 N 个同类条目(**数据面字段 scanSkipped 里有全量**)」—— `scanSkipped` 正是从这条
 * **已截断**的数组来的:模型照着这句话去翻 payload,只会看到同样被截断的那些,
 * 于是合理地得出"总数就是这些"。这违反「建议必须能被照做」这条规矩 ——
 * 它给了一条**做不到**的指引(数字与指引同时不可靠)。
 *
 * 所以计数(`skippedTotal`,永远累加)与明细(`skipped`,只留前 N 条)分开;截断由
 * `apiSkipCoverage` 标成 `truncated`,渲染层一律加 `≥` 并当场说清"明细就是明细,不是全量"。
 */
const API_SKIP_DETAIL_MAX = 20
const API_FINDINGS_INLINE_MAX = 40

// ── 角色联动技能(随包)────────────────────────────────────────────────────
/**
 * 五个角色文档里「联动技能(按需加载)」一栏点名的技能,随插件一起发布在 `<pkg>/skills/`。
 *
 * 为什么放进插件(而不是留在外部技能库里):
 *   · 角色子会话跑在 DSH 里,而 DSH 的技能目录只认**自己注册的提供者** —— 外部技能库里的技能
 *     对角色不可见,"按需加载联动技能"这句人设就成了一句做不到的话(与 api-architect 技能同因);
 *   · 技能的可用性跟"项目是不是在走 dev-workflow"同生命周期:没激活的项目里它们不该出现。
 *
 * `roles` = 哪些角色会用到它,用于**按档案的角色集收窄技能目录**(lean3 没有 arch/fe 两个角色,
 * 那两个角色的技能就不进目录)。这是当前契约下能做到的最细粒度 —— 技能提供者的 `list()` 只拿得到
 * 调用方 `cwd`、拿不到 agent 身份(与 tools 注册同一条约束,见文件头硬事实);要全量可见把配置
 * `roleSkills` 设成 `always`。
 *
 * 技能正文与参考件都是随包文件(改 SKILL.md 立刻生效,不用重启);这张表只声明**角色归属与顺序**,
 * name/description/whenToUse 一律以各自的 `SKILL.md` frontmatter 为准,不在这里抄第二份。
 */
export const ROLE_SKILLS = [
  // ① 项目经理 + ② 架构师
  { name: 'grill-me', roles: ['pm', 'arch'] },
  // ② 架构师
  { name: 'architecture-diagram', roles: ['arch'] },
  { name: 'excalidraw', roles: ['arch'] },
  { name: 'ponytail', roles: ['arch', 'be'] },
  // ③ 后端开发
  { name: 'systematic-debugging', roles: ['be'] },
  { name: 'test-driven-development', roles: ['be'] },
  { name: 'spring-boot-project-creator', roles: ['be'] },
  { name: 'spring-boot-crud-patterns', roles: ['be'] },
  { name: 'spring-boot-rest-api-standards', roles: ['be'] },
  { name: 'spring-boot-test-patterns', roles: ['be', 'qa'] },
  // ③ 后端开发(Python/Django 那一路 —— ③ 的角色正文本来就写着"按项目技术栈加载技能",
  // 这五份不进技能目录的话,那句话在 Python 项目里就是空的)
  { name: 'django-patterns', roles: ['be'] },
  { name: 'django-security', roles: ['be'] },
  { name: 'django-tdd', roles: ['be'] },
  { name: 'python-project-structure', roles: ['be'] },
  { name: 'python-error-handling', roles: ['be'] },
  { name: 'spike', roles: ['be'] },
  // ③' 前端开发(+ ④ 质检的前端验收)
  { name: 'frontend-design', roles: ['fe', 'qa'] },
  { name: 'impeccable', roles: ['fe', 'qa'] },
  { name: 'ui-ux-pro-max', roles: ['fe', 'qa'] },
  // ④ 质检员
  { name: 'requesting-code-review', roles: ['qa'] },
  { name: 'testing-strategy', roles: ['qa'] },
  { name: 'python-testing-patterns', roles: ['qa'] },
  { name: 'api-docs', roles: ['qa'] },
]
/**
 * 角色技能的 rank(低者胜)。
 *
 * api-architect 用 60:**它必须与 `api_contract` 工具的口径严格同源**(模板、lint 规则、清单都长在
 * 同一份文本上),被别的同名技能盖掉会让工具与技能说两套话,所以它压在所有人之上。
 * 这一批是**通用方法论**,不该盖掉用户/项目自己放的同名技能 —— DSH 内置档位是
 * project-dsh 100 / project-agents 200 / custom 300 / user-dsh 400 / user-agents 500 / bundled 600,
 * 取 550:盖过随包发布的那一份,让位给用户与项目自己的。
 */
export const ROLE_SKILL_RANK = 550

const ROLE_LABELS = {
  pm: '① 项目经理',
  arch: '② 架构师',
  be: '③ 后端开发',
  fe: "③' 前端开发",
  qa: '④ 质检员',
}

/**
 * 角色 → 人工入口预设 id 的**标签映射**。`wf-*` 预设默认不再安装:
 * 角色子会话的人格走 PERSONAS(经 request.persona 注入)、工具集走 toolFilter,
 * 整条链路一处都不读预设。所以这个映射只用于"人工自己装了入口预设时"的核对与显示,
 * 以及 profile 里 `role.preset` 这个人类可读标签。
 */
const PRESET_IDS = { pm: 'wf-pm', arch: 'wf-arch', be: 'wf-be', fe: 'wf-fe', qa: 'wf-qa' }

/**
 * 角色人设(必须显式透传给子会话,否则角色会顶着主会话的默认人格)。
 * **唯一事实来源**:人工入口预设(可选)若要装,其 persona prefix 应与此处逐行一致
 * —— 人肉同步会漂移;默认不装预设,这条约束自然消失。
 */
const PERSONAS = {
  pm: [
    '你是 dev-workflow 流程中的 ① 项目经理:把模糊需求变成清晰可执行的规划。',
    '职责边界:只管需求、优先级与验收标准,不做技术设计与编码。',
    '产出契约:写入 docs/workflow/项目经理.md,固定小节——需求背景 / 需求清单(ID|描述|优先级 P0-P2|可测验收标准)/ 假设列表 / 排期(按需)/ 给架构师的提醒。',
    '技术可行性问题一律互呼 @arch,不自行拍定。需求最终稿必须停下来交用户审核(唯一不受「开工授权」影响的硬关卡)。',
    '联动技能(按需加载):需求模糊时 `skill name=grill-me`(2-3 问的澄清法,问完即走);需求清晰就不加载,别为用而用。',
  ].join('\n'),
  arch: [
    '你是 dev-workflow 流程中的 ② 架构师:决定系统怎么搭。',
    '职责边界:技术选型、模块划分、数据模型、API 契约、可行性结论;不写业务代码。',
    '产出契约:写入 docs/workflow/架构师.md,固定小节——架构决策记录(ADR,含被否方案)/ 模块划分 / 数据模型 / API 契约 / 可行性结论 / 给开发的提醒。',
    'API 规范:项目有接口时,先 `skill name=api-architect` 加载 API 设计规范,按 `api_contract action=guide` 选范式、`action=template` 取模板产出 spec(OpenAPI 3.1 / GraphQL SDL / .proto)落到 docs/api/,再用 `api_contract action=lint` 自检到 ERROR 0 才准写「API 契约」小节(verdict 必须是 `pass`:`no_specs` = spec 根本没落地;`pass_with_skips` = 有候选被跳过、这条结论只覆盖一部分候选 —— 这两种都不是通过,要把跳过消掉或显式登记为未校验);spec 路径 + 版本策略 + lint 结论(含覆盖面)必须写进该小节。spec 是接口的唯一基准。',
    '架构师.md 是实现的唯一基准。任何修订都必须在「给开发的提醒」里标注受影响集,并要求下游显式确认。',
    '可行性不可行时当场指出并回退到项目经理重定需求,不等到代码写完才发现白干。',
    '联动技能(按需加载):画架构图 `skill name=architecture-diagram`(HTML+SVG)或 `skill name=excalidraw`(手绘风 JSON);方案最小化与可行性反驳 `skill name=ponytail`、`skill name=grill-me`;API 规范见上一条的 `skill name=api-architect`。',
  ].join('\n'),
  be: [
    '你是 dev-workflow 流程中的 ③ 后端开发者:把设计变成后端代码。',
    '职责边界:只做后端实现,不评估需求合理性。',
    '契约基准:严格按 架构师.md 的 API 契约/数据模型/模块划分执行,不自由发挥。发现契约疑点先按契约实现,把疑点记入「与设计的偏差」并互呼 @arch。',
    '接口基准:docs/api/ 下的 spec 就是接口事实来源——路径、方法、字段名与类型、状态码、错误码逐一对齐;没有 spec 不得自己发明接口,先互呼 @arch。',
    '改码必验:每改完一个模块立即编译或跑相关测试,报错当场修;最多自动重试 3 轮,仍失败才上报(附错误摘要与已尝试的修复)。',
    '产出契约:写入 docs/workflow/开发者-后端.md,固定小节——改动清单 / 自测证据(命令+关键输出+是否通过)/ 与设计的偏差 / 给质检的提醒。复测回报必须附原始输出。',
    '联动技能(按需加载):通用 `skill name=ponytail`(最小改动)、`skill name=systematic-debugging`(先定根因再改码)、`skill name=test-driven-development`;**按项目技术栈挑一路** —— Java/Spring 用 `spring-boot-project-creator` / `spring-boot-crud-patterns` / `spring-boot-rest-api-standards` / `spring-boot-test-patterns`,Python/Django 用 `django-patterns` / `django-security` / `django-tdd` / `python-project-structure` / `python-error-handling`;动手前探路用 `skill name=spike`。',
  ].join('\n'),
  fe: [
    "你是 dev-workflow 流程中的 ③' 前端开发者:把设计变成前端页面。",
    '职责边界:只做前端实现与联调配合,不评估需求合理性、不做后端实现。',
    '契约基准:严格按 架构师.md 的 API 契约执行;mock 字段结构/响应格式也要对齐契约,不自己发明。契约疑点先按契约实现并互呼 @arch。',
    '接口基准:调接口一律以 docs/api/ 下的 spec 为准(路径/参数/字段结构/错误结构照抄);spec 缺失或与页面需求矛盾,先互呼 @arch,不自行发明字段。',
    '改码必验:每改完一个模块立即 npm run build(或 lint),报错当场修;最多自动重试 3 轮。',
    '产出契约:写入 docs/workflow/开发者-前端.md,固定小节——改动清单 / 自测证据 / 与设计的偏差 / 联调结果 / 给质检的提醒。',
    '联动技能(按需加载):`frontend-design`(定视觉方向)、`impeccable`(界面打磨)、`ui-ux-pro-max`(规则库)—— 挑 1-2 个加载,不一次全挂。',
  ].join('\n'),
  qa: [
    '你是 dev-workflow 流程中的 ④ 质检员:验收代码质量,是唯一的独立把关者。',
    '绝对职责边界:你不改代码。产出永远是「问题 + 修改要求 + 建议修法」,动手修复一律回 ③ 开发者。',
    '独立性:只依据代码文件与契约/需求文档评审,不看实现说明里的设计意图,避免自我辩护。',
    '问题分级:🔴 严重(功能正确性/数据错误/安全/阻断主流程)、🟡 一般(边界/健壮性/性能)、🟢 建议(风格/可读性)。🔴🟡 必须附「可直接粘贴的修复补丁」,禁止抽象描述。',
    '交付门槛:编译失败、有测试而通过率<100%、存在未修严重问题、关键路径联调不通 → 任一即不交付,回 ③ 修。唯一允许低于全绿的是显式登记的「已知失败白名单」(用例名+地址+原因分类+责任人+排期+复核日期),到期未解除自动失效。',
    'API 门槛:项目有接口时,`api_contract action=lint` 必须 ERROR 0 **且真的扫到了契约文件**(verdict 必须是 `pass` —— `no_specs` 是一个 spec 都没有时的"空集通过";`pass_with_skips` 是有候选被跳过、结论只覆盖 M/N 个候选,也不许当作已过门槛),并按 `action=checklist` 逐条核对实现与 spec(路径/方法/字段/状态码/错误码/分页/鉴权);不符即 🔴 回 ③,不许"文档归文档、代码归代码"。',
    '产出契约:写入 docs/workflow/质检员.md,固定小节——结论 / 问题清单(等级|位置 文件:行|描述|修改要求|可粘贴补丁)/ 测试结果(覆盖范围含核心路径|通过率|遗留风险)/ DoD 判定。',
    '跳过测试必须声明为「无测试基建,跳过自动测试」,并把被跳过的覆盖范围作为遗留风险显式登记,不得留空。',
    '联动技能(按需加载):代码评审 `skill name=requesting-code-review`、测试设计评审 `skill name=testing-strategy`、接口核对 `skill name=api-docs`、测试写法按技术栈挑 `spring-boot-test-patterns` / `python-testing-patterns`;前端验收时挑 `frontend-design` / `impeccable` / `ui-ux-pro-max` 中的 1-2 个,后端项目不加载。',
  ].join('\n'),
}

/**
 * **本机环境约束**随人格一起注入角色子会话。
 *
 * 不注入的话:角色按文档写 `pwsh -File …`(本机只有 PS 5.1)必失败,还得自己证明"这是环境
 * 不是我的代码";`node --test` 因沙箱禁止管道 stdio 必然 `spawn EPERM`,而"通过率 <100% 不
 * 交付"的人设会把它当成代码缺陷。文档里没有这些约束,角色只能自己踩 —— 所以替它先踩一次。
 *
 * 放在**注入时拼接**而不是写进 PERSONAS:人设是"角色是谁",环境约束是"这台机器长什么样",
 * 两者生命周期不同(换机器只改这一处);同时也避免与可选入口预设的"同源校验"打架。
 */
const ENV_NOTES = [
  '【本机环境约束(实测;踩到这些一律按"环境"登记,不要写成代码缺陷)】',
  '· 没有 PowerShell 7:只有 Windows PowerShell 5.1 —— 命令写 `powershell -File …`,不要写 `pwsh -File …`。',
  '· PS 5.1 的 `2>` 抓到的不是原生 stderr(是 ErrorRecord 包装 + UTF-16LE BOM):要字节级证据用 `cmd /c "… > out.txt 2> err.txt"`。',
  '· 控制台默认 GBK:Python 打印非 ASCII(如 ↔)会 `UnicodeEncodeError` → 先 `$env:PYTHONIOENCODING="utf-8"`,必要时再设 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`。',
  '· 沙箱禁止管道 stdio:`spawnSync` 默认 `stdio:"pipe"` → `EPERM`,因此 `node --test` 必然失败 —— 属**环境阻断**,登记为"环境失败、通过率无法计算"。',
  '· 插件写不了工作区:`台账投影:插件直写被拒`是设计如此,按提示交给主会话 write 落盘。',
  '· 报通过率必须带三元组(**命令 + 采集时刻 + 工作树哈希**),否则两个人都"有证据"却互相反驳不了。',
].join('\n')

/** readonly 角色的工具白名单(质检/架构核对用)。
 *  注意 api_contract 必须在里面:它是只读工具(模板回全文交会话落盘、lint 只读文件),
 *  而 qa 在 standard 档案里就是只读角色、人设里又被要求跑 lint/checklist —— 漏一个就自相矛盾。 */
const READONLY_ALLOW = [
  'read', 'glob', 'grep', 'skill', 'relay', 'send_message', 'list_agents',
  'workflow_state_status', 'workflow_state_load', 'api_contract',
]

/**
 * profile = 一份纯数据(角色集 + 人格 + 模型 + relay 规则 + 状态文件)。
 * 这是「多档案」的落点:切 profile 不写代码、不加 preset 文件。
 */
const BUILTIN_PROFILES = {
  standard: {
    label: '标准五角色',
    desc: 'pm/arch/be/fe/qa 完整流程(角色子会话由 relay_spawn 派出,人格来自 persona)。',
    coordinator: 'pm',
    roles: ['pm', 'arch', 'be', 'fe', 'qa'],
    readonly: { qa: true },
    relay: { limit: RELAY_LIMIT, windowMs: RELAY_WINDOW_MS, autoDeliver: true },
  },
  lean3: {
    label: '精简三角色',
    desc: 'pm/be/qa:小需求或原型期,砍掉架构与前端两条并行线。',
    coordinator: 'pm',
    roles: ['pm', 'be', 'qa'],
    readonly: { qa: true },
    relay: { limit: RELAY_LIMIT, windowMs: RELAY_WINDOW_MS, autoDeliver: true },
  },
  review: {
    label: '评审双角色(只读)',
    desc: 'arch/qa:只做架构评审与质检,不产出代码;两个角色都是只读工具集。',
    coordinator: 'arch',
    roles: ['arch', 'qa'],
    readonly: { arch: true, qa: true },
    relay: { limit: 8, windowMs: RELAY_WINDOW_MS, autoDeliver: true },
  },
}

/**
 * 默认模板若是**档案盲**的常量,会有两个后果:
 *   · `lean3`(无 arch)/ `review`(无 pm)里,"下一步:① 项目经理"指向一个**不存在的角色**;
 *   · 更隐蔽的是「产出文件」预填了两份 .md,而 kickoff 生成初始文档时不传 outputs,
 *     于是这两行被保留,`summarize()` 再把它读进 outputs ——
 *     **流程状态文档从诞生第一秒就在撒谎**,回报两个根本不存在的产出。
 * 现在按档案的协调者现算;不传参数时 = 标准档案,与旧常量逐字一致(自测 10.x / 20.5 依赖)。
 */
export function defaultHeader(opts) {
  const o = opts || {}
  const coord = String(o.coordinator || 'pm')
  const coordLabel = ROLE_LABELS[coord] || coord
  return [
    '# 流程状态', '', '## 当前进度', '- 已完成:(无)', '- 当前角色:(无)', `- 下一步:${coordLabel}`,
    '', '## 产出文件', '- (无)',
    '', '## API 契约', '- (无接口;有接口时 ② 架构师产出 spec 到 docs/api/ 并跑到 api_contract lint ERROR 0)',
    '', '## 待办', `- [ ] ${coordLabel} 理需求`,
    '', '## 契约修订台账', '- (无)',
    '', '## 遗留风险', '- (无)', '',
  ].join('\n')
}

/** 标准档案的默认模板由 `defaultHeader()` 现算;需要常量时调用 `defaultHeader()`。 */

const DOC_BEGIN = '-----BEGIN 流程状态.md-----'
const DOC_END = '-----END 流程状态.md-----'
const LEDGER_BEGIN = '-----BEGIN 协作台账.md-----'
const LEDGER_END = '-----END 协作台账.md-----'

function makeTS(ms) {
  const d = ms === undefined ? new Date() : new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 稳定短哈希(去重用),不引 crypto。 */
export function hashText(text) {
  const s = String(text)
  let h = 5381
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(16)
}

export function extractRelayMarks(text) {
  const all = extractRelayMarksAll(text)
  if (!all) return null
  // ⚠️ 返回值必须保持**逐字原样**的 `{to,msg}`:selftest 1.1/1.4b/1.5/1.6 用
  // `JSON.stringify(...) === JSON.stringify({to,msg})` 比,多挂一个字段就红。
  // 所以"还发现了别的标记"这件事走下面的 extractRelayMarksAll,不塞进这个对象。
  const last = all[all.length - 1]
  return { to: last.to, msg: last.msg }
}

/**
 * 一条回覆里可以同时招呼两个人。若只 `MARK_RE.exec(最后一行)`、**只认最后一条** `@relay`
 * (如一段总结末尾同时写 `@relay:qa 请复测` 与 `@relay:arch 请评审`),前一条会被**静默丢弃**,
 * 而回执与渲染照样写"标记 @arch: …",调用者以为两个人都收到了 —— 漏掉的那个永远不会回话,
 * 也没人知道它被漏掉了。
 *
 * 这个函数把末行的**全部**标记取出来(顺序即出现顺序),交给调用处决定怎么说。
 * 与其他标记口径一致的部分:
 *   · **只在最后一个非空行找** —— 正文中间提到的 `@relay:be …` 是引用,不是回话指令
 *     (selftest 1.2 守的就是它);
 *   · 只做**语法**校验:成员校验交给 profile,自定义档案的角色名照样认。
 * 末行写多条时的处理:全部取出(`MARK_RE` 的正文是 lazy 的,单标记时正好吃到行尾;
 * 多标记时它会把后面那条一起吞进正文,所以按"空格 + 后面紧跟 `@relay:`"二次切分)。
 * 正文里引用别人的 `@relay:` 字样会被当成一条 —— 那种引用本来就不该写在标记行里;
 * 真发生也只是"多报了一条"(调用处会明说只转发了哪一条),不会静默丢掉。
 */
export function extractRelayMarksAll(text) {
  if (!text || typeof text !== 'string') return null
  const lines = text.split(/\r?\n/).filter((ln) => ln.trim() !== '')
  if (lines.length === 0) return null
  const one = MARK_RE.exec(lines[lines.length - 1])
  if (!one) return null
  const marks = []
  // 回答标记 `@relay:<角色>` 的解析不能写死内置角色集 —— 否则自定义档案的角色
  // 无法用它回话。改为接受任何合法角色名;是否属于当前 profile 由调用处按 profile 判定。
  const parts = String(one[2]).split(/\s+(?=\S*@relay:)/).filter((s) => s.trim() !== '')
  if (/^[a-z][a-z0-9_-]*$/.test(one[1])) marks.push({ to: one[1], msg: String(parts[0] || '').trim() })
  // 其余段落形如 `@relay:arch 评审`(前面没有行首空白),用宽松形式解
  for (const p of parts.slice(1)) {
    const loose = /@relay:([a-zA-Z]+)\s+(.+?)\s*$/.exec(p.trim())
    if (loose && /^[a-z][a-z0-9_-]*$/.test(loose[1])) marks.push({ to: loose[1], msg: loose[2].trim() })
  }
  return marks.length === 0 ? null : marks
}

function finish(parts, status, note, extra) {
  const out = { status, note, attempts: parts.slice() }
  if (extra) for (const k of Object.keys(extra)) out[k] = extra[k]
  return out
}

/**
 * 给状态文件路径插入 `-<需求名>`(提到模块级,便于 selftest 直接测)。
 * 不能只写 `base.replace(/流程状态/, ...)`:自定义档案把 `state.file` 设成
 * 不含"流程状态"字样的路径(如 `docs/workflow/state.md`)时,replace 匹配不上、**原样返回**,
 * 于是"切到子流程"静默失效(所有流程仍写同一份文件),而回执还在宣称已切换。
 * 所以:含"流程状态"照旧插在词后;否则插在扩展名之前(没有扩展名就追加在末尾)。
 */
export function withStateName(base, nm) {
  const s = String(base || '')
  if (s.includes('流程状态')) return s.replace(/流程状态/, `流程状态-${nm}`)
  const ext = path.extname(s)
  return ext ? `${s.slice(0, -ext.length)}-${nm}${ext}` : `${s}-${nm}`
}

/**
 * `statSync` 失败的**分类**(提到模块级,便于 selftest 直接测判定规则)。
 * 只有"确实不存在"算已删;其余(EACCES/EBUSY/EPERM/EIO/网络盘断连…)一律按
 * "暂时读不到"处理 —— 把所有失败都当成已删,会因一次瞬时故障就清空合法绑定。
 */
export function classifyRootError(code) {
  const c = String(code || '')
  return (c === 'ENOENT' || c === 'ENOTDIR') ? 'gone' : 'io'
}

// ── profile 归一化 ──────────────────────────────────────────────────────────

function normalizeProfile(id, raw, base) {
  const src = raw || {}
  const b = base || {}
  // base.roles 可能是「内置的字符串 id 列表」,也可能是「已归一化的角色对象列表」
  // (用户只覆盖 relay 等字段时,base 传进来的就是已归一化的结果)。
  // 两种形态都要能当基线,否则部分覆盖会把角色集塌成对象 —— 角色表随即失效。
  const baseRoles = Array.isArray(b.roles) ? b.roles : []
  const baseById = {}
  const baseIds = []
  for (const r of baseRoles) {
    if (typeof r === 'string' && r) { baseById[r] = {}; baseIds.push(r) }
    else if (r && typeof r === 'object' && r.id) { baseById[String(r.id)] = r; baseIds.push(String(r.id)) }
  }
  const srcRoles = Array.isArray(src.roles) && src.roles.length > 0 ? src.roles : null
  const roleIds = srcRoles
    ? srcRoles.map((r) => (typeof r === 'string' ? r : String((r && r.id) || ''))).filter((r) => r !== '')
    : (baseIds.length > 0 ? baseIds.slice() : ['pm'])
  const roleOverrides = {}
  if (srcRoles) {
    for (const r of srcRoles) if (r && typeof r === 'object' && r.id) roleOverrides[String(r.id)] = r
  }
  const readonly = Object.assign({}, b.readonly || {}, src.readonly || {})
  const roles = roleIds.map((rid) => {
    const o = roleOverrides[rid] || {}
    const pr = baseById[rid] || {}
    return {
      id: rid,
      label: String(o.label || pr.label || ROLE_LABELS[rid] || rid),
      preset: String(o.preset || pr.preset || PRESET_IDS[rid] || `wf-${rid}`),
      persona: String(o.persona || pr.persona || PERSONAS[rid] || `你是 dev-workflow 的 ${rid} 角色。`),
      readonly: o.readonly === undefined ? (readonly[rid] === true || pr.readonly === true) : o.readonly === true,
      provider: o.provider ? String(o.provider) : (pr.provider || ''),
      model: o.model ? String(o.model) : (pr.model || ''),
      /**
       * 角色的 reasoning effort 默认档 —— "便宜角色用便宜档"的落点。
       * 缺省空串 = 不写 agentOptions.reasoningEffort,子会话继续继承调度者的
       * agentReasoningEffort(即 "max"),保持既有行为,不改变任何既有档案的成本。
       * 用法(profiles.json 或组合 config 的 profiles):
       *   { "roles": [{ "id": "qa", "reasoningEffort": "low" }] }
       */
      reasoningEffort: o.reasoningEffort ? String(o.reasoningEffort) : (pr.reasoningEffort || ''),
    }
  })
  return {
    id,
    label: String(src.label || b.label || id),
    desc: String(src.desc || b.desc || ''),
    coordinator: String(src.coordinator || b.coordinator || roles[0].id),
    roles,
    relay: {
      limit: Number((src.relay && src.relay.limit) || (b.relay && b.relay.limit) || RELAY_LIMIT),
      windowMs: Number((src.relay && src.relay.windowMs) || (b.relay && b.relay.windowMs) || RELAY_WINDOW_MS),
      autoDeliver: !((src.relay && src.relay.autoDeliver === false) || (b.relay && b.relay.autoDeliver === false)),
      waitTimeoutMs: Number((src.relay && src.relay.waitTimeoutMs) || (b.relay && b.relay.waitTimeoutMs) || WAIT_TIMEOUT_MS),
      replyClosesWait: !((src.relay && src.relay.replyClosesWait === false) || (b.relay && b.relay.replyClosesWait === false)),
    },
    state: {
      file: String((src.state && src.state.file) || (b.state && b.state.file) || DEFAULT_STATE_REL),
      ledger: String((src.state && src.state.ledger) || (b.state && b.state.ledger) || DEFAULT_LEDGER_REL),
    },
  }
}

/** 把 BUILTIN_PROFILES + 用户 profiles.json + 组合 config 合成可用 profile 表。 */
export function buildProfileTable(userProfiles, configProfiles) {
  const table = {}
  for (const id of Object.keys(BUILTIN_PROFILES)) {
    const b = BUILTIN_PROFILES[id]
    table[id] = normalizeProfile(id, { label: b.label, desc: b.desc, coordinator: b.coordinator, roles: b.roles, readonly: b.readonly, relay: b.relay }, b)
  }
  for (const src of [userProfiles, configProfiles]) {
    if (!src || typeof src !== 'object') continue
    for (const id of Object.keys(src)) {
      // 自定义档案**不继承** standard 的 label/desc。若拿 standard 当兜底,
      // 回显会自相矛盾:`platform6 — 平台六角色(大项目)(pm/arch/be/fe/dba/qa) pm/arch/be/fe/qa 完整流程(…)`
      // —— 前半是自己写的,后半是 standard 的描述。角色级人格/preset 仍然从同名内置角色继承(那是有用的)。
      const base = Object.assign({}, table[id] || BUILTIN_PROFILES.standard, { label: undefined, desc: undefined })
      table[id] = normalizeProfile(id, src[id], base)
    }
  }
  return table
}

export function roleOf(profile, id) {
  if (!profile) return undefined
  for (const r of profile.roles) if (r.id === id) return r
  return undefined
}

// ── 互呼协调器(语义定稿:此后只做缺陷修复,不改语义)────────────────────

/**
 * RelayCoordinator — 纯逻辑,不碰任何服务。
 * `waiting` 的值**必须**保持为角色字符串(自测 2/3/5/6/8 节直接断言它的 JSON),
 * 额外元数据(waitMeta)另存,避免污染。
 */
export class RelayCoordinator {
  constructor(limit, windowMs) {
    this.waiting = {}
    this.waitMeta = {}
    this.relayTs = {}
    this.limit = Number(limit) || RELAY_LIMIT
    this.windowMs = Number(windowMs) || RELAY_WINDOW_MS
  }

  checkDeadlock(from, to) {
    /**
     * 只有"链走回 from"才是真死锁(新边 from→to 与既有等待链构成环)。
     * 把 `seen` 重入也判成环是错的 —— 环只可能来自 hydrate(盘上的旧等待图),
     * 于是任意第三方 D→环内节点都会被判"你与 @X **互相等待**":通知文案不实(D 什么都没等),
     * D 的正文被扣进仲裁,环上的中间节点还会被无声解绑。不含 from 的环与本次互呼无关。
     */
    let cur = to
    const seen = new Set()
    while (Object.prototype.hasOwnProperty.call(this.waiting, cur)) {
      if (seen.has(cur)) return false // 不含 from 的环:与本次互呼无关
      seen.add(cur)
      cur = this.waiting[cur]
      if (cur === from) return true // 链走回 from = 真死锁(新边 from→to 与旧链成环)
    }
    return false
  }

  breakWaitChain(from, to) {
    let cur = to
    const cleared = []
    while (Object.prototype.hasOwnProperty.call(this.waiting, cur) && cleared.indexOf(cur) === -1) {
      cleared.push(cur)
      const nxt = this.waiting[cur]
      delete this.waiting[cur]
      delete this.waitMeta[cur]
      if (nxt === from) break
      cur = nxt
    }
    return cleared
  }

  windowCheck(from, to, project) {
    const key = `${from}\u0000${to}\u0000${project}`
    const now = Date.now()
    let dq = this.relayTs[key]
    if (!dq) { dq = []; this.relayTs[key] = dq }
    while (dq.length > 0 && now - dq[0] > this.windowMs) dq.shift()
    return { ok: dq.length < this.limit, used: dq.length, key }
  }

  release(from) {
    delete this.waiting[from]
    delete this.waitMeta[from]
    return true
  }

  markWait(from, to, msg) {
    this.waiting[from] = to
    this.waitMeta[from] = { to, ts: makeTS(), since: Date.now(), msg: String(msg || '').slice(0, 120) }
  }

  tryRelay(from, to, msg, project, writeBack, opts) {
    const ts = makeTS()
    const pkey = project || 'no-project'
    const parts = []
    const deliver = typeof writeBack === 'function' ? writeBack : () => true
    const o = opts || {}
    /**
     * 熔断计数的分桶键**只能有一个**。`project` 参数现在是**人读的标签**(写进台账/仲裁事件),
     * 不再参与分桶 —— 把它当桶名,于是同一项目里出现 `[platform6@F:\…\l-platform]` 与
     * `[l-platform]` 两种键,10 分钟上限实际能发到约 2 倍(实测 6 对角色命中)。
     */
    const bucket = String(o.bucket || pkey)
    /**
     * 熔断/死锁升级时,除了通知发起方,还要把事件推给协调者(只进队列没人推 = 升级等于没发生)。
     *
     * 不能写成 `if (coordRole === '' || coordRole === from || coordRole === to) return` ——
     * 把"协调者就是互呼一方"的升级**静默丢掉** —— 而 standard 档的协调者正是 @pm,
     * 于是 @pm 自己发起的互呼熔断、或别人发给 @pm 的互呼熔断,升级事件**没有一方收到**,
     * 回执与台账却宣称"已升级主线程仲裁" —— 而 status 里连 escalate 这一格都不会有。
     * 所以:协调者是一方时改投**它的父会话(主会话)**,没有父会话可投就换第三个角色;
     * 两条路都不通时如实返回 ok:false,由 limit/deadlock 分支改写回执 —— 不宣称"已升级"。
     * 返回值被调用处用来措辞,parts 里始终能看出**这次到底投给了谁**(target 字段)。
     */
    const escalateTo = (notice) => {
      const coordRole = String(o.coordinator || '')
      if (coordRole === '') return { ok: false, target: '', reason: 'profile 未配协调者(coordinator 为空)' }
      const direct = coordRole !== from && coordRole !== to
      const candidates = direct ? [coordRole] : [MAIN_SESSION_ROLE]
      if (!direct) {
        // 协调者是一方 → 再退一步:换一个既不是发起方、也不是目标、也不是协调者的角色
        const others = (Array.isArray(o.roles) ? o.roles : []).filter((r) => r !== from && r !== to && r !== coordRole)
        if (others.length > 0) candidates.push(others[0])
      }
      const tries = []
      for (const target of candidates) {
        const okc = deliver(target, notice) !== false
        tries.push({ target, delivered: okc })
        if (okc) break
      }
      const hit = tries.filter((t) => t.delivered)[0] || null
      parts.push({
        actor: 'escalate',
        target: hit ? hit.target : tries.map((t) => t.target).join(','),
        delivered: !!hit,
      })
      if (hit) return { ok: true, target: hit.target, reason: '' }
      return {
        ok: false, target: '',
        reason: direct
          ? `协调者 @${coordRole} 投不出去(没有可用投递身份)`
          : `协调者 @${coordRole} 就是本次互呼的一方,且没有可投递的主会话或第三方角色`,
      }
    }

    /**
     * 在这里**直接 return** 会把消息正文整条丢掉,只回发起方一句
     * "你被忽略了":正文整条丢失,而 status 里连"丢弃"这一格都不会有。
     * 所以:等待图仍然**不被改写**(死锁检测依赖 waiting 是单值函数),
     * 但正文照常投给目标,并计入滑动窗口(直接 return 连熔断计数都绕过了)。
     * 自测 5.1/5.2 依赖 status==='busy' 且 waiting 不被覆盖,这里逐条保住。
     */
    if (Object.prototype.hasOwnProperty.call(this.waiting, from)) {
      const prev = this.waiting[from]
      // 通知文案必须基于**真实投递结果**,所以它不能再在这里发 —— 此处还不知道 sentB。
      // 这里不能写死"已并线送达,无需重发" —— 投递失败时既谎报成功又劝止补救。文案见下方 sentB 之后。
      const winB = this.windowCheck(from, to, bucket)
      if (!winB.ok) {
        // 只喊"已升级主线程仲裁"就结束是不够的 —— 被拦下的正文在仲裁队列里,
        // 而**取回正文的唯一动作** relay action=arbitrate 在通知/回执/status 里一次都没出现,
        // 于是发起方只能反复重投同一对角色(仍然 limit),这一对角色 10 分钟内完全不可用。
        // 所以:通知里点名取回动作;升级投给谁按 escalateTo 的真实结果措辞(没投出去就不许说"已升级")。
        const lim = `${PREFIXES.circuit}本窗口互呼已达上限(${winB.used}/${this.limit}次)。本次互呼已熔断,正文**未投给 @${to}**、已扣进仲裁队列 —— 用 relay action=arbitrate 可取回原文。`
        const sentL = deliver(from, lim) !== false
        parts.push({ actor: 'limit-breaker', target: from, delivered: sentL, used: winB.used })
        const escL = escalateTo(`${PREFIXES.circuit}@${from}→@${to} 互呼超限(${winB.used}/${this.limit}),正文已扣进仲裁队列(用 relay action=arbitrate 取回),需要你裁决。`)
        return finish(parts, 'limit', `@${from} 互呼超限(${winB.used}/${this.limit}),已熔断;${escL.ok ? `升级已投给 @${escL.target}` : `升级**未投出**(${escL.reason})`}`, {
          arbitration: { ts, from, to, msg, reason: 'limit', project: pkey },
          ledger: { ts, from, to, summary: msg, status: '🔴 熔断-超限', note: `窗口内已 ${winB.used} 次(上限 ${this.limit});正文在仲裁队列(relay action=arbitrate 取回);升级${escL.ok ? `已投 @${escL.target}` : `未投出(${escL.reason})`}` },
          escalatedTo: escL.ok ? escL.target : '',
        })
      }
      this.relayTs[winB.key] = this.relayTs[winB.key] || []
      const stampB = Date.now()
      this.relayTs[winB.key].push(stampB)
      const forwardB = `${PREFIXES.forward}@${from} 直接向你提问(请直接回答,无需转述):\n${msg}`
      const sentB = deliver(to, forwardB) !== false
      // 投递失败不该占熔断额度。插件自己的补救指令就是"重发",若失败也计数,
      // 第 6 次会返回"本窗口已达上限,请先收敛需求" —— 熔断理由与真实成因无关。
      if (!sentB) {
        const arrB = this.relayTs[winB.key] || []
        const iB = arrB.lastIndexOf(stampB)
        if (iB !== -1) arrB.splice(iB, 1)
      }
      parts.push({ actor: 'forward-busy', target: to, delivered: sentB })
      // 发起方通知按**真实投递结果**生成。失败时必须明说未送达并要求重发 ——
      // 无条件宣称"已并线送达,无需重发",是"静默丢消息 + 劝止补救"的源头。
      const noticeB = sentB
        ? `${PREFIXES.busy}你已有互呼在等 @${prev} 回答(等待关系保持不改写)。本次发给 @${to} 的正文已并线送达,无需重发。`
        : `${PREFIXES.busy}你已有互呼在等 @${prev} 回答(等待关系保持不改写)。⚠️ **本次发给 @${to} 的正文未送达**,请重发。`
      const sentI = deliver(from, noticeB) !== false
      parts.push({ actor: 'busy-notice', target: from, delivered: sentI })
      // 返回给模型的正文同样必须与 sentB 一致(写死"已并线送达"就会与真实结果不符)
      return finish(parts, 'busy', sentB
        ? `@${from} 已在等待 @${prev};本次正文已并线送达 @${to}(等待关系未改写)`
        : `@${from} 已在等待 @${prev};⚠️ 本次正文**未送达** @${to},请重发(等待关系未改写)`, {
        ledger: {
          ts, from, to, summary: msg,
          status: sentB ? '🔀 并线送达' : '⚠️ 并线失败',
          note: sentB ? `已在等 @${prev},等待图未改写` : `已在等 @${prev};**投递失败、正文未送达**,等待图未改写`,
        },
        busyOn: prev, delivered: sentB,
        merged: sentB, // 恒为 true 会让 busyMerged 把失败计成成功
      })
    }

    if (this.checkDeadlock(from, to)) {
      // 拆环若只通知发起方 —— 环上的中间节点等待被无声删除,
      // 它们会一直以为对方会回覆(而那条回覆永远不会来)。这里先拍一份"谁在等谁"的快照,
      // 拆完之后逐个告知"你的等待已被拆环释放"。
      const before = Object.assign({}, this.waiting)
      const cleared = this.breakWaitChain(from, to)
      // 只停在"已升级主线程仲裁" —— 被扣下的正文在仲裁队列里,
      // 而取回它的唯一动作 relay action=arbitrate 从未出现在这句通知里(通知/回执/status 三处都没有)。
      // 这里把"正文去哪了 + 怎么取回"一句话说全,拆环语义与"死锁"字样保持不变(自测 6.3/9.2 靠它)。
      const notice = `${PREFIXES.circuit}检测到互呼死锁环(你与 @${to} 互相等待)。本次互呼已熔断,正文**未投给 @${to}**、已扣进仲裁队列 —— 用 relay action=arbitrate 可取回原文。请暂停等待,回到主任务。`
      const sentD = deliver(from, notice) !== false
      parts.push({ actor: 'deadlock-breaker', target: from, delivered: sentD, cleared })
      const notified = []
      for (const n of cleared) {
        if (n === from) continue
        const wasWaitingFor = String(before[n] || '')
        const nNotice = `${PREFIXES.circuit}检测到互呼环并已拆环:你等 @${wasWaitingFor || '(未知)'} 的等待关系**已被释放**,不必再等那条回覆。请回到主任务,或重新发起互呼。`
        const okn = deliver(n, nNotice) !== false
        notified.push({ role: n, wasWaitingFor, delivered: okn })
      }
      if (notified.length > 0) parts.push({ actor: 'deadlock-notify', targets: notified.map((x) => x.role).join(','), delivered: notified.every((x) => x.delivered) })
      const escD = escalateTo(`${PREFIXES.circuit}@${from}→@${to} 形成死锁环(已拆环:${cleared.join('→') || '无'};已通知 ${notified.length} 个中间节点),正文在仲裁队列(用 relay action=arbitrate 取回),需要你裁决。`)
      return finish(parts, 'deadlock', `@${from}→@${to} 形成死锁环,已拆环并熔断;${escD.ok ? `升级已投给 @${escD.target}` : `升级**未投出**(${escD.reason})`}`, {
        arbitration: { ts, from, to, msg, reason: 'deadlock', project: pkey },
        ledger: {
          ts, from, to, summary: msg, status: '🔴 熔断-死锁',
          // 不能再无条件写"已升级仲裁队列" —— 升级没投出去就如实说(自测 24.7 依赖
          // 后半句"已通知 N 个中间节点",逐字保留)。
          note: `${escD.ok ? `升级已投 @${escD.target}` : `升级未投出(${escD.reason})`};拆环:${cleared.join('→') || '无'};已通知 ${notified.length} 个中间节点${notified.filter((x) => !x.delivered).length > 0 ? `(其中 ${notified.filter((x) => !x.delivered).length} 个通知**未送达**)` : ''}`,
        },
        deadlockCleared: cleared,
        deadlockNotified: notified,
        escalatedTo: escD.ok ? escD.target : '',
      })
    }

    const win = this.windowCheck(from, to, bucket)
    if (!win.ok) {
      // 这一格是"死路"—— 只给出"禁止投递"四个字,
      // 发起方重投同一对角色仍然 limit,该对角色整整一个窗口(默认 10 分钟)不可用,
      // 而本次正文停在仲裁队列里,**没有任何一句话告诉人怎么取回**。
      // 现在通知里点名 relay action=arbitrate;nextActions 由 relay 工具侧补齐(等窗口 / 改道第三方)。
      const notice = `${PREFIXES.circuit}本窗口互呼已达上限(${win.used}/${this.limit}次)。本次互呼已熔断,正文**未投给 @${to}**、已扣进仲裁队列 —— 用 relay action=arbitrate 可取回原文。`
      const sentL = deliver(from, notice) !== false
      parts.push({ actor: 'limit-breaker', target: from, delivered: sentL, used: win.used })
      const esc = escalateTo(`${PREFIXES.circuit}@${from}→@${to} 互呼超限(${win.used}/${this.limit}),正文已扣进仲裁队列(用 relay action=arbitrate 取回),需要你裁决。`)
      return finish(parts, 'limit', `@${from} 互呼超限(${win.used}/${this.limit}),已熔断;${esc.ok ? `升级已投给 @${esc.target}` : `升级**未投出**(${esc.reason})`}`, {
        arbitration: { ts, from, to, msg, reason: 'limit', project: pkey },
        ledger: { ts, from, to, summary: msg, status: '🔴 熔断-超限', note: `窗口内已 ${win.used} 次(上限 ${this.limit});正文在仲裁队列(relay action=arbitrate 取回);升级${esc.ok ? `已投 @${esc.target}` : `未投出(${esc.reason})`}` },
        escalatedTo: esc.ok ? esc.target : '',
      })
    }

    this.markWait(from, to, msg)
    this.relayTs[win.key] = this.relayTs[win.key] || []
    const stamp = Date.now()
    this.relayTs[win.key].push(stamp)
    const forward = `${PREFIXES.forward}@${from} 直接向你提问(请直接回答,无需转述):\n${msg}`
    const sent = deliver(to, forward) !== false
    parts.push({ actor: 'forward', target: to, delivered: sent })
    if (!sent) {
      // 同 busy 分支 —— 没送达就不占额度(理由见那里的注释)。
      const arr = this.relayTs[win.key] || []
      const i = arr.lastIndexOf(stamp)
      if (i !== -1) arr.splice(i, 1)
      this.release(from)
      return finish(parts, 'no_reply', `@${to} 无已知 agent 会话,转发失败`)
    }
    return finish(parts, 'done', '已转发,等待目标回答')
  }

  /** 落盘用快照(waiting 保持原形,元数据另带)。 */
  snapshot() {
    return {
      waiting: Object.assign({}, this.waiting),
      waitMeta: Object.assign({}, this.waitMeta),
      relayTs: JSON.parse(JSON.stringify(this.relayTs)),
    }
  }

  hydrate(snap) {
    if (!snap || typeof snap !== 'object') return this
    this.waiting = Object.assign({}, snap.waiting || {})
    this.waitMeta = Object.assign({}, snap.waitMeta || {})
    this.relayTs = {}
    const src = snap.relayTs || {}
    for (const k of Object.keys(src)) this.relayTs[k] = Array.isArray(src[k]) ? src[k].slice() : []
    return this
  }
}

// ── 状态文档(纯函数区,便于单测)────────────────────────────────────────────

/**
 * 定位小节时必须**跳过围栏代码块里的同名标题**,并且容忍标题的空格变体。
 *
 * `findIndex(l => l.trim() === '## 待办')` 有两个真问题:
 * ① 文档靠前处若有**示例/模板/归档**里的 `## 待办`(常见于围栏代码块内),命中的就是它 ——
 *    改写会把那段示例破坏掉(连围栏收尾都被删),而真正的待办段一个字不动;
 * ② `##  待办`(多空格)这类写法匹配不上,于是**追加**一个新小节,旧段留下、两段并存。
 * 现在:围栏外才算命中,标题按 `^##\s+` 规范化比较(`###` 不算),多处命中取**最后一个**
 * (示例在前、真小节在后是文档的常态)。
 */
function sectionRange(lines, name) {
  const isMarker = (l) => l.indexOf('## ') === 0 || /^##\s/.test(l)
  const titleOf = (l) => (isMarker(l) && !/^###/.test(l.trim()) ? l.trim().replace(/^##\s+/, '') : null)
  let inFence = false
  let hit = -1
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]
    if (/^\s*```/.test(l)) { inFence = !inFence; continue }
    if (inFence) continue
    const t = titleOf(l)
    if (t !== null && t === name) hit = i
  }
  if (hit === -1) return null
  let end = lines.length
  inFence = false
  for (let i = hit + 1; i < lines.length; i += 1) {
    const l = lines[i]
    if (/^\s*```/.test(l)) { inFence = !inFence; continue }
    if (inFence) continue
    if (isMarker(l) && !/^###/.test(l.trim())) { end = i; break }
  }
  return { start: hit, end }
}

export function replaceSection(text, name, body) {
  const lines = String(text).split('\n')
  const marker = `## ${name}`
  const block = [''].concat([marker]).concat(String(body).split('\n'))
  const range = sectionRange(lines, name)
  if (range === null) return lines.concat(block).join('\n')
  const start = range.start
  const end = range.end
  let cut = start
  while (cut > 0 && lines[cut - 1].trim() === '') cut -= 1
  let tail = end
  while (tail < lines.length && lines[tail].trim() === '') tail += 1
  return lines.slice(0, cut).concat(block).concat(['']).concat(lines.slice(tail)).join('\n')
}

export function readSection(text, name) {
  const lines = String(text).split('\n')
  const range = sectionRange(lines, name)
  if (range === null) return ''
  return lines.slice(range.start + 1, range.end).join('\n').trim()
}

export function countOpenTodos(section) {
  let n = 0
  // 只认**行首**的 `- [ ]` —— 缩进 / `*` / `+` / 有序列表 / 多余空格全漏,
  // 而这个计数是"流程收口"的判据(实测:真实分组写法 5 条只报 2 条)。
  for (const l of String(section).split('\n')) {
    if (/^\s*(?:[-*+]|\d+[.)])\s+\[\s*\]\s*/.test(l)) n += 1
  }
  return n
}

function bulletList(items, empty) {
  if (!items || items.length === 0) return `- ${empty || '(无)'}`
  return items.map((s) => `- ${s}`).join('\n')
}

/**
 * 契约修订台账的**确认人反查**。
 *
 * 真因:台账把 `confirmedBy` 当自由字符串写进去,**从不校验被点名的角色是否真的参与过**。
 * 大档实机发生过一次:调度者 15:20:17 登记 REV-0006 时把确认人写成「@arch + @qa(只读复核)」,
 * 而它**从未向 @qa 发起该笔复核** —— 等于把"计划中的确认人"写成"已完成的确认人"。
 * 契约台账是审计件,而它最关键的"谁确认的"这一栏一直是**自证**。
 *
 * 判据(只用插件已有的编排事实,不新增任何"确认"接口):
 *   ① 该角色在角色绑定表里(派过会话)  ② 台账里有过 from/to = 该角色的互呼记录  ③ 在等待图里
 * 三条都不成立 → 标 `未验证`(仍然写进台账,但写明"未验证"与原因,并在回执里给出补救动作)。
 *
 * **不硬拒绝**:把"计划"写成"已完成"是记账问题,不是权限问题;拦下来只会让人绕开工具手写台账。
 * 想显式表达"这是计划中的确认人",在文案里带 `计划` / `待确认` / `待复核` 之一即可(不再反查)。
 */
export function verifyConfirmers(confirmedBy, info) {
  const raw = String(confirmedBy === undefined || confirmedBy === null ? '' : confirmedBy)
  /**
   * `empty` 这个字段是给**回执分支**用的。若直接 `return out`,
   * 调用处只看到 `unverified.length === 0 && planned === false`,就落进最正面那句
   * 「确认人参与度已核对」—— 一次**根本没人可核**的登记被写成了"核对过了"。
   * 空值必须在回执层与"核对通过"分开(见 workflow_state_save 的 note 三分支)。
   */
  const out = { planned: false, empty: false, mentioned: [], verified: [], unverified: [] }
  if (raw.trim() === '') { out.empty = true; return out }
  if (CONTRACT_PLAN_MARKERS.some((m) => raw.indexOf(m) !== -1)) { out.planned = true; return out }
  const src = info || {}
  const roles = (Array.isArray(src.roles) ? src.roles : []).map((r) => String(r).toLowerCase())
  const seen = {}
  const mentioned = []
  const at = /@([A-Za-z][A-Za-z0-9_-]*)/g
  let m
  while ((m = at.exec(raw)) !== null) {
    const t = String(m[1]).toLowerCase()
    if (!seen[t]) { seen[t] = true; mentioned.push(t) }
  }
  if (mentioned.length === 0) {
    // 没写 @ 前缀时退化成"按角色 id 认词"(实测有人写「确认人:架构师 + 质检员」)
    for (const r of roles) {
      if (!seen[r] && new RegExp(`(^|[^A-Za-z0-9_])${r}([^A-Za-z0-9_]|$)`, 'i').test(raw)) { seen[r] = true; mentioned.push(r) }
    }
  }
  const ledger = Array.isArray(src.ledger) ? src.ledger : []
  const roleAgents = src.roleAgents || {}
  const waiting = src.waiting || {}
  const evidenceOf = (role) => {
    if (roleAgents[role]) return '已派会话'
    for (const r of ledger) if (String(r && r.from) === role || String(r && r.to) === role) return '有互呼/投递记录'
    if (waiting[role]) return '在等待图里'
    return ''
  }
  for (const role of mentioned) {
    const why = evidenceOf(role)
    if (why !== '') out.verified.push({ role, why })
    else out.unverified.push({ role, why: roles.indexOf(role) === -1 ? '本项目既没有这个角色的绑定,也没有它的互呼记录' : '本项目台账里没有与它的互呼/投递记录,也没有绑定会话' })
  }
  out.mentioned = mentioned
  return out
}

/**
 * 解析磁盘 package.json 的版本,并**把"解析不了"与"没有这个文件"分开**。
 *
 * 由来是一次真实的翻车:package.json 的描述里写了 ASCII 引号,Node 侧 `JSON.parse` 完全正常,
 * 但 PS 5.1 按 GBK 读同一个文件时引号计数错位 → 解析第 5 步抛「应为 : 或 }」。
 * 更值得警惕的是 `catch { return '' }` 这种写法:文件在、内容坏了,版本自证会**静默失效**,
 * status 反而什么都不报 —— 于是"部署了但没重启"这一层兜底等于不存在。
 */
export function parsePackageVersion(text) {
  try {
    const j = JSON.parse(String(text === undefined || text === null ? '' : text))
    const v = j && typeof j === 'object' ? String(j.version || '') : ''
    if (v === '') return { version: '', error: 'package.json 里没有 version 字段' }
    return { version: v, error: '' }
  } catch (e) {
    return { version: '', error: `package.json 解析失败(${String((e && e.message) || e)})` }
  }
}

export function buildDocument(currentText, a) {
  const args = a || {}
  let text = currentText && String(currentText).trim() !== ''
    ? String(currentText)
    : defaultHeader(args.header)
  if (args.role || (args.nextStep && String(args.nextStep).trim() !== '')) {
    if (args.role) {
      const label = ROLE_LABELS[args.role] || args.role
      const rows = [`- 已完成:${label} ✅(${makeTS()})`]
      if (args.nextStep) rows.push(`- 下一步:${args.nextStep}`)
      text = replaceSection(text, '当前进度', rows.join('\n'))
    } else {
      // 只给 nextStep 时也要生效(没有 role 就整段忽略,
      // 于是 kickoff 生成的初始文档里「下一步」一直是模板里那句硬编码)
      const rows = readSection(text, '当前进度').split('\n').filter((l) => l.trim() !== '')
      const line = `- 下一步:${args.nextStep}`
      const idx = rows.findIndex((l) => l.indexOf('- 下一步:') === 0)
      if (idx >= 0) rows[idx] = line
      else rows.push(line)
      text = replaceSection(text, '当前进度', rows.join('\n'))
    }
  }
  if (args.outputs && args.outputs.length > 0) {
    text = replaceSection(text, '产出文件', bulletList(args.outputs.map((o) => (typeof o === 'string' ? o : `${o.name}:${o.path}`))))
  }
  if (args.apiSpecs && args.apiSpecs.length > 0) {
    text = replaceSection(text, 'API 契约', bulletList(args.apiSpecs.map((s) => {
      if (typeof s === 'string') return s
      const parts = [String(s.path || s.name || '(未命名 spec)')]
      if (s.kind) parts.push(`类型=${s.kind}`)
      if (s.versioning) parts.push(`版本=${s.versioning}`)
      if (s.lint) parts.push(`lint=${s.lint}`)
      return parts.join(' | ')
    })))
  }
  if (args.todos && args.todos.length > 0) {
    text = replaceSection(text, '待办', args.todos.map((t) => (typeof t === 'string' ? `- [ ] ${t}` : `- [${t.done ? 'x' : ' '}] ${t.text}`)).join('\n'))
  }
  if (args.contractRevision) {
    const prev = readSection(text, '契约修订台账')
    const cr = args.contractRevision
    const ver = cr.verification && typeof cr.verification === 'object' ? cr.verification : null
    let confirm = String(cr.confirmedBy || '(待确认)')
    // 点了名但本项目查不到参与证据的确认人 —— 如实标注在**同一行**里,
    // 免得"确认:@qa"被当成"@qa 已经确认过了"。
    if (ver && Array.isArray(ver.unverified) && ver.unverified.length > 0) {
      confirm += ` ⚠️ 未验证:${ver.unverified.map((u) => `@${u.role}`).join(' ')}(${ver.unverified[0].why}${ver.unverified.length > 1 ? ' 等' : ''})`
    }
    const row = `- ${makeTS()} | ${String(cr.content || '')} | 受影响:${String(cr.affected || '(未标注)')} | 确认:${confirm}`
    text = replaceSection(text, '契约修订台账', (prev && prev !== '- (无)' ? `${prev}\n` : '') + row)
  }
  if (args.risks && args.risks.length > 0) text = replaceSection(text, '遗留风险', bulletList(args.risks))

  const raw = text.split('\n')
  const kept = []
  for (let i = 0; i < raw.length; i += 1) {
    const l = raw[i]
    if (i > 0 && l.indexOf('更新:') === 0) continue
    if (kept.length === 0 && l.trim() === '') continue
    kept.push(l)
  }
  if (kept.length === 0 || kept[0].trim() === '') kept.unshift('# 流程状态')
  // 带 BOM 的文档首行是 `\uFEFF# 流程状态` —— 既匹配不上标题变体,
  // 也让 projectName **静默失效**(一个字都不提示)。统一剥掉再比。
  if (kept[0]) kept[0] = String(kept[0]).replace(/^\uFEFF/, '')
  if (args.projectName && kept[0].indexOf('# 流程状态') === 0) kept[0] = `# 流程状态:${args.projectName}`
  kept.splice(1, 0, `更新:${makeTS()}`)
  return kept.join('\n').replace(/\n{3,}/g, '\n\n')
}

export function summarize(text) {
  return {
    title: String(text).split('\n')[0],
    progress: readSection(text, '当前进度'),
    outputs: readSection(text, '产出文件'),
    apiSpecs: readSection(text, 'API 契约'),
    todos: readSection(text, '待办'),
    todoOpen: countOpenTodos(readSection(text, '待办')),
    contractLog: readSection(text, '契约修订台账'),
    risks: readSection(text, '遗留风险'),
  }
}

// ── 协作台账渲染(人读一侧)───────────────────────────────────────────

export function renderLedger(rows, meta) {
  const m = meta || {}
  const head = [
    `# 协作台账${m.project ? `:${m.project}` : ''}`,
    `更新:${makeTS()}`,
    `档案:profile=${m.profile || '(未知)'} | 状态文件=${m.stateFile || DEFAULT_STATE_REL} | 熔断上限=${m.limit || RELAY_LIMIT}次/${Math.round((m.windowMs || RELAY_WINDOW_MS) / 60000)}分钟`,
    '',
    '## 互呼记录(新→旧)',
    '',
    '| 时间 | 发起 | 目标 | 摘要 | 状态 | 备注 |',
    '|---|---|---|---|---|---|',
  ]
  const list = Array.isArray(rows) ? rows.slice().reverse() : []
  if (list.length === 0) head.push('| — | — | — | (暂无) | — | — |')
  for (const r of list) {
    const cell = (s) => String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
    head.push(`| ${cell(r.ts)} | @${cell(r.from)} | @${cell(r.to)} | ${cell(String(r.summary || '').slice(0, 80))} | ${cell(r.status)} | ${cell(r.note)} |`)
  }
  head.push('')
  return head.join('\n')
}

// ── API 契约层(纯函数区,便于单测)─────────────────────────────────
//
// 这一层是随包 `api-architect` 技能的可执行一面:
//   · parseSkillFrontmatter —— 把 SKILL.md 的 frontmatter 解析成技能摘要
//   · discoverApiSpecs / classifySpec / lint* —— 纯 JS 的契约校验
//     (递归扫候选目录,ERROR>0 即 FAIL;不依赖 bash,也不受当前目录限制)
// 落盘一律交给会话的 write(插件写不了工作区),插件只算、只判、只回全文。

/** 解析 SKILL.md 的 YAML frontmatter。只认标量 + `>` / `|` 折行,不引 YAML 依赖。 */
export function parseSkillFrontmatter(text) {
  const src = String(text || '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  if (!m) return { attrs: {}, body: src }
  const attrs = {}
  const folded = {}
  const lines = m[1].split(/\r?\n/)
  let key = ''
  for (const line of lines) {
    if (line.trim() === '') continue
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (kv) {
      key = kv[1]
      const val = kv[2].trim()
      if (val === '>' || val === '|' || val === '>-' || val === '|-' || val === '>+' || val === '|+') {
        attrs[key] = ''
        folded[key] = true
      } else attrs[key] = val.replace(/^(['"])([\s\S]*)\1$/, '$2')
    } else if (key && /^\s+\S/.test(line)) {
      attrs[key] = attrs[key] ? `${attrs[key]} ${line.trim()}` : line.trim()
    }
  }
  return { attrs, body: src.slice(m[0].length) }
}

function finding(rel, level, rule, message, fix, line) {
  const out = { file: String(rel), level, rule, message: String(message) }
  if (fix) out.fix = String(fix)
  if (line) out.line = Number(line)
  return out
}

function lineOf(text, re) {
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) if (re.test(lines[i])) return i + 1
  return 0
}

/** 判定一个文件属于哪种契约(与原脚本"是不是 OpenAPI/GraphQL/proto"同口径)。 */
export function classifySpec(rel, text) {
  const p = String(rel || '').toLowerCase()
  const t = String(text || '')
  if (p.endsWith('.proto') || /^\s*syntax\s*=\s*["']proto[23]["']/m.test(t)) return 'proto'
  if (/\.(graphql|gql|graphqls)$/.test(p)) {
    // `.graphql` 里**不只有 schema** —— 客户端操作文档(`query GetUser {...}`)
    // 也用这个扩展名。一律按 schema 判会"没有 type Query"直接 ERROR,
    // 而这条 ERROR 是写进角色人设的硬门槛(ERROR 必须为 0):一份合法的操作文档
    // 没有任何"修法",arch 与 qa 会互相卡死。这里把操作文档单独归类,不套 schema 规则。
    return looksLikeGraphqlOperations(t) ? 'graphql-op' : 'graphql'
  }
  if (/^\s*(openapi|swagger)\s*:/m.test(t) || /"(openapi|swagger)"\s*:/.test(t)) return 'openapi'
  if (/^\s*type\s+Query\b/m.test(t) || /^\s*schema\s*\{/m.test(t)) return 'graphql'
  if (/\.(ya?ml|json)$/.test(p)) return 'generic'
  return 'unknown'
}

/**
 * 判断一份 .graphql 是"操作文档"而不是"schema"。
 * 判据:出现 `query/mutation/subscription <名字>` 或匿名 `{ ... }` 操作,**且**没有任何 SDL 类型定义。
 * 两者兼有的文件(带类型定义又附示例操作)仍按 schema 判 —— 那时 schema 规则才有意义。
 *
 * 多文件 schema 里两类**天然不可能是独立 schema**的文件被漏判,
 * 落进 `graphql` 分类后被套上"每个 .graphql 文件都必须有 type Query"的硬门槛:
 *   · `fragment TaskFields on Task { … }` —— 判据若不含 fragment,既不算操作文档、
 *     又没有类型定义,直接当 schema 判 → ERROR `graphql-query`;
 *   · `extend type Query { … }` —— 把 `extend` 也算作"自己的类型定义"时,
 *     可 extend 的前提就是**别处已经定义过**,这种文件自己必然没有入口。
 * 后果不是"少报"而是"报错方向相反":fix「补 type Query」会催模型往纯 fragment/纯扩展文件里塞一个假入口,
 * 契约被改坏、lint 反而通过。判据按文件的**独立 SDL 能力**收窄:
 *   · `extend` 不再算自有定义(它只是扩展别处的定义);
 *   · `fragment` 与 extend 语句算"非独立 schema"的信号。
 * 反守卫:真有 `type User { … }` 这类自有定义的文件仍按 schema 判(schema 规则才有意义,23.3/23.4 守的就是这条)。
 */
function looksLikeGraphqlOperations(t) {
  const hasTypeDef = /^\s*(type|interface|union|enum|input|scalar|schema|directive)\s+/m.test(t)
  if (hasTypeDef) return false
  return /^\s*(query|mutation|subscription)\s+[A-Za-z_]/m.test(t)
    || /^\s*fragment\s+[A-Za-z_]/m.test(t)
    || /^\s*extend\s+(type|interface|union|enum|input|scalar|schema)\b/m.test(t)
    || /^\s*\{\s*$/m.test(t)
}

/**
 * 只取 `paths` 那一段来跑"动词式路径"规则。
 *
 * 对**整份文本**跑动词式路径正则,于是 `description: "调用 /getUserById"`、
 * 示例里的 `/deleteItem/3`、甚至 `$ref: '#/components/schemas/updateUserRequest'`
 * 都会被判 ERROR —— 而这条是硬门槛,fix 文案还引导去改 paths,等于让模型去改正确内容。
 */
export function pathsRegion(t) {
  const s = String(t || '')
  // JSON 形态:从 "paths": { 起做花括号配对
  const j = /"paths"\s*:\s*\{/.exec(s)
  if (j) {
    const start = s.indexOf('{', j.index)
    let depth = 0
    for (let k = start; k < s.length; k += 1) {
      if (s[k] === '{') depth += 1
      else if (s[k] === '}') {
        depth -= 1
        if (depth === 0) return s.slice(start, k + 1)
      }
    }
    return s.slice(start)
  }
  // YAML 形态:从顶格的 paths: 起,到下一个顶格的非注释行(下一个顶层键)为止
  const m = /^paths\s*:/m.exec(s)
  if (!m) return ''
  const rest = s.slice(m.index + m[0].length).split(/\r?\n/)
  const body = [rest[0] || '']
  for (let i = 1; i < rest.length; i += 1) {
    const ln = rest[i]
    if (ln.trim() !== '' && !/^\s/.test(ln) && !ln.trim().startsWith('#')) break
    body.push(ln)
  }
  return body.join('\n')
}

/**
 * 取出 `paths` 段里的**路径键本身**(`/users:` / `"/users":`)。
 *
 * 只限定到"paths 段"还不够 —— 操作对象里的 `description:` / `example:` / `$ref:` 同样缩进在
 * paths 段内(selftest 23.8 守的就是它)。这条规则问的是"**路径**里有没有动词",
 * 所以只该看路径键。
 *
 * 只填了这坑的一半:一份**完全正确**的 OpenAPI 3.1,
 * 只在 `get.description: |` 的块标量里写了一段迁移说明
 *     paths:
 *       /v1/tasks:
 *         get:
 *           description: |
 *             /getUsers: 已废弃
 * 就判 FAIL —— `openapi-verb-url` 是硬门槛,而 fix「用名词路径 + HTTP 方法表达动作」指向的是
 * **契约里根本不存在的路径**,模型又被要求"按 fix 逐条改",能做的只有删掉这段文档或去改正确的 /v1/tasks。
 * 根因:判据只要求"在 paths 段内 + 行首是 /"是不够的 —— YAML 块标量(description/summary/example)的
 * 内容行缩进比其所属键更深,**照样落进这个形状**。
 * 现在按 YAML 的硬规则收窄:路径键是 `paths` 的直接子级,缩进必然等于这一层的最小缩进 ——
 * 先量出"本段内映射键行的最小缩进"(排除 `}` / `]` / `,` 收尾行与 `- ` 序列项),
 * 只有缩进**恰好等于**它的行才算路径键;块标量内容必然更深,自动出局。
 * 反守卫:真路径键的缩进必然等于这一层 ⇒ 照旧认得出(23.9 与真实契约那一批靠的就是这条)。
 */
export function pathKeys(t) {
  const region = pathsRegion(t)
  const out = []
  const lines = region.split(/\r?\n/)
  const indentOf = (ln) => ln.length - ln.replace(/^[ \t]+/, '').length
  let keyIndent = -1
  for (let i = 1; i < lines.length; i += 1) {
    const body = lines[i].trim()
    if (body === '' || body.startsWith('#') || body.startsWith('-') || /^[}\],]/.test(body)) continue
    const ind = indentOf(lines[i])
    if (keyIndent === -1 || ind < keyIndent) keyIndent = ind
  }
  // 第 0 行是 `paths:` 那一行的残余(内联 flow 写法,如单行 JSON),没有可比缩进,一律放行
  const atKeyLevel = (i) => i === 0 || keyIndent < 0 || indentOf(lines[i]) === keyIndent
  for (let i = 0; i < lines.length; i += 1) {
    if (!atKeyLevel(i)) continue
    const y = /^\s*"?'?(\/[^"'\s:]*)"?'?\s*:/.exec(lines[i])
    if (y) out.push(y[1])
    // JSON 写法 {"paths":{"/a":{...}}} / `"/a": {` 也要认(与 YAML 形态同一道缩进闸)
    const jre = /"(\/[^"]*)"\s*:/g
    let jm = jre.exec(lines[i])
    while (jm !== null) { out.push(jm[1]); jm = jre.exec(lines[i]) }
  }
  return Array.from(new Set(out))
}

/** JSON 形态的键是 `"key":`,旧正则 `key\s*:` 匹配不上 → 必然误报。 */
function hasKeyYamlOrJson(t, key) {
  return new RegExp(`"?${key}"?\\s*:`).test(String(t || ''))
}

/** OpenAPI 规则(对应原脚本 check_openapi,判定口径不变)。 */
export function lintOpenApi(rel, text) {
  const t = String(text || '')
  const out = []
  if (/^\s*swagger\s*:/m.test(t) || /"swagger"\s*:/.test(t)) {
    out.push(finding(rel, 'warn', 'openapi-version', '用的是 Swagger 2.0,建议升到 OpenAPI 3.1', '3.x 的 components/schemas 与 webhooks 更完整,迁移面很小', lineOf(t, /swagger/)))
  // `openapi: "3.1.0"`(YAML 允许给标量加引号)被报成"缺少 3.x 的 openapi 版本号" ——
  // 两个正则,一个要求**裸值**、一个要求**带引号的键**(只在 JSON 形态成立),带引号的值两边都不匹配,
  // 一份合法 spec 平白多一条 WARN。现在两处都接受可选的引号;JSON 形态的键照旧认。
  // 反守卫:`openapi: 2.0` / `openapi: 3.1`(只有两段)仍然报 —— `["']?3` 之后必须跟两段数字。
  } else if (!/^\s*openapi\s*:\s*["']?3\.\d+\.\d+/m.test(t) && !/"openapi"\s*:\s*["']?3\.\d+\.\d+/.test(t)) {
    out.push(finding(rel, 'warn', 'openapi-version', '缺少 3.x 的 openapi 版本号(或版本号格式不对)', '首行写 openapi: 3.1.0', 1))
  }
  if (!/^\s*info\s*:/m.test(t) && !/"info"\s*:/.test(t)) {
    out.push(finding(rel, 'error', 'openapi-info', '缺少 info 小节(title/version 是必需的)', '补 info: { title, version, description }'))
  }
  if (!/^\s*servers\s*:/m.test(t) && !/"servers"\s*:/.test(t)) {
    out.push(finding(rel, 'warn', 'openapi-servers', '缺少 servers 小节', '写明 base URL,用变量占位而不是写死域名'))
  }
  if (!hasKeyYamlOrJson(t, 'securitySchemes')) {
    out.push(finding(rel, 'warn', 'openapi-security', '缺少 securitySchemes(鉴权方式没声明)', '补 components.securitySchemes: bearerAuth / apiKey / oauth2'))
  }
  const hasOps = /^\s{2,}(get|post|put|patch|delete)\s*:/m.test(t) || /"(get|post|put|patch|delete)"\s*:/.test(t)
  if (hasOps && !hasKeyYamlOrJson(t, 'operationId')) {
    out.push(finding(rel, 'warn', 'openapi-operationid', '有操作但缺 operationId(SDK 生成会退化成随机名)', '每个操作补唯一的 operationId'))
  }
  // 只看 paths 段里的**路径键**(扫全文会把描述/示例/$ref 里的 /getXxx 判成 ERROR)
  const badPath = pathKeys(t).find((p) => /\/(get|create|update|delete|remove|fetch)[A-Z][A-Za-z]*/.test(p))
  if (badPath) {
    out.push(finding(
      rel, 'error', 'openapi-verb-url', `路径里出现动词式命名(${badPath})`,
      '用名词路径 + HTTP 方法表达动作:/users + POST',
      lineOf(t, new RegExp(badPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
    ))
  }
  if (hasKeyYamlOrJson(t, 'responses') && !/['"]?4\d\d['"]?\s*:/.test(t)) {
    out.push(finding(rel, 'warn', 'openapi-4xx', '缺少 4xx 错误响应(错误路径没定义)', '至少补 400/401/404/409 的统一错误体'))
  }
  // 这条规则的前置条件不能只认 YAML 缩进式的 `post:` —— JSON 契约里是 `"post": {`,
  // 永不触发 —— 同一份「有 POST、没有幂等键」的契约,YAML 版报 WARN、JSON 版一条不报,
  // 于是 JSON 形态的契约整体比 YAML 松一档 —— 这一偏向在别的规则上也出现过("照抄模板按整行比对"那条规则也是同一偏向)。
  // 补上 JSON 分支,写法与上面 hasOps 那行保持一致:两种形态任一命中即算"有 POST"。
  if ((/^\s{2,}post\s*:/m.test(t) || /"post"\s*:/.test(t)) && !/Idempotency-Key/i.test(t)) {
    out.push(finding(rel, 'warn', 'openapi-idempotency', '有 POST 但没提 Idempotency-Key(重试会建重复资源)', '变更类接口收 Idempotency-Key 头,回放首次响应'))
  }
  return out
}

/**
 * GraphQL"服务入口"判据 —— 单文件与整批各用一半,共用一份,免得两处走偏。
 *
 *   · hasGraphqlQueryRoot(单文件口径):本文件**声明了查询入口** —— `type Query`、`schema { … }`,
 *     或扩展式声明 `extend type Query { … }` / `extend schema { … }`。
 *     extend 的前提就是根类型已在别处定义,所以它同样证明"这套 schema 有入口",
 *     不该再被 fix 催着补一个假 `type Query`。
 *   · hasGraphqlAnyRoot(整批口径):再宽一档 —— 只定义了 `type Mutation`(也是根类型)的批次同样算有入口。
 *
 * 注意单文件口径**不**把 `type Mutation` 当入口:一个只有 type User + type Mutation 的文件
 * 确实缺查询根,该报还得报(18.1 / 23.3 守的就是这条 —— 别把误报修成漏报)。
 */
function hasGraphqlQueryRoot(t) {
  const s = String(t || '')
  return /^\s*type\s+Query\b/m.test(s) || /^\s*schema\s*\{/m.test(s)
    || /^\s*extend\s+type\s+Query\b/m.test(s) || /^\s*extend\s+schema\s*\{/m.test(s)
}

function hasGraphqlAnyRoot(t) {
  const s = String(t || '')
  return hasGraphqlQueryRoot(s)
    || /^\s*type\s+Mutation\b/m.test(s) || /^\s*extend\s+type\s+Mutation\b/m.test(s)
}

/** GraphQL 规则(对应原脚本 check_graphql;原脚本的 `scalar A\|scalar B` 正则本身是错的,这里按逐类型判定)。 */
export function lintGraphql(rel, text) {
  const t = String(text || '')
  const out = []
  // 入口判据换成 hasGraphqlQueryRoot(多了 extend 形态)。
  // 单文件仍然照判 —— 整批的豁免在 lintApiFiles 里做,因为只有那里看得见"这一批都有哪些文件"。
  if (!hasGraphqlQueryRoot(t)) {
    out.push(finding(rel, 'error', 'graphql-query', '缺少 type Query(schema 没有入口)', '补 type Query,或用 schema { query: RootQuery }'))
  }
  if (/type\s+\w*Connection\b/.test(t) && !/^\s*type\s+PageInfo\b/m.test(t)) {
    out.push(finding(rel, 'warn', 'graphql-pageinfo', '有 Connection 类型但缺 PageInfo(Relay 分页不完整)', '补 type PageInfo { hasNextPage hasPreviousPage startCursor endCursor }'))
  }
  if (/^\s*type\s+Mutation\b/m.test(t) && !/errors\s*:\s*\[/.test(t)) {
    out.push(finding(rel, 'warn', 'graphql-mutation-errors', 'Mutation payload 没有 errors 数组(业务错误没地方放)', 'payload 里加 errors: [UserError!]!'))
  }
  for (const scalar of ['DateTime', 'Date', 'JSON', 'UUID', 'Decimal', 'URL']) {
    const used = new RegExp(`\\b${scalar}\\b`).test(t)
    const declared = new RegExp(`^\\s*scalar\\s+${scalar}\\b`, 'm').test(t)
    if (used && !declared) {
      out.push(finding(rel, 'warn', 'graphql-scalar', `用到 ${scalar} 但没有 scalar 声明`, `补 scalar ${scalar} 并在 resolver 里实现序列化`))
    }
  }
  return out
}

/** Protocol Buffer 规则(对应原脚本 check_protobuf;字段号 0 的判定改用花括号栈,不再用 -B5 猜)。 */
export function lintProto(rel, text) {
  const t = String(text || '')
  const out = []
  if (!/^\s*syntax\s*=\s*["']proto3["']/m.test(t)) {
    out.push(finding(rel, 'warn', 'proto-syntax', '不是 proto3 语法', '首行写 syntax = "proto3";'))
  }
  if (!/^\s*package\s+[\w.]+\s*;/m.test(t)) {
    out.push(finding(rel, 'error', 'proto-package', '缺少 package 定义(类型会撞名)', '补 package com.example.api;'))
  }
  if (!/option\s+go_package/.test(t)) {
    out.push(finding(rel, 'warn', 'proto-go-package', '缺少 option go_package(Go 侧生成路径不定)', '补 option go_package = "example.com/api;api";'))
  }
  const stack = []
  const lines = t.split(/\r?\n/)
  /**
   * `enum Color` 与 `{` **换行写**是合法的 protobuf 风格,只在含 `{` 的
   * 同一行里认 opener —— 于是
   *     enum Color
   *     {
   *       RED = 0;
   *     }
   * 里的 `= 0;` 被当成"消息字段号 0"判 ERROR(硬门槛),模型照 fix 会把正确的枚举首值改成 1,
   * **改坏合法文件**。现在用 pending 记住上一行留下的 opener,下一行出现 `{` 时再入栈。
   */
  let pending = ''
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\/\/.*$/, '')
    const kw = /(\benum|\bmessage|\bservice|\boneof|\bextend)\s+[\w.]*/.exec(line.trim())
    const isEnumDecl = !!kw && kw[1] === 'enum'
    if (/=\s*0\s*;/.test(line) && stack.indexOf('enum') === -1 && !isEnumDecl && pending !== 'enum') {
      out.push(finding(rel, 'error', 'proto-field-zero', '消息里出现字段号 0(消息字段号必须为正;只有 enum 的第一个值可以是 0)', '把该字段改成 1 起,或确认真的是 enum', i + 1))
    }
    const opens = (line.match(/\{/g) || []).length
    const closes = (line.match(/\}/g) || []).length
    if (opens > 0) {
      for (let k = 0; k < opens; k += 1) stack.push(kw ? kw[1] : (pending || 'other'))
      pending = ''
    } else if (kw) pending = kw[1]
    for (let k = 0; k < closes; k += 1) stack.pop()
  }
  return out
}

/**
 * protobuf 语言规范里 `package` 是**可选**的,写成 ERROR(硬门槛)就会把合法契约判失败 ——
 * 实测:一份合法的 `syntax = "proto3"; message Task { string id = 1; }` 直接判 FAIL,
 * fix「补 package com.example.api;」等于让模型去改一份本来正确的契约。
 * 等级只能在"看得见这一批文件"的地方定,所以挪到汇合处(lintApiFile 单文件 / lintApiFiles 整批):
 *   · 默认降为 **WARN** —— package 只是建议,不再拦门槛;
 *   · 只有当这一批里的**多个无 package 文件声明了同名 message** 时才升回 ERROR ——
 *     没有 package 的类型都落在同一个根命名空间,这时"类型会撞名"才是一句真话,那条 fix 也才有意义
 *     (有 package 的文件在独立命名空间里,不与根命名空间撞名,故不参与统计)。
 * 语法 / 字段号那几条规则完全不受影响:它们仍在 lintProto 里各判各的(18.6/18.7 照旧)。
 */
function adjustProtoPackageLevel(findings, protoTexts) {
  const texts = (Array.isArray(protoTexts) ? protoTexts : [])
    .map((x) => String(x === undefined || x === null ? '' : x))
  const seen = new Set()
  let collide = false
  for (const t of texts) {
    if (/^\s*package\s+[\w.]+\s*;/m.test(t)) continue
    const re = /^\s*message\s+([A-Za-z_]\w*)/gm
    let m = re.exec(t)
    while (m !== null) {
      if (seen.has(m[1])) collide = true
      else seen.add(m[1])
      m = re.exec(t)
    }
  }
  const level = collide ? 'error' : 'warn'
  for (const f of (Array.isArray(findings) ? findings : [])) {
    if (f && f.rule === 'proto-package') f.level = level
  }
  return collide
}

/** 通用规则(对应原脚本 check_common_issues 的硬编码主机检查)。 */
export function lintGeneric(rel, text) {
  const out = []
  /**
   * 豁免若是无锚点的**子串**匹配 `/(dev|local|test|example|sample|mock)/i.test(rel)`,
   * 而 rel 是整条相对路径 —— 于是整条硬编码主机检查会被静默关掉:`docs/api/latest.yaml`("la"+"test")、
   * `docs/api/protest/notes.yaml`(目录名含 test),甚至只是名字里带个正常域名也算。
   * 现在按**文件名级**精确匹配:必须被分隔符(`.` `_` `-`)或首尾夹住的整词才算豁免。
   * 反守卫:`xxx-example-xxx.yaml` / `notes.dev.yaml` / `notes.test.yaml` 照旧豁免;
   * `latest.yaml`、`protest/notes.yaml`、`contest.yaml` 不再豁免(它们只是碰巧含这些字母)。
   */
  const base = String(rel || '').split(/[\\/]/).pop()
  if (/(^|[._-])(dev|local|test|example|sample|mock)([._-]|$)/i.test(base)) return out
  const t = String(text || '')
  const m = /(localhost|127\.0\.0\.1|0\.0\.0\.0)/.exec(t)
  if (m) {
    out.push(finding(rel, 'warn', 'hardcoded-host', `出现硬编码主机 ${m[1]}`, '换成环境变量/模板变量,别把本机地址带进契约', lineOf(t, /localhost|127\.0\.0\.1|0\.0\.0\.0/)))
  }
  return out
}

export function lintApiFile(rel, text) {
  const kind = classifySpec(rel, text)
  if (kind === 'openapi') return lintOpenApi(rel, text)
  if (kind === 'graphql') return lintGraphql(rel, text)
  if (kind === 'graphql-op') return [] // M9:操作文档不是 schema,不套 schema 规则
  if (kind === 'proto') {
    // 单文件也算一"批"(口径见 adjustProtoPackageLevel)——
    // 缺 package 默认 WARN;只有同一个文件里就重复声明了同名 message 时才升回 ERROR。
    const out = lintProto(rel, text)
    adjustProtoPackageLevel(out, [String(text === undefined || text === null ? '' : text)])
    return out
  }
  if (kind === 'generic') return lintGeneric(rel, text)
  return []
}

/** 原脚本的汇总口径:ERROR>0 → FAIL;WARN>5 → 通过但有告警;否则通过。 */
export function summarizeLint(findings) {
  let errors = 0
  let warnings = 0
  let infos = 0
  for (const f of (Array.isArray(findings) ? findings : [])) {
    if (f.level === 'error') errors += 1
    else if (f.level === 'warn') warnings += 1
    else infos += 1
  }
  return { errors, warnings, infos, verdict: errors > 0 ? 'fail' : (warnings > 5 ? 'pass_with_warnings' : 'pass') }
}

export function lintApiFiles(entries) {
  const list = Array.isArray(entries) ? entries : []
  const findings = []
  const files = []
  const kinds = {}
  /**
   * 有两条规则的结论**必须整批看**才成立,逐文件判必然误判 ——
   *   · `graphql-query`:多文件 schema 里除主文件外谁都没有 `type Query`,逐文件判会让整批 FAIL,
   *     而 fix「补 type Query」会教模型往纯类型文件里塞假入口;
   *   · `proto-package`:protobuf 里 package 可选,只有"多个无 package 文件声明同名 message"
   *     才是真撞名(该 ERROR),否则只是建议(WARN)。
   * 所以在循环里把这一批的原始文本收齐,循环结束后统一重定级:规则照旧逐文件跑,等级在批级定。
   */
  const gqlTexts = []
  const protoTexts = []
  for (const e of list) {
    const kind = classifySpec(e.rel, e.text)
    if (kind === 'unknown') continue
    kinds[kind] = (kinds[kind] || 0) + 1
    const text = String(e.text === undefined || e.text === null ? '' : e.text)
    if (kind === 'graphql' || kind === 'graphql-op') gqlTexts.push(text)
    if (kind === 'proto') protoTexts.push(text)
    if (kind !== 'generic') {
      // 每个契约文件都留指纹。lint 记录若只有 ERROR/WARN 计数 + 时间 ——
      // "lint ERROR 0"这条证据**不保证是对同一份文件成立的**:spec 被整体换掉、重跑
      // lint 依旧 PASS,而旧结论已经无法用盘上文件复现。
      files.push({ rel: String(e.rel), kind, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256Hex(text) })
    }
    for (const f of templateDumpFindings(e.rel, text)) findings.push(f)
    for (const f of lintApiFile(e.rel, text)) findings.push(f)
  }
  // 整批只要有**任一**文件提供了入口(type Query / type Mutation / schema { … } / extend 形态),
  // 这一批就不算"schema 没有入口" —— 撤掉全部 graphql-query。
  // 反守卫:整批都没有入口时原样保留;操作文档(`query Foo {…}`)与纯 fragment **不算**入口,
  // 所以"纯类型文件 + 操作文档"这种组合仍然报(它确实缺查询根)。
  if (gqlTexts.some((t) => hasGraphqlAnyRoot(t))) {
    for (let i = findings.length - 1; i >= 0; i -= 1) {
      if (findings[i].rule === 'graphql-query') findings.splice(i, 1)
    }
  }
  // proto 缺 package 的等级(默认 WARN;这一批里出现同名 message 才升回 ERROR)
  adjustProtoPackageLevel(findings, protoTexts)
  const versioned = list.some((e) => /\/v[0-9]+([/"'\s]|$)/m.test(String(e.text)) || /version(ing)?\s*:\s*(header|query|url)/i.test(String(e.text)))
  if (files.length > 0 && !versioned) {
    findings.push(finding(files[0].rel, 'info', 'versioning', '没有检测到版本化策略(/v1/ 或 version: header/query)', '三选一写进 spec:URL / Header / Query'))
  }
  const summary = summarizeLint(findings)
  // 空集**不算通过**:一个契约文件都没扫到时,ERROR 0 是空洞的 ——
  // 会让"lint 必须 ERROR 0"这道门在"压根没写 spec"的项目上形同虚设。
  // 否则 qa 拿到 ✅ PASS 就会把 API 门槛打勾放行 —— 这正是这条规则要防的。
  if (files.length === 0) summary.verdict = 'no_specs'
  return Object.assign({ files, kinds, findings, digest: specDigest(files) }, summary)
}

/** 契约指纹:对 {rel, sha256} 排序后取一次 SHA256 —— 一份可核对的"这批文件"名字。 */
export function specDigest(files) {
  const list = (Array.isArray(files) ? files : [])
    .filter((f) => f && f.rel)
    .map((f) => `${String(f.rel)}:${String(f.sha256 || sha256Hex(''))}`)
    .sort()
  if (list.length === 0) return ''
  return sha256Hex(list.join('\n'))
}

function sha256Hex(text) {
  return createHash('sha256').update(String(text === undefined || text === null ? '' : text), 'utf8').digest('hex')
}

/**
 * 模板原文假装成"本项目的契约"。
 *
 * 实测:把插件包内 `skills/api-architect/references/openapi-spec.yaml`
 * 原样落盘到 `docs/api/openapi.yaml`,lint 一路报 `✅ PASS | ERROR 0 / WARN 0` ——
 * 因为可机读的规则里**没有一条问"这份 spec 是不是这个项目的"**:标题还是 `User Service API`、
 * 路径还是 `/users`、base URL 还是 `api.example.com`,照样通过。于是"契约关"形同虚设。
 *
 * 判据用**与包内参考件的逐行重合度**,而不是硬编码几个关键词:模板改了、这里跟着改,
 * 不需要两处维护。口径是"**这份 spec 有多大比例是模板原文**"(与参考件逐字相同的行 ÷ 本 spec 有效行),
 * 且要求重合行数 ≥25 —— 小 spec 里那些 OpenAPI 通用关键字(`get:`/`type: string`)凑不到这个数,
 * 而整份照抄是 140 行级别的重合(100%)。这样既不误杀"照模板开了个头、已按项目改写"的正常 spec,
 * 也不放过模板原文。
 */
export function templateDumpFindings(rel, text) {
  const out = []
  const refs = referenceTemplates()
  // 参考件读不到时,`catch { }` 会让整条归属校验**静默消失** ——
  // lint 照样报 PASS,而"照抄模板"这件最该拦的事没人管了。读不到就必须说出来。
  if (refs.length === 0) {
    out.push(finding(
      rel, 'warn', 'vendor-template-uncheckable',
      '插件包内的参考模板读不到,**"照抄模板"这条归属校验没有执行**(不代表这份 spec 没问题)',
      '确认安装时 skills/api-architect/references/ 与 lib/ 一起拷了过去;或手工核对这份 spec 是不是模板原文',
    ))
    return out
  }
  const mine = specLines(text)
  if (mine.length === 0) return out
  const mineSet = new Set(mine)
  for (const t of refs) {
    const theirs = specLines(t.text)
    if (theirs.length === 0) continue
    const theirsSet = new Set(theirs)
    // 两侧都按**去重后的行**比:否则模板里重复出现的 `type: string` 会把命中数刷到
    // 超过本 spec 的行数,比率失真(不设这条会把一份正经的项目 spec 误判)。
    let hit = 0
    for (const l of mineSet) if (theirsSet.has(l)) hit += 1
    const ratioMine = hit / mineSet.size
    const ratioTheirs = hit / theirsSet.size
    /**
     * 只按"本 spec 有多少行来自模板"这一个方向判是不够的,于是
     *   ① 把模板删到 30 有效行以下就直接跳过校验;
     *   ② **照抄模板之后再堆自有内容**必然把比值稀释到 0.85 以下(分母是本 spec 的行数,数学上必然)。
     * 现在两个方向各判一次:整份照抄(命中率)与"模板被大面积搬进来"(覆盖率)任一中招都报。
     * 小文件不再被无条件跳过,而由 `hit >= 25` 兜住误报 —— OpenAPI 里那些通用关键字
     * (`get:`/`type: string`)凑不到 25 个不同行。
     */
    if (hit >= 25 && (ratioMine >= 0.85 || ratioTheirs >= 0.85)) {
      out.push(finding(
        rel, 'error', 'vendor-template',
        `这份 spec 与插件包内参考模板 ${t.file} 大面积逐字相同(本 spec ${Math.round(ratioMine * 100)}% 的行来自模板,模板 ${Math.round(ratioTheirs * 100)}% 的行被搬了过来,共 ${hit} 个不同行)—— 它是模板原文/搬运稿,不是本项目的契约`,
        `按 api_contract action=guide 改写:换掉 info.title/servers、把 paths 换成项目真实端点、把 components 换成项目真实模型;改到与参考件不再大面积重合再跑 lint`,
        lineOf(String(text), /^(openapi|swagger|info|title):/),
      ))
      break
    }
  }
  /**
   * **反照抄不能只按"整行集合重合"判**。
   *
   * 唯一判据若是"本 spec 的有效行 ∩ 参考件的有效行"(见上面的循环)。而 YAML 与 JSON 是
   * 同一份数据的两种写法:把 `references/openapi-spec.yaml` 用任意 JSON 序列化落成
   * `docs/api/openapi.json`,`openapi: 3.1.0` 变成 `"openapi": "3.1.0"`、`- url: …` 变成
   * `"url": "…"` —— **逐行零重合**,`hit` 直接是 0,于是整条归属校验被"换个格式"绕过。
   * 实测:同一份模板 YAML 落盘 = FAIL,同一份模板 JSON 落盘 = PASS。
   *
   * 修法不是"再猜几个关键词",而是**在数据层比**:
   *   · 两侧都解析成对象时(`parseSpecDoc`:先 JSON,再退化到极简 YAML)做结构比对 ——
   *     叶子值集合(`specLeaves`,同时出字符串与数字,所以 `'200'` 与 `200` 不算差异)
   *     与键路径集合(`specKeyPaths`)各算一次重合率;
   *   · 判据 = 重合率 ≥0.85(任一侧为分母) **且** 模板里至少有 3 条"长且带大写"的特征串
   *     (标题/描述/url/`operationId`/`$ref`/schema 名那一类)原样出现在本 spec 里。
   *
   * ⚠️ YAML 那一半是**必须**的:包内五份参考件全是 YAML/proto,只做 `JSON.parse` 的话
   * 结构比对永远不会对参考件生效(若只做结构比对,参考件这条永远不会生效)。
   * `parseSpecDoc` 里的 YAML 是**极简**实现(缩进 + `- ` 序列 + 内联数组 + 标量 + `#` 注释),
   * 只求把这几份参考件读成对象;**解析不出来就返回"不可比"**,退回逐行判据,不做"猜着报"。
   *
   * 反向守卫(这一条与正向同样重要)——**按项目改写的 spec 一律不许报**:
   *   · 只把 `title`/`servers`/`paths` 换掉、结构与字段名照旧的项目 spec:`leafHit` 掉到 0,
   *     结构化判据要求 0.85 的**值**重合,它直接过;
   *   · 真的按项目改写、只是**碰巧**沿用模板里几个字段名(`email`/`type: string` 这类):
   *     既凑不出 0.85 的叶子重合,也凑不出 3 条长特征串(短于 12 字符、全小写的一律不算特征串,
   *     所以 `application/json` 这种通用 MIME 串**不参与**);
   *   · 任一侧解析不了(参考件换了写法 / spec 里带注释):这一层**不生效、不报**,
   *     退回上面那层逐行判据。
   * `vendor-template-format` 是**独立 rule 名**:它表示"命中了结构比对",fix 与 `vendor-template`
   * 同一条(改成项目自己的契约),但排障时能一眼区分是行判据还是结构判据抓到的。
   */
  const specParsed = parseSpecDoc(text)
  if (specParsed !== SPEC_PARSE_FAIL) {
    // 相对口径要知道"这份 spec 是什么范式"(决定该拿哪份推荐模板当基准)
    const kind = classifySpec(rel, String(text === undefined || text === null ? '' : text))
    for (const t of refs) {
      const refParsed = parseSpecDoc(t.text)
      if (refParsed === SPEC_PARSE_FAIL) continue
      const mineLeaves = specLeaves(specParsed)
      const theirsLeaves = specLeaves(refParsed)
      if (mineLeaves.length === 0 || theirsLeaves.length === 0) continue
      // 叶子值:**去重后**比(模板里 `string`/`object` 会重复几十次,不去重会把比率刷过 1)
      const leafHit = countOverlap(mineLeaves, theirsLeaves)
      const mineKeys = specKeyPaths(specParsed)
      const theirsKeys = specKeyPaths(refParsed)
      const pathHit = countOverlap(mineKeys, theirsKeys)
      const ratioLeafMine = leafHit / mineLeaves.length
      const ratioLeafTheirs = leafHit / theirsLeaves.length
      const ratioPathMine = mineKeys.length > 0 ? pathHit / mineKeys.length : 0
      const ratioPathTheirs = theirsKeys.length > 0 ? pathHit / theirsKeys.length : 0
      if (!((ratioLeafMine >= 0.85 || ratioLeafTheirs >= 0.85 || ratioPathMine >= 0.85 || ratioPathTheirs >= 0.85))) continue
      // 特征串:模板里"长(≥12 字符)且含 ASCII 大写"的叶子串。这条是**抗改写**的一半 ——
      // 顺着字段名填数据的搬运稿值会变,标题/描述/url/operationId 不会变。
      const mineStrings = new Set(mineLeaves.filter((l) => typeof l === 'string' && l !== ''))
      const distinctiveOf = (leaves) => Array.from(new Set(leaves.filter(
        (l) => typeof l === 'string' && l.length >= 12 && /[A-Z]/.test(l),
      )))
      const distinctive = distinctiveOf(theirsLeaves).filter((s) => mineStrings.has(s))
      /**
       * ② 相对门槛(与**这一份**参考件比"本 spec 有多少值来自它")。
       *
       * 绝对门槛(leafHit≥25 / pathHit≥40)漏掉的是这一类:`action=guide` 推 openapi,
       * 但作者把模板改成 JSON 落成 openapi.json,又顺手改掉了标题与一半模型 ——
       * 单看绝对数只重合十几条,够不到 25;而**比值**是 100%(本 spec 的每一个叶子值都来自模板)。
       * 相对口径正是"这份 spec 有多大比例是模板原文"这句原话的直接实现。
       *
       * 所以循环里每份参考件都各算一次相对口径;跨范式那几份天然过不了
       * (字段结构差得远,ratioLeafMine 上不去)。这里比的是 `t`(当前加载的那份参考件)**本身**,
       * 不是 `API_TEMPLATES[kind][1]` —— 那是 `openapi.yaml` 这种**推荐输出名**,
       * references/ 里并没有这个文件(拿它去读会读到空、相对判据整个失效)。
       *
       * "硬证据"条数定 4:参考模板 openapi-spec.yaml 一共 11 条特征串
       * (User Service API / https://api.example.com/v1 / listUsers / #/components/schemas/… 那一类),
       * "搬过来又改掉一半"的稿子留着 4 条;而**按项目改写**的稿子一条都留不下
       * (标题、描述、url、operationId、schema 名全换)。阈值定 8 时半改写稿会漏。
       */
      const semHit = countOverlap(mineLeaves, theirsLeaves)
      const semDistinctive = distinctiveOf(theirsLeaves).filter((s) => mineStrings.has(s))
      const semRatio = mineLeaves.length > 0 ? semHit / mineLeaves.length : 0
      const semGuard = semDistinctive.length >= 4 && semRatio >= 0.35
      // 三条同时成立才算搬:① 结构确实大面积相同(任一方向 ≥0.85)② 有"模板原文"硬证据
      // ③ 而且这份相似可以归到"整份搬运"上(绝对门槛)或"搬了这一份参考件"上(相对门槛)
      if (distinctive.length < 3) continue
      if (!((ratioLeafMine >= 0.85 || ratioLeafTheirs >= 0.85 || ratioPathMine >= 0.85 || ratioPathTheirs >= 0.85))) continue
      if (leafHit >= 25 || pathHit >= 40 || semGuard) {
        const semPart = semGuard
          ? `;相对口径:本 spec ${Math.round(semRatio * 100)}% 的叶子值来自这份参考件(重合 ${semHit} 条,特征串 ${semDistinctive.length} 条)`
          : ''
        out.push(finding(
          rel, 'error', 'vendor-template-format',
          `这份 spec 与插件包内参考模板 ${t.file} **结构上大面积相同**(叶子值重合 ${leafHit} 条:本 spec ${Math.round(ratioLeafMine * 100)}%、模板 ${Math.round(ratioLeafTheirs * 100)}%;键路径重合 ${pathHit} 条,本 spec ${Math.round(ratioPathMine * 100)}%、模板 ${Math.round(ratioPathTheirs * 100)}%;模板特征串原样出现 ${distinctive.length} 条,如 ${JSON.stringify(distinctive.slice(0, 3))})${semPart}—— 它是模板原文换了序列化格式(JSON/紧凑写法)/只改了部分值的搬运稿,不是本项目的契约`,
          `按 api_contract action=guide 改写:换掉 info.title/servers、把 paths 换成项目真实端点、把 components 换成项目真实模型(改的是**值**,不是把 YAML 改成 JSON);改完再跑 lint`,
          lineOf(String(text), /"?\s*(openapi|swagger|info|title)"?\s*:/),
        ))
        break
      }
    }
  }
  return out
}

/** 结构比对用:`JSON.parse` 的哨兵失败值(与"解析出 null"区分开)。 */
const SPEC_PARSE_FAIL = Symbol('spec-parse-fail')

function parseJsonMaybe(text) {
  try { return JSON.parse(String(text === undefined || text === null ? '' : text)) } catch { return SPEC_PARSE_FAIL }
}

/**
 * 把一份 spec 文本解析成对象:**先 JSON,不成再退化到极简 YAML**;两条都不行返回哨兵。
 *
 * 为什么必须带 YAML:包内五份参考件(openapi-spec / rate-limiting / api-security 都是 YAML,
 * graphql-schema 是 SDL,grpc-service 是 proto)里,只有 YAML 那三份是"可与 spec 比结构"的。
 * 只做 `JSON.parse` 的话结构比对对参考件**永远不生效** —— 这条改动就等于没做。
 */
function parseSpecDoc(text) {
  const s = String(text === undefined || text === null ? '' : text)
  const j = parseJsonMaybe(s)
  if (j !== SPEC_PARSE_FAIL) return j
  return parseSimpleYaml(s)
}

/**
 * 极简 YAML 读取(只为本条判据服务,不是通用 YAML 实现)。
 * 支持:缩进映射、`- ` 块序列(含"序列项下继续挂键")、内联 `[a, b]`、`'x'`/`"x"` 标量、
 * 数字/布尔/null、`#` 整行注释与"空格后的行尾注释"。
 * 不支持(遇到就当解析失败,由调用方退回逐行判据):锚点/引用、多行标量 `|` `>`、流式 `{…}` 映射。
 */
function parseSimpleYaml(text) {
  const src = String(text === undefined || text === null ? '' : text)
  if (/^\s*[|>][-+]?\s*$/m.test(src)) return SPEC_PARSE_FAIL
  if (/(^|\s)[&*][A-Za-z0-9_-]+/.test(src)) return SPEC_PARSE_FAIL
  const rows = []
  for (const raw of src.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue
    if (/^\s*\t/.test(raw)) return SPEC_PARSE_FAIL // YAML 禁用 tab 缩进
    const indent = raw.match(/^ */)[0].length
    rows.push({ indent, text: stripYamlComment(raw.slice(indent).replace(/\s+$/, '')) })
  }
  if (rows.length === 0) return SPEC_PARSE_FAIL
  const pos = { i: 0 }
  try {
    const v = yamlBlock(rows, pos, rows[0].indent)
    return v === undefined ? SPEC_PARSE_FAIL : v
  } catch { return SPEC_PARSE_FAIL }
}

/** 去掉行尾注释 —— 只在 `#` 前面是空白且那一行不是纯 `#` 注释时才算注释。 */
function stripYamlComment(s) {
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '#' && (i === 0 || s[i - 1] === ' ')) return s.slice(0, i).replace(/\s+$/, '')
  }
  return s
}

function yamlBlock(rows, pos, indent) {
  if (pos.i >= rows.length) return null
  return rows[pos.i].text.startsWith('- ') || rows[pos.i].text === '-'
    ? yamlSeq(rows, pos, indent)
    : yamlMap(rows, pos, indent)
}

function yamlSeq(rows, pos, indent) {
  const out = []
  while (pos.i < rows.length) {
    const r = rows[pos.i]
    if (r.indent !== indent || !r.text.startsWith('-')) break
    const rest = r.text.slice(1).trim()
    pos.i += 1
    if (rest === '') {
      // `-` 后面整块缩进内容
      const item = pos.i < rows.length && rows[pos.i].indent > indent
        ? yamlBlock(rows, pos, rows[pos.i].indent)
        : null
      out.push(item)
      continue
    }
    const kv = yamlKeyValue(rest)
    if (!kv) { out.push(yamlScalar(rest)); continue }
    // `- key: value` —— 该项是个映射,首行这对键值要和后面同缩进的键合并
    const item = {}
    item[kv.k] = kv.v === '' ? (pos.i < rows.length && rows[pos.i].indent > indent ? yamlBlock(rows, pos, rows[pos.i].indent) : null) : yamlScalar(kv.v)
    while (pos.i < rows.length && rows[pos.i].indent > indent) {
      const inner = rows[pos.i]
      if (inner.text.startsWith('- ')) break
      const kv2 = yamlKeyValue(inner.text)
      // `kv2.v === ''` 是"这个键的值在更深的缩进里",必须继续收(把这种情况一起 break 掉,
      // 于是 `- name: userId` 后面的 `in: path` / `schema:` 全丢,`paths` 解析成 null)
      if (!kv2) break
      pos.i += 1
      item[kv2.k] = kv2.v !== ''
        ? yamlScalar(kv2.v)
        : (pos.i < rows.length && rows[pos.i].indent > inner.indent ? yamlBlock(rows, pos, rows[pos.i].indent) : null)
    }
    out.push(item)
  }
  return out
}

function yamlMap(rows, pos, indent) {
  const out = {}
  while (pos.i < rows.length) {
    const r = rows[pos.i]
    if (r.indent !== indent || r.text.startsWith('-')) break
    const kv = yamlKeyValue(r.text)
    if (!kv) return out
    pos.i += 1
    if (kv.v !== '') { out[kv.k] = yamlScalar(kv.v); continue }
    out[kv.k] = pos.i < rows.length && rows[pos.i].indent > indent
      ? yamlBlock(rows, pos, rows[pos.i].indent)
      : null
  }
  return out
}

/** `key: value` / `key:` —— 找不到键值对返回 null(调用方当解析失败处理)。 */
function yamlKeyValue(s) {
  const m = /^("([^"]*)"|'([^']*)'|([^:]+?))\s*:(?:\s+(.*))?$/.exec(s)
  if (!m) return null
  const k = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : String(m[4] || '').trim())
  if (k === '') return null
  return { k, v: m[5] === undefined ? '' : String(m[5]).trim() }
}

function yamlScalar(s) {
  const t = String(s).trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  if (t.startsWith('[') && t.endsWith(']')) {
    return t.slice(1, -1).split(',').map((x) => yamlScalar(x)).filter((x) => x !== '')
  }
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'null' || t === '~') return null
  if (/^-?\d+$/.test(t)) return Number(t)
  return t
}

/**
 * 结构比对用:把这个 JSON 文档里**所有叶子值**摊平成一维。
 * 出**字符串与数字**(不做 `'200'` / `200` 的区分 —— 两种序列化都合法,内容一样),
 * 布尔与 null 不出(它们是结构而不是内容,`required: true`、`nullable: null` 这类
 * 到处都有,计入只会抬高比率、制造误报)。
 */
function specLeaves(node, out, depth) {
  const acc = out || []
  if ((depth || 0) > 40) return acc
  if (Array.isArray(node)) {
    for (const c of node) specLeaves(c, acc, (depth || 0) + 1)
    return acc
  }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) specLeaves(node[k], acc, (depth || 0) + 1)
    return acc
  }
  if (typeof node === 'string' || typeof node === 'number') acc.push(String(node))
  return acc
}

/** 结构比对用:把这个 JSON 文档的**键路径**摊平成一维(`paths./users.get.responses.200` 这种)。 */
function specKeyPaths(node, prefix, out, depth) {
  const acc = out || []
  const pre = prefix || ''
  if ((depth || 0) > 40) return acc
  if (Array.isArray(node)) {
    for (const c of node) specKeyPaths(c, `${pre}[]`, acc, (depth || 0) + 1)
    return acc
  }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) specKeyPaths(node[k], `${pre}.${k}`, acc, (depth || 0) + 1)
    return acc
  }
  acc.push(pre)
  return acc
}

/** 去重后的交集大小(两侧都去重:重复出现的 `type: string` 不该把命中数刷上去)。 */
function countOverlap(a, b) {
  const sa = new Set(a)
  const sb = new Set(b)
  let hit = 0
  for (const x of sa) if (sb.has(x)) hit += 1
  return hit
}

/** 归一化后的有效行(去空白、去空行、去整行注释)—— 逐行比对用。 */
function specLines(text) {
  return String(text === undefined || text === null ? '' : text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('//'))
}

/**
 * 惰性读取包内参考件。
 *
 * 最朴素的写法
 *   `if (REFERENCE_CACHE) return REFERENCE_CACHE` … `REFERENCE_CACHE = out; return out`
 * 有两个坑叠在一起:
 *   ① **空数组也进缓存**:首次调用时参考件读不到(`out = []`),`REFERENCE_CACHE` 变成 `[]`,
 *      而 `[]` 是**真值** → 此后本进程**余生**都走 `return REFERENCE_CACHE`,再也不读盘;
 *      于是 `templateDumpFindings` 每次都从 `refs.length === 0` 分支返回
 *      "参考模板读不到,这条校验没有执行" —— 归属校验**永久失效**,而人只看得到一句 warning。
 *      触发条件很现实:插件与 skills/ 分两次部署、或部署中途有一次 lint 调用。
 *   ② **永不失效**:参考件事后被换掉(升级、手工改),本进程仍拿旧文本比对。
 *
 * 修法(两件一起做,因为它们是同一处代码的两个洞):
 *   · 读不到就**不进缓存**(`out.length === 0` 直接返回),下一次调用重新尝试 —— 部署完成后
 *     不需要重启进程就能恢复校验;
 *   · 读到了也要**记住来源(mtime + size)**,每次调用先核对 `referenceStamp()`:
 *     任一文件变了(或文件数变了)就整份重读。核对本身只是几次 `statSync`,
 *     而 lint 本来就是 IO 活儿,这点开销可以忽略。
 */
function referenceTemplates() {
  const stamp = referenceStamp()
  if (REFERENCE_CACHE && REFERENCE_CACHE.stamp === stamp) return REFERENCE_CACHE.list
  const out = []
  for (const kind of Object.keys(API_TEMPLATES)) {
    const file = API_TEMPLATES[kind][0]
    try { out.push({ kind, file, text: fs.readFileSync(path.join(API_SKILL_DIR, 'references', file), 'utf8') }) } catch { /* 包内没有就跳过 */ }
  }
  // 空结果**不进缓存** —— 否则一次读失败就把整条归属校验钉死在本进程里
  if (out.length === 0) return out
  REFERENCE_CACHE = { stamp, list: out }
  return out
}

/** 参考件目录的"来源指纹"(每个文件的 mtimeMs + size,按文件名排序)。读不到目录返回空串。 */
function referenceStamp() {
  const dir = path.join(API_SKILL_DIR, 'references')
  try {
    return fs.readdirSync(dir).sort().map((f) => {
      try {
        const st = fs.statSync(path.join(dir, f))
        return `${f}:${st.mtimeMs}:${st.size}`
      } catch { return `${f}:?` }
    }).join('|')
  } catch { return '' }
}

let REFERENCE_CACHE = null

/** 扫描项目根下的候选目录,返回候选契约文件(不做 lint,调用方决定)。 */
export function discoverApiSpecs(root, extraPaths) {
  const found = []
  const seen = new Set()
  /**
   * 三类"静默跳过"必须留痕 —— 超限(512 KB)/ 读失败 / 超深度若都不说一个字,
   * 于是"契约明明在,插件却说扫不到"这种局面没法自查(与 80 文件上限那条提示同一族问题)。
   * 记录挂在返回的数组上(`found.skipped`),不改函数签名 —— 既有调用方一行都不用动。
   *
   * "既有调用方一行都不用动"这句只对**形状**成立,对**条数**不成立:
   * 明细封顶 20 条时,`apiSkipCoverage(found.skipped, found.length)` 这种老调用方拿到的
   * 计数**直接是错的**(截断后 25 处只会数出 19 处)。现在改成"计数与明细分开":
   *   · `skippedTotal` —— 不封顶的**计数**(与数组平行的一个字段,形状仍是数组,老调用方读不到它也不会崩);
   *   · `skipped` —— 只留前 `API_SKIP_DETAIL_MAX` 条的**明细**(留痕要能一条条枚举);
   *   · 老调用方即使只传数组,`apiSkipCoverage` 也会自己从 `skipped.skippedTotal` 取计数 → 自动说真话。
   */
  const skipped = []
  let skippedTotal = 0
  const noteSkip = (o) => { skippedTotal += 1; if (skipped.length < API_SKIP_DETAIL_MAX) skipped.push(o) }
  const push = (rel, abs) => {
    if (found.length >= API_SCAN_MAX_FILES || seen.has(abs)) return
    seen.add(abs)
    try {
      const st = fs.statSync(abs)
      if (!st.isFile()) return
      if (st.size > API_SCAN_MAX_BYTES) { noteSkip({ rel, reason: 'oversize', size: st.size, limit: API_SCAN_MAX_BYTES }); return }
      const text = fs.readFileSync(abs, 'utf8')
      const kind = classifySpec(rel, text)
      if (kind === 'unknown') return
      // .json 只认真正的契约文件,免得把 package.json / tsconfig.json 全捞进来
      if (kind === 'generic' && /\.json$/i.test(rel) && !/"(openapi|swagger|asyncapi)"\s*:/.test(text)) return
      found.push({ rel, path: abs, text, kind, size: st.size })
    } catch (e) { noteSkip({ rel, reason: 'unreadable', error: String((e && e.code) || (e && e.message) || e) }) }
  }
  const walk = (dir, base, depth) => {
    if (depth > API_SCAN_MAX_DEPTH) { noteSkip({ rel: base || '.', reason: 'depth', limit: API_SCAN_MAX_DEPTH }); return }
    if (found.length >= API_SCAN_MAX_FILES) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (found.length >= API_SCAN_MAX_FILES) return
      const nm = String(ent.name)
      if (API_SCAN_SKIP.indexOf(nm) !== -1) continue
      const abs = path.join(dir, nm)
      const rel = base ? `${base}/${nm}` : nm
      if (ent.isDirectory()) { walk(abs, rel, depth + 1); continue }
      if (!ent.isFile()) continue
      if (API_SCAN_EXT.indexOf(path.extname(nm).toLowerCase()) === -1) continue
      push(rel, abs)
    }
  }
  const rootStr = String(root || '')
  for (const rel of API_SCAN_DIRS) {
    const abs = path.join(rootStr, rel)
    try { if (fs.statSync(abs).isDirectory()) walk(abs, rel === '.' ? '' : rel, 0) } catch { /* 目录不存在 */ }
  }
  for (const p of (Array.isArray(extraPaths) ? extraPaths : [])) {
    const abs = path.isAbsolute(String(p)) ? String(p) : path.join(rootStr, String(p))
    try {
      const st = fs.statSync(abs)
      if (st.isDirectory()) walk(abs, path.relative(rootStr, abs).replace(/\\/g, '/'), 0)
      else push(path.relative(rootStr, abs).replace(/\\/g, '/'), abs)
    } catch { /* 路径不存在 */ }
  }
  found.skipped = skipped
  /**
   * 与明细**平行**的计数 —— 不改既有字段的形状(`skipped` 仍是那个数组),
   * 只多挂一个数:明细被截断时,这个数才是"到底记下了几条跳过记录"的真话。
   *
   * 挂**两处**是有意的:`found.skippedTotal` 给结构化读者,`skipped.skippedTotal`(挂在明细
   * 数组自己身上)让"只把数组传下去"的老调用方也能自动说真话 —— 否则那句"老调用方一行不用改"
   * 只对**形状**成立、对**数字**仍然不成立(实测:反面用例里
   * `apiSkipCoverage(found.skipped, found.length)` 数出的还是被截断的 20)。
   */
  found.skippedTotal = skippedTotal
  skipped.skippedTotal = skippedTotal
  return found
}

/**
 * 判定与建议必须跟着覆盖面走。
 *
 * 三类"静默跳过"已有留痕、也进了显示面 —— 但
 * **判定**与**建议**没跟着走:
 *   有 3 个候选被跳过时,同一条回执上写「⚠️ 有 3 个候选被**跳过**」,下写
 *     「结论:✅ PASS | ERROR 0 / WARN 0」—— 而这条结论只覆盖 3/6 个候选,模型很容易读成
 *     "API 门槛已过"。
 *   那句「若契约明明在,请用 paths 精确指路」在 oversize 场景下**是错的**:
 *     ① `paths` 是**追加**(默认候选目录 ∪ paths),不是收窄;② size 守卫在 `push()` 里
 *     **无条件**生效 —— 把 paths 精确指到那个超限文件上,它照样被跳过。模型照做一次、
 *     回执一字未变,于是得出"这文件确实扫不到",正是留痕要消灭的盲区。
 *
 * 这里把两件事收进同一处口径:覆盖面(结构化 → 判定与渲染共用)+ **按 reason 分支**的建议。
 * 纯函数,离线断言可直接 import。
 */
export function apiSkipCoverage(skipped, covered, skippedTotal) {
  /**
   * `paths` 与默认候选目录**重叠**时,同一个候选会被走两遍 ——
   * 例如默认扫描已经覆盖 `api/`,再 `paths=["api"]` 就会把 `api/nested/a`(depth)记两次。
   * 那是**同一个候选**,重复计数会把分母撑大、把覆盖面说小(实测:
   * 实际 2 个候选被跳过,旧口径报成 4 个 → 「只覆盖 1/5」,而真值是 1/3)。
   * 按 `rel|reason` 去重,保留首次出现的那条(顺序即"谁先被扫到")。
   *
   * ── 口径 v2:**嵌套的 depth 记录也只算一处** ──────────────
   * 实测:`discoverApiSpecs` 会从**项目根**和**每个候选目录**各走一遍,
   * 同一片未展开的深子树因此有两种记法 —— 从根起走它在第 3 层就超限(`api/nested/a`),
   * 从 `api` 起走它才刚到第 3 层(`api/nested/a/b`)。旧口径把它们算两处:
   * 回执说"跳过 3",而**真实未扫到的候选是 2 个**(1 个 oversize 文件 + 1 个深件)。
   *
   * 为什么**留最深的那条**:skip 记的是"这个目录没被展开",而深度预算从各次 walk 的
   * **基址**算起。基址更深的 walk 已经在同一支里把上层文件扫过了 —— 它的边界深度 =
   * 基址深度 + 上限 + 1,于是祖先那条记法里的文件必在它的预算内(要么被 push,要么
   * 按自己的原因另记一条)→ 祖先那条是**过近似**,丢掉它不丢信息,而且更深的那条 rel
   * 才是"要补进结论该指哪儿"。**兄弟**子树(互不为祖先)各留各的号:它们各自都是
   * 没被展开的地方(这条有专门的断言守着,别把它误折掉)。
   *
   * 计数单位随之明确(见 `apiCoverageText`):跳过 = **处**,一处 = 一个文件
   * (oversize / unreadable / other)或一棵未展开的子树(depth,已折叠)。
   */
  const normRel = (s) => String(s === undefined || s === null ? '' : s).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  const seen = new Set()
  const list = []
  for (const s of (Array.isArray(skipped) ? skipped : [])) {
    if (!s || typeof s !== 'object') continue
    // 归一后同键才算同一条(`api\x` 与 `api/x`、`./api/x` 与 `api/x` 是同一个目标)
    const key = `${normRel(s.rel)}|${String(s.reason || '')}`
    if (seen.has(key)) continue
    seen.add(key)
    list.push(s)
  }
  const isDepth = (s) => String(s.reason || '') === 'depth'
  const relOf = (s) => normRel(s.rel)
  const depthDirs = list.filter(isDepth).map((s) => relOf(s))
  // 有另一条 depth 记录落在我**之下** ⇒ 我是过近似(基址更深的那次 walk 已经替我扫过了)
  const kept = list.filter((s) => !isDepth(s) || !depthDirs.some((o) => o !== relOf(s) && o.indexOf(`${relOf(s)}/`) === 0))
  const cnt = (r) => kept.filter((s) => String(s.reason || '') === r).length
  const known = cnt('oversize') + cnt('depth') + cnt('unreadable')
  const regions = cnt('depth')
  /**
   * ── 计数与明细对账 —— 差的那些**连明细都没有** ──────────────
   * 明细只留前 `API_SKIP_DETAIL_MAX` 条(留痕要能一条条枚举),计数不封顶。
   * 这里两者的差额就是"只在计数里、没有明细"的条数(`missingDetail`)。
   *
   * 有差额时,**所有"处 / 个"的数字都只是下界**:被截掉的那几条可能是文件、也可能是一整棵
   * 子树,而且**折叠也算不了它们**(折叠要靠明细里的 rel 比对)→ 于是:
   *   · `truncated = true`、`exactTotal = false`(分母不精确 → 一律不给分数);
   *   · 渲染层凡是要报这个数,都经 `apiSkipCountText()` 写成 `≥N`;
   *   · 并且明确说清"数据面 `scanSkipped` 也是**明细**、同样没有那几条" —— 否则那句
   *     「scanSkipped 里有全量」在截断时是**做不到的指引**(违反「建议必须能被照做」)。
   *
   * 计数从哪来:显式第三参 >(缺省时)数组自带的 `skipped.skippedTotal` > 明细条数。
   * 第二条让"只传数组"的老调用方**自动**说真话(`discoverApiSpecs` 会把计数挂在数组上),
   * 只传两个参数的调用一行都不用改,行为逐字一致(那时不会有 skippedTotal)。
   */
  const detailCount = Array.isArray(skipped) ? skipped.length : 0
  const totalArg = (skippedTotal === undefined || skippedTotal === null)
    ? (Array.isArray(skipped) ? skipped.skippedTotal : undefined)
    : skippedTotal
  const rawTotal = (totalArg === undefined || totalArg === null || !isFinite(Number(totalArg)))
    ? detailCount
    : Math.max(detailCount, Math.floor(Number(totalArg)))
  const missingDetail = Math.max(0, rawTotal - detailCount)
  const truncated = missingDetail > 0
  return {
    covered: Math.max(0, Number(covered) || 0),
    skipped: kept.length,
    total: Math.max(0, Number(covered) || 0) + kept.length,
    // 文件级跳过(oversize / unreadable / other)与未展开子树分开报 —— 前者"有明确目标",
    // 后者"里面有几个候选是未知数",混在一个数里正是高估/低估的来源。
    files: kept.length - regions,
    regions,
    // 分母精确 = ① 没有未展开的子树(**没有未知数**)② 明细没被截断(数的就是全部)。
    // 任何一条不满足,分数就没有根据 —— 宁可说"已扫到的 M 个候选",也不给一个人造分母。
    exactTotal: regions === 0 && !truncated,
    reasons: { oversize: cnt('oversize'), depth: regions, unreadable: cnt('unreadable'), other: kept.length - known },
    entries: kept.map((s) => ({
      rel: String(s.rel === undefined || s.rel === null ? '' : s.rel),
      reason: String(s.reason || 'other'),
      size: typeof s.size === 'number' ? s.size : null,
      limit: typeof s.limit === 'number' ? s.limit : null,
      error: s.error ? String(s.error) : null,
    })),
    // 计数与明细的对账结果 —— 渲染层靠这四个字段说"这个数只是下界"
    detailMax: API_SKIP_DETAIL_MAX,
    detailCount,
    skippedTotal: rawTotal,
    missingDetail,
    truncated,
  }
}

/**
 * 跳过计数的**唯一**展示入口 —— 明细被截断时这个数只是**下界**。
 *
 * 为什么单开一个函数:同一个数在回执里有六处出现(总述行 / 扫描行 / 降级行 / note /
 * 「上次 lint」行 / 两处面板),口径一改就会漏掉一两处 —— 那样"数字说得比证据多"的毛病
 * 会从被修好的那处**换个地方**再长出来。凡是要报"跳过几处",都从这里取。
 */
export function apiSkipCountText(cov) {
  const c = cov && typeof cov === 'object' ? cov : {}
  const n = Math.max(0, Number(c.skipped) || 0)
  return c.truncated ? `≥${n}` : `${n}`
}

/** 字节数的可读写法(留痕文案里要说清"多大 > 多大上限")。 */
function fmtBytes(n) {
  const v = Number(n)
  if (!isFinite(v) || v <= 0) return '0 B'
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(v < 10240 ? 1 : 0)} KB`
  return `${(v / 1024 / 1024).toFixed(1)} MB`
}

/** 单个跳过条目的可读描述:`api/x.yaml(2.7 MB > 512 KB)` / `api/nested/a(深度 > 2)` / `api/y.proto(读失败:EACCES)`。 */
export function skipEntryText(s) {
  if (s.reason === 'oversize') return `${s.rel}(${fmtBytes(s.size)} > ${fmtBytes(s.limit)})`
  if (s.reason === 'depth') return `${s.rel}(深度 > ${s.limit === null || s.limit === undefined ? API_SCAN_MAX_DEPTH : s.limit})`
  if (s.reason === 'unreadable') return `${s.rel}(读失败${s.error ? `:${s.error}` : ''})`
  return `${s.rel}(${s.reason})`
}

/** 跳过构成的短句:`1 个文件 + 1 棵未展开的子树`(给"跳过 N 处(…)"这种句式用)。 */
export function apiSkipBreakdown(cov) {
  const c = cov && typeof cov === 'object' ? cov : apiSkipCoverage([], 0)
  const files = Math.max(0, Number(c.files) || 0)
  const regions = Math.max(0, Number(c.regions) || 0)
  const parts = []
  if (files > 0) parts.push(`${files} 个文件`)
  if (regions > 0) parts.push(`${regions} 棵未展开的子树`)
  return parts.join(' + ')
}

/**
 * 覆盖面的一句话(口径 v2)—— **全文件唯一出处**:结论行 / 扫描行 / 降级行 /
 * note / `上次 lint` 行 / relay 与 state 两处面板都调它,免得同一件事有六种说法。
 *
 * 为什么分两种写法(口径细化的核心):
 *   · 跳过**全是文件**(oversize / unreadable)时,分母是**精确的候选数** → 照旧给分数
 *     `M/N(P%)`,既有回执逐字一致(那时也只能有这一类);
 *   · 只要有一棵**未展开的子树**,它里面有几个候选就是**未知数** → **不给分数**。
 *     把子树也当"1 个候选"塞进分母:一棵装着 50 份契约的子树会被算成 1,于是
 *     "覆盖 8/9(89%)"这种**高估**照样打得出来 —— 与要消灭的高估同源,只是方向相反。
 *     现在如实说"已扫到 M 个候选;另有 S 处未扫到,子树内容未知"。
 *
 * 更早的记录(没有 `exactTotal` 的那些)按原有写法渲染 ——
 * 不拿新口径去改历史结论的说法,也不假装它是新口径算出来的。
 *
 * 再加一种:**明细被截断**(`truncated`)时也不给分数,并且给这个数
 * 加 `≥` —— 明细只有前 N 条时,连"跳过几处"都数不全(见 `apiSkipCoverage` 的对账)。
 *
 * @param {object} cov apiSkipCoverage() 的返回
 * @param {boolean} short 面板/状态行用的短写法(`1/3` 或 `1 个候选,跳过 2 处`)
 */
export function apiCoverageText(cov, short) {
  const c = cov && typeof cov === 'object' ? cov : apiSkipCoverage([], 0)
  const covered = Math.max(0, Number(c.covered) || 0)
  const skipped = Math.max(0, Number(c.skipped) || 0)
  if (c.exactTotal === undefined) return `${covered}/${Math.max(0, Number(c.total) || 0)}` // 更早写的记录,没有 exactTotal
  if (skipped === 0) return short ? `${covered}` : `${covered} 个候选(全部已扫描)`
  if (c.exactTotal) {
    const total = Math.max(1, Number(c.total) || 0)
    return short ? `${covered}/${c.total}` : `${covered}/${c.total} 个候选(${Math.round((covered / total) * 100)}%)`
  }
  /**
   * 明细被截断时连"几处"都只是**下界**(被截掉的那几条可能是文件、也可能整棵子树),
   * 所以这里加 `≥`,并且把"共几条记录 / 其中几条没有明细"一并说出来 —— 读者不必再去别处找,
   * 更不必去找一个并不存在的"全量字段"。
   */
  if (c.truncated) {
    return short
      ? `${covered} 个候选,跳过 ${apiSkipCountText(c)} 处(明细截断)`
      : `${covered} 个已扫到的候选(另有 ${apiSkipCountText(c)} 处未扫到,子树内容未知;跳过记录共 ${c.skippedTotal} 条,其中 ${c.missingDetail} 条没有明细)`
  }
  return short
    ? `${covered} 个候选,跳过 ${skipped} 处`
    : `${covered} 个已扫到的候选(另有 ${skipped} 处未扫到,子树内容未知)`
}

/**
 * 跳过留痕全文:**列全**(`slice(0, 3)` + `…` 会让第 4 条起永久不可见),
 * 并按 reason 分支给"照做有效 / 无效"的建议。
 *
 * 这里有两种"截断",必须**分开说**、而且都不许指向一个同样没有它们的地方 ——
 *   · **每组显示上限**(`perGroupMax`,默认 6):超出的那些**还在** `coverage.entries` 里,
 *     所以照旧可以说"数据面字段 scanSkipped 里有全量"(这句话只在这一种情形下成立);
 *   · **明细本身的截断**(`cov.truncated`,源头只留了前 `API_SKIP_DETAIL_MAX` 条):
 *     那些条目**哪儿都没有**(`scanSkipped` 就是明细的投影)→ 必须当场说清,
 *     否则模型会照着"去找全量"翻 payload,只看到同样一批,于是得出错误的总数。
 *
 * @param cov apiSkipCoverage() 的返回
 * @param perGroupMax 每组最多列几条(默认 6;超出时如实报"另有 N 个" —— 明细没被源头截断时,
 *        数据面 scanSkipped 里确实还有这批;被截断时按上面第二种说法如实交代)
 */
export function apiSkipNote(cov, perGroupMax) {
  const c = cov && typeof cov === 'object' ? cov : apiSkipCoverage([], 0)
  if (!c.skipped) return ''
  const cap = Number(perGroupMax) > 0 ? Number(perGroupMax) : 6
  /**
   * 总述行(口径 v2):跳过**全是文件**时沿用原有说法("有 N 个候选被跳过"+ 覆盖 M/N(P%));
   * 只要有未展开的子树,就换单位说"跳过 N 处(1 个文件 + 1 棵未展开的子树)",并且**不给分数** ——
   * 分母里有未知数,给了就是高估(理由见 `apiCoverageText`)。
   */
  const lines = [c.exactTotal
    ? `⚠️ 有 ${c.skipped} 个候选被**跳过**:本次结论只覆盖 ${apiCoverageText(c)} —— **不算完整通过**`
    : (c.truncated
      // 明细被截断 → 计数加 `≥`,并点名下面的构成只按**已留明细**算(见紧随其后那行)
      ? `⚠️ 跳过 ${apiSkipCountText(c)} 处(${apiSkipBreakdown(c)} —— 只按**已留明细**算):本次结论只覆盖 ${apiCoverageText(c)} —— **不算完整通过**`
      : `⚠️ 跳过 ${c.skipped} 处(${apiSkipBreakdown(c)}):本次结论只覆盖 ${apiCoverageText(c)} —— **不算完整通过**`)]
  /**
   * 截断当场交代 —— 放在总述行**之后、各组之前**:读者先知道"下面的清单本身不全",
   * 才不会把"列了 6 条"读成"一共就 6 条"。措辞刻意把两件事分开:
   *   「只保留前 N 条明细」= 留痕与数据面**都**只有这些;「另有 M 条连明细都没有」= 别再去找。
   */
  if (c.truncated) {
    lines.push(`  · ⚠️ **明细已截断**:本次共记下 ${c.skippedTotal} 条跳过记录(同一片区域被不同基址的扫描各记一次时会各算一条,所以**记录条数 ≥ 处数**),留痕只保留前 ${c.detailMax} 条明细;另有 ${c.missingDetail} 条**连明细都没有**(数据面 \`scanSkipped\` 是**明细**、同样没有它们 —— 它们只在计数里,别去找"全量")`)
  }
  const group = (reason, head, advice, unit) => {
    const list = c.entries.filter((s) => s.reason === reason)
    if (list.length === 0) return
    lines.push(`  · ${head} ${list.length} ${unit || '个'} —— ${advice}`)
    for (const s of list.slice(0, cap)) lines.push(`      - ${skipEntryText(s)}`)
    if (list.length > cap) lines.push(c.truncated
      ? `      - …另有 ${list.length - cap} 个同类条目(数据面字段 scanSkipped 里有这一批;**它不是全量** —— 见上面的「明细已截断」)`
      : `      - …另有 ${list.length - cap} 个同类条目(数据面字段 scanSkipped 里有全量)`)
  }
  group('oversize', `超过 ${fmtBytes(API_SCAN_MAX_BYTES)} 上限(oversize):`, '**paths 精确指路对它无效**(size 守卫对 paths 同样生效)—— 把文件拆到上限以下,或确认它不属于本项目契约并在「API 契约」小节**显式登记为未校验**')
  // depth 组的单位是"棵"(一棵未展开的子树),不是"个文件" —— 里面有几个候选是未知数,
  // 而且这里的条数已经按"同一片子树只算一处"折叠过(见 apiSkipCoverage 的口径 v2)。
  group('depth', `超过 ${API_SCAN_MAX_DEPTH} 层目录深度(depth):`, '**用 paths 精确指到"文件"可以把它补进结论**;指到它**附近(不超过 2 层)的目录**同样有效,指到更高的祖先目录仍会因深度被跳过 —— paths 是**追加**到默认候选,不是收窄', '棵')
  group('unreadable', '读取失败(unreadable):', '确认编码/权限后重试;仍读不到就登记为未校验')
  group('other', '其它原因(other):', '按括号里的原因处理')
  return lines.join('\n')
}

/** 范式选择 / 信封 / 版本化(api_contract action=guide)。 */
export function apiGuide() {
  return [
    '# API 契约:先定这四件事',
    '',
    '1. **范式** —— REST 做 CRUD 与对外公开接口;GraphQL 做前端要灵活取数的聚合层;',
    '   gRPC 做内部服务间调用(强类型 + 流式);WebSocket 只做推送,不做请求-响应。',
    '2. **信封**(全局统一,别一处一个样):',
    '   `success: { data, meta: { page, total } }` / `error: { error: { code, message, details: [{ field, issue }] } }`',
    '3. **版本化**(发第一个版本之前就定):URL `/v1/users`(对外推荐) / Header `Accept: ...;version=1` / Query `?version=1`',
    '4. **错误码表**:业务码 + HTTP 状态码两套并存,业务码稳定、可枚举、可写进 SDK。',
    '',
    '## 接下来',
    '- 取模板:`api_contract action=template kind=openapi|graphql|proto|ratelimit|security`(回全文,由你用 write 落到 ' + API_SPEC_DIR + '/)',
    '- 自检:`api_contract action=lint`(ERROR 必须为 0 **且 verdict 必须是 `pass`** 才准写进「API 契约」小节 —— `no_specs` / `pass_with_skips` 都不算通过)',
    '- 核对:`api_contract action=checklist`(④ 质检按它逐条核)',
    '- 规范全文:`skill name=' + API_SKILL_NAME + '`(技能里含十条反模式与参考件)',
  ].join('\n')
}

/** 质量清单(api_contract action=checklist)。 */
export function apiChecklist() {
  return [
    '# API 契约质量清单(逐条给结论,别写"已检查")',
    '',
    '## 契约本身',
    '- [ ] 端点全部用名词,动作交给 HTTP 方法(无 /getXxx /createXxx)',
    '- [ ] 响应信封全局一致(success/error 两种形态固定)',
    '- [ ] 错误响应带稳定的业务错误码 + 可执行文案 + 字段级 details',
    '- [ ] 所有列表端点都有分页(默认上限 + 游标/页码 + hasMore)',
    '- [ ] 鉴权/授权写明(securitySchemes / OAuth scope / RBAC 角色)',
    '- [ ] 限流档位与 X-RateLimit-* 响应头已定义',
    '- [ ] 版本策略写明(URL / Header / Query 三选一)',
    '- [ ] CORS 只放已知来源,不用 * 配凭证',
    '- [ ] 变更类接口支持 Idempotency-Key',
    '- [ ] 每种请求/响应都有示例',
    '',
    '## 落地核对(④ 质检)',
    '- [ ] `api_contract action=lint` 结果为 ERROR 0 **且 verdict=`pass`**(覆盖面 `M/M`;`pass_with_skips` = 有候选被跳过,要按留痕逐类处理或显式登记为未校验)',
    '- [ ] 实现与 spec 逐条对齐:路径 / 方法 / 字段名与类型 / 状态码 / 错误码',
    '- [ ] 分页参数与响应结构实现一致(别只在 spec 里好看)',
    '- [ ] 鉴权与限流真的生效(不是只写在文档里)',
    '- [ ] 破坏性变更走版本化 + 弃用头 + 下线期,并登记 contractRevision',
  ].join('\n')
}

/** 激活门的判定表(从"文件独裁"改成三选一,且可显式关闭)。
 *  优先级:`.active` 写 off(显式关闭)> `.active` 存在(显式开启)> 插件记忆(首用自动激活)
 *  > 项目里已有流程状态文档(跨机器/跨克隆自愈)。纯函数,便于单测。 */
export function gateDecision(input) {
  const i = input || {}
  if (i.fileExists) {
    // 独立的 off/inactive/false/0 行 = 显式关闭;其余内容(如 "active")一律视为开启
    if (/^\s*(off|inactive|false|0|disabled?)\s*$/im.test(String(i.fileText || ''))) return 'off'
    return 'file'
  }
  if (i.remembered) return 'remembered'
  if (i.stateDocExists) return 'state-doc'
  return 'none'
}

export const GATE_LABELS = {
  file: '文件 docs/workflow/.active',
  remembered: '插件记忆(首用自动激活)',
  'state-doc': '项目里已有流程状态文档',
  off: '显式关闭(.active 写了 off)',
  none: '未激活',
}

export function isActiveGate(gate) {
  return gate !== 'none' && gate !== 'off'
}

/**
 * 预设驱动自动激活的清单归一化。
 *
 * 纯函数、与 `apply` 无关,便于单测 —— 口径与 `gateDecision` 那一族相同(它们是同一个
 * 判定的两半:谁允许开工 / 什么时候开工)。
 *
 * 口径:
 *   · 缺省 `['dev-workflow']`(本机新建的那个预设 id);
 *   · `false` / `''` / `[]` 一律关掉 → 行为退回"只认文件"(其余预设本来就什么都不做);
 *   · 字符串与数组都收(配置从 YAML 来,`autoActivatePresets: dev-workflow` 与
 *     `['dev-workflow']` 两种写法都该能用),逐项去空白、丢掉空项。
 */
export function resolveAutoActivatePresets(value) {
  if (value === undefined || value === null) return ['dev-workflow']
  if (value === false || value === '') return []
  const list = Array.isArray(value) ? value : [value]
  const out = []
  for (const item of list) {
    const id = String(item).trim()
    if (id !== '') out.push(id)
  }
  return out
}

/**
 * 预设判定:**Session 投影优先,header 兜底**。
 *
 * 只读 `header.agentPreset` 不够 —— 那是**会话创建那一刻**的化石。DSH 的 Web 入口先按默认
 * 预设建会话(header 写 `cordis`),随后才把用户选的预设作为 `agent-preset/selected` 事件
 * 追加进会话日志。实测:
 *   · 第 1 行 header:`"agentPreset":"cordis"`;
 *   · 第 6 行 seq=4:`{"type":"agent-preset/selected","data":{"agentPreset":"dev-workflow"}}`。
 * 于是"在 dev-workflow 预设下"这件事在 header 上**永远看不见**,只读 header 的自动激活在真宿主上
 * 一次都没触发过,而且失败是静默的。
 *
 * 口径照抄 DSH 自己(`@deepseek-ai/dsh-agent-presets` 的 session.js 原文:
 * "Reconstruction reads the `agentPreset` Session projection, never the header")。
 *
 * 纯函数,与 `apply` 无关,便于单测 —— 与 `resolveAutoActivatePresets` 同一族。
 */
export function resolveSessionPreset(projectionValue, headerValue) {
  const live = typeof projectionValue === 'string' ? projectionValue.trim() : ''
  if (live !== '') return live
  return typeof headerValue === 'string' ? headerValue.trim() : ''
}

/**
 * 预设自动激活的四条入口(顺序就是渲染顺序)。
 * 单独导出,是因为"哪四条"这个口径同时被渲染(`formatPresetAutoStats`)、计数
 * (`presetAutoStats`)与判据( / )读 —— 三处各写一遍就会漂。
 */
export const PRESET_AUTO_VIAS = ['agent/created', 'session/event', 'agent-preset/selected', 'tools/execute']

/** 三个**判定结局**桶(顺序即渲染顺序;`outcome` 名与 `presetAutoStats` 的字段名逐字一致)。 */
export const PRESET_AUTO_OUTCOMES = [['activated', '激活'], ['gateOpen', '门已定'], ['notInList', '不命中清单']]

/**
 * 三个**没判成**的桶:它们发生在"判定"之前(清单被配置关掉 / 根还没就绪 / 会话查不到),
 * 而且**不去重**(`tools/execute` 每次调用都会重试) —— 所以与上面那三个分开报:
 * 混在一起会让"判定 N 次"的含义漂掉。
 */
export const PRESET_AUTO_UNJUDGED = [['noRoot', '根未就绪'], ['noAgent', '查不到会话'], ['disabled', '清单已关']]

/**
 * 把 `presetAutoStats` 渲染成**一行**人读文本(纯函数,便于单测)。
 *
 * 为什么要这一行:"判定发生了、而外面看不见"是最坏的一种 —— 四条入口只在"到且成功"时
 * 留痕,别的分支一路静默。这一行把"到达 / 判定 / 结局 / 没判成 / 最近一笔"五件事同时摆出来,
 * 于是"事件入口在真宿主上到不到"不必靠翻宿主日志。
 *
 * 容错口径:任何缺字段都不抛(旧宿主/半成品 payload 也要能渲染),一律按 0 计 ——
 * 报错会把一个"排障用的读数"变成新的故障点。
 */
export function formatPresetAutoStats(stats) {
  const s = stats && typeof stats === 'object' ? stats : {}
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
  const pair = (m, keys) => keys.map((k) => `${k}=${num(m && m[k])}`).join(' ')
  const nonZero = (m, keys) => keys.filter((k) => num(m && m[k]) > 0).map((k) => `${k}=${num(m && m[k])}`).join(' ')
  const buckets = (defs, extra) => defs
    .map(([key, label]) => {
      const n = num(s[key])
      const tail = key === 'activated' && n > 0 && extra !== '' ? `(${extra})` : ''
      return `${label} ${n}${tail}`
    })
    .join(' / ')
  const activatedVia = nonZero(s.activatedVia, PRESET_AUTO_VIAS)
  const last = typeof s.last === 'string' && s.last.trim() !== '' ? s.last.trim() : '(还没判过)'
  return `预设自动激活(本进程):到达 ${pair(s.reached, PRESET_AUTO_VIAS)}`
    + ` | 判定 ${num(s.judged)} 次(${nonZero(s.judgedVia, PRESET_AUTO_VIAS) || '(无)'})`
    + ` | 结局:${buckets(PRESET_AUTO_OUTCOMES, activatedVia)}`
    + ` | 没判成:${buckets(PRESET_AUTO_UNJUDGED, '')}`
    + ` | 最近:${last}`
}

// ── 插件本体 ────────────────────────────────────────────────────────────────

export const name = NAME
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const cfg = config || {}
  const BOOT_ID = `${Date.now()}-${process.pid}`

  /**
   * 预设驱动的自动激活。
   *
   * 依据:会话**运行时**的 preset —— `presetOf()` 读 Session 投影、header 兜底(
   * 只读 header 不够 —— header 是创建时的化石,据此判定在真宿主上一次都没触发过)。
   * 命中清单的会话,把它的 cwd 记成一笔"已开工",复用**既有的 `remembered` 档**,
   * 于是 gateDecision 的优先级、技能可见性、档案解析**全都不用改**:
   *   · 显式 `.active` 写 off 仍然赢(gateDecision 第一分支)→ 用户保留关掉它的手段;
   *   · 不命中的预设走既有那条链(文件 > 记忆 > 状态文档 > 未激活),行为一字不变;
   *   · **为什么必须落进 remembered、而不是做成"预设匹配就当场算激活"的瞬态判定**:
   *     skills 的 `SkillProvider.list(options)` 只收 `{cwd, signal}`,拿不到 agent/预设
   *     (见 dsh-skills 契约)。随包技能是按 cwd 查门的 —— 瞬态判定会造出
   *     "状态已激活、技能还藏着"的半开态,正是"两批技能必须一起翻转"这条不变量要守的。
   *
   * 缺省 ['dev-workflow'];要关掉就传 false / '' / [](行为退回"只认文件")。
   */
  const AUTO_ACTIVATE_PRESETS = resolveAutoActivatePresets(cfg.autoActivatePresets)
  /**
   * 每个 agent 只判一次。两个作用:
   *   ① 省掉 `tools/execute` 每次调用都去读盘(挂载校验时 gateStateOf 要 readFile + stat);
   *   ② **让用户会话内的 `relay action=deactivate` 站得住** —— 本插件是"进入预设时激活",
   *      不是"持续强制激活"。想彻底关掉仍可用 `.active` 写 off(它就赢在 gateDecision 第一分支)。
   */
  /**
   * 每个 **agent × 预设** 只判一次(键 = `agentId\u0000preset`)。三个作用:
   *   ① 省掉 `tools/execute` 每次调用都去读盘(挂载校验时 gateStateOf 要 readFile + stat);
   *   ② **让用户会话内的 `relay action=deactivate` 站得住** —— 本插件是"进入预设时激活",
   *      不是"持续强制激活"。想彻底关掉仍可用 `.active` 写 off(它就赢在 gateDecision 第一分支)。
   *   ③ 键里必须带预设:键若只有 agentId,**会话建立那一刻**的读数
   *      (`cordis`,默认预设)被缓存成"这个 agent 判过了" —— 而真宿主里预设是**之后**才提交的,
   *      兜底入口再也补不上。这不是优化过度,是这个缺陷的第二个成因。
   */
  const presetAutoSeen = new Set()

  /**
   * **各入口命中计数**(进程内,不落盘)。
   *
   * 由来 —— 预设命中而"门已开"时,判定在
   * `if (gateStateOf(root) !== 'none') return false` 那一步**如实短路**,而那一行在打日志之前,
   * 于是**四条入口到底通没通,在插件外面一个字都读不到**。代价是:观测者会先怀疑
   * "事件送不到",而不是"门已经开着"。
   *
   * 这格子补上之后,"入口健康度"不必靠翻日志猜:
   *   · `reached`  = 每条入口**到达**过几次(原始调用;`tools/execute` 每次工具调用都会到,
   *                 所以它数字大是正常的 —— 要看的是 `judged` 那一列);
   *   · `judged`   = 过了去重、**真的做了判定**的次数(按判定的那条入口记);
   *   · 结局桶      = 激活 / 门已开 / 不命中清单 / 根未就绪 / 查不到会话 / 清单已关;
   *   · `last`     = 最近一笔判定的可读描述(排障时一眼看到最后一次落在哪个分支)。
   *
   * ⚠️ **进程内**是刻意的:它是"本进程这几条入口健康度"的读数,落盘会让它变成跨重启的
   * 累计值,而"跨重启累计"回答不了它要回答的问题(重启后入口还通不通)。
   */
  const presetAutoStats = {
    reached: { 'agent/created': 0, 'session/event': 0, 'agent-preset/selected': 0, 'tools/execute': 0 },
    judged: 0,
    judgedVia: { 'agent/created': 0, 'session/event': 0, 'agent-preset/selected': 0, 'tools/execute': 0 },
    activated: 0,
    activatedVia: { 'agent/created': 0, 'session/event': 0, 'agent-preset/selected': 0, 'tools/execute': 0 },
    gateOpen: 0, notInList: 0, noRoot: 0, noAgent: 0, disabled: 0,
    last: '',
  }

  /** 入口到达计数(`${via}` 一定是四条入口之一;未知名字不计数,免得口径被写错的人悄悄撑大)。 */
  function bumpPresetReached(via) {
    const k = String(via || '')
    if (Object.prototype.hasOwnProperty.call(presetAutoStats.reached, k)) presetAutoStats.reached[k] += 1
  }

  /** 记一次"真的做了判定"及其结局。`desc` 人读,`last` 只留最近一笔。 */
  function bumpPresetJudged(via, outcome, desc) {
    const k = String(via || '')
    presetAutoStats.judged += 1
    if (Object.prototype.hasOwnProperty.call(presetAutoStats.judgedVia, k)) presetAutoStats.judgedVia[k] += 1
    if (Object.prototype.hasOwnProperty.call(presetAutoStats, outcome)) presetAutoStats[outcome] += 1
    // "哪条入口真的把项目开起来了" —— 与激活总数据同一次事件,分开记是为了回答"谁中的"
    if (outcome === 'activated' && Object.prototype.hasOwnProperty.call(presetAutoStats.activatedVia, k)) {
      presetAutoStats.activatedVia[k] += 1
    }
    presetAutoStats.last = `${desc}(via=${via})`
  }

  /** 状态面用:一行渲染 + 同源的结构化读数(relay / workflow_state_* 共用一个口径)。 */
  function presetAutoView() {
    return formatPresetAutoStats(presetAutoStats)
  }
  function presetAutoPayload() {
    const copy = (m) => Object.assign({}, m)
    return {
      reached: copy(presetAutoStats.reached),
      judged: presetAutoStats.judged,
      judgedVia: copy(presetAutoStats.judgedVia),
      activated: presetAutoStats.activated,
      activatedVia: copy(presetAutoStats.activatedVia),
      gateOpen: presetAutoStats.gateOpen,
      notInList: presetAutoStats.notInList,
      noRoot: presetAutoStats.noRoot,
      noAgent: presetAutoStats.noAgent,
      disabled: presetAutoStats.disabled,
      last: presetAutoStats.last,
      view: presetAutoView(),
    }
  }

  /**
   * 运行时自证的第二半 —— 读**磁盘上**那份 package.json 的版本。
   * 本模块的 VERSION 常量在加载时就定死了;若磁盘上的 package.json 后来被换成别的版本
   * (每次部署都会变),两者就会不一致 —— 这正是"部署了但没重启"的唯一信号,
   * 而且不需要任何外部脚本配合就能自己报出来。
   *
   * 不能写成 `catch { return '' }` —— **文件在、但读不动/解析不了**时,
   * 版本自证会**静默失效**(mismatch 恒为 false,status 一行都不报),而这一层保护恰恰
   * 是给"磁盘新、内存旧"兜底的。现在把"读不出来"本身变成一个可见状态。
   */
  const diskPkg = (() => {
    try {
      const p = fileURLToPath(new URL('../package.json', import.meta.url))
      const text = fs.readFileSync(p, 'utf8')
      const parsed = parsePackageVersion(text)
      if (parsed.error) return { version: '', error: `${p}:${parsed.error}` }
      return { version: parsed.version, error: '' }
    } catch {
      // 文件读不到(裁剪安装/权限)不算异常 —— 那种安装形态本就没有 package.json,不该每次启动报警
      return { version: '', error: '' }
    }
  })()
  const diskVersion = diskPkg.version
  const diskVersionError = diskPkg.error
  const versionMismatch = diskVersion !== '' && diskVersion !== VERSION
  /** 磁盘上**有** package.json 却读不出可用版本 = 版本自证这一层不成立,必须说出来。 */
  const versionUnverifiable = diskVersion === '' && diskVersionError !== ''

  /**
   * 把"磁盘版本"从**启动时取一次**改成**调用时按需重读**(按 mtime 缓存,不重复解析)。
   *
   * 原判据的两个取样点是同一时刻的:`VERSION` 是模块常量,`diskPkg` 在 apply 时读一次 ——
   * 于是"**进程启动之后**才换上新版"这一最该被抓住的场景,结构上报不出来(mismatch 恒为 false)。
   * 而这一层保护的**全部意义**就是发现"磁盘新、内存旧"。现在每次问都给当下的答案。
   */
  let diskPkgCache = { mtimeMs: -1, version: diskVersion, error: diskVersionError }
  function currentDiskVersion() {
    try {
      const p = fileURLToPath(new URL('../package.json', import.meta.url))
      const st = fs.statSync(p)
      if (st.mtimeMs !== diskPkgCache.mtimeMs) {
        const parsed = parsePackageVersion(fs.readFileSync(p, 'utf8'))
        diskPkgCache = { mtimeMs: st.mtimeMs, version: parsed.error ? '' : parsed.version, error: parsed.error ? `${p}:${parsed.error}` : '' }
      }
    } catch { /* 读不到就沿用上次的值(裁剪安装本就没有 package.json) */ }
    return { version: diskPkgCache.version, error: diskPkgCache.error }
  }
  function versionState() {
    const cur = currentDiskVersion()
    return {
      loaded: VERSION,
      disk: cur.version,
      error: cur.error,
      mismatch: cur.version !== '' && cur.version !== VERSION,
      unverifiable: cur.version === '' && cur.error !== '',
    }
  }

  // ── 私有状态存储─────────────────────────────────────────────────────
  const dshHome = () => {
    const env = process.env && process.env.DSH_HOME
    if (env && String(env).trim() !== '') return String(env).trim()
    return path.join(os.homedir(), '.dsh')
  }
  const storeDir = () => path.join(dshHome(), 'dev-workflow')
  const storePath = () => path.join(storeDir(), 'state.json')
  const profilesPath = () => path.join(storeDir(), 'profiles.json')
  const useFileStore = cfg.stateStore !== 'memory'

  const store = {
    version: STATE_VERSION,
    boot: '',
    updatedAt: '',
    projects: {},
    activeProfiles: {},
    /** 开工记忆 —— 首用自动激活落在这里(插件写不了工作区;详见 gateDecision)。 */
    activeProjects: {},
    dedupe: {},
    lifetime: { stateSaves: 0, relayCalls: 0, spawns: 0, toolCalls: 0, deliveries: 0, deliveryFailures: 0 },
  }
  /**
   * `blocked` = 读不出/隔离不了现有状态文件时**本进程拒绝落盘**。
   * "读失败只写一句 error,启动时那次 saveStore 照样整份覆盖同名文件" ——
   * 一次瞬时 IO 故障或手工改坏 JSON,就能让所有项目静默失忆,而 status 还报"可写"。
   */
  const storeHealth = { ok: null, error: '', path: storePath(), writes: 0, lastWriteAt: '', blocked: false, readError: '', lastWriteMtimeMs: 0, foreignMerge: null }

  function probeStore() {
    if (!useFileStore) { storeHealth.ok = false; storeHealth.error = 'stateStore=memory(配置为不落盘)'; return }
    try {
      fs.mkdirSync(storeDir(), { recursive: true })
      const probe = path.join(storeDir(), '.probe')
      fs.writeFileSync(probe, 'ok', 'utf8')
      fs.unlinkSync(probe)
      storeHealth.ok = true
      storeHealth.error = ''
    } catch (e) {
      storeHealth.ok = false
      storeHealth.error = String((e && e.message) || e)
    }
  }

  function loadStore() {
    if (!useFileStore) return
    let text = ''
    try {
      text = fs.readFileSync(storePath(), 'utf8')
    } catch (e) {
      const code = String((e && e.code) || '')
      // 首次运行(ENOENT)是正常的"没有文件",不是故障。
      if (code === 'ENOENT') return
      // 读不出来 ≠ 没有数据。EACCES/EBUSY/EPERM/网络盘断连/杀软占用这类
      // **一次性故障**下若带着空 store 继续,紧接着启动那次 saveStore 把现有文件
      // 整份覆盖 —— 所有项目静默失忆,而且 status 仍然报"可写"。
      // 现在改为**锁存**:本进程一律不落盘,原因写进 readError 并在 status 里显式暴露。
      storeHealth.blocked = true
      storeHealth.ok = false
      storeHealth.readError = `状态文件读不出来(${code || String((e && e.message) || e)}):为不覆盖现有数据,本进程拒绝落盘;排除故障后重启即可恢复`
      storeHealth.error = storeHealth.readError
      return
    }
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') {
        store.projects = parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : {}
        store.activeProfiles = parsed.activeProfiles && typeof parsed.activeProfiles === 'object' ? parsed.activeProfiles : {}
        store.activeProjects = parsed.activeProjects && typeof parsed.activeProjects === 'object' ? parsed.activeProjects : {}
        store.dedupe = parsed.dedupe && typeof parsed.dedupe === 'object' ? parsed.dedupe : {}
        store.lifetime = Object.assign(store.lifetime, parsed.lifetime || {})
        // 写入次数若每次启动都从 0 起, 1206 行刚读回来的历史值
        // 马上被 saveStore 用 1 覆盖 —— 注释宣称的"独立持久化"从来没成立过
        //(实测:重启前 lifetime.storeWrites=14,重启后变 1)。
        // 现在从盘上的历史值续接,status 的"已写 N 次"才是真正的累计。
        const persistedWrites = Number(parsed.lifetime && parsed.lifetime.storeWrites)
        if (Number.isFinite(persistedWrites) && persistedWrites > 0) storeHealth.writes = persistedWrites
        store.updatedAt = String(parsed.updatedAt || '')
        store.loadedFrom = storePath()
        store.loadedBoot = String(parsed.boot || '')
        // 记下"读进内存那一刻"的 mtime —— mergeForeignWrite 用它判断
        // "这份文件自我们读入之后有没有被别人动过"(boot 相同**不代表**没动过)。
        try { storeHealth.loadedMtimeMs = fs.statSync(storePath()).mtimeMs } catch { storeHealth.loadedMtimeMs = 0 }
      }
    } catch (e) {
      // 文件在、但内容坏了。把它当"空状态"直接写回同名文件 —— 原始字节
      // 永久消失,连取证的机会都没有。现在**先隔离留证**(改名 .bad-<时间戳>)再以空状态
      // 继续;若连改名都失败,就锁存不写(宁可本次不落盘,也不覆盖用户数据)。
      const bad = `${storePath()}.bad-${makeTS().replace(/[^0-9]/g, '').slice(0, 14)}`
      storeHealth.readError = `状态文件解析失败(${String((e && e.message) || e)})`
      try {
        fs.renameSync(storePath(), bad)
        storeHealth.error = `${storeHealth.readError};已隔离留证为 ${path.basename(bad)},本次以空状态继续`
      } catch (e2) {
        storeHealth.blocked = true
        storeHealth.ok = false
        storeHealth.error = `${storeHealth.readError}且无法隔离(${String((e2 && e2.message) || e2)}):为不覆盖,本进程拒绝落盘`
        storeHealth.readError = storeHealth.error
      }
    }
  }

  /**
   * 落盘前先看盘上那份**是不是别的实例写的**,是就做**槽级合并**。
   *
   * 只做原子替换(临时文件名里带 pid,说明作者考虑过并发),但没有 re-read / merge / 锁:
   * 两个 DSH 进程(或同一进程的两个插件实例)共享 `$DSH_HOME` 时,**后写者会把前者的
   * projects / activeProjects / roleAgents / ledger 整份抹掉** —— 插件自己的 smoke 注释里
   * 早就写了"盘上是谁最后写的就是谁的",但没有任何断言守它。
   *
   * 合并口径(保守、可解释):同一个槽按 `updatedAt` 取新的;顶层映射取并集;
   * lifetime 各计数取 max(单调,不会把两个进程的数相加翻倍)。
   */
  /**
   * 同一槽被两个实例各写一半时,"整槽取新的"会把另一方的台账行
   * 整段丢掉(两边各写一半的台账行,最后只剩一半)。这里以**新槽**为底,把旧槽**独有的台账行**按原顺序补在后面
   * (按行内容去重,不改写任何一行),计数器取 max(计数是单调量,取 max 不会翻倍)。
   * 其余字段(等待图 / 角色绑定 / apiLint / 熔断窗口)仍然取新槽 —— 它们表示"当前事实",
   * 把两份不同时刻的事实拼起来只会制造自相矛盾。
   */
  function mergeSlots(base, older) {
    const out = Object.assign({}, base)
    const rowsA = Array.isArray(base && base.ledger) ? base.ledger : []
    const rowsB = Array.isArray(older && older.ledger) ? older.ledger : []
    if (rowsB.length > 0) {
      const seen = new Set(rowsA.map((r) => JSON.stringify(r)))
      const extra = rowsB.filter((r) => !seen.has(JSON.stringify(r)))
      if (extra.length > 0) out.ledger = rowsA.concat(extra).slice(-LEDGER_MAX)
    }
    if ((base && base.stat) || (older && older.stat)) {
      const st = Object.assign({}, (older && older.stat) || {}, (base && base.stat) || {})
      for (const key of ['stateSaves', 'relayCalls', 'spawns', 'deliveries', 'deliveryFailures', 'duplicates', 'busyMerged', 'staleRebinds']) {
        st[key] = Math.max(Number((base && base.stat && base.stat[key]) || 0), Number((older && older.stat && older.stat[key]) || 0))
      }
      out.stat = st
    }
    return out
  }

  function mergeForeignWrite() {
    let st
    try { st = fs.statSync(storePath()) } catch { return } // 还没有文件
    if (storeHealth.lastWriteMtimeMs && st.mtimeMs === storeHealth.lastWriteMtimeMs) return // 自上次写入后没人动过
    // "是不是自己人"的判据必须落在**文件有没有变过**,而不是 boot 是谁。
    // 把"启动时读进来的那个 boot"(`store.loadedBoot`)也当成自己人,于是那个进程**之后的每次写入**
    // 都被跳过合并 —— B 启动时读到 A 的 boot、A 随后写了自己的槽,B 落盘就会把 A 的槽整份盖掉;
    // 三个实例交错各写各的,更是最后盘上只剩一个槽。换成"自我们读进内存之后 mtime 没变过"才安全:
    // 那种情况下我们的内存就等于文件内容,不合并也不会丢任何东西。
    if (storeHealth.loadedMtimeMs && st.mtimeMs === storeHealth.loadedMtimeMs) return // 自启动读入后没人动过
    let cur
    try { cur = JSON.parse(fs.readFileSync(storePath(), 'utf8')) } catch { return }
    if (!cur || typeof cur !== 'object' || !cur.boot) return
    if (String(cur.boot) === String(store.boot)) return // 本进程自己刚写的(正常已被上面那条 mtime 拦下)
    const stats = { at: makeTS(), foreignBoot: String(cur.boot), slotsAdded: 0, slotsKept: 0 }
    const merged = Object.assign({}, cur.projects || {})
    for (const k of Object.keys(store.projects || {})) {
      const mine = store.projects[k]
      const other = merged[k]
      if (!other) { merged[k] = mine; stats.slotsAdded += 1; continue }
      const mineNewer = String(mine.updatedAt || '') >= String(other.updatedAt || '')
      merged[k] = mergeSlots(mineNewer ? mine : other, mineNewer ? other : mine)
      if (!mineNewer) stats.slotsKept += 1
    }
    store.projects = merged
    store.activeProfiles = Object.assign({}, cur.activeProfiles || {}, store.activeProfiles || {})
    store.activeProjects = Object.assign({}, cur.activeProjects || {}, store.activeProjects || {})
    store.dedupe = Object.assign({}, cur.dedupe || {}, store.dedupe || {})
    const lt = Object.assign({}, cur.lifetime || {})
    for (const key of Object.keys(store.lifetime || {})) {
      lt[key] = Math.max(Number(store.lifetime[key]) || 0, Number(lt[key]) || 0)
    }
    store.lifetime = lt
    storeHealth.foreignMerge = stats
  }

  /**
   * 「重新读盘 → 合并 → 原子替换」必须**整段互斥**。
   * `mergeForeignWrite()` 只能缩小窗口 —— 两个真实进程**同时**写同一个槽时仍会丢增量
   * (实测各写 4 行只剩 4~5 行)。这里用锁文件做跨进程互斥,而不是只在内存里串行。
   *
   * 三条保守设计(宁可偶发覆盖,也绝不让锁把写入整块堵死):
   * ① 拿不到锁(只读盘 / 权限错 / 超时)→ **照写不误**,只是退回旧行为;
   * ② 陈旧锁(超过 STALE_MS 没动过)直接回收 —— 写进程被 kill 也不会留下永久死锁;
   * ③ 同步等待有上限(WAIT_MS):这是同步上下文,没有 sleep,只能短忙等。
   */
  const STORE_LOCK_STALE_MS = 5000
  const STORE_LOCK_WAIT_MS = 300
  function acquireStoreLock() {
    const lock = `${storePath()}.lock`
    const deadline = Date.now() + STORE_LOCK_WAIT_MS
    for (;;) {
      try {
        const fd = fs.openSync(lock, 'wx')
        try { fs.writeSync(fd, `${process.pid} ${makeTS()}\n`) } catch { /* 内容只是给人看的 */ }
        return { fd, path: lock }
      } catch (e) {
        if (!e || e.code !== 'EEXIST') return null // 不是"已被占用":别把写入堵死
        try {
          const st = fs.statSync(lock)
          if (Date.now() - st.mtimeMs > STORE_LOCK_STALE_MS) { fs.unlinkSync(lock); continue }
        } catch { /* 锁刚被对方删掉:直接重试 */ }
        if (Date.now() > deadline) return null
        const until = Date.now() + 8
        while (Date.now() < until) { /* 短忙等(窗口是毫秒级) */ }
      }
    }
  }
  function releaseStoreLock(lock) {
    if (!lock) return
    try { fs.closeSync(lock.fd) } catch { /* ignore */ }
    try { fs.unlinkSync(lock.path) } catch { /* ignore */ }
  }

  function saveStore() {
    if (!useFileStore) return false
    // 锁存期间绝不写 —— 包括 apply 时那次"启动即写"。
    if (storeHealth.blocked) return false
    let tmp = ''
    let storeLock = null
    try {
      fs.mkdirSync(storeDir(), { recursive: true })
      storeLock = acquireStoreLock() // 跨进程互斥 —— 读盘 / 合并 / 替换必须整段独占
      mergeForeignWrite() // M5:先把别的实例写进去的东西并进来,再落盘
      store.updatedAt = makeTS()
      // 写入次数若只活在 storeHealth 里(进程内),重启即失忆;
      // 而且 lifetime.stateSaves 只统计 workflow_state_save 那一条路(实测 3 vs 实际 8)。
      // 现在把"落盘次数"独立持久化,语义与 stateSaves 分开,不再互相冒充。
      // 注意:计数必须在**序列化之前**加,否则写进文件的是上一次的值(off-by-one);
      // 但也不能在 rename 之后再加一次 —— 那会变成一次写入计两次
      //(踩过的坑:status 会报"已写 2 次"而文件里 storeWrites=1)。
      storeHealth.writes += 1
      store.lifetime.storeWrites = Math.max(storeHealth.writes, Number(store.lifetime.storeWrites) || 0)
      tmp = `${storePath()}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(store, null, 1), 'utf8')
      fs.renameSync(tmp, storePath())
      try { storeHealth.lastWriteMtimeMs = fs.statSync(storePath()).mtimeMs } catch { storeHealth.lastWriteMtimeMs = 0 }
      storeHealth.lastWriteAt = store.updatedAt
      if (storeHealth.ok === null) storeHealth.ok = true
      return true
    } catch (e) {
      storeHealth.ok = false
      storeHealth.error = `写入状态失败:${String((e && e.message) || e)}`
      // L3:写失败要清掉半截临时文件,否则磁盘满/权限错误后留下垃圾
      if (tmp) { try { fs.unlinkSync(tmp) } catch { /* 清不掉就算了,不影响主流程 */ } }
      return false
    } finally {
      releaseStoreLock(storeLock)
    }
  }

  function loadUserProfiles() {
    try {
      const text = fs.readFileSync(profilesPath(), 'utf8')
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  probeStore()
  loadStore()
  store.boot = BOOT_ID
  /**
   * 全量清扫必须紧挨着下面的 saveStore —— 否则清掉的东西落在内存里,盘上不动。
   * 清扫回两块 —— 已删目录的死槽、以及按 TTL 回收的空槽。
   * 两个数组都留着:回执/日志要分别说清"为什么少了一个槽"(目录没了 vs 空置太久),
   * 混成一句话的话,`state.json` 变小这事就没人能归因。
   */
  const sweep = sweepDeadSlots()
  const sweptOnBoot = sweep.done
  const sweptEmpty = sweep.reclaimed
  saveStore() // 启动即写一次:既验证可写性,也留下本次 boot 标记(重启对账靠它)
  const userProfiles = loadUserProfiles()
  const profiles = buildProfileTable(userProfiles, cfg.profiles)

  // ── 活动统计 ─────────────────────────────────────────────────────────────
  const activity = {
    stateSaves: 0, relayCalls: 0, spawns: 0, toolCalls: 0, inFlight: 0,
    deliveries: 0, deliveryFailures: 0, duplicates: 0,
    /** 忙等并线送达次数(不计数就会变成"被忽略"= 静默丢弃) */
    busyMerged: 0,
    /** 因绑定属于别的父会话/已失效而自动重派的次数 */
    staleRebinds: 0,
    lastAt: '', lastSaveAt: '', lastRelayAt: '', lastDeliveryAt: '', lastError: '',
  }
  /** 最近自动重派的失效绑定(给人看的,status 里回放最后 10 条)。 */
  const staleRebindLog = []

  // ── 项目根 / 文件读取 ────────────────────────────────────────────────────
  function workspaceRoot() {
    const shell = ctx.get('shell')
    if (shell) {
      try {
        if (typeof shell.cwd === 'function') { const c = shell.cwd(); if (c) return c }
        if (typeof shell.cwd === 'string' && shell.cwd) return shell.cwd
      } catch { /* ignore */ }
    }
    return process.cwd()
  }

  /**
   * `root` 是可选参数,不传时回退到 agent cwd(再退 shell/进程 cwd)。
   * 这个回退若**完全静默** —— 而 `workflow_state_save` 还会顺手 `markActive(推断出来的目录)`,
   * 于是"忘带 root"就把一个无关目录记成了已开工项目(实测:调用者 cwd 是工作区根,
   * 它保存的却是另一个项目的状态文档 → 工作区根被激活,之后 load/status 全按它走,
   * 还会拦住 `.active=off` 的清理)。现在把"根从哪来"显式算出来:靠 cwd 兜底的一律标 inferred,
   * 由回执明说"可能是按 cwd 猜的、不是你要的项目"。
   */
  function resolveRootInfo(a, exec) {
    if (a && a.root) return { root: a.root, inferred: false, source: 'arg' }
    const agent = exec && exec.agent
    // 角色子会话 → 它被登记的那个项目(见 rootOfRoleAgent 的注释)。这是**登记过的绑定**,不是猜的。
    const roleRoot = rootOfRoleAgent(agent)
    if (roleRoot !== '') return { root: roleRoot, inferred: false, source: 'role-binding' }
    const cwd = cwdOf(agent)
    if (cwd) return { root: cwd, inferred: true, source: 'agent-cwd' }
    return { root: workspaceRoot(), inferred: true, source: 'workspace-cwd' }
  }

  function resolveRoot(a, exec) {
    return resolveRootInfo(a, exec).root
  }

  function readMaybe(rel, root) {
    const p = path.join(root, rel)
    try {
      const text = fs.readFileSync(p, 'utf8')
      const st = fs.statSync(p)
      return { exists: true, text, size: st.size, path: p }
    } catch {
      return { exists: false, text: null, size: 0, path: p }
    }
  }

  function isActive(root) {
    const g = gateStateOf(root)
    return g !== 'none' && g !== 'off'
  }

  /** 项目当前是"怎么激活的"(供 status 显示与排障)。 */
  function gateStateOf(root) {
    const key = String(root || '')
    if (key === '') return 'none'
    const file = readMaybe(ACTIVE_REL, key)
    let stateDocExists = false
    try { stateDocExists = fs.statSync(path.join(key, DEFAULT_STATE_REL)).isFile() } catch { stateDocExists = false }
    return gateDecision({
      fileExists: file.exists,
      fileText: file.exists ? file.text : '',
      remembered: !!store.activeProjects[key],
      stateDocExists,
    })
  }

  /** 首次真正"开工"时把项目记进插件私有状态(插件写不了工作区,只能记在自己地盘)。 */
  function markActive(root, reason) {
    const key = String(root || '')
    if (key === '') return false
    if (store.activeProjects[key]) {
      store.activeProjects[key].lastUsedAt = makeTS()
      return false
    }
    store.activeProjects[key] = { at: makeTS(), reason: String(reason || ''), boot: BOOT_ID }
    saveStore()
    return true
  }

  /**
   * 预设命中时把项目记成已开工。返回 true 表示本次真的记了一笔。
   *
   * 只在 `gate === 'none'` 时动手 —— `.active`(file)与 `.active` 写 off(off)都必须赢:
   * 后者是用户的显式关闭,自动激活绝不能把它顶掉;前者本来就已激活,再记一笔只会
   * 污染"这项目当初是怎么开的"这条信息(排障时要能分清是预设开的还是首用开的)。
   *
   * 四条入口(只挂前两条时,它们在真宿主的 Web 时序里**都赶不上**预设提交):
   *   · `session/event`(主 —— 预设提交本身就是一条会话事件,零工具调用即生效,
   *     "连第一份技能目录都是对的"唯一可能成立的时机);
   *   · `agent-preset/selected`(同一条提交的另一条投递形状,值取自事件载荷);
   *   · `agent/created`(会话一发布就判定 —— 只在"创建时就带着这个预设"的入口上有用);
   *   · `tools/execute`(兜底 —— 防事件路径没赶上,例如 header 尚未就绪、或投影还没提交)。
   */
  function autoActivateByPreset(agent, via, presetOverride) {
    if (AUTO_ACTIVATE_PRESETS.length === 0) { presetAutoStats.disabled += 1; return false }
    if (!agent) { presetAutoStats.noAgent += 1; return false }
    const id = agent.id ? String(agent.id) : ''
    if (id === '') { presetAutoStats.noAgent += 1; return false }
    // 预设值优先取**事件载荷**。`agent-preset/selected(sessionId, preset)` 这条形状
    // 不带活 Session,而且监听器顺序上投影读数不保证已经落地 —— 赌它就会漏掉那次提交。
    const preset = presetOverride === undefined || presetOverride === null || String(presetOverride) === ''
      ? presetOf(agent)
      : String(presetOverride)
    const seenKey = `${id}\u0000${preset}`
    if (presetAutoSeen.has(seenKey)) return false
    if (AUTO_ACTIVATE_PRESETS.indexOf(preset) === -1) {
      presetAutoSeen.add(seenKey) // 不命中也要记:同一个 agent 在同一个预设下不必再判
      /**
       * 不命中清单若**完全静默** —— 于是"正确地没激活"与
       * "判定压根没跑到"在观测面上长得一模一样(两者的证明力完全不够)。
       * 现在留一行可分辨的痕迹 + 一笔记数。
       * ⚠️ 顺带一条结构事实:这一步发生在**取根之前**(下面才 `cwdOf`),所以"不命中的预设
       * 不可能把任何目录记成已开工"是结构性成立的,不靠纪律。
       */
      bumpPresetJudged(via, 'notInList', `不命中清单(预设=${preset}, 清单=${AUTO_ACTIVATE_PRESETS.join('/')})`)
      ctx.logger?.info?.(`[${NAME}] 预设不命中清单:${preset} 预设的会话不激活(清单=${AUTO_ACTIVATE_PRESETS.join('/')};via=${via};本会话在该预设下不再重判)`)
      return false
    }
    const root = cwdOf(agent)
    if (root === '') {
      // header 还没就绪 → **不记 seen**,留给后面重试。这条会在每次工具调用上重复触发,
      // 所以只计数、不打日志(否则日志会被淹掉)。
      presetAutoStats.noRoot += 1
      return false
    }
    presetAutoSeen.add(seenKey)
    const gate = gateStateOf(root)
    if (gate !== 'none') {
      /**
       * 门已判定时若**一声不响**地 `return false`(那一行在打日志之前),
       * 于是"这个项目已经因为 .active / 记忆 / 状态文档开着"时,四条入口到底通没通
       * **无法从任何地方看出来** —— 判定发生了却从任何地方都看不出来。
       *
       * 短路本身是对的(**不抢功**:显式文件、显式 off、既有记忆都必须赢,再记一笔只会污染
       * "这项目当初是怎么开的"这条信息);**错的是沉默**。现在留一行**可分辨**的痕迹。
       *
       * ⚠️ 措辞:不能说"门已**开**" —— `gate` 有四档会走到这里,
       * 其中 `off` 是**用户显式关掉**(门是关着的)、`file`/`remembered`/`state-doc` 才是"已经开着"。
       * 四档的共同点只有一个:**门已经被别的来源定了**,预设路径不抢功 —— 所以叫「门已定」,
       * 具体是哪一档由 `gate=` 如实带出。
       */
      bumpPresetJudged(via, 'gateOpen', `门已定(root=${root}, gate=${gate}, 预设=${preset})`)
      ctx.logger?.info?.(`[${NAME}] 预设命中但门已定:${preset} 预设的会话在 ${root}(gate=${gate}),不抢功(via=${via};本会话在该预设下不再重判)`)
      return false
    }
    const did = markActive(root, `preset=${preset}`)
    bumpPresetJudged(via, 'activated', `激活(root=${root}, 预设=${preset})${did ? '' : ',记忆里已有同一条'}`)
    ctx.logger?.info?.(`[${NAME}] 预设自动激活:${preset} 预设的会话在 ${root} 开工(${via})`)
    return did
  }

  /**
   * 显示用标签:把"记忆激活"细分成"预设自动激活"与"首用自动激活"。
   * 排障时要能一眼看出这个项目是谁开的 —— "数据面有、显示面没有"这族缺陷在本插件的
   * 这类信息反复出现,而"激活来源"正是最容易变成盲区的一类信息。
   */
  function gateLabelOf(root, gate) {
    if (gate === 'remembered') {
      const rec = store.activeProjects[String(root || '')]
      const m = /^preset=([^\s(]+)/.exec(rec && rec.reason ? String(rec.reason) : '')
      if (m) return `预设 ${m[1]}(自动激活)`
    }
    return GATE_LABELS[gate] || String(gate)
  }

  /**
   * 未激活回执里的下一步提示。把"本会话在哪个预设"直接说出来 —— 否则用户看到
   * "未激活"、而自己明明在 dev-workflow 预设里,两边对不上,只能靠猜。
   */
  function autoActivateHint(exec) {
    if (AUTO_ACTIVATE_PRESETS.length === 0) return ''
    const list = AUTO_ACTIVATE_PRESETS.join('/')
    const preset = presetOf(exec && exec.agent ? exec.agent : undefined)
    if (preset === '') return `本会话的预设未知;在 ${list} 预设下,会话一建立就会自动记成已开工。`
    if (AUTO_ACTIVATE_PRESETS.indexOf(preset) !== -1) {
      return `本会话就在 ${preset} 预设下却仍未激活 —— 多半是本进程启动于该改动生效之前,重启后再看。`
    }
    return `本会话的预设是 ${preset}(不在自动激活清单 ${list} 里),所以要先 kickoff;换到 ${list} 预设可免这一步。`
  }

  /** 从插件记忆里移除开工记录。`.active` 文件若存在仍会激活(那是显式的)。 */
  function unmarkActive(root) {
    const key = String(root || '')
    if (key === '' || !store.activeProjects[key]) return false
    delete store.activeProjects[key]
    saveStore()
    return true
  }

  /**
   * 反查:这个 agent 是不是某个项目里已登记的角色子会话?是则返回**那个项目**的根。
   *
   * 真问题:DSH 的 subagents 契约里 `SubagentStartRequest` **没有 cwd 字段**,
   * 子会话的工作目录一律继承父会话。于是 `relay action=kickoff root=<别的目录>` 派出的角色,
   * 各自把 `root` 默认解析成**父会话的 cwd** —— 实测它们会去读错项目、甚至把错项目自动激活
   * (验收时 5 个子会话全落在工作区根,把工作区当成项目根写文件)。
   * 角色绑定本来就在插件状态里按项目存着,所以这里直接反查,比让模型自己记得传 root 可靠。
   */
  function rootOfRoleAgent(agent) {
    const id = agent && agent.id ? String(agent.id) : ''
    if (id === '') return ''
    for (const key of Object.keys(store.projects)) {
      const slot = store.projects[key]
      if (!slot || !slot.roleAgents) continue
      for (const role of Object.keys(slot.roleAgents)) {
        if (String(slot.roleAgents[role]) === id) return String(slot.root || '')
      }
    }
    return ''
  }

  /**
   * 反查角色绑定的**归属槽**(跨档案扫)。与 rootOfRoleAgent 同源,但多带回 profileId ——
   * readonly 守卫需要它:`resolveProfile()` 在子会话调用时只知道 root,
   * 并不知道自己属于哪个 profile 的槽(review 的 arch 会落回 standard 槽),于是
   * 按"当前解析出的 profile"查角色会查空,守卫形同虚设。
   */
  function roleSlotOfAgent(agent) {
    const id = agent && agent.id ? String(agent.id) : ''
    if (id === '') return null
    for (const key of Object.keys(store.projects)) {
      const slot = store.projects[key]
      if (!slot || !slot.roleAgents) continue
      for (const role of Object.keys(slot.roleAgents)) {
        if (String(slot.roleAgents[role]) === id) {
          return { role, profileId: String(slot.profile || ''), root: String(slot.root || ''), key }
        }
      }
    }
    return null
  }

  function gateProfileId(root) {
    const act = readMaybe(ACTIVE_REL, root)
    if (!act.exists || !act.text) return ''
    const m = /profile=([^\s]+)/.exec(act.text)
    return m && m[1] ? String(m[1]).trim() : ''
  }

  /**
   * 占位写法 —— "这里没有 stateName"被写成 `(空)`/`(空值)` 时,一律当空值。
   *
   * 工具**自己教模型**把 `.active` 写成 `stateName=(空)`(`workflow_state_use` 空参分支的落盘指示),
   * 而解析器 `gateStateName` 用 `[^\s]+` 原样捕获 `(空)`,`safeStateName('(空)')` 把它洗净成 `空_`,
   * 落点就变成 `流程状态-空_.md`;紧接着 status 报 hasState=false,协调者据此以为"流程丢了"重开一轮。
   * (实测:一条自己下的指示就能把状态文件分叉成两份。)
   * 现在两种占位写法都认,`.active` 与工具参数两条入口共用这一个判据。
   */
  function isBlankStateNameToken(raw) {
    const t = String(raw === undefined || raw === null ? '' : raw).trim()
    return t === '(空)' || t === '(空值)' || t === '（空）' || t === '（空值）'
  }

  function gateStateName(root) {
    const act = readMaybe(ACTIVE_REL, root)
    if (!act.exists || !act.text) return ''
    const m = /stateName=([^\s]+)/.exec(act.text)
    if (!m || !m[1]) return ''
    const raw = String(m[1]).trim()
    // 占位符不是需求名 —— 返回 '' 才会回落到主状态文件。
    if (isBlankStateNameToken(raw)) return ''
    return raw
  }

  /**
   * 状态文件落点:显式 stateName > 激活门 `.active` 里的 `stateName=` > 主状态文件。
   *
   * 契约断裂之处:`workflow_state_use` 指示主会话把 `stateName=<需求名>` 写进 `.active`,
   * 但真正读写的三条路径只有 `load` 认**显式**参数 —— `save` 连参数都没有(落点写死主文件),
   * `status`/`load` 又不读门里的声明。于是"切换状态文件"对落盘完全无效(子流程文档只能手抄),
   * 切过去之后 load 也读不回(多流程并行只能读不能写)。
   *
   * 三者统一走这里之后,`use` 写下的声明才真正生效;传空串视为"要主文件"的显式意图,
   * 仍然回落门声明 —— 想切回主文件请用 `workflow_state_use`(它会把门里的 stateName 清掉)。
   */
  function stateRelFor(profile, root, explicit) {
    const base = profile.state.file
    // 显式参数里写占位符(`(空)`/`(空值)`)与"不传"等价 —— 否则会被 safeStateName 洗净成
    // `空_` 再拼进文件名,状态文件就分叉了(这条路径能稳定复现)。
    const given = isBlankStateNameToken(explicit) ? '' : explicit
    const raw = (given === undefined || given === null || given === '') ? gateStateName(root) : given
    const nm = safeStateName(raw)
    return nm ? withStateName(base, nm) : base
  }

  /**
   * `withStateName` 已提到模块级(export,便于单测)——见文件上方。
   */

  // ── agent 叶子读取(只取基本类型,绝不序列化活对象)────────────────────────
  /**
   * "查不动"与"不存在"必须分开。
   * agentOf 不能把三种完全不同的情况压成同一个 `undefined`:agents 服务没挂载、
   * `svc.get` 抛错(瞬时 IO/未就绪)、以及 agent 真的不存在。而唯一的消费者
   * bindingUsable 把 `undefined` 直接读成"agent 已不存在(会话结束或进程重启)",
   * 于是服务一次瞬时故障就足以让**合法绑定被删并落盘**(下一轮 kickoff 还会重派一个人)。
   * 现在给出三态:{ok:true,agent} / {ok:false,reason:'not_found'} / {ok:false,reason:'unavailable'}。
   */
  function lookupAgent(id) {
    if (!id) return { ok: false, reason: 'unavailable', detail: '未给 agent id' }
    const svc = ctx.get('agents')
    if (!svc || typeof svc.get !== 'function') return { ok: false, reason: 'unavailable', detail: 'agents 服务不可用' }
    try {
      const ag = svc.get(String(id))
      if (ag === undefined || ag === null) return { ok: false, reason: 'not_found' }
      return { ok: true, agent: ag }
    } catch (e) {
      return { ok: false, reason: 'unavailable', detail: String((e && e.message) || e) }
    }
  }

  function agentOf(id) {
    const r = lookupAgent(id)
    return r.ok ? r.agent : undefined
  }

  function headerOf(agent) {
    try { return agent && agent.session && agent.session.header ? agent.session.header : null } catch { return null }
  }

  function cwdOf(agent) {
    const h = headerOf(agent)
    if (h && h.cwd) return String(h.cwd)
    try { return agent && agent.cwd ? String(agent.cwd) : '' } catch { return '' }
  }

  function parentSessionOf(agent) {
    const h = headerOf(agent)
    return h && h.parentSession ? String(h.parentSession) : ''
  }

  /**
   * 给人看的短 id。会话 id 前 8 位**恒为** `session-`,直接 `slice(0, 8)`
   * 等于什么都没显示(实测:告警里"父会话"与"调度者"两侧渲染出来一模一样),
   * 所以先剥前缀再截。agentId 不带这个前缀,行为不变。
   */
  function shortId(x) {
    const s = String(x === undefined || x === null ? '' : x)
    const t = s.startsWith('session-') ? s.slice('session-'.length) : s
    return `${t.slice(0, 8)}…`
  }

  /**
   * 这次流程的"调度者会话"是谁 —— = **谱系顶端**那个会话。
   *
   * 旧口径是"调用者自己的父会话"(角色子会话的父;主会话自己调用时是它本身),
   * 只在调用者恰好是深度 2 的角色子会话时才对。角色为了跑测试/自查自己派一个 helper
   * (深度 3,DSH 允许任意深度)时,基准变成那个角色会话,而绑定的 owner 是**主调度者会话** ——
   * 于是合法绑定被判 staleBinding 并删除。实测证据:
   * `gc-1 调 relay from=pm to=arch` → status=no_reply、staleRebinds=1、sent 记录为空
   * ("正文一条都没发出去"),而控制组 AC(真·别人的父会话)才该命中这条。
   * 现在沿 header.parentSession 一路向上走到顶:同一次开工里深度 2/3 的调用者归一化到
   * 同一个调度者,不会误判;换过会话/换了进程才会变(这正是要抓的东西)。
   */
  function schedulerIdOf(caller) {
    if (!caller) return ''
    return sessionTopOf(String(caller.id || ''))
  }

  /**
   * 等待图作废用的基准(比 schedulerIdOf 更严一档,只给 slotFor 的作废判据用)。
   *
   * 必须挡掉这种情况:DSH 里确实存在 header **没有 parentSession** 的角色子会话
   * (workflow_state_status 的 isChildCaller 就是靠"它是本项目的角色绑定"来兜这条的)。
   * 它**不是**调度者 —— 若把调用者本人当基准,同一次开工里"根会话调用"与"该角色调用"
   * 会来回翻转基准,每一次翻转都把等待图当"换了会话"整片清掉(比只清内存更糟)。
   * 归属查不出来的角色调用者一律返回 ''(=未知):不作废等待图,等真正的调度者来判。
   */
  function slotSchedulerOf(slot, caller) {
    if (!caller) return ''
    const self = String(caller.id || '')
    const top = sessionTopOf(self)
    if (top === self && roleSlotOfAgent(caller) !== null) return ''
    return top
  }

  /** 会话谱系顶端:沿 parentSession 上溯;查不动就地停(绝不因"读不到"下结论)。 */
  function sessionTopOf(id) {
    let cur = String(id || '')
    const seen = new Set()
    for (let i = 0; i < 12 && cur !== ''; i += 1) {
      if (seen.has(cur)) break
      seen.add(cur)
      const r = lookupAgent(cur)
      if (!r.ok) return cur // 父会话查不到/查不动:当前 id 就是能确认的顶端
      const p = parentSessionOf(r.agent)
      if (p === '' || p === cur) return cur
      cur = p
    }
    return cur
  }

  /**
   * 绑定"还活着吗、还是我们的人吗"。
   *
   * UNAUTHORIZED(be / arch)的根因就是绑定表里躺着**别的父会话**的 agent id:
   * DSH 在服务层强制邻接(`parentSession === parent.id`),所以调度者会话一换
   * (resume / fork / 重启新会话),表里所有绑定**同时**失效 —— 而当前代码
   * 只是把 `live:false` 打印出来,从不参与决策,于是 kickoff 还会把这些死绑定
   * 当成"已登记"跳过,报"人齐了"而实际一个都派不动。
   *
   * 判据用 parentSession 比较而不是"存不存在":UNAUTHORIZED 的那一刻 agent 是**存在**的,
   * 只是归属不对 —— 只查存在性抓不住它。
   *
   * 两处收紧:
   *   ① **只在确认归属不对时判失效**。"查不动"(agents 服务抛错/没挂载)与"不存在"
   *      必须分开 —— 把前者也读成"agent 已不存在",一次瞬时故障就删掉合法绑定;
   *   ② 归属基准两侧都取**谱系顶端**(槽的调度者),而不是拿 owner 直接比"调用者的父会话":
   *      孙代调用者(角色自己派的 helper)才不会自伤绑定(AD 对照见 schedulerIdOf 注释)。
   */
  function bindingUsable(boundId, caller) {
    const r = lookupAgent(boundId)
    if (!r.ok && r.reason === 'unavailable') {
      return {
        ok: true, unconfirmed: true,
        reason: `agents 服务暂时查不动(${r.detail || '未知原因'}),按"绑定仍可用"处理:不删绑定,投递失败由投递层如实报错`,
      }
    }
    if (!r.ok) return { ok: false, reason: 'agent 已不存在(会话结束或进程重启)', gone: true }
    const ag = r.agent
    const owner = parentSessionOf(ag)
    if (owner === '') return { ok: true, reason: '' } // 不是子会话,归属无从判断 —— 认它
    const sched = schedulerIdOf(caller)
    if (sched === '') return { ok: true, reason: '' }
    if (sessionTopOf(owner) === sched) return { ok: true, reason: '' }
    // owner 自己查不动 —— 又一次"读不到"而非"不存在":同样不下结论
    const ownerLookup = lookupAgent(owner)
    if (!ownerLookup.ok && ownerLookup.reason === 'unavailable') {
      return { ok: true, unconfirmed: true, reason: `owner 会话 ${owner} 暂时查不动,按"绑定仍可用"处理` }
    }
    return { ok: false, reason: `属于另一个父会话 ${owner}` }
  }

  /**
   * 会话**运行时**在哪个预设(读取面)。
   *
   * 投影 = `ctx.sessionProjections.stateOf(session, 'agentPreset')`:它按会话日志事件推进,
   * 是"**已提交**的选择";header 只是创建时的初值。投影读不到(老宿主没组合 sessionProjections
   * 注册表、会话还没提交过选择)才落回 header —— 见纯函数 `resolveSessionPreset` 的口径。
   */
  function presetViewOf(agent) {
    const session = agent && agent.session ? agent.session : null
    if (!session) return undefined
    const sp = ctx.get('sessionProjections')
    if (!sp || typeof sp.stateOf !== 'function') return undefined
    try { return sp.stateOf(session, 'agentPreset') } catch { return undefined }
  }

  function presetOf(agent) {
    const h = headerOf(agent)
    return resolveSessionPreset(presetViewOf(agent), h && h.agentPreset ? String(h.agentPreset) : '')
  }

  function providerNames() {
    const sub = ctx.get('subagents')
    if (!sub || typeof sub.list !== 'function') return []
    try { return sub.list().map(String) } catch { return [] }
  }

  async function loadRoster() {
    const svc = ctx.get('agentPresets')
    if (!svc || typeof svc.list !== 'function') return null
    try { return await svc.list() } catch { return null }
  }

  // ── 真 signal────────────────────────────────────────────────────────
  function isRealSignal(s) {
    return !!s && typeof s.addEventListener === 'function' && typeof s.aborted === 'boolean'
      && !!s.constructor && s.constructor.name === 'AbortSignal'
  }

  function realSignal(preferred) {
    if (isRealSignal(preferred)) return preferred
    try {
      if (typeof AbortController === 'function') return new AbortController().signal
    } catch { /* ignore */ }
    return undefined
  }

  function makeDisposableSignal() {
    const holder = { cancelled: false }
    let controller = null
    try { if (typeof AbortController === 'function') controller = new AbortController() } catch { controller = null }
    const signal = controller ? controller.signal : undefined
    ctx.effect(() => () => {
      holder.cancelled = true
      try { if (controller) controller.abort() } catch { /* ignore */ }
    }, `${NAME}: disposable signal`)
    return { holder, signal }
  }

  // ── profile 解析 ─────────────────────────────────────────────────────────
  function profileTable() {
    return buildProfileTable(loadUserProfiles(), cfg.profiles)
  }

  function resolveProfile(root, explicitId) {
    const table = profileTable()
    const ids = Object.keys(table)
    const wanted = String(explicitId || store.activeProfiles[root] || gateProfileId(root) || cfg.defaultProfile || 'standard')
    if (table[wanted]) return { profile: table[wanted], ids, unknown: '', table }
    return { profile: table.standard, ids, unknown: wanted, table }
  }

  function setActiveProfile(root, id) {
    if (!root) return
    if (!id) delete store.activeProfiles[root]
    else store.activeProfiles[root] = id
    saveStore()
  }

  /**
   * root 必须先归一化。
   * `stateKey` 把 root **原串**直接拼进槽键,同一个项目只要写法不同就裂成两个槽 ——
   * 实测:`relay action=status root=F:\AI\Proj\` 与 `root=f:\ai\proj` 各建一个槽,
   * `state.json` 里两个槽并存;更常见的是模型一次写尾部分隔符、一次不写(Windows 盘符大小写
   * 还随调用方变化)。两个槽意味着:角色绑定/等待图/熔断窗口/台账各算一半,
   * status 报"这台机器上项目 A 没开工"而实际上刚派过角色,熔断上限实际翻倍。
   *
   * 归一化口径(**保守、可解释**,只动"同一个路径的不同写法",不动路径语义):
   *   · 去掉首尾空白;空串保持空串(调用方自己会写 `(no-root)`,不在这里造)
   *   · 统一分隔符:Windows 上 `\` 与 `/` 视为同一个(两处混写是常态);
   *     POSIX 上 `/` 是**唯一**合法分隔符,绝不把 `\` 当分隔符(那是合法文件名字符)
   *   · 去掉尾部一个分隔符(`F:\AI\Proj\` → `F:\AI\Proj`),但**根本身**保留:
   *     `C:\` / `\\server\share\` / POSIX `/` 去掉尾部分隔符就变成另一个意思了
   *   · 大小写:只在 **win32** 折叠(Windows 路径不区分大小写),且**只折叠 ASCII A-Z** ——
   *     `toLowerCase()` 会顺手动到非 ASCII(某些语言里大小写折叠长度都会变),那不是本意
   *   · **带 URL scheme 的一律不归一**(`file:///C:/x` 之类):它不是本地路径,折叠大小写会改动它的语义
   *
   * ⚠️ 这个函数**只用于槽键**(以及由槽键派生的分桶键/去重键)。回执与文档里给人看的
   * `slot.root`、`v.root` 仍然是**用户原样传进来的那个串**——归一化是为了"认得出是同一个项目",
   * 不是为了改写用户给的路径(用户看到 `F:\AI\Proj\` 就应该看到 `F:\AI\Proj\`)。
   */
  function normalizeRootKey(root) {
    let s = String(root === undefined || root === null ? '' : root).trim()
    if (s === '') return ''
    // URL 形态(`file:///…`、`http://…`):不是本地路径,原样返回
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return s
    const isWin = process.platform === 'win32'
    if (isWin) s = s.replace(/\//g, '\\')
    if (s.length > 1 && s.endsWith(isWin ? '\\' : '/')) {
      const body = s.slice(0, -1)
      // 根本身(去掉分隔符就变了意思)不剥:`C:\`、POSIX `/`。UNC 的 `\\server\share\`
      // 剥掉尾巴是安全的(share 名仍在),所以不特判。
      if (!/^[a-zA-Z]:$/.test(body) && body !== '') s = body
    }
    // 这里只折叠整个串的 ASCII 大小写,且 Windows 专属 —— 路径中段的空格/分隔符一个都不碰。
    if (isWin) s = s.replace(/[A-Z]/g, (c) => c.toLowerCase())
    return s
  }

  function stateKey(profileId, root) {
    return `${profileId}@${root || '(no-root)'}`
  }

  /**
   * 按归一化后的键找**已存在的**槽(找不到返回 '')。
   *
   * 这就是 root 未归一的落点:"写法不同 = 两个槽"发生在**建槽**那一步
   * (slotFor 拿原串当键直接 `store.projects[key] = {…}`)。修法是在建槽**之前**先按
   * 归一化口径回头找一遍:同一个项目的不同写法(`F:\AI\Proj\` / `f:\ai\proj`)命中同一个槽,
   * 于是不再裂成两个 —— 绑定/等待图/熔断窗口/台账重新合到一处。
   *
   * ⚠️ 为什么是"查找时归一"而不是"把归一化后的串当键写盘":键必须与**磁盘上已有的键逐字一致**。
   * 外部检查件都是按 `standard@<原样路径>` 直查 `state.json` 的,把存量键改写成小写
   * 会让它们全部查空。查找归一、键保持原样,两边都成立。
   * 代价是极少数"同一个项目被两个进程用两种写法各建过一次槽"的历史数据不会自动合并 ——
   * 那属于合并语义(mergeSlots 已按槽级合并处理),不在本条范围。
   */
  function findSlotKeyByRoot(profileId, root) {
    const want = normalizeRootKey(root)
    for (const k of Object.keys(store.projects)) {
      const slot = store.projects[k]
      if (!slot) continue
      if (String(slot.profile || '') !== String(profileId)) continue
      if (normalizeRootKey(slot.root) === want) return k
    }
    return ''
  }

  /**
   * stateName 由模型直接给出、直接拼进文件名,若**零校验**:
   *   `../../evil` → 归一化后逃出 docs/workflow/(路径穿越);
   *   `$&x`       → 触发 String.replace 的替换语义,展开成匹配到的原文,文件名变成
   *                 `流程状态-流程状态x.md`。
   * 现在只留下 [字母数字下划线中文连字符],并去掉开头的点。
   */
  function safeStateName(raw) {
    return String(raw === undefined || raw === null ? '' : raw)
      .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
      .replace(/^[._]+/, '')
      .slice(0, 60)
  }

  /**
   * 本项目自己的计数。status 里的「投递统计」与「最后错误」是**进程级全局量**,
   * 于是从未开工的项目也会报出别的项目的路径/错误/派出数 —— 实测把 @qa 和 @pm 双双误导成
   * "调度者越权写入是 @qa 干的"(@qa 根本没有 write 工具)。这里按槽(profile@root)分桶,
   * 全局量则明确标注"进程累计(全部项目)"。
   */
  function bumpStat(slot, key, n) {
    if (!slot) return
    if (!slot.stat || typeof slot.stat !== 'object') {
      slot.stat = { stateSaves: 0, relayCalls: 0, spawns: 0, deliveries: 0, deliveryFailures: 0, duplicates: 0, busyMerged: 0, staleRebinds: 0, lastError: '', lastAt: '' }
    }
    if (key === 'lastError') slot.stat.lastError = String(n || '')
    else slot.stat[key] = Number(slot.stat[key] || 0) + (n === undefined ? 1 : Number(n) || 0)
    slot.stat.lastAt = makeTS()
  }

  /**
   * 多一个可选入参 `caller` —— 等待图作废要按**调度者会话**判,
   * 而调度者只能从调用者反查(schedulerIdOf)。不传时退化成原有的进程级 boot 判据。
   */
  function slotFor(profile, root, coordinators, caller) {
    /**
     * 建槽前先按归一化口径回头找。
     * 直接 `stateKey(profile.id, root)` 当键会让同一个项目的不同写法
     * (`F:\AI\Proj\` 与 `f:\ai\proj`)各建一个槽 —— 实测两槽并存,角色绑定/等待图/
     * 熔断窗口/台账各算一半,status 会报"这个项目没开工"而实际上刚派过角色。
     * 现在:精确键优先(磁盘上写了什么就是什么),精确键不存在时才按归一化找;
     * 找到就**复用那个槽**(键、slot.root 都保持用户给的原样,回执里显示的仍是原始路径)。
     */
    const exactKey = stateKey(profile.id, root)
    const key = store.projects[exactKey] ? exactKey : (findSlotKeyByRoot(profile.id, root) || exactKey)
    if (!store.projects[key]) {
      store.projects[key] = {
        root: String(root || ''), profile: profile.id, boot: '',
        waiting: {}, waitMeta: {}, relayTs: {}, roleAgents: {},
        ledger: [], arbitration: [], staleWaiting: [], updatedAt: '',
      }
    }
    const slot = store.projects[key]
    slot.profile = profile.id
    /**
     * **已经登记过 root 的槽不许被后续调用改写**。
     * 无条件 `slot.root = String(root || '')` —— 归一化之后这就有后果:同一个项目
     * 用另一种写法(`f:\ai\proj`)再调一次,会把槽里显示的路径改写成那种写法,
     * 于是回执/status/台账里人看到的路径变成"最后一次调用者碰巧写的那个"。
     * 建槽时的那个写法才是"用户给的原始路径",留住它。
     */
    if (String(slot.root || '') === '') slot.root = String(root || '')
    // 根目录都没了,绑定必然无用 —— 惰性回收。
    // 留着它们,kickoff 会把死绑定当成"已登记"跳过(实测 UNAUTHORIZED 的来源之一)。
    if (slot.root !== '') {
      // 只有"确实不存在"才算已删 —— 判定逻辑提成 cameGone() 见下。
      const g = cameGone(slot.root)
      slot.rootMissing = g.gone
      if (g.gone) delete slot.ioWarning
      else if (g.ioError) slot.ioWarning = { at: makeTS(), root: slot.root, code: g.ioError }
      if (g.gone && Object.keys(slot.roleAgents || {}).length > 0) {
        const n = Object.keys(slot.roleAgents).length
        slot.reclaimed = { at: makeTS(), root: slot.root, bindings: n, by: 'lazy-slotFor' }
        slot.roleAgents = {}
        // 光在内存里清**等于没清** —— 实测 `relay action=deactivate` 的 noop 路径
        // 不会 saveStore(unmarkActive 发现没记录就提前返回),于是 GC 清掉的东西一直
        // 停在内存里,磁盘上 6 个死绑定原封不动。就地落盘,别指望别人顺手帮你刷。
        try { saveStore() } catch { /* 落盘失败不影响本次调用 */ }
      }
    }
    if (!coordinators.has(key)) {
      const c = new RelayCoordinator(profile.relay.limit, profile.relay.windowMs)
      c.hydrate(slot)
      coordinators.set(key, c)
      // 用 basename(root) 或模型自报的 project 当桶名,残留在磁盘上的那些桶
      // **永远不会再被计数**,却照样出现在 status 的「熔断计数」里 —— 看起来就像"同一项目
      // 有两套计数"(实测 6 对角色命中)。这里 hydrate 之后就地把不属于本槽的桶清掉,并留痕。
      const mineBucket = stateKey(profile.id, slot.root)
      const dropped = []
      for (const k of Object.keys(c.relayTs)) {
        const seg = String(k).split('\u0000')
        if (seg.length !== 3 || seg[2] !== mineBucket) { dropped.push(String(k)); delete c.relayTs[k] }
      }
      if (dropped.length > 0) {
        slot.bucketPruned = { at: makeTS(), dropped: dropped.length, sample: dropped.slice(0, 3), bucket: mineBucket }
        // 清桶只改了内存里的 coordinator,而 saveStore 落的是 slot.relayTs ——
        // 于是盘上旧桶一个不少,"已就地清掉 N 个旧桶"每次启动都重报一次。
        // 这里把清完的结果同步回槽,落盘才真的收敛。
        slot.relayTs = JSON.parse(JSON.stringify(c.relayTs))
        try { saveStore() } catch { /* 落盘失败不影响本次调用 */ }
      }
    }
    const coord = coordinators.get(key)
    coord.limit = profile.relay.limit
    coord.windowMs = profile.relay.windowMs
    // 重启对账:进程重启后所有 agent 都没了,等待关系必然失效。
    /**
     * 作废判据从"进程级"改成"**调度者会话级**"。
     * 只比 `slot.boot !== BOOT_ID`(进程启动 id) 不够: DSH Web GUI 里新开一个会话
     * **不会重启进程** —— 新会话于是原样继承上一会话留下的等待图,残留链
     * (`arch→pm` 之类)让新会话第一次回覆就撞 checkDeadlock 被判死锁环、正文扣进仲裁。
     * 实测证据:只有重启进程才"修好",同一个进程里换会话必复现。
     * 现在以**槽的调度者会话 id**为准(slotSchedulerOf:谱系顶端,且挡掉"没有 parentSession 的
     * 角色子会话"这种查不出归属的调用者 —— 否则基准会在根会话与该角色之间来回翻转、反复清空):
     * 同一次开工里深度 2/3 的调用者归一化到同一个调度者,不会误清;换了会话(或换了进程)立刻作废并留痕。
     * caller 未知的调用点(slotFor 不传第 4 参)只保留原有的 boot 判据,行为不变。
     */
    const schedNow = caller ? slotSchedulerOf(slot, caller) : ''
    const schedChanged = schedNow !== '' && String(slot.schedulerId || '') !== '' && String(slot.schedulerId) !== schedNow
    if (slot.boot !== BOOT_ID || schedChanged) {
      const stale = Object.keys(coord.waiting).map((role) => ({ role, to: coord.waiting[role], ...(coord.waitMeta[role] || {}) }))
      if (stale.length > 0) {
        slot.staleWaiting = stale.concat(slot.staleWaiting || []).slice(0, 50)
        coord.waiting = {}
        coord.waitMeta = {}
      }
      if (schedChanged) {
        slot.schedulerChanged = { at: makeTS(), from: String(slot.schedulerId || ''), to: schedNow, cleared: stale.length }
        // 就地落盘(与上面的清桶、绑定点相同做法):"换会话已作废 N 条残留等待"是事实,
        // 不写下来的话,status 路径之后盘上还留着那串链,下一次排查又要重新推一遍。
        try { saveStore() } catch { /* 落盘失败不影响本次调用 */ }
      }
      if (schedNow !== '') slot.schedulerId = schedNow
      slot.boot = BOOT_ID
    } else if (schedNow !== '' && String(slot.schedulerId || '') !== schedNow) {
      // 首次见到调度者(升级前写下的老 state.json 没有这个字段):只记下来,不作废等待图
      slot.schedulerId = schedNow
    }
    return { key, slot, coord }
  }

  /**
   * 把"这个项目根的目录还在不在"的判定收成一处。
   *
   * 别写成 `catch { gone = true }` —— **任何** statSync 失败都被当成"目录已删"。
   * 盘符没挂载、网络盘断了、OneDrive 没 hydrate、杀软/索引器占用、权限瞬时错误……
   * 这些都是一次性 IO 抖动,却会立刻清空该项目的**全部角色绑定**并落盘(见 sweepDeadSlots
   * 与 slotFor 的惰性 GC),后续 kickoff 便以为"没派过"而重派 —— 正是
   * `UNAUTHORIZED: belongs to another parent session` 的来源之一。
   *
   * 现在只有 ENOENT/ENOTDIR(确实不存在)算已删;其余一律按"暂时读不到"处理:
   * 保留绑定、不落盘、写一条 ioWarning 让 status 能看见。
   */
  /**
   * `未激活(未激活)` 这种重复文案的根治点。
   * `GATE_LABELS.none` 本身就是"未激活",而调用点又统一写成 `未激活(${GATE_LABELS[gate]})` ——
   * 于是最常见的"门没开"反而渲染成最啰嗦的重复词。这里统一给一个措辞函数。
   */
  function inactivePhrase(gate) {
    return gate === 'none' || !gate ? '未激活' : `未激活(${GATE_LABELS[gate] || gate})`
  }

  function cameGone(root) {
    try {
      return { gone: !fs.statSync(root).isDirectory() }
    } catch (e) {
      const code = String((e && e.code) || '')
      if (classifyRootError(code) === 'gone') return { gone: true }
      return { gone: false, ioError: code || String((e && e.message) || e) }
    }
  }

  /**
   * 惰性 GC 只在**槽被访问**时跑,而废弃项目的槽
   * 永远不会再被访问 —— 实测两个临时验收目录被删掉一整天,6 个绑定还在 state.json 里,
   * 连 `rootMissing` 都没被写上过一次。这里在 apply 时做一次全量清扫,
   * 并且**紧挨着 boot 的那次 saveStore**,保证清掉的东西真的落盘。
   */
  /**
   * 清扫要能识别"空槽",而"空"必须包括
   * **台账边车不存在** —— 有边车的槽是有证据的槽,不能删(边车文件名由 profile@root 算出,
   * 用户删了槽就再也对不上那份证据了)。边车路径的计算与 ledgerSidecarPath 同源,只是
   * 入参是 `{profile,root}` 而不是 slot 对象(槽也可以传,字段名一样)。
   */
  function ledgerSidecarExistsFor(profileId, root) {
    try {
      return fs.statSync(ledgerSidecarPath({ profile: profileId, root })).size >= 0
    } catch { return false }
  }

  /**
   * 这个槽是不是"空槽"(没有任何值得保留的东西)?空槽才允许按 TTL 回收。
   * 判定故意写成**白名单**:任何未知字段、任何计数、任何等待、任何绑定、任何台账行
   * 都会让它返回 false —— 保守优先,宁可留着垃圾也不能删掉证据。
   */
  function isEmptySlot(slot) {
    if (!slot || typeof slot !== 'object') return false
    if (String(slot.schedulerId || '') !== '') return false
    if (Object.keys(slot.roleAgents || {}).length > 0) return false
    if (Object.keys(slot.waiting || {}).length > 0) return false
    if (Object.keys(slot.waitMeta || {}).length > 0) return false
    for (const k of Object.keys(slot.relayTs || {})) {
      if (Array.isArray(slot.relayTs[k]) && slot.relayTs[k].length > 0) return false
    }
    for (const f of ['ledger', 'arbitration', 'staleWaiting']) {
      if (Array.isArray(slot[f]) && slot[f].length > 0) return false
    }
    // 跑过 lint 的槽有指纹与结论,那是审计证据(「lint ERROR 0」这条记录要能回查)
    if (slot.apiLint) return false
    // 计数非零 = 这个项目真的用过它(哪怕现在没绑定)
    const stat = slot.stat || {}
    for (const k of Object.keys(stat)) {
      const v = stat[k]
      if (typeof v === 'number' && v > 0) return false
      if (typeof v === 'string' && v !== '') return false
    }
    if (ledgerSidecarExistsFor(String(slot.profile || ''), String(slot.root || ''))) return false
    return true
  }

  /**
   * `updatedAt`(本地时间串 `YYYY-MM-DD HH:mm:ss`,见 makeTS)→ 毫秒。
   * 解析不出来一律返回 0 = "时间未知",调用方据此**不回收**(旧 state.json 里没有这个字段的
   * 槽就是这么被保住的 —— 不知道它多老,就不敢删)。
   */
  function slotUpdatedMs(slot) {
    const s = String((slot && slot.updatedAt) || '')
    if (s === '') return 0
    const t = Date.parse(s.replace(' ', 'T'))
    return Number.isFinite(t) ? t : 0
  }

  function sweepDeadSlots() {
    const done = []
    for (const key of Object.keys(store.projects)) {
      const slot = store.projects[key]
      if (!slot) continue
      const r = String(slot.root || '')
      if (r === '') continue
      const g = cameGone(r) // S2:瞬时 IO 失败不再等同"目录已删"
      slot.rootMissing = g.gone
      if (g.gone) delete slot.ioWarning
      else if (g.ioError) slot.ioWarning = { at: makeTS(), root: r, code: g.ioError }
      const bound = Object.keys(slot.roleAgents || {})
      if (g.gone && bound.length > 0) {
        slot.reclaimed = { at: makeTS(), root: r, bindings: bound.length, by: 'sweep-on-boot' }
        slot.roleAgents = {}
        done.push({ root: r, bindings: bound.length })
      }
    }
    /**
     * 上面的循环只回收"根目录确实已删"的槽。
     * 若没有任何一条按**时间**回收的路径,一次性项目、建了又删的临时目录、被 `root=` 写错的
     * 一次性调用留下的槽**永久保留** —— 实测 11 个槽里 6 个是垃圾,`state.json` 长到 178 KB,
     * 而每一行 status 都要把它们读进来、每次 saveStore 都要把它们写回去。
     *
     * 门槛刻意保守,四条**同时**满足才回收:
     *   ① 空槽(见 isEmptySlot:无绑定/无等待/无台账/无计数/无边车,且没有 schedulerId);
     *   ② `updatedAt` 能解析、且早于 TTL(**默认 7 天**)—— 解析不出来就不删(时间未知);
     *   ③ 根目录不是"暂时读不到"(瞬时 IO 失败时不动它,与 statSync 分类同口径);
     *   ④ 这个根**不在开工记忆里**(activeProjects)—— 人记得的项目哪怕暂时是空的也不删。
     * 回收必须留痕:只删内存不够(落盘会把它带回来),紧挨着 boot 的那次 saveStore 会落盘;
     * 统计量进 `done` 之外单独一个数组,由 status 报出来。
     */
    const ttlMs = SWEEP_EMPTY_TTL_MS
    const now = Date.now()
    const openKeys = new Set()
    for (const k of Object.keys(store.activeProjects || {})) openKeys.add(normalizeRootKey(k))
    const reclaimed = []
    for (const key of Object.keys(store.projects)) {
      const slot = store.projects[key]
      if (!slot) continue
      const r = String(slot.root || '')
      // ③ 读不到 = 不动(瞬时 IO 抖动;真删了由上面那条路径处理)
      if (r === '' || slot.rootMissing === true || slot.ioWarning) continue
      // ④ 开工记忆里的项目不回收
      if (openKeys.has(normalizeRootKey(r)) || store.activeProjects[r]) continue
      // ① 空槽
      if (!isEmptySlot(slot)) continue
      // ② 够老(updatedAt 定不出来 = 不动)
      const at = slotUpdatedMs(slot)
      if (at <= 0 || now - at < ttlMs) continue
      delete store.projects[key]
      /**
       * 这里**不能**顺手 `coordinators.delete(key)`:本函数在 apply 里紧挨着 loadStore() 跑,
       * 而 `coordinators` 是后面才声明的 const —— 碰它就是 TDZ(`Cannot access 'coordinators'
       * before initialization`,直接让插件起不来)。而且也不需要:能走到这里的槽必然是**空槽**,
       * 空的 coordinator 里没有等待图/熔断计数,hydrate 出来也是空的。
       */
      reclaimed.push({ key, root: r, profile: String(slot.profile || ''), updatedAt: String(slot.updatedAt || ''), ageDays: Math.floor((now - at) / 86400000) })
    }
    return { done, reclaimed }
  }

  function syncSlot(slot, coord) {
    const snap = coord.snapshot()
    slot.waiting = snap.waiting
    slot.waitMeta = snap.waitMeta
    slot.relayTs = snap.relayTs
    slot.updatedAt = makeTS()
  }

  /**
   * 台账边车路径。净化成**跨平台安全**的文件名 —— 踩过的坑:允许 `:`,于是
   * `standard@F:\AI\...` 在 Windows 上被解释成 NTFS 备用数据流(ADS),
   * 文件实际落成 `standard@F` —— readdir 看得见、按原路径却读不回内容。
   * 现在只留 [字母数字_@中文.-],并去掉首尾的点与空格(Windows 会静默吞掉它们)。
   */
  function ledgerSidecarPath(slot) {
    const raw = `${slot.profile || 'p'}@${slot.root || 'no-root'}`
    const clean = raw
      .replace(/[^A-Za-z0-9_@\u4e00-\u9fa5.-]+/g, '_')
      .replace(/^[.\s]+|[.\s]+$/g, '')
    // 截断必须保住**区分度**。直接 `slice(0, 80)` 不行 —— 实测两个
    // 只在前缀之后才不同的项目(`clients\very-long-customer-name-(×4)\alpha` 与 `…\beta`)
    // 净化后前 80 字符**一模一样**,于是共用一个边车文件:全文证据互相串台、status 的
    // "本项目 X KB"其实是两个项目的合计、2 MB 换代还会把一个项目的证据转走销毁。
    // 修法:只在真需要截断时拼上全串短哈希(键 ≤80 的项目文件名不变,既有边车不会被孤儿化)。
    const key = clean.length <= 80 ? clean : `${clean.slice(0, 71)}-${hashText(raw).slice(0, 8)}`
    return path.join(storeDir(), LEDGER_FULL_DIR, `${key}.jsonl`)
  }

  function ledgerSidecarSize(slot) {
    try { return fs.statSync(ledgerSidecarPath(slot)).size } catch { return 0 }
  }

  /**
   * 边车**总体积**(全部项目文件 + 换代后的 .1)。
   * 只报本项目时,实测会出现"status 没有任何边车行,而盘上已经有 680 KB"的盲区
   * —— 那 680 KB 分散在别的项目的文件里,本项目那个文件还没建。
   */
  function ledgerSidecarTotal() {
    const dir = path.join(storeDir(), LEDGER_FULL_DIR)
    let total = 0
    let files = 0
    try {
      for (const f of fs.readdirSync(dir)) {
        try {
          const st = fs.statSync(path.join(dir, f))
          if (st.isFile()) { total += st.size; files += 1 }
        } catch { /* 单个文件读不到就跳过 */ }
      }
    } catch { /* 目录不存在 = 还没有边车 */ }
    return { total, files }
  }

  /** 台账全文边车:插件私有地盘(可写),按项目追加 JSONL。 */
  function appendLedgerFull(slot, row) {
    try {
      const dir = path.join(storeDir(), LEDGER_FULL_DIR)
      fs.mkdirSync(dir, { recursive: true })
      const file = ledgerSidecarPath(slot)
      // 边车若只 append,**没有任何上限或轮转** —— 实测一天三个 e2e 项目
      // 就 680 KB(单项目 378 KB),真实使用是按月单调增长。内存里的台账投影有
      // LEDGER_MAX=200 行上限,边车没有。现在超过上限就转一代(.1.jsonl),只留最近两代。
      try {
        const st = fs.statSync(file)
        if (st.size > LEDGER_FULL_MAX) fs.renameSync(file, `${file}.1`)
      } catch { /* 不存在或转不动都不影响追加 */ }
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8')
    } catch { /* 边车写不进去不影响主流程:摘要已经入库,只是丢了全文 */ }
  }

  /**
   * 入库前把 summary 截断成投影。
   * 实测:活宿主 23 行台账占 state.json 的 **83.9%**,单行最大 4,074 字节 ——
   * 因为存的是**消息全文**,而渲染侧本来就 slice(0,80)。
   *
   * 两条必须同时成立的性质(第二版才想明白):
   *   1) **保持引用别名** —— 调用方拿到 `res.ledger` 之后还会改 `rowRef.status`
   *      (「✅ 已转发」→「✅ 已投递/已判定」),所以必须原地改、push 同一个对象,
   *      不能 push 一份副本(smoke 12.14 就是被这个抓出来的);
   *   2) 全文转存边车,但边车只存**消息本身**(ts/from/to/summary/hash),
   *      不复制 status/note/delivery —— 那些是编排事实,归投影所有,免得两份状态打架。
   */
  function pushLedger(slot, row) {
    if (!row) return
    const full = String(row.summary === undefined || row.summary === null ? '' : row.summary)
    if (full.length > LEDGER_SUMMARY_MAX) {
      appendLedgerFull(slot, {
        ts: row.ts, from: row.from, to: row.to,
        summary: full, summaryLen: full.length, summaryHash: hashText(full),
      })
      row.summary = full.slice(0, LEDGER_SUMMARY_MAX)
      row.summaryTruncated = true
      row.summaryLen = full.length
      row.summaryHash = hashText(full)
    }
    slot.ledger = (slot.ledger || []).concat([row])
    if (slot.ledger.length > LEDGER_MAX) slot.ledger = slot.ledger.slice(-LEDGER_MAX)
  }

  function pushArbitration(slot, ev) {
    if (!ev) return
    // 仲裁事件若存**消息全文**、且只限条数(100 条),就是 state.json
    // 无界膨胀的入口(台账早已裁到 120 字节,这边没同步;100 条 × 数 KB
    // 再叠加"每次 saveStore 都整份序列化"就够呛)。现在单条超 8KB 就存投影,
    // 全文转存台账边车(仍可取证),并在渲染里如实标注。
    const e = Object.assign({}, ev)
    const full = String(e.msg === undefined || e.msg === null ? '' : e.msg)
    if (full.length > ARBITRATION_MSG_MAX) {
      try {
        appendLedgerFull(slot, {
          ts: e.ts, from: e.from, to: e.to, kind: 'arbitration',
          summary: full, summaryLen: full.length, summaryHash: hashText(full),
        })
      } catch { /* 边车写不进去不影响主流程 */ }
      e.msg = full.slice(0, ARBITRATION_MSG_MAX)
      e.msgTruncated = true
      e.msgLen = full.length
      e.msgHash = hashText(full)
    }
    slot.arbitration = (slot.arbitration || []).concat([e])
    if (slot.arbitration.length > ARBITRATION_MAX) slot.arbitration = slot.arbitration.slice(-ARBITRATION_MAX)
  }

  /**
   * 超时释放等待关系。返回被释放的条目(供输出与台账使用)。
   * 没有这条,等待关系在目标永不回覆时会永久占住发起方。
   */
  function sweepExpiredWaits(slot, coord, profile) {
    const ttl = Number(profile.relay.waitTimeoutMs || WAIT_TIMEOUT_MS)
    const now = Date.now()
    const expired = []
    for (const role of Object.keys(coord.waiting)) {
      const meta = coord.waitMeta[role] || {}
      const since = Number(meta.since || 0)
      if (since > 0 && now - since > ttl) {
        expired.push({ role, to: coord.waiting[role], ageSec: Math.round((now - since) / 1000) })
      }
    }
    for (const e of expired) {
      coord.release(e.role)
      pushLedger(slot, {
        ts: makeTS(), from: e.role, to: e.to, summary: '(等待超时)',
        status: '⏱ 超时释放', note: `等待 ${e.ageSec}s 超过 ${Math.round(ttl / 1000)}s,关系已释放`,
      })
    }
    return expired
  }

  // ── 投递层──────────────────────────────────────────────────────
  /**
   * 同步判定一次投递是否可行,并算出用哪个身份发。必须是同步的:
   * RelayCoordinator.tryRelay 的 writeBack 在同步上下文里被调用(自测 43 条依赖这一点)。
   * 返回值: { ok:true, sender, targetId, via } | { ok:false, reason }
   */
  function planDelivery(opts) {
    const sub = ctx.get('subagents')
    if (!sub || typeof sub.sendMessage !== 'function') return { ok: false, reason: 'subagents 服务不可用' }
    const slot = opts.slot
    const caller = opts.caller
    let targetId = ''
    let fromBinding = false
    if (opts.explicitTarget && opts.role === opts.primaryRole) targetId = String(opts.explicitTarget)
    if (!targetId && slot.roleAgents && slot.roleAgents[opts.role]) {
      targetId = String(slot.roleAgents[opts.role])
      fromBinding = true
    }
    const callerParent = parentSessionOf(caller)
    let sender = null
    let via = ''
    if (!targetId && callerParent && opts.role === opts.profile.coordinator) {
      targetId = callerParent
      sender = caller
      via = 'to-parent'
    }
    if (!targetId) return { ok: false, reason: `角色 @${opts.role} 没有已登记的 agent 会话` }
    if (caller && String(caller.id) === targetId) return { ok: false, reason: '目标就是发起者本人,跳过投递' }

    /**
     * 发之前先问一句"这条绑定**还是我们的人**吗"。
     *
     * 只在 `relay_spawn` / `kickoff` 里用 `bindingUsable` 是不够的 —— `send` 路径也必须查:
     * 于是换过会话(resume / fork / 重启)之后,表里那些属于**别的父会话**的绑定会被一路投递到
     * DSH 的归属校验上,每次都撞 `UNAUTHORIZED: belongs to another parent session`,
     * 而错误被记成普通"投递失败":不区分成因、不清理绑定、还把失败重试交给模型自觉。
     * 现场正是这样:同一时刻三条同错,之后正文改走"并线",
     * 直到 15:23:27 熔断 —— 内容再没送达过 @be。
     *
     * 现在:绑定归属不对就地判定 `staleBinding`,由调用处清理并给出可照做的补救指令。
     * 注意**只对绑定表里的 id** 做这个预检:显式 targetAgentId 是调用方的明确指定,不该被我们拦。
     */
    if (fromBinding) {
      const u = bindingUsable(targetId, caller)
      if (!u.ok) {
        return {
          ok: false, staleBinding: true, via: 'stale-binding', role: opts.role, targetId,
          reason: `绑定 @${opts.role}(${String(targetId).slice(0, 8)})不可用:${u.reason}`,
          owner: parentSessionOf(agentOf(targetId)),
          expectedScheduler: schedulerIdOf(caller),
        }
      }
    }

    if (caller && callerParent === '' ) { sender = caller; via = 'scheduler' }
    else if (caller && callerParent && targetId === callerParent) { sender = caller; via = 'to-parent' }
    else if (caller && callerParent) {
      const p = agentOf(callerParent)
      if (p) { sender = p; via = 'scheduler-proxy' }
      /**
       * 配套:深度>2 的调用者要换投递身份,否则正文发不出去。
       * `sender = 调用者的父会话` 只在"父会话恰好是目标的父会话"时成立(深度 2 的角色子会话)。
       * 角色自己派了 helper(深度 3)时,helper 的父会话与目标绑定是**兄弟**,DSH 的邻接校验
       * (`parentSession === parent.id`)必然判 UNAUTHORIZED —— 表现就是"正文一条都发不出"。
       * 这里只在**能确认**的两种安全情形下改用绑定真正的父会话当投递身份:
       *   ① 目标绑定就是调用者自己派的(owner === caller.id)→ 用调用者本人;
       *   ② 目标绑定的父会话就是槽的调度者(owner === 谱系顶端)→ 用调度者本人。
       * 两者都不是时保持原样(仍然由父会话代发),失败照旧如实上报,不猜。
       */
      if (fromBinding && sender) {
        const ownerId = parentSessionOf(agentOf(targetId))
        if (ownerId !== '' && ownerId !== callerParent) {
          if (ownerId === String(caller.id || '')) { sender = caller; via = 'self-owner' }
          else if (ownerId === schedulerIdOf(caller)) {
            const topAg = agentOf(ownerId)
            if (topAg) { sender = topAg; via = 'scheduler-top-proxy' }
          }
        }
      }
    }
    if (!sender) return { ok: false, reason: '找不到可用投递身份(调度者会话可能已关闭)' }
    return { ok: true, sender, targetId, via, role: opts.role, text: opts.text, callerId: caller ? String(caller.id) : '' }
  }

  async function deliverPlan(plan, signal) {
    const sub = ctx.get('subagents')
    if (!sub || typeof sub.sendMessage !== 'function') return { ok: false, reason: 'subagents 服务不可用' }
    const sig = realSignal(signal)
    if (!sig) return { ok: false, reason: '拿不到真 AbortSignal,拒绝投递以免冷恢复静默失败' }
    try {
      const id = await sub.sendMessage(plan.sender, plan.targetId, [{ type: 'text', text: plan.text }], { signal: sig })
      return { ok: true, messageId: String(id || ''), via: plan.via, senderId: String(plan.sender.id || ''), targetId: plan.targetId }
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e), code: String((e && e.code) || ''), via: plan.via, targetId: plan.targetId }
    }
  }

  function dedupeHit(profileId, key, nowMs) {
    const d = store.dedupe[key]
    if (!d) return null
    if (nowMs - Number(d.at || 0) > DEDUPE_MS) { delete store.dedupe[key]; return null }
    return d
  }

  function dedupeSet(key, messageId) {
    const now = Date.now()
    store.dedupe[key] = { at: now, messageId: String(messageId || '') }
    for (const k of Object.keys(store.dedupe)) {
      if (now - Number(store.dedupe[k].at || 0) > DEDUPE_MS) delete store.dedupe[k]
    }
  }

  // ── relay ────────────────────────────────────────────────────────────────
  const coordinators = new Map()
  /**
   * 原实现是一个**永久化的否定缓存** —— 把两种完全不同的成因
   * ("fs 服务暂时不可用" 与 "被沙箱拒绝")塌缩进同一个布尔,还全局共享、永不过期。
   * 后果:启动顺序上一次瞬时缺服务,就让**这个进程余生所有项目**都不再尝试直写台账,
   * 于是每次 relay action=ledger 都白付一遍全文 + 一次 write(双倍 token 被永久化)。
   * 现在:按 root 分桶 + "被拒"带 TTL + "服务不可用"完全可重试。
   */
  const FS_DENY_TTL_MS = 5 * 60 * 1000
  const fsLedgerState = new Map() // root → { reason, until }
  function fsDenyFor(root) {
    const key = String(root || '')
    const st = fsLedgerState.get(key)
    if (!st) return null
    if (Date.now() > st.until) { fsLedgerState.delete(key); return null }
    return st
  }
  /** 插件生命周期内共享的真 signal:spawn 用它,卸载时统一 abort(不再每次 spawn 泄漏一个 effect)。 */
  const lifetimeSignal = makeDisposableSignal()

  const relayTool = {
    name: 'relay',
    description:
      // 这里不再把 11 个 action 逐个复述一遍:而 action 字段自己有同样的清单 ——
      // 同一份信息在每个会话的常驻上下文里付两遍钱。现在只留"什么时候用它"和三条硬语义。
      'dev-workflow 互呼编排:登记一次角色间互呼(@relay)并**自动投递**到目标角色(无需再调 send_message),'
      + '内联做死锁环检测、并线忙等与滑动窗口熔断。'
      + '兄弟角色之间由插件以调度者身份代偿中转(DSH 在服务层禁止兄弟直连),对模型就是直呼。'
      + '**不需要用户先建任何文件**:首次 `relay_spawn` 或 `action=kickoff` 会自动激活项目(记在插件私有状态里)。'
      + '回复闭合:B 回覆正在等它的 A 时,A 的等待关系自动释放;等待超过 waitTimeoutMs 也会自动释放。'
      + '各 action 的用途见下面 action 字段。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['send', 'kickoff', 'status', 'providers', 'presets', 'arbitrate', 'profile', 'ledger', 'release', 'deactivate'], description: 'send=发起互呼(默认);kickoff=一句话开工(派齐角色);status=总览;profile=list/use;ledger=协作台账全文;release=释放等待关系(from=<角色>);deactivate=撤销开工记忆;providers/presets/arbitrate=查询' },
        goal: { type: 'string', description: 'kickoff 用:用户的一句话需求(写进协调者的开场指令与流程状态待办)' },
        roles: { type: 'array', items: { type: 'string' }, description: 'kickoff 用:只派这些角色(默认派 profile 全部角色;协调者必派,不在列表里会自动补上)' },
        from: { type: 'string', description: '发起角色(按当前 profile 的角色 id);省略时按调用者 agent 的登记身份自动推断' },
        to: { type: 'string', description: '目标角色(send 必填,或由 answer 末行 @relay: 标记解析);取值按当前 profile 的角色 id' },
        targetAgentId: { type: 'string', description: '目标角色的 durable agent/session id;提供后跳过角色登记表' },
        msg: { type: 'string', description: '互呼问题原文;若给出 answer 则可省略' },
        answer: { type: 'string', description: '角色回答原文:取最后一行 @relay:<角色> <问题> 作为本次互呼' },
        project: { type: 'string', description: '项目标识,用于熔断计数分对隔离' },
        root: { type: 'string', description: '项目根目录;不传时取 agent cwd / shell cwd' },
        profile: { type: 'string', description: 'profile id;send/status 时用于指定本次使用哪个角色集,action=profile 时表示要切换到的目标' },
        release: { type: 'boolean', description: 'send 成功后立即释放等待关系' },
        noDeliver: { type: 'boolean', description: 'true=只做编排判定、不实际投递(只返回指令,不投递)' },
        // 60 秒去重必须留出口 —— 同一句话想重发只能改一个字符绕 hash。
        // 与 noDeliver 同写法(布尔,执行期用 boolTrue 兼容 "true"/1)。
        skipDedupe: { type: 'boolean', description: 'true=跳过去重(60 秒内强制重发同一句话,内容一字不改也照发);默认 false' },
      },
      required: [],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        const v = value || {}
        const lines = [`relay ${v.status || 'ok'}`]
        // 把"本进程加载的是哪一版"摆在第一屏。它与磁盘上的版本不一致 =
        // 部署了但没重启 —— 一眼可见。
        if (v.version) lines.push(`插件:${NAME} v${v.version}(本进程已加载)`)
        // 两块版本告警必须都挂在这张面板上 ——
        // `versionMismatch` 会渲染,它的孪生分支 `versionUnverifiable`(磁盘 package.json
        // 读不出/解析失败)却只在状态工具里出声;而排查"跑的是哪一版"时人最先看的就是 relay status。
        // 版本不一致**只说一次**。这一条是第一屏那条(见下方注释);
        // `v.version` 缺失时回落到 `v.versions.loaded`,免得把"进程内 vundefined"打出去。
        if (v.versions && v.versions.mismatch) lines.push(`⚠️ 版本不一致:进程内 v${v.version || v.versions.loaded || '?'} ≠ 磁盘 package.json v${v.versions.disk} —— 部署后没重启`)
        if (v.versions && v.versions.unverifiable) lines.push(`⚠️ 版本自证失效:${v.versions.error} —— 进程内是 v${v.version},但"磁盘有没有换版"无从判断`)
        if (v.ioWarnings && v.ioWarnings.length > 0) {
          for (const e of v.ioWarnings) lines.push(`⚠️ 项目根暂时读不到(${e.warn.code}):${e.warn.root} —— 已按"未删除"处理,绑定保留`)
        }
        if (v.note) lines.push(String(v.note))
        if (v.coordination) lines.push(`coordination=${v.coordination}`)
        if (v.abort) lines.push(`中止:${v.abort}`)
        /**
         * send 路径写的 `staleBinding` 在**本** render 里
         * 一直没有读取点 —— 唯一的渲染点在另一个工具 `relay_spawn` 里(而且那条分支执行不到:
         * spawnRole 只写 staleRebind)。于是 `oldAgentId`(到底是哪条绑定被判失效)永远不显示,
         * 人只能从上面 abort 那句话里读到 owner/期望,无法回答"被清掉的是哪一个 id"。
         * 触发:换过会话 / resume / 重启之后,对旧绑定发一次 `relay action=send`(status=stale_binding)。
         */
        if (v.staleBinding) {
          lines.push(`🔁 失效绑定:@${v.staleBinding.role}(${shortId(v.staleBinding.oldAgentId)})属于另一个父会话 `
            + `${v.staleBinding.owner || '(未知)'},期望调度者 ${v.staleBinding.expectedScheduler || '(未知)'} —— 该绑定已清理,先 relay_spawn 重派`)
        }
        if (v.delivery) {
          lines.push(v.delivery.ok
            ? `投递:✓ ${v.delivery.via} → agent=${v.delivery.targetId}${v.delivery.messageId ? ` (msg=${String(v.delivery.messageId).slice(0, 8)})` : ''}`
            : `投递:✗ ${v.delivery.via || '-'} ${v.delivery.reason}${v.delivery.code ? ` [${v.delivery.code}]` : ''}`)
        }
        /**
         * noDeliver 模式下回执里的 `deliver`
         * (targetAgentId / sessionId / text)没有任何显示路径 —— 屏幕上只剩
         * 「投递:✗ off noDeliver=true:只做编排判定」,而"该发给谁、正文在哪"全在 payload 里,
         * 模型不翻 payload 就不知道该把这次互呼递给谁。正文不整段打印(可能很长,做法已由
         * nextActions 给出),只报目标与字数。
         * 触发:`relay action=send … noDeliver:true`。
         */
        if (v.deliver) {
          const dv = v.deliver
          lines.push(`noDeliver:正文未由插件投出 —— 用 send_message 发给 agent=${dv.targetAgentId}`
            + `${dv.sessionId && dv.sessionId !== dv.targetAgentId ? `(session=${dv.sessionId})` : ''}`
            + `;正文(${String(dv.text || '').length} 字)在 payload.deliver.text`)
        }
        if (v.duplicate) lines.push(`去重:${DEDUPE_MS / 1000}s 内同一互呼已投递过,未重复发送`)
        if (v.replyClosed) lines.push(`回复闭合:@${v.replyClosed} 的等待关系已释放(不再误判死锁)`)
        /**
         * status / ledger 两条路径给的是**对象**数组
         * (`{role,to,ageSec}`,见 sweepExpiredWaits),而这里一直写的是 `join(', ')` ——
         * 屏幕上是「等待超时释放:[object Object]」,**释放了谁的等待完全读不出**。
         * 只有 send 路径中招不了,因为它写回执前自己把元素转成了字符串。
         * 复现实例(自定义档 waitTimeoutMs=800):
         *   payload = [{"role":"pm","to":"be","ageSec":1}]  →  渲染 = 等待超时释放:[object Object]
         */
        if (Array.isArray(v.expiredWaits) && v.expiredWaits.length > 0) {
          lines.push(`等待超时释放:${v.expiredWaits.map((w) => (typeof w === 'string' ? w : `@${w && w.role}→@${w && w.to}${w && typeof w.ageSec === 'number' ? `(${w.ageSec}s)` : ''}`)).join(', ')}`)
        }
        if (v.mark) lines.push(`标记 @${v.mark.to}: ${v.mark.msg}`)
        // 末行有多条标记时必须渲染出来 —— 只出现在 payload 里的告警,人看不到
        if (v.markDroppedNote) lines.push(String(v.markDroppedNote))
        if (v.profileView) lines.push(`档案:${v.profileView.current}${v.profileView.unknown ? ` (未知 profile ${v.profileView.unknown} → 回退 standard)` : ''} | 角色:${v.profileView.roles.join('/')} | 协调者:@${v.profileView.coordinator} | 自动投递:${v.profileView.autoDeliver ? '开' : '关'} | 熔断:${v.profileView.limit}次/${Math.round(v.profileView.windowMs / 60000)}分钟`)
        if (Array.isArray(v.profileView && v.profileView.available)) {
          lines.push('可用 profile:')
          for (const p of v.profileView.available) lines.push(`  ${p.id === v.profileView.current ? '▶' : ' '} ${p.id} — ${p.label}(${p.roles.join('/')})${p.desc ? ` ${p.desc}` : ''}`)
        }
        if (v.waitingView) lines.push(`等待图:${JSON.stringify(v.waitingView)}`)
        if (v.staleWaiting && v.staleWaiting.length > 0) lines.push(`重启作废的等待:${v.staleWaiting.map((w) => `@${w.role}→@${w.to}`).join(', ')}`)
        if (v.roleView) lines.push(`角色绑定:${JSON.stringify(v.roleView)}`)
        // roleView 补口:把"活着但归属不是当前调度者"的绑定单独说清楚 ——
        // 这一列早已写进 roleView,但没有任何渲染,等于没告诉人。
        if (Array.isArray(v.roleMismatch) && v.roleMismatch.length > 0) {
          // ① 判据已与投递预检同源,`≠` 因此是真的不相等;② id 截断先剥 `session-`
          // 前缀 —— `String(id).slice(0, 8)` 对会话 id 恰好只截出常量前缀 `session-`,
          // 两侧看起来一模一样,读者根本无法判断到底比了什么。
          lines.push(`⚠️ 绑定归属与调度者不符:${v.roleMismatch.map((m) => `@${m.role}(${shortId(m.agentId)} 的父会话 ${m.owner ? shortId(m.owner) : '(空)'} ≠ 调度者 ${v.schedulerId ? shortId(v.schedulerId) : '(未知)'})`).join(' | ')} —— 投递前会被判 staleBinding,需 relay_spawn 重派`)
        }
        if (v.gateView) lines.push(`激活:${v.gateView}`)
        /**
         * `kickoff` 与 `deactivate` 两条路径都会把 `root`
         * 写进回执,但 relay 面板**从来没有读取点** —— 「这次动手的是哪个项目根」在屏幕上从不出现。
         * 同一件事在 state 工具里有「项目根:」一行(还带 rootInferred 告警),relay 这边是空白。
         * 根错一位的后果不对称:kickoff 会去派另一个目录的角色,deactivate 会去撤另一个项目的开工记忆。
         * 触发:不传 root 调 `relay action=kickoff goal="x"` 或 `relay action=deactivate`。
         */
        if (v.root) lines.push(`项目根:${v.root}`)
        if (v.apiView) lines.push(`API 契约:技能 ${v.apiView.skill} | lint ${v.apiView.lint}`)
        if (v.roleSkillsView) lines.push(`角色技能:${v.roleSkillsView}`)
        if (v.activityView) lines.push(`活动统计:${v.activityView}`)
        // 进程内累计重启即归零,而 lifetime 是跨重启的历史 —— 两个数必须分开摆,
        // 否则重启后看到"投递 成功=0/失败=0"(而盘上是 82/6)会以为历史丢了。
        if (v.lifetimeView) lines.push(`累计:${v.lifetimeView}`)
        if (v.projectActivityView) lines.push(`本项目统计:${v.projectActivityView}`)
        if (v.activityView) lines.push(`投递统计:${v.deliveryStatsGlobal ? `进程累计 成功=${v.deliveryStatsGlobal.deliveries} 失败=${v.deliveryStatsGlobal.deliveryFailures} 去重=${v.deliveryStatsGlobal.duplicates} 并线=${v.deliveryStatsGlobal.busyMerged || 0}` : ''}${v.deliveryStatsGlobal && v.deliveryStats ? ' | ' : ''}${v.deliveryStats ? `本项目 成功=${v.deliveryStats.deliveries} 失败=${v.deliveryStats.deliveryFailures} 去重=${v.deliveryStats.duplicates} 并线=${v.deliveryStats.busyMerged || 0}` : ''}`)
        if (v.bucketPruned) lines.push(`熔断计数:本槽曾就地清掉 ${v.bucketPruned.dropped} 个不属于本项目的旧桶(${v.bucketPruned.at},按目录名/自报项目名分桶会留下这种桶,已落盘收敛);本窗口只认 ${v.bucketPruned.bucket}`)
        if (v.staleRebindView && v.staleRebindView.length > 0) {
          lines.push(`自动重派的失效绑定:${v.staleRebindView.map((s) => `@${s.role}(${s.reason})`).join(' | ')}`)
        }
        if (Array.isArray(v.bootSweep) && v.bootSweep.length > 0) {
          lines.push(`🧹 启动清扫:回收 ${v.bootSweep.length} 个已删目录的死槽(${v.bootSweep.map((s) => `${String(s.root).split(/[\\/]/).pop()}:${s.bindings}绑定`).join(' | ')})`)
        }
        // 回收了几个空槽也必须出声 —— 否则"槽怎么少了"无从归因
        if (Array.isArray(v.emptySlotSweep) && v.emptySlotSweep.length > 0) {
          lines.push(`🧹 空槽回收:${v.emptySlotSweep.length} 个空槽超过 ${Math.round(SWEEP_EMPTY_TTL_MS / 86400000)} 天没被碰过(无绑定/无台账/无边车),已删除(${v.emptySlotSweep.map((s) => `${s.profile}@${String(s.root).split(/[\\/]/).pop()}:${s.updatedAt || '时间未知'}`).join(' | ')})`)
        }
        if (Array.isArray(v.providers)) lines.push(`provider: ${v.providers.length === 0 ? '(无)' : v.providers.join(', ')}`)
        if (Array.isArray(v.presetView)) {
          const have = v.presetView.filter((e) => e.installed)
          if (have.length === 0) {
            // 预设是可选项(默认不装):不逐条报 ❌,免得每次 status 都刷五行噪音
            lines.push('角色预设:未安装(可选;角色子会话人格由 profile.persona 注入,不依赖预设)')
          } else {
            lines.push('角色预设(仅影响人工以该预设开会话;角色子会话的人格由 persona 显式注入):')
            for (const e of v.presetView) {
              lines.push(`  @${e.role} ${e.id} ${e.installed ? (e.broken ? '⚠️ 组合有误' : '✅ 就绪') : '— 未安装(可选)'}${e.name ? ` (${e.name})` : ''}${e.broken ? ` — ${e.broken}` : ''}`)
            }
          }
        }
        /**
         * `relay action=presets` 写的是 `expected` / `others`,
         * 而 render 读的是 `presetView`(只有 status 路径写它)—— 于是**逐角色的预设对照表永不显示**,
         * presets 动作的屏幕上只剩一行 note("已安装 3/5"),到底哪个角色缺哪个预设读不出来。
         * 触发:`relay action=presets`。
         */
        if (Array.isArray(v.expected)) {
          lines.push(`预设对照(profile=${v.profileView ? v.profileView.current : '?'},期望 ${v.expected.length} 个角色):`)
          for (const e of v.expected) {
            lines.push(`  @${e.role} ${e.id} ${e.installed ? (e.broken ? '⚠️ 组合有误' : '✅ 就绪') : '— 未安装(可选)'}${e.name ? ` (${e.name})` : ''}${e.broken ? ` — ${e.broken}` : ''}`)
          }
          if (Array.isArray(v.others)) lines.push(`  不属于本 profile 的预设:${v.others.length === 0 ? '(无)' : v.others.join(', ')}`)
        }
        if (Array.isArray(v.counters)) {
          lines.push(`熔断计数:${v.counters.length === 0 ? '(空)' : v.counters.map((c) => `@${c.from}→@${c.to}[${c.project}] ${c.used}/${c.limit}`).join(' | ')}`)
        }
        // 只说"有几条待仲裁"是不够的 —— 而取回被拦下正文的**唯一动作**
        // (relay action=arbitrate)在熔断通知/回执/status 三处一次都没出现过,于是队列里的正文
        // 事实上取不回来(实测:发起方只看到"禁止投递",只能反复重投直到再次 limit)。
        if (typeof v.arbitrationPending === 'number') lines.push(`待仲裁:${v.arbitrationPending} 条${v.arbitrationPending > 0 ? '(含被判熔断/死锁拦下的**正文**,用 relay action=arbitrate 取回)' : ''} | 台账 ${v.ledgerRows} 行${typeof v.ledgerPending === 'number' ? `(用 relay action=ledger 渲染投影)` : ''}`)
        /**
         * arbitrate 被拒(unauthorized)时写了 `pending`,
         * 而拒绝回执里从未报出队列条数 —— note 却让调用者"用 status 看「待仲裁:N 条」并把这件事
         * 报给协调者",对方连有几条都读不到,只能再去调一次 status 才敢回话。
         * 触发:只读角色(或任何非协调者 / 非调度者)调 `relay action=arbitrate`。
         */
        if (typeof v.pending === 'number') lines.push(`待仲裁队列:${v.pending} 条(**一条都没取走** —— 本动作只放行协调者/调度者)`)
        if (v.ledgerStatus) lines.push(`台账投影:${v.ledgerStatus}${v.ledgerPath ? ` → ${v.ledgerPath}` : ''}`)
        /**
         * send 路径写了 ledgerRows / ledgerPending / ledgerPath,
         * 而 render 里唯一的读取点就长在上面那两条 `if` 里 —— 一条要求 arbitrationPending 是数字、
         * 一条要求 ledgerStatus 为真,而 send 路径这两个字段一个都不写,于是
         * 「这次互呼后台账有几行、落在哪个文件」**100% 打不出来**,只能靠人翻 payload。
         * 触发:任意一次 `relay action=send`。
         * 注:两条路径给的 ledgerPending 与 ledgerRows 取值表达式逐字相同(都是 (slot.ledger||[]).length),
         * 所以正常情况下只打一个数;真要是分叉了才把第二个数补上(不另写一个永远为空的独立分支)。
         */
        if (typeof v.ledgerRows === 'number' && !v.ledgerStatus && typeof v.arbitrationPending !== 'number') {
          lines.push(`协作台账:${v.ledgerRows} 行${typeof v.ledgerPending === 'number' && v.ledgerPending !== v.ledgerRows ? `(其中待渲染 ${v.ledgerPending} 行)` : ''} → relay action=ledger 渲染投影${v.ledgerPath ? `(${v.ledgerPath})` : ''}`)
        }
        /**
         * 顶层 `ledger` 这个形状**没有写入者**,所以不能在这里渲染:
         * `if (v.ledger) lines.push(`台账: ${v.ledger.status} | ${v.ledger.note}`)` **执行不到** ——
         * 全文件没有任何 relay execute 路径往**顶层** `ledger` 写东西;它读的那个形状
         * (`{status, note}`)其实是**台账行**:`breakerRow()` 之类的助手返回 `res.ledger`,
         * 由 send 路径取走 push 进槽,**从不进 out**(`out.ledgerText` 是另一回事);
         * 状态工具 payload 里的 `ledger` 与 relay 的 render 无关。
         * 删而不是留档,是为了守住本文件的不变量"render 读的字段必须有写入者" ——
         * 留着就等于把这条不变量变成"除了这两处",反查脚本也就报不出新出现的死渲染行。
         * 若将来真有路径回顶层 `ledger`(例如要让 send 回执直接报"本次被熔断,已记一行台账"),
         * 就在这里把那一行按当时的字段形状写回来 —— 别忘了同时补断言。
         */
        if (v.stateHealth) lines.push(`插件私有状态:${v.stateHealth}`)
        // 有别的实例在写同一个 state.json —— 必须说出来(不说的话,
        // "为什么我的项目槽看起来是别人的"永远查不出来)
        if (v.foreignMerge) lines.push(`⚠️ 检测到**另一个实例**写过同一个 state.json(boot=${String(v.foreignMerge.foreignBoot).slice(0, 16)}…,${v.foreignMerge.at}):已按槽级合并(并入 ${v.foreignMerge.slotsAdded} 个、保留对方较新 ${v.foreignMerge.slotsKept} 个),未整份覆盖`)
        if (typeof v.ledgerFullSize === 'number' && v.ledgerFullSize > 0 && !v.ledgerFullTotal) lines.push(`台账全文边车:${(v.ledgerFullSize / 1024).toFixed(1)} KB(超过 ${LEDGER_FULL_MAX / 1024 / 1024} MB 自动转一代 .1)`)
        if (v.ledgerFullTotal && typeof v.ledgerFullTotal.total === 'number' && (v.ledgerFullTotal.total > 0 || v.ledgerFullSize > 0)) {
          lines.push(`台账全文边车:本项目 ${((v.ledgerFullSize || 0) / 1024).toFixed(1)} KB / 全部 ${(v.ledgerFullTotal.total / 1024).toFixed(1)} KB(${v.ledgerFullTotal.files} 个文件;单文件超 ${LEDGER_FULL_MAX / 1024 / 1024} MB 自动转一代 .1,只留两代)`)
        }
        /**
         * 版本告警**只留第一屏那一条**,不要在这里再来一条同文的:
         * `⚠️ 版本不一致:进程内 v${v.versions.loaded} ≠ 磁盘 v${v.versions.disk} —— 说明部署后没重启`。
         * 实测:同一条 relay status 回执上连打两行,
         * 说的是同一件事,读的人会怀疑"是不是两处版本各不一致"。
         * 第一屏那条紧随「插件:… vX(本进程已加载)」;`v.version` 缺失时
         * 回落到 `v.versions.loaded` —— 两个数据源都读得出时也只打一行。
         */
        if (Array.isArray(v.events)) {
          lines.push(`取出仲裁事件:${v.events.length} 条${v.events.length > 0 ? ` → ${v.events.map((e) => `${e.reason}(${e.from}→${e.to})`).join(', ')}` : ''}`)
          // 被熔断/死锁拦下的正文只进队列、**取不回来** —— 只渲染
          // reason/from/to,把 msg 丢了。仲裁的全部意义就是"把被拦下的东西交还给人裁决",
          // 不给出正文等于把它永久丢掉(小档的质检报告就是这样丢的)。
          if (Array.isArray(v.events) && v.events.length > 0) {
            v.events.forEach((e, i) => {
              lines.push(`  ── 事件 ${i + 1}/${v.events.length} ─────────────────`)
              lines.push(`  时间:${e.ts || '(无)'} | 发起:@${e.from} | 目标:@${e.to} | 原因:${e.reason || '(无)'} | 项目:${e.project || '(无)'}`)
              const body = typeof e.msg === 'string' ? e.msg : ''
              if (body) {
                const shown = body.length > 4000 ? `${body.slice(0, 4000)}\n…(正文共 ${body.length} 字,此处截断)` : body
                lines.push('  正文(原文,可直接重投或落盘):')
                for (const ln of shown.split('\n')) lines.push(`    ${ln}`)
                // 超过保留上限的正文已转存台账边车 —— 如实告诉取用的人去哪儿拿全文
                if (e.msgTruncated) lines.push(`  ⚠️ 该条正文在插件状态里只保留了前 ${ARBITRATION_MSG_MAX} 字(全文共 ${e.msgLen} 字,已转存台账边车 ledger/*.jsonl,按 hash ${e.msgHash} 检索)`)
              } else {
                lines.push('  ⚠️ 该事件未携带正文(更早的记录里没有正文)—— 被拦下的内容无法取回')
              }
            })
          }
        }
        if (Array.isArray(v.attempts) && v.attempts.length > 0) {
          lines.push(`编排动作:${v.attempts.map((a) => `${a.actor}→${a.target}${a.delivered ? '✓' : '✗'}`).join(', ')}`)
        }
        // kickoff 的开工回执
        if (Array.isArray(v.spawned) || Array.isArray(v.failed)) {
          lines.push(`开工:profile=${v.profileId} | 协调者=@${v.coordinator}${v.goal ? ` | 需求:${String(v.goal).slice(0, 60)}` : ''}`)
          // 三类结果**各自成段并带计数**。只有「已派出 N 个角色」+ ✅ 行时,
          // "到底重派了、还是被跳过、还是失败了"只能靠比对 agentId 才判得出来。
          lines.push(`  spawned(${(v.spawned || []).length}):`)
          for (const s of (v.spawned || [])) lines.push(`    ✅ @${s.role}(${s.label})→ ${s.agentId}${s.readonly ? ' [只读]' : ''}`)
          if ((v.spawned || []).length === 0) lines.push('    (无)')
          lines.push(`  skipped(${(v.skipped || []).length}):`)
          for (const s of (v.skipped || [])) lines.push(`    ↷ @${s.role} 已登记,未重派 → ${s.agentId}`)
          if ((v.skipped || []).length === 0) lines.push('    (无)')
          lines.push(`  failed(${(v.failed || []).length}):`)
          for (const f of (v.failed || [])) lines.push(`    ❌ @${f.role} ${f.status}: ${f.note}`)
          if ((v.failed || []).length === 0) lines.push('    (无)')
          if (v.autoActivated) lines.push('  🔓 本项目已自动激活(不需要 .active 文件)')
          if (v.existingState) lines.push(`  ℹ️ 已有流程状态文档 ${v.existingState}:不覆盖,先 workflow_state_load`)
        }
        /**
         * kickoff / deactivate 还有几个字段只进 payload ——
         * 「协调者到底就位没有」「有哪些档可用」「这次的门是怎么判的」「解绑了谁、解掉哪些等待」
         * 全靠人从 note 与 spawned/failed 数组里反推,而 note 在协调者失败时只留下失败原因前 80 字。
         * 各字段只有对应动作才写,所以逐条按"字段在不在"渲染。deactivate 的 released* 也放在这里,
         * 因为 deactivate 既没有 spawned 也没有 failed,落不进上面那个开工块。
         */
        if (typeof v.coordinatorSpawned === 'boolean') {
          lines.push(v.coordinatorSpawned
            ? `协调者 @${v.coordinator || '?'}:✅ 已就位(唯一的回话入口)`
            : `⚠️ 协调者 @${v.coordinator || '?'} **没就位**${v.degraded === true ? '(degraded=true)' : ''}:没人能给这批角色派活 —— 修好 failed 里的原因后用 relay_spawn 补派`)
        }
        if (Array.isArray(v.availableProfiles) && v.availableProfiles.length > 0) {
          lines.push(`可用 profile:${v.availableProfiles.join(', ')}`)
        }
        if (v.gateSource) lines.push(`激活门:${v.gate || '(未标)'}(${v.gateSource})`)
        // kickoff / deactivate / status 的回执都带上"各入口命中计数"——
        // 排障时最常问的两句("入口到了没""为什么没动手")都能在这一条回执里读到。
        // 两种字段形状都收:deactivate 直接给渲染好的串,status 给结构化读数(内含 view)。
        {
          const paView = v.presetAutoView || (v.presetAuto && v.presetAuto.view)
          if (paView) lines.push(String(paView))
        }
        if (Array.isArray(v.releasedRoles) || Array.isArray(v.releasedWaits)) {
          const rr = Array.isArray(v.releasedRoles) ? v.releasedRoles : []
          const rw = Array.isArray(v.releasedWaits) ? v.releasedWaits : []
          lines.push(`本次撤销:解绑角色 ${rr.length} 个${rr.length > 0 ? `(${rr.map((r) => `@${r}`).join(' ')})` : ''} | 解掉等待 ${rw.length} 条${rw.length > 0 ? `(${rw.map((w) => `@${w.role}→@${w.to}`).join(' ')})` : ''}`)
        }
        if (v.documentText) { lines.push(DOC_BEGIN); lines.push(String(v.documentText)); lines.push(DOC_END) }
        if (Array.isArray(v.notices) && v.notices.length > 0) {
          lines.push('通知投递:')
          for (const n of v.notices) lines.push(`  → @${n.role}: ${n.ok ? '✓ 已投递' : `✗ ${n.reason || '跳过'}`}`)
        }
        if (Array.isArray(v.nextActions) && v.nextActions.length > 0) {
          lines.push('后续动作:')
          for (const s of v.nextActions) lines.push(`  - ${s}`)
        }
        if (v.ledgerText) { lines.push(LEDGER_BEGIN); lines.push(String(v.ledgerText)); lines.push(LEDGER_END) }
        if (v.persistInstruction) lines.push(v.persistInstruction)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const a = args || {}
      const action = a.action || 'send'
      // 未知 action 若**静默落到 send 路径** —— `action=deactivatee`
      // 只要带上残留的 from/to/msg,就是一次真实互呼(还可能真的投出去)。
      // api_contract 早就有 invalid_action,relay 一直没有。这里补上,且放在最前面:
      // 未知 action 不碰任何状态。
      if (RELAY_ACTIONS.indexOf(String(action)) === -1) {
        return { status: 'invalid_action', note: `未知 action:${String(action)};可用:${RELAY_ACTIONS.join(', ')}` }
      }
      const root = resolveRoot(a, exec)
      const caller = exec && exec.agent ? exec.agent : undefined
      const { profile, ids: profileIds, unknown, table } = resolveProfile(root, a.profile)
      // 把 caller 交给 slotFor —— 换过会话(同进程新会话)的残留等待图就地作废
      const { slot, coord } = slotFor(profile, root, coordinators, caller)
      const ledgerRel = profile.state.ledger
      const ledgerPath = path.join(root, ledgerRel)

      /**
       * readonly 只做一半等于没做 —— `READONLY_ALLOW` 放行了 `relay`,
       * 而 `relay` 自己带 kickoff(内部 `spawnRole()` × N)、`deactivate`、档案切换。
       * 于是 `review` 档案里两个只读角色,一次调用就能派出一整队 agent。
       * 工具粒度上没法"只放行 send/status"(那要拆工具),所以在**角色**这一层把
       * 真正会改世界的三个动作拦下来。
       */
      const boundInfo = caller ? roleSlotOfAgent(caller) : null
      if (boundInfo) {
        const tbl = profileTable()
        const boundProfile = tbl[boundInfo.profileId] || profile
        const boundRoleDef = roleOf(boundProfile, boundInfo.role)
        const switchingProfile = action === 'profile' && !!a.profile
        if (boundRoleDef && boundRoleDef.readonly === true
          && (action === 'kickoff' || action === 'deactivate' || switchingProfile)) {
          // 注意:这里**不能**带 profileView —— 它是本函数后面才声明的 const(会踩 TDZ)
          return {
            status: 'readonly_denied',
            note: `@${boundInfo.role} 在 profile=${boundProfile.id} 里是**只读角色**,不允许 relay action=${action}`
              + '(它会派角色 / 改项目激活态 / 切档案)。只读角色可用:send、status、release、ledger、providers、presets、arbitrate。',
          }
        }
      }

      const profileView = () => ({
        current: profile.id,
        unknown,
        roles: profile.roles.map((r) => r.id),
        coordinator: profile.coordinator,
        autoDeliver: profile.relay.autoDeliver !== false && !boolTrue(a.noDeliver),
        limit: profile.relay.limit,
        windowMs: profile.relay.windowMs,
        waitTimeoutMs: profile.relay.waitTimeoutMs,
        replyClosesWait: profile.relay.replyClosesWait !== false,
        available: profileIds.map((id) => ({ id, label: table[id].label, roles: table[id].roles.map((r) => r.id), desc: table[id].desc })),
      })

      // ── kickoff:一句话开工──────────────────────────────────────────
      if (action === 'kickoff') return await kickoff({ a, exec, root })

      // ── deactivate:撤销开工记忆(自动激活的配套逃生阀)──────────────
      if (action === 'deactivate') {
        // 撤销开工必须**同时解绑角色**,否则留下一堆
        // "记忆说没开工、绑定表说过五个人都在"的鬼状态 —— 死绑定正是
        // 实测 UNAUTHORIZED 与"kickoff 报人齐了却派不动"的直接来源。
        const boundBefore = Object.keys(slot.roleAgents || {})
        const had = unmarkActive(root)
        // 只解绑角色、不清等待图 → 撤销开工后图里还留着 `arch/qa→pm` 的等待关系,
        // 下一次 kickoff 的协调者会看到"有人在等我"的假象,甚至被误判成死锁环。
        const waitsBefore = Object.keys(coord.waiting || {}).map((role) => ({ role, to: coord.waiting[role] }))
        if (waitsBefore.length > 0) {
          coord.waiting = {}
          coord.waitMeta = {}
        }
        if (boundBefore.length > 0 || waitsBefore.length > 0) {
          slot.roleAgents = {}
          slot.reclaimed = { at: makeTS(), root, bindings: boundBefore.length, waits: waitsBefore.length, by: 'deactivate' }
          syncSlot(slot, coord)
          saveStore()
        }
        const gate = gateStateOf(root)
        return {
          status: (had || boundBefore.length > 0 || waitsBefore.length > 0) ? 'deactivated' : 'noop',
          root, gateView: `${gate}(${gateLabelOf(root, gate)})`,
          // 撤销之后"同一个 agent × 同一个预设不再重判"这条语义要看得见 ——
          // 回执里直接给出本进程的入口计数与最近一笔判定。
          presetAuto: presetAutoPayload(),
          presetAutoView: presetAutoView(),
          releasedRoles: boundBefore,
          releasedWaits: waitsBefore,
          note: (had || boundBefore.length > 0 || waitsBefore.length > 0)
            ? `已从插件记忆里移除开工记录${boundBefore.length > 0 ? `,并解绑 ${boundBefore.length} 个角色(${boundBefore.map((r) => `@${r}`).join(' ')})` : ''}`
              + `${waitsBefore.length > 0 ? `,并解掉 ${waitsBefore.length} 条等待关系(${waitsBefore.map((w) => `@${w.role}→@${w.to}`).join(' ')})` : ''}`
              + `(技能回到隐藏;注意:7 个工具仍然可见 —— 那是注册期的,撤销激活改不了)`
              + (gate === 'none' ? '' : `;但项目还有别的激活来源(${gateLabelOf(root, gate)}),要彻底关掉就在 ${ACTIVE_REL} 里写 off`)
            : '插件记忆里本就没有这个项目的开工记录,也没有绑定的角色(可能靠 .active 文件或已有流程状态文档激活)',
        }
      }

      if (action === 'status') {
        /**
         * 等待超时若**只在该槽的 send 路径**懒触发(sweepExpiredWaits 只在 send 里调),
         * status / ledger 就不释放 ——一条早就该超时的等待关系,20 分钟后
         * `relay action=status` 仍报 `ageSec:1200`、`waitingView` 里挂着对方 —— 而模型判断
         * "他还在等我吗 / 我是不是该回话"正是看这个视图,于是要么白等、要么按错的等待图发消息。
         * 现在:status 先清扫再渲染(清扫才写盘,没超时就一个字节都不落,不打扰 2.8 那类自洽断言)。
         */
        const expiredWaits = sweepExpiredWaits(slot, coord, profile)
        if (expiredWaits.length > 0) { syncSlot(slot, coord); saveStore() }
        const waitingView = {}
        for (const k of Object.keys(coord.waiting)) {
          const meta = coord.waitMeta[k] || {}
          waitingView[k] = { to: coord.waiting[k], since: meta.ts || '', ageSec: meta.since ? Math.round((Date.now() - meta.since) / 1000) : null }
        }
        const roleView = {}
        const roleMismatch = []
        const agentsSvc = ctx.get('agents')
        const schedulerId = schedulerIdOf(caller)
        for (const k of Object.keys(slot.roleAgents)) {
          const id = slot.roleAgents[k]
          // isOwnedBy 只在"该子会话此刻活着且正是调用者的子"时为真(运行期归属,
          // 不是持久谱系),所以只作辅助信号,不用它下"绑定失效"的结论。
          let liveOwnedByCaller = null
          try {
            if (caller && agentsSvc && typeof agentsSvc.isOwnedBy === 'function') liveOwnedByCaller = agentsSvc.isOwnedBy(id, caller) === true
          } catch { liveOwnedByCaller = null }
          const liveAgent = agentOf(id)
          const owner = liveAgent ? parentSessionOf(liveAgent) : ''
          roleView[k] = { agentId: id, live: liveAgent !== undefined, liveOwnedByCaller, owner }
          // roleView 的可观测性那一半:活着的绑定,若它的父会话不是当前调度者,
          // 那么**下一次投递一定会在发之前被判 staleBinding**(投递预检)—— 提前说出来,
          // 就不用等到"发了没回、再怀疑内容丢没丢"。只报 live/liveOwnedByCaller 时,
          // 而 liveOwnedByCaller=false 这层意思没有任何渲染。
          // 判据必须与**投递预检** `bindingUsable` 同源。
          // 那里比的是 `schedulerIdOf(caller)`(角色子会话会归一化到它的父会话),而这里
          // 却用**原始 caller** 的 `isOwnedBy(id, caller)` —— 于是角色子会话查 status 时
          // `isOwnedBy(自己,自己)=false`,**每个**活绑定(含它自己)都被报成"归属与调度者不符",
          // 而投递其实判得通过。实测:@pm 据此建议调度者"绕过 relay 直投 / 先重派我" —— 建议本身是错的。
          // 判据与 bindingUsable **逐字同源** —— 两侧都取谱系顶端比。
          // 不能比 `owner !== schedulerId`(原始父会话) —— 基准是谱系顶端:
          // 绑定的 owner 是中间层角色会话时(角色自己派的 helper),这里会误报"归属不符",
          // 而投递预检其实判得通过 —— 又一处"面板与预检说法不一致"。
          const ownerTop = owner === '' ? '' : sessionTopOf(owner)
          const mismatch = liveAgent !== undefined && owner !== '' && schedulerId !== '' && ownerTop !== schedulerId
          if (mismatch) {
            roleMismatch.push({ role: k, agentId: String(id), owner, ownerTop, expectedScheduler: schedulerId })
          }
        }
        const counters = Object.keys(coord.relayTs)
          .filter((k) => coord.relayTs[k].length > 0)
          .map((k) => {
            const seg = k.split('\u0000')
            return { from: seg[0], to: seg[1], project: seg[2], used: coord.relayTs[k].length, limit: coord.limit }
          })
        const roster = await loadRoster()
        // 全局量与项目量**分开报、各自带标签**。把进程级计数直接写进任何项目的 status,
        // 未开工的项目也会报出别的项目的错误/派出数,实测误导过两个角色。
        const slotStat = slot.stat || {}
        const activityView = `进程累计(全部项目):状态保存=${activity.stateSaves} 互呼=${activity.relayCalls} 派出=${activity.spawns} 工具调用(已完成)=${activity.toolCalls} 在飞=${activity.inFlight}${activity.lastError ? ` 最后错误=${activity.lastError}(全局口径:任何项目里某次工具调用失败都会写在这里,不等于本项目出错)` : ''}`
        const projectActivityView = `本项目(${profile.id}@${root || '(no-root)'}):状态保存=${slotStat.stateSaves || 0} 互呼=${slotStat.relayCalls || 0} 派出=${slotStat.spawns || 0} 投递=成功 ${slotStat.deliveries || 0}/失败 ${slotStat.deliveryFailures || 0} 去重=${slotStat.duplicates || 0} 并线=${slotStat.busyMerged || 0} 失效重派=${slotStat.staleRebinds || 0}${slotStat.lastError ? ` 最后错误=${slotStat.lastError}` : ''}`
        // 只求值一次 fsDenyFor:调两次理论上能在两次调用之间跨过 TTL,
        // 第二次返回 null 而 `.reason` 直接抛 TypeError
        const ledgerDeny = fsDenyFor(root)
        return {
          status: 'ok',
          profileView: profileView(),
          waitingView, roleView, roleMismatch, schedulerId, counters,
          // 本视图是清扫**之后**的等待图;有东西被释放就一并报出来(只能靠 ageSec 自己猜)。
          expiredWaits,
          staleWaiting: (slot.staleWaiting || []).slice(-10),
          staleRebindView: staleRebindLog.slice(-10),
          bootSweep: sweptOnBoot.map((s) => ({ root: s.root, bindings: s.bindings })),
          // status 要能报出"按 TTL 回收了几个空槽"——
          // 只有"回收已删目录的死槽"这一条时,空槽永久保留却无任何可见性。
          emptySlotSweep: sweptEmpty.map((s) => ({ root: s.root, profile: s.profile, updatedAt: s.updatedAt, ageDays: s.ageDays })),
          arbitrationPending: (slot.arbitration || []).length,
          ledgerRows: (slot.ledger || []).length,
          ledgerPending: (slot.ledger || []).length,
          ledgerPath,
          ledgerStatus: ledgerDeny
            ? `插件直写被拒(${ledgerDeny.reason}),需主会话 write 落盘`
            : '可用 relay action=ledger 渲染(插件会先试直写)',
          stateHealth: storeHealth.blocked
            ? `🔒 已锁存,本进程不落盘:${storeHealth.readError || storeHealth.error}`
            : (storeHealth.ok === true
              ? `可写(${storeHealth.path},已写 ${storeHealth.writes} 次)${storeHealth.readError ? ` ⚠️ ${storeHealth.readError}` : ''}`
              : `不可写:${storeHealth.error || '未知'}`),
          version: VERSION,
          versions: versionState(),
          foreignMerge: storeHealth.foreignMerge || null,
          ioWarnings: Object.keys(store.projects)
            .map((k) => ({ key: k, warn: store.projects[k] && store.projects[k].ioWarning }))
            .filter((e) => !!e.warn),
          lifetimeView: `历史累计(落盘,跨重启):状态保存=${store.lifetime.stateSaves || 0} 互呼=${store.lifetime.relayCalls || 0} 派出=${store.lifetime.spawns || 0} 工具调用=${store.lifetime.toolCalls || 0} 投递=成功 ${store.lifetime.deliveries || 0}/失败 ${store.lifetime.deliveryFailures || 0} 落盘=${store.lifetime.storeWrites || 0} 次`,
          ledgerFullSize: ledgerSidecarSize(slot),
          // 边车是**按项目分文件**的,只报本项目等于永远看不到盘在长
          // (实测 680 KB 分散在三个别的项目的文件里,本项目那行是 0 → 一行都不渲染)。
          ledgerFullTotal: ledgerSidecarTotal(),
          providers: providerNames(),
          gateView: `${gateStateOf(root)}(${gateLabelOf(root, gateStateOf(root))})`,
          /**
           * 各入口命中计数。放在 status 里是有意的 —— 没有它,
           * 根因就是"门已开时判定静默",而那时唯一能看的地方是宿主日志。
           */
          presetAuto: presetAutoPayload(),
          presetView: roster ? presetRows(roster, profile) : [],
          apiView: {
            /**
             * 技能文本的 frontmatter `version`
             * 它若一直停在 `1.2.0` 而插件已经走到新版本 —— 两个数对不上,排障时无从判断
             * "手上这份技能文本是哪一版插件带来的"。现在把**两边都摆在同一行**:
             * 技能自己的快照版本 + 插件进程内版本,不一致就直接标出来(不是静默显示一个旧号)。
             * 这条只报不拦:技能文本随包,不会因为版本号写旧了就变得不可用。
             */
            skill: `${API_SKILL_NAME} ${apiSkillVisible(root) ? '可见' : '隐藏'}`
              + `${apiSkillVersion() ? ` v${apiSkillVersion()}` : ''}`
              + (apiSkillVersion() && apiSkillVersion() !== VERSION ? ` ⚠️ 技能版本与插件版本不一致(插件 v${VERSION})` : ''),
            lint: slot.apiLint ? `ERROR ${slot.apiLint.errors}/WARN ${slot.apiLint.warnings} → ${slot.apiLint.verdict}${slot.apiLint.coverage ? `(覆盖 ${apiCoverageText(slot.apiLint.coverage, true)})` : ''} @${slot.apiLint.at}${slot.apiLint.digest ? ` 指纹 ${String(slot.apiLint.digest).slice(0, 12)}…` : ''}` : '尚未跑过 api_contract lint',
          },
          /**
           * 同一行里再报一次**角色联动技能**的可见性 —— 角色人设写着"按需加载 xxx",
           * 而技能到不到得了角色手里取决于激活门与当前档案;不报的话,"人设说了、目录里没有"
           * 只能靠人去猜(status 与实际能力必须同源)。
           */
          roleSkillsView: roleSkillsSummary(root),
          activityView,
          projectActivityView,
          bucketPruned: slot.bucketPruned || null,
          deliveryStats: {
            deliveries: slotStat.deliveries || 0, deliveryFailures: slotStat.deliveryFailures || 0,
            duplicates: slotStat.duplicates || 0, busyMerged: slotStat.busyMerged || 0,
            staleRebinds: slotStat.staleRebinds || 0,
          },
          deliveryStatsGlobal: {
            deliveries: activity.deliveries, deliveryFailures: activity.deliveryFailures,
            duplicates: activity.duplicates, busyMerged: activity.busyMerged,
            staleRebinds: activity.staleRebinds,
          },
          limit: coord.limit,
          windowMs: coord.windowMs,
        }
      }

      if (action === 'providers') return { status: 'ok', providers: providerNames() }

      if (action === 'presets') {
        const roster = await loadRoster()
        if (!roster) return { status: 'unavailable', note: 'agentPresets 服务不可用' }
        const expected = presetRows(roster, profile)
        const expectedIds = profile.roles.map((r) => r.preset)
        const others = roster.filter((p) => expectedIds.indexOf(String(p.id)) === -1).map((p) => String(p.id))
        const installed = expected.filter((e) => e.installed)
        const missing = expected.filter((e) => !e.installed).map((e) => e.id)
        const broken = installed.filter((e) => e.broken !== '').map((e) => e.id)
        // 预设是**可选项**:角色子会话的人格由 profile.persona 显式注入、工具集由
        // toolFilter 收敛,整条链路一处都不读预设。所以"没装 wf-* 预设"不是缺件,只报事实;
        // 只有**装了但组合坏了**才值得提醒(那会影响人工以该预设开会话)。
        const installedIds = installed.map((e) => e.id)
        return {
          status: broken.length > 0 ? 'incomplete' : 'ok',
          presetMode: 'optional',
          expected, others, profileView: profileView(),
          note: (installed.length === 0
            ? `本 profile 的角色预设未安装(可选,不影响任何流程):${expected.length} 个角色的子会话由 relay_spawn 派出,人格来自 profile.persona`
            : `已安装 ${installed.length}/${expected.length}:${installedIds.join(', ')}` + (missing.length > 0 ? `;未安装: ${missing.join(', ')}` : ''))
            + (broken.length > 0 ? `;⚠️ 组合有误: ${broken.join(', ')}` : '')
            + ';预设只影响人工以该预设开的会话,与角色子会话无关',
        }
      }

      if (action === 'arbitrate') {
        /**
         * 仲裁队列必须校验归属。
         * **一条校验都没有** 时, 队列里装的是"被判熔断/死锁拦下、正文从未投给任何人"的
         * 队列里装的是消息全文(唯一一份),而动作语义是 **drain**(取走并清空)——
         * review 档里连只读的 @arch/@qa 都能用一次 `relay action=arbitrate` 把全项目被拦下的
         * 正文一次性取走清空,真正该裁决的协调者再取就是空队列(内容永久丢失,且无人知道谁拿走了)。
         * 现在只放行两类调用者,且**先判后动**:
         *   ① 协调者本人 —— 按调用者反查角色绑定表(roleSlotOfAgent)得到的角色 === 本档 coordinator;
         *   ② 调度者本人 —— 没有父会话的根会话(派角色、改项目激活态的就是它)。
         * 拒绝分支连 slot.arbitration 都不读改,避免"拒绝了但已经动了"。
         */
        const arbCallerRole = boundInfo ? String(boundInfo.role || '') : ''
        const arbIsCoordinator = arbCallerRole !== '' && arbCallerRole === String(profile.coordinator)
        const arbIsScheduler = !!caller && parentSessionOf(caller) === ''
        if (!arbIsCoordinator && !arbIsScheduler) {
          return {
            status: 'unauthorized',
            pending: (slot.arbitration || []).length,
            note: `不允许:你${arbCallerRole ? `(@${arbCallerRole})` : '(未登记为本项目角色)'}没有权限取走仲裁队列 —— `
              + `队列里是**被判熔断/死锁拦下、正文一条都没投出去**的消息全文,而本动作会**清空**它。`
              + `只允许两类调用者:① 协调者 @${profile.coordinator} **本人**;② **调度者**(派角色的根会话,即主会话)。`
              + `你是角色子会话时,请用 relay action=status 看「待仲裁:N 条」并把这件事报给协调者/主会话,不要自己取。`,
            roleView: roleBindings(slot),
            profileView: profileView(),
          }
        }
        const taken = (slot.arbitration || []).slice()
        slot.arbitration = []
        syncSlot(slot, coord)
        saveStore()
        return { status: 'ok', events: taken, count: taken.length }
      }

      if (action === 'release') {
        const role = a.from
        if (!role) return { status: 'invalid', note: 'release 需要 from=<角色>(要释放谁的等待关系)', profileView: profileView() }
        /**
         * release 若**没有任何归属校验**, 参数里给个 from 就改等待图,
         * 于是任意一个角色子会话(甚至只是想"清理一下"的旁观者)都能把别人的等待关系删掉,
         * 而等待图是死锁检测与"谁在等谁"的唯一真相来源(等待被无声删掉 = 那条回覆永远不来,
         * 发起方会一直等)。实测:换过会话之后旧绑定还在表里,新会话可以直接 release 掉任意角色。
         *
         * 现在只放行两类调用者(两者都不满足就 unauthorized,且不碰任何状态):
         *   1) from 本人:按调用者 agent 反查角色绑定表(roleSlotOfAgent,全项目扫)得到的就是 from;
         *   2) 调度者本人:没有父会话的根会话(它才是派角色、能改这个项目的人)。
         * 注意**先校验后改动**:unauthorized 分支连 coord.waiting 都不读改,避免"拒绝了但已经动了"。
         */
        const callerRole = boundInfo ? String(boundInfo.role || '') : ''
        const callerIsScheduler = !!caller && parentSessionOf(caller) === ''
        if (callerRole !== role && !callerIsScheduler) {
          return {
            status: 'unauthorized',
            note: `不允许:你${callerRole ? `(@${callerRole})` : '(未登记为本项目角色)'}没有权限释放 @${role} 的等待关系 —— `
              + '等待图直接决定死锁检测与回覆闭合,只允许两类调用者改写:'
              + `① @${role} **本人**(用自己的角色身份调用 relay action=release from=${role});`
              + `② **调度者**(派角色的根会话,即主会话)。`
              + `你是角色子会话时,请把"要释放谁"交给主会话;若这条等待确实是你的,把 from 改成你自己的角色重试。`,
            waitingView: (() => { const w = {}; for (const k of Object.keys(coord.waiting)) w[k] = coord.waiting[k]; return w })(),
            profileView: profileView(),
          }
        }
        const had = coord.waiting[role] || ''
        coord.release(role)
        syncSlot(slot, coord)
        saveStore()
        const waitingView = {}
        for (const k of Object.keys(coord.waiting)) waitingView[k] = coord.waiting[k]
        return {
          status: had ? 'released' : 'noop',
          note: had ? `已释放 @${role} → @${had} 的等待关系` : `@${role} 当前没有等待关系(无需释放)`,
          waitingView, profileView: profileView(),
        }
      }

      if (action === 'profile') {
        const list = profileIds.map((id) => ({ id, label: table[id].label, roles: table[id].roles.map((r) => r.id), desc: table[id].desc }))
        if (!a.profile) {
          return { status: 'ok', profileView: Object.assign(profileView(), { available: list }), note: `当前 profile=${profile.id};传 profile=<id> 可切换(写进插件状态,按项目记忆)` }
        }
        if (!table[a.profile]) {
          return { status: 'invalid', profileView: Object.assign(profileView(), { available: list }), note: `未知 profile:${a.profile};可用:${profileIds.join(', ')}` }
        }
        setActiveProfile(root, String(a.profile))
        const next = table[a.profile]
        return {
          status: 'switched',
          profileView: Object.assign({}, profileView(), {
            current: next.id, roles: next.roles.map((r) => r.id), coordinator: next.coordinator,
            limit: next.relay.limit, windowMs: next.relay.windowMs, autoDeliver: next.relay.autoDeliver, available: list,
          }),
          note: `已把项目 ${root} 切到 profile=${next.id}(${next.label});等待图/熔断计数/台账按 profile 隔离,旧 profile 的状态原样保留`,
        }
      }

      if (action === 'ledger') {
        /**
         * 渲染台账前也扫一次超时 —— 否则"还在等 @x"这种行会永久留在台账里,
         * 而台账是给人看的审计投影(与 status 同一条懒触发路径的漏口)。
         */
        const expiredWaits = sweepExpiredWaits(slot, coord, profile)
        if (expiredWaits.length > 0) { syncSlot(slot, coord); saveStore() }
        const text = renderLedger(slot.ledger || [], {
          project: path.basename(String(root || '')),
          profile: profile.id, stateFile: profile.state.file,
          limit: coord.limit, windowMs: coord.windowMs,
        })
        const wrote = await tryWriteLedger(root, ledgerRel, text)
        const out = {
          status: 'ok',
          // 清扫若释放了等待关系,这里如实带上(render 会渲染成一行)。
          expiredWaits,
          ledgerStatus: wrote.ok
            ? `已由插件直接写入 ${ledgerPath}`
            : `插件直写未成功(${wrote.reason}),请在 BEGIN/END 之间取全文用 write 落盘`,
          profileView: profileView(),
        }
        // 不要给字段赋 undefined:DSH 对工具返回值做"无损 JSON"校验,
        // 含 undefined 的对象会让整次调用失败(invalid output: value is not lossless JSON)。
        if (!wrote.ok) {
          out.ledgerText = text
          out.persistInstruction = `主会话:把 ${LEDGER_BEGIN} 与 ${LEDGER_END} 之间的全文用 write 写入 ${ledgerPath}`
        }
        return out
      }

      // ── send ─────────────────────────────────────────────────────────────
      let from = a.from
      let to = a.to
      let msg = a.msg
      let mark = null
      /**
       * 一条回覆里出现**多个** `@relay` 时必须出声。
       * `extractRelayMarks` 只取最后一条时,这里拿到的就是那一条 —— 前几条被静默丢弃,
       * 回执却写"标记 @arch: …",调用者以为两个人都收到了。行为本身保守不改(一次 send 只投
       * 一个目标,这是既有的"单等待位"设计,不属于本次范围),但**如实说出来**:
       * `multiMark` 字段 + 回执里明确"只转发了这一条,前 N 条没转发",并给出逐条补发的动作。
       * 想一次招呼多人时,正确做法就是逐条 send —— 回执现在直接教这一步。
       * 全部标记由 `extractRelayMarksAll` 扫出来(`extractRelayMarks` 的返回形状不能动,
       * selftest 1.1/1.4b/1.5/1.6 逐字比它)。
       */
      let multiMark = null
      if (typeof a.answer === 'string' && a.answer !== '') {
        const allMarks = extractRelayMarksAll(a.answer)
        mark = extractRelayMarks(a.answer)
        if (!mark) return { status: 'no_mark', note: '回答末行没有合法的 @relay:<角色> 标记,本次不发起互呼' }
        to = mark.to
        msg = mark.msg
        if (Array.isArray(allMarks) && allMarks.length > 1) {
          const dropped = allMarks.slice(0, -1)
          multiMark = {
            detected: allMarks.map((x) => x.to),
            forwarded: mark.to,
            dropped: dropped.map((x) => x.to),
          }
        }
      }
      if (!from && caller) from = reverseLookup(slot, caller)
      if (!from && caller && parentSessionOf(caller) === '') from = profile.coordinator
      if (!from || !to || !msg) {
        return {
          status: 'invalid',
          note: 'send 需要 from/to/msg(或提供可解析的 answer);from 省略时按调用者 agent 的登记身份推断',
          roleView: roleBindings(slot),
          profileView: profileView(),
        }
      }
      /**
       * 自报 from 不能冒名。
       * from 若只做"角色名在不在本档"的解析、不与调用者身份比对 —— 实测证据:
       * 让 @be 的会话发一条 `from=pm to=qa`,结果是 `status=done`、`via=scheduler-proxy`:
       * 等待图被写成 `{"pm":"qa"}`(pm 从未发起过),这次互呼消耗的是 **pm 的熔断额度**,
       * 而 pm 之后所有互呼都撞上"忙等"走并线降级 —— 看到的现象是"pm 莫名其妙处于忙等"。
       * 这**不是**理论攻击面:插件自己的 nextActions 就在教模型显式写 from,而"抄错对象"是标准失误。
       * 现在:显式 from 必须等于**调用者反查出的角色**;反查不出角色的调用者
       * (根会话/调度者、以及未登记进任何槽的子会话)保持原样放行 —— 它本来就没有角色身份,
       * 代角色发消息正是它的正常职责(smoke 12.3 那条 from=be 的回覆就走这一类)。
       * 只查"显式传入"的 from:缺省值本来就是本函数反查出来的,不存在冒名。
       */
      const explicitFrom = (a.from === undefined || a.from === null) ? '' : String(a.from)
      if (explicitFrom !== '') {
        let callerRoleId = caller ? reverseLookup(slot, caller) : ''
        if (callerRoleId === '' && caller) {
          // 兜底:反查要跨档扫(角色子会话的 root 归一化/多 root 并存时,只在当前槽里查会查空)
          const anySlot = roleSlotOfAgent(caller)
          if (anySlot && String(anySlot.profileId) === String(profile.id)) callerRoleId = String(anySlot.role || '')
        }
        if (callerRoleId !== '' && explicitFrom !== callerRoleId) {
          return {
            status: 'forged_from',
            forgedFrom: true,
            callerRole: callerRoleId,
            declaredFrom: explicitFrom,
            note: `拒绝:你的会话登记为 @${callerRoleId},但本次互呼显式写了 from=${explicitFrom} —— `
              + 'from 决定"谁在等谁"与熔断额度记在谁头上,冒名会把等待图写成别人在忙等、并花掉别人的额度。',
            nextActions: [
              `用你自己的角色重发:relay action=send from=${callerRoleId} to=${to} msg=<原文>`,
              `确实需要代 @${explicitFrom} 发起(例如转述用户原话):交给**调度者/主会话**调用 —— 它没有角色身份,可以显式写 from`,
            ],
            roleView: roleBindings(slot),
            profileView: profileView(),
          }
        }
      }
      /**
       * 角色名层面的自环没人拦。
       * `planDelivery` 里那条"目标就是发起者本人"比的是 **caller 的 agent id 与 targetId**,
       * 而 `relay action=send from=pm to=pm` 会把 `markWait('pm','pm')` 照常写下去 ——
       * 该角色此后所有互呼都走"并线"降级分支、等待图不再更新,回执还会写出
       * "@pm 已在等待 @pm" 这种读不通的话。可恢复(`release from=pm` 实测有效),
       * 但没人会想到去释放一个"自己等自己"的关系。
       */
      if (String(from) === String(to)) {
        return {
          status: 'invalid',
          selfLoop: true,
          note: `from 与 to 都是 @${from}:自环互呼不会产生等待关系,也不该占用熔断额度。请把 to 改成真正要提问的角色`,
          nextActions: [`改成真正的目标角色重发,例如 relay action=send from=${from} to=<别的角色> msg="…"`],
          profileView: profileView(),
        }
      }
      const fromRole = roleOf(profile, from)
      const toRole = roleOf(profile, to)
      if (!fromRole || !toRole) {
        // "用 action=profile 切换,或换角色"这句**没有终止条件** ——
        // 照做切档后重发还是同一句(实测 standard → lean3,@dba 两档都不存在)。
        // 现在点名:哪几档含该角色;一档都不含时明说"没有任何一档",并给自建档的出路。
        const badRole = !fromRole ? from : to
        const allProfiles = profileTable()
        const holders = Object.keys(allProfiles).filter((id) => roleOf(allProfiles[id], badRole))
        return {
          status: 'role_not_in_profile',
          available: Object.keys(allProfiles),
          profilesWithRole: holders,
          note: `profile=${profile.id} 的角色集是 ${profile.roles.map((r) => r.id).join('/')},不含 @${badRole};`
            + (holders.length > 0
              ? `**含 @${badRole} 的档:${holders.join('/')}** —— 用 relay action=profile profile=${holders[0]} 切换后重发`
              : `当前**没有任何一档含 @${badRole}**(可用档:${Object.keys(allProfiles).join('/')})—— 请换角色,或往 ~/.dsh/dev-workflow/profiles.json 里加一档`),
          profileView: profileView(),
        }
      }

      // ── 等待关系维护(等待关系必须能进能出)─────────────────────────
      // waiting 若只能建立:建立后该角色再调 relay 会被忙等守卫拦下,
      // 而 release 只在 status==='done' 时生效 → 等待关系永远无法释放。
      // 更糟的是插件自己 nextActions 给的那条"收到回覆后 from=<对方> to=<原发起方>"
      // 指令:waiting[A]=B 时 B→A 走 checkDeadlock 必然成环 → 每次回覆都熔断。
      // 三条释放路径(都不改动 RelayCoordinator,原有语义逐条保留):
      //   1) 回复闭合:B→A,且 A 正在等 B
      //   2) 超时释放:等待超过 profile.relay.waitTimeoutMs(默认 15 分钟)
      //   3) 显式释放:relay action=release from=<角色>
      const expired = sweepExpiredWaits(slot, coord, profile)
      let replyClosed = ''
      /**
       * 闭合条件不能多一条 `waiting[from] === undefined` —— "回覆者自己没在等别人"。
       * 于是 A→B 之后 B 又问了 C,当 B 回来答复 A 时 **A 的等待不会被闭合**:
       * 一直挂到 15 分钟懒超时(而且只有 A 再调一次 relay 才会触发),期间 A 的每次互呼都只走"并线",
       * status 的等待图与事实不符。B 在等谁是 B 自己的事,和"B 答复了 A"没有关系。
       */
      if (profile.relay.replyClosesWait !== false && coord.waiting[to] === from) {
        replyClosed = to
        coord.release(to)
        pushLedger(slot, {
          ts: makeTS(), from: to, to: from, summary: '(回复闭合)',
          status: '↩️ 等待闭合', note: `@${to} 等到 @${from} 的回覆,等待关系已释放`,
        })
      }

      // 原用 path.basename(root) 当项目键 —— D:\a\svc 与 E:\b\svc 会共用 "svc",
      // 互相消耗熔断额度(实测 @arch→@pm[dsh-workspace] 已贴 4/5 上限)。改用无歧义的项目键。
      // 标签(写进台账/仲裁事件给人看)与分桶键彻底分离 —— 分桶**永远**只认 profile@root,
      // 显式传 project 也换不掉桶(传了它就另开一个桶,上限直接翻倍)。
      const bucketKey = stateKey(profile.id, root) || 'no-project'
      const projectKey = a.project ? String(a.project) : bucketKey
      const dupKey = `${profile.id}|${stateKey(profile.id, root)}|${from}|${to}|${hashText(String(msg))}`
      const dup = dedupeHit(profile.id, dupKey, Date.now())
      /**
       * 60 秒去重若**没有出口**, 参数表里既没有 force 也没有 skipDedupe,
       * 想重发同一句话只能靠"改一个字符"绕过 hash(实测:@pm 把同一段需求重发一次被去重,
       * 只能改成"需求(重发)"才能再发出去)。现在给一个显式开关 skipDedupe(与 noDeliver 同写法:
       * boolTrue 兼容 "true"/1),并在去重回执里点名副作用的动作。
       */
      if (dup && !boolTrue(a.noDeliver) && !boolTrue(a.skipDedupe)) {
        activity.duplicates += 1
        bumpStat(slot, 'duplicates')
        return {
          status: 'duplicate',
          duplicate: true,
          coordination: 'proceed',
          delivery: { ok: true, messageId: dup.messageId, via: 'dedupe', targetId: String(slot.roleAgents[to] || '') },
          note: `${DEDUPE_MS / 1000} 秒内已投递过同一互呼,本次未重复发送;要**强制重发**请带 skipDedupe:true,或改 msg 内容`,
          nextActions: [
            '确实要重发同一句话:relay action=send 带上 skipDedupe:true(内容一字不改也照发)',
            '只是想确认对方收没收到:relay action=status 看等待图与投递统计,不必重发',
          ],
          profileView: profileView(),
        }
      }

      const autoDeliver = profile.relay.autoDeliver !== false && !boolTrue(a.noDeliver)
      const plans = []
      const writeBack = (role, text) => {
        if (!autoDeliver) { plans.push({ role, text, ok: true, plan: null }); return true }
        /**
         * MAIN_SESSION_ROLE 是 relay 侧的哨兵角色名 —— 熔断/死锁升级事件
         * 在"协调者就是本次互呼的一方"时改投**派它的主会话**(parentSessionOf(caller))。
         * 不能走 planDelivery:那条路会先命中 slot.roleAgents 里协调者自己的绑定,
         * 于是又变回"投给自己"(被 '目标就是发起者本人,跳过投递' 拦下),升级照样丢。
         */
        if (role === MAIN_SESSION_ROLE) {
          const parentId = parentSessionOf(caller)
          const parentAg = parentId ? agentOf(parentId) : undefined
          if (!parentId || parentAg === undefined) {
            plans.push({
              role, text, ok: false,
              reason: parentId ? '主会话(父会话)已结束,拿不到投递身份' : '发起方自己就是根会话,没有可投的父会话',
            })
            return false
          }
          plans.push({
            role, text, ok: true,
            plan: { ok: true, sender: caller, targetId: parentId, via: 'to-parent', role, text, callerId: caller ? String(caller.id) : '' },
          })
          return true
        }
        const p = planDelivery({ role, text, caller, slot, profile, explicitTarget: a.targetAgentId, primaryRole: to })
        if (!p.ok) {
          // 失败也要**带全字段**往上走。只留 {ok:false, reason},
          // 于是"绑定属于另一个父会话"这条可自愈的成因被压成一句泛泛的"无可用投递身份"。
          plans.push({
            role, text, ok: false, reason: p.reason,
            staleBinding: p.staleBinding === true, targetId: p.targetId || '',
            owner: p.owner || '', expectedScheduler: p.expectedScheduler || '',
          })
          return false
        }
        plans.push({ role, text, ok: true, plan: p })
        return true
      }

      // 把协调者一并交给 tryRelay —— 死锁/超限升级时要主动推给它,
      // 而不是只丢进一个没人通知、谁都能取走的仲裁队列。
      // 再补一份**角色清单** —— 协调者恰好是本次互呼的一方时,
      // escalateTo 需要能换一个第三方角色投递(没有这份清单,升级只能被丢掉)。
      const res = coord.tryRelay(from, to, String(msg), projectKey, writeBack, {
        coordinator: profile.coordinator, bucket: bucketKey,
        roles: profile.roles.map((r) => r.id),
      })
      // 台账:成功互呼与编排异常都要记行。只记异常的台账不算台账,
      // 而且投递结果需要挂到**本次**这一行上(早期版本会错挂到上一行)。
      let rowRef = null
      if (res.ledger) { rowRef = res.ledger; pushLedger(slot, rowRef) }
      else if (res.status === 'done') {
        rowRef = { ts: makeTS(), from, to, summary: String(msg), status: '✅ 已转发', note: '等待回覆' }
        pushLedger(slot, rowRef)
      }

      /**
       * 目标绑定归属不对 —— 从普通"无可用投递身份"里**分出来**。
       *
       * 这条路径的现场:绑定属于别的父会话,
       * 投递必然撞 UNAUTHORIZED;记成普通"投递失败",绑定继续留在表里,
       * 三次之后正文改走"并线",直到熔断 —— 内容再没送达过,而**台账里连成因都看不到**。
       * 现在:就地清理失效绑定、计入"失效重派"、补一条台账行、回执给可照做的补救。
       */
      const stalePlan = plans.find((p) => p.role === to && p.ok === false && p.staleBinding === true)
      if (stalePlan) {
        delete slot.roleAgents[to]
        bumpStat(slot, 'staleRebinds')
        activity.staleRebinds += 1
        bumpStat(slot, 'lastError', `投递 @${to} 失败:绑定属于另一个父会话(${stalePlan.owner || '未知'}),已清理,请 relay_spawn 重派`)
        staleRebindLog.push({
          role: to, oldAgentId: stalePlan.targetId,
          reason: `属于另一个父会话 ${stalePlan.owner || '(未知)'}(期望 ${stalePlan.expectedScheduler || '(未知)'})`, at: makeTS(),
        })
        if (staleRebindLog.length > 20) staleRebindLog.shift()
        if (rowRef) {
          rowRef.status = '🔁 绑定失效-已清理'
          rowRef.note = `${stalePlan.reason};owner=${stalePlan.owner || '(未知)'} 期望=${stalePlan.expectedScheduler || '(未知)'};已清理,请 relay_spawn 重派`
          rowRef.delivery = '✗ stale-binding'
        } else {
          // 这条路径若**不记账**,则 审计件里看不到"为什么没送到"
          rowRef = { ts: makeTS(), from, to, summary: String(msg), status: '🔁 绑定失效-已清理', note: `${stalePlan.reason};已清理,请 relay_spawn 重派`, delivery: '✗ stale-binding' }
          pushLedger(slot, rowRef)
        }
      }
      if (res.arbitration) pushArbitration(slot, res.arbitration)
      if (res.merged === true) { activity.busyMerged += 1; bumpStat(slot, 'busyMerged') }
      if (boolTrue(a.release) && res.status === 'done') coord.release(from)
      activity.relayCalls += 1
      bumpStat(slot, 'relayCalls')
      activity.lastAt = makeTS()
      activity.lastRelayAt = makeTS()
      store.lifetime.relayCalls += 1

      const signal = realSignal(exec && exec.signal)
      const notices = []
      let delivery = null

      if (res.status === 'done') {
        const forward = plans.find((p) => p.ok && p.plan && p.plan.role === to)
        if (!autoDeliver) {
          delivery = { ok: false, via: 'off', reason: 'noDeliver=true:只做编排判定', targetId: String(slot.roleAgents[to] || a.targetAgentId || '') }
          // 台账是审计件,必须如实:noDeliver 下插件没有投递,不能写"已转发"。
          if (rowRef) {
            rowRef.status = '✅ 已判定'
            rowRef.note = 'noDeliver=true:投递由模型执行'
            rowRef.delivery = '— off'
          }
        } else if (!forward) {
          delivery = { ok: false, via: 'plan', reason: '目标角色无可用投递身份' }
        } else {
          const out = await deliverPlan(forward.plan, signal)
          delivery = out
          if (out.ok) {
            activity.deliveries += 1
            bumpStat(slot, 'deliveries')
            activity.lastDeliveryAt = makeTS()
            store.lifetime.deliveries += 1
            dedupeSet(dupKey, out.messageId)
            if (rowRef) { rowRef.status = '✅ 已投递'; rowRef.delivery = `✓ ${out.via}` }
          } else {
            activity.deliveryFailures += 1
            bumpStat(slot, 'deliveryFailures')
            store.lifetime.deliveryFailures += 1
            coord.release(from)
            if (out.staleBinding) {
              // 绑定归属不对 = 这条绑定对本调度者已经没用了。
              // 让它继续躺在表里,就 每次投递都撞一次 UNAUTHORIZED,重试还会被"并线"吞掉。
              // 现在:清理绑定 + 计入"失效重派"(与 spawn 路径同一套计数与台账)+ 回执给出补救指令。
              delete slot.roleAgents[to]
              bumpStat(slot, 'staleRebinds')
              activity.staleRebinds += 1
              bumpStat(slot, 'lastError', `投递 @${to} 失败:绑定属于另一个父会话(${out.owner || '未知'}),已清理,请 relay_spawn 重派`)
              staleRebindLog.push({
                role: to, oldAgentId: out.targetId,
                reason: `属于另一个父会话 ${out.owner || '(未知)'}(期望 ${out.expectedScheduler || '(未知)'})`, at: makeTS(),
              })
              if (staleRebindLog.length > 20) staleRebindLog.shift()
              if (rowRef) {
                rowRef.status = '🔁 绑定失效-已清理'
                rowRef.note = `${out.reason};owner=${out.owner || '(未知)'} 期望=${out.expectedScheduler || '(未知)'}`
                rowRef.delivery = '✗ stale-binding'
              }
            } else {
              bumpStat(slot, 'lastError', `投递 @${to} 失败:${out.reason}${out.code ? ` [${out.code}]` : ''}`)
              if (rowRef) {
                rowRef.status = '⚠️ 投递失败'
                rowRef.note = `${out.reason}${out.code ? ` [${out.code}]` : ''}`
                rowRef.delivery = `✗ ${out.via || '-'}`
              }
            }
          }
        }
        // 熔断/忙等类通知:投给发起方(跳过"自己给自己发")
        for (const p of plans) {
          if (p.role === to) continue
          if (!p.ok || !p.plan) { notices.push({ role: p.role, ok: false, reason: p.reason || (p.plan === null ? 'noDeliver=true:未投递' : '未规划投递') }); continue }
          if (p.plan.callerId === p.plan.targetId) { notices.push({ role: p.role, ok: false, reason: '目标是发起者本人,通知已在工具结果里' }); continue }
          const n = await deliverPlan(p.plan, signal)
          notices.push({ role: p.role, ok: n.ok, reason: n.reason || '' })
        }
      } else if (res.status !== 'done' && plans.length > 0) {
        for (const p of plans) {
          if (!p.ok || !p.plan) { notices.push({ role: p.role, ok: false, reason: p.reason || (p.plan === null ? 'noDeliver=true:未投递' : '未规划投递') }); continue }
          if (p.plan.callerId === p.plan.targetId) { notices.push({ role: p.role, ok: false, reason: '目标是发起者本人,通知已在工具结果里' }); continue }
          const n = await deliverPlan(p.plan, signal)
          notices.push({ role: p.role, ok: n.ok, reason: n.reason || '' })
        }
      }

      syncSlot(slot, coord)
      saveStore()

      const out = { status: res.status, note: res.note, coordination: 'halted', attempts: res.attempts, profileView: profileView() }
      if (mark) out.mark = mark
      /**
       * answer 末行有多个 `@relay` 时,**如实回报只转发了哪一条**。
       * 这里若什么都不说, 回执里只有 `mark: {to:"arch"}` 与"已转发",写了两个标记的人
       * 会以为两个人都收到了。字段名与措辞都点明"另一条没转发",并给出补发的下一步。
       */
      if (multiMark) {
        out.multiMark = multiMark
        out.markDroppedNote = `⚠️ answer 末行有 ${multiMark.detected.length} 条 @relay 标记(${multiMark.detected.map((x) => `@${x}`).join('/')}),本次**只转发了最后一条 @${multiMark.forwarded}**;`
          + `${multiMark.dropped.map((x) => `@${x}`).join('/')} 这条**没有转发** —— 一次 send 只投一个目标。`
      }
      if (replyClosed) out.replyClosed = replyClosed
      if (expired.length > 0) out.expiredWaits = expired.map((e) => `@${e.role}→@${e.to}(${e.ageSec}s 未回覆)`)
      out.delivery = delivery
      if (notices.length > 0) out.notices = notices
      out.ledgerRows = (slot.ledger || []).length
      out.ledgerPending = (slot.ledger || []).length
      out.ledgerPath = ledgerPath

      if (stalePlan) {
        // 把它排在所有分支之前 —— 否则会落到 no_reply 分支,
        // 说"目标 @be 无可用投递身份,先用 relay_spawn 派出",与真正的成因(归属不对)不符。
        /**
         * 上一条只改了渲染文案,**status 仍然是 no_reply**(它来自 tryRelay 的
         * 转发失败返回值)。只读 status 字段的调用方(以及按 status 分支的上层编排)于是把
         * "绑定归属不对"读成"对方不在" —— 两种成因的补救动作完全不同:前者要 relay_spawn 重派,
         * 后者要 relay_spawn 首派,而误读者会去查"对方为什么消失了"。现在给独立状态
         * stale_binding,不再与 no_reply 混用(20.21 那条断言覆盖的是**清理之后**的真实 no_reply,不受影响)。
         */
        out.status = 'stale_binding'
        out.coordination = 'halted'
        out.delivery = { ok: false, via: 'stale-binding', staleBinding: true, targetId: stalePlan.targetId, role: to }
        out.staleBinding = {
          role: to, oldAgentId: stalePlan.targetId,
          owner: stalePlan.owner || '', expectedScheduler: stalePlan.expectedScheduler || '',
        }
        out.abort = `目标 @${to} 的绑定属于**另一个父会话**(${stalePlan.owner || '未知'}),不是本流程的调度者(${stalePlan.expectedScheduler || '未知'})—— 正文**没有送达**。`
        out.nextActions = [
          '这次失败**不是**"对方不在",而是绑定归属不对:换过会话 / resume / fork / 重启都会如此。失效绑定已自动清理。',
          `照做即可:relay_spawn role=${to}(派出新实例并登记新绑定)→ 再**重发本次互呼**(relay action=send from=${from} to=${to} msg=<原文>)`,
          '不要改用 send_message:邻居约束与冷恢复限制相同,同样会失败',
        ]
      } else if (res.status === 'done' && !autoDeliver) {
        // noDeliver=true:只做编排判定、投递交给模型
        out.coordination = 'proceed'
        const targetId = String(slot.roleAgents[to] || a.targetAgentId || '')
        const forwardPlan = plans.find((p) => p.role === to)
        if (targetId) {
          out.deliver = { targetAgentId: targetId, sessionId: targetId, text: forwardPlan ? forwardPlan.text : '' }
          out.nextActions = [
            `用 send_message 向 ${targetId} 投递互呼正文`,
            // 这句只写 from=${to} 是不够的 —— 角色照抄就成了冒名(现在会被拒)。
            // 现在点名"由谁写 from":回覆者本人用自己的角色;调度者代发时 from 可省(插件按调用者反查)。
            `收到回覆后闭合等待关系:由 @${to} **本人**调用 relay action=send from=${to} to=${from} msg=<回覆>;调度者代发时省略 from(插件按调用者反查角色)`,
          ]
        } else {
          out.nextActions = [`目标 @${to} 没有已登记的 agent 会话,先用 relay_spawn 派出`]
        }
      } else if (res.status === 'done' && delivery && delivery.ok) {
        out.coordination = 'proceed'
        out.nextActions = [
          `已投递给 @${to}(${delivery.via}),你无需再调 send_message`,
          `收到回覆后闭合等待关系:由 @${to} **本人**调用 relay action=send from=${to} to=${from} msg=<回覆>(同样会自动投递);调度者代发时省略 from`,
          // 多标记时补一条**可照做**的动作,否则"另一条没转发"只是一句坏消息
          ...(multiMark ? [`补发被漏掉的那一条:relay action=send from=${from} to=${multiMark.dropped[0]} msg=<该角色的原文>`] : []),
        ]
      } else if (res.status === 'done' && delivery && delivery.staleBinding) {
        // 归属错误是**可自愈**的 —— 失效绑定已被清理,重派一次即可,别让流程卡死。
        // 与普通投递失败分开报:成因、后果、补救动作各不相同。
        out.coordination = 'halted'
        out.staleBinding = {
          role: to, oldAgentId: delivery.targetId,
          owner: delivery.owner || '', expectedScheduler: delivery.expectedScheduler || '',
        }
        out.abort = `目标 @${to} 的绑定属于**另一个父会话**(${delivery.owner || '未知'}),不是本流程的调度者(${delivery.expectedScheduler || '未知'})—— 正文**没有送达**。`
        out.nextActions = [
          '这次失败**不是**"对方不在",而是绑定归属不对:换过会话 / resume / fork / 重启都会如此。失效绑定已自动清理。',
          `照做即可:relay_spawn role=${to}(派出新实例并登记新绑定)→ 再**重发本次互呼**(relay action=send from=${from} to=${to} msg=<原文>)`,
          '不要改用 send_message:邻居约束与冷恢复限制相同,同样会失败',
        ]
      } else if (res.status === 'done' && delivery && !delivery.ok) {
        out.coordination = 'halted'
        out.abort = `目标 @${to} 投递失败:${delivery.reason}${delivery.code ? ` [${delivery.code}]` : ''}`
        out.nextActions = [
          `若提示 NOT_RESUMABLE/无会话:该角色的会话已经不在了 —— 直接 relay_spawn role=${to}(会自动重派并把绑定换成新 id),再重发本次互呼`,
          `若提示 UNAUTHORIZED(belongs to another parent session):绑定属于**另一个父会话**(换过会话 / 重启 / resume 都会如此)。` +
            `重派即可:relay_spawn role=${to} —— 该绑定会被自动判定失效并就地替换,不需要你手工清理`,
          '不要改用 send_message:邻居约束与冷恢复限制相同,同样会失败',
        ]
      } else if (res.status === 'busy') {
        out.coordination = 'proceed'
        out.abort = ''
        /**
         * 这里不能**无条件**写"正文已**并线送达** @${to},你不必重发"。
         * 但自动投递模式下 tryRelay 的 busy 分支里 `deliver()` 只做**规划**(planDelivery),
         * 真正的 sendMessage 发生在本函数随后的 plans/notices 循环里 —— 于是"规划过、真实发送失败"
         * (目标会话刚结束 / UNAUTHORIZED / 冷恢复拒绝 / 拿不到真 signal)时:
         * 台账那格已按真实结果分记,回执 note 与 nextActions 却仍劝人"不必重发",消息就此静默丢失。
         * 口径一致:优先取**真实投递结果**(notices 里 to 那一格),拿不到才回落到规划结果 res.delivered。
         */
        const realBusy = notices.filter((n) => n.role === to)[0] || null
        const reallySent = realBusy ? realBusy.ok === true : res.delivered === true
        if (!reallySent && rowRef) {
          // 审计件与回执同口径:并线失败就是失败(这一格若恒为"🔀 并线送达")
          rowRef.status = '⚠️ 并线失败'
          rowRef.note = `已在等 @${res.busyOn || '?'};规划通过但真实投递失败${realBusy && realBusy.reason ? `(${realBusy.reason})` : ''},等待图未改写`
        }
        out.note = reallySent
          ? res.note
          : `@${from} 已在等待 @${res.busyOn || '?'};⚠️ 本次发给 @${to} 的正文**未送达**${realBusy && realBusy.reason ? `(${realBusy.reason})` : ''},请重发(等待关系未改写)`
        out.nextActions = reallySent
          ? [
            `正文已**并线送达** @${to}(等待图未改写),你不必重发`,
            `你仍有一个未闭合的等待(等 @${res.busyOn || '?'});收到它的回覆后用 relay action=send from=<对方> to=${from} 闭合`,
            '若那个等待其实已经作废(对方早回过、或已不在),用 relay action=release from=<你的角色> 手动释放,否则会一直占着这一个等待位',
          ]
          : [
            `⚠️ 本次发给 @${to} 的正文**未送达**(规划通过、真实发送失败${realBusy && realBusy.reason ? `:${realBusy.reason}` : ''})—— 请**重发**:relay action=send from=${from} to=${to} msg=<原文>`,
            `你仍有一个未闭合的等待(等 @${res.busyOn || '?'});收到它的回覆后用 relay action=send from=<对方> to=${from} 闭合`,
            '若那个等待其实已经作废(对方早回过、或已不在),用 relay action=release from=<你的角色> 手动释放,否则会一直占着这一个等待位',
          ]
      } else if (res.status === 'deadlock') {
        // 只说"等待图已拆,请调度者裁决" —— 没有一个具体动作。
        // 发起方读到的只有"禁止投递",既不知道等待已经解开(可以重投),也不知道正文在哪、怎么取。
        out.abort = `死锁环:本次正文**未投出**(已扣进仲裁队列),环上的等待关系已全部拆掉,你不必再等 @${to} 的回覆。`
        out.nextActions = [
          '① 等待关系**已被拆环释放**(不是"还在等"),可以直接重投本次互呼;重投前先看一眼 status 的等待图,别又接成新环',
          '② 本次正文没丢:用 relay action=arbitrate 取回被扣下的全文与裁决事件(events[].reason=deadlock,events[].msg 就是原文)',
          `③ 需要人工裁决时找协调者 @${profile.coordinator}${res.escalatedTo ? `(升级事件已推给 @${res.escalatedTo})` : '(⚠️ 升级事件**没能推出**,请直接找它,别只等队列)'}`,
          '④ 同一对角色反复成环 = 两边在互相追问同一件事:回到主任务,由协调者收敛需求后再重发',
        ]
      } else if (res.status === 'limit') {
        // 这一格不能是**死路** —— 只给"禁止投递",
        // 重投同一对角色仍然 limit(额度按"角色对+项目"计、与 msg 内容无关),该对角色在整个窗口内不可用,
        // 而正文停在仲裁队列里,回执里没有一句话告诉人怎么取回。四条 nextActions 逐条给出出路。
        const marks = coord.relayTs[`${from}\u0000${to}\u0000${bucketKey}`] || []
        const oldest = marks.length > 0 ? Math.min.apply(null, marks) : 0
        const waitSec = oldest > 0
          ? Math.max(1, Math.ceil((oldest + coord.windowMs - Date.now()) / 1000))
          : Math.ceil(coord.windowMs / 1000)
        out.abort = `滑动窗口熔断:同一对角色在该项目 ${Math.round(coord.windowMs / 60000)} 分钟内已达 ${coord.limit} 次。本次**未投出**(正文已扣进仲裁队列)。`
        out.nextActions = [
          `① 本窗口内**不要再重投 @${from}→@${to}**:额度按"角色对+项目"计、与 msg 内容无关,重投还是这条 limit`,
          '② 本次正文没丢:用 relay action=arbitrate 取回被扣下的全文(events[].msg 就是原文),再决定重投 / 改需求 / 落盘',
          `③ 出路二选一:等满窗口(**约 ${waitSec} 秒**后这一对角色才恢复),或**改道第三方角色**(把问题发给既没在等、也没熔断的角色:relay action=send from=${from} to=<别的角色>)`,
          `④ 同一对角色 10 分钟互问 ${coord.limit} 次属于流程性反复,请让协调者 @${profile.coordinator} 收敛需求再继续${res.escalatedTo ? `(升级事件已推给 @${res.escalatedTo})` : '(⚠️ 升级事件**没能推出**,请直接找它,别只等队列)'}`,
        ]
      } else if (res.status === 'no_reply') out.abort = `目标 @${to} 无可用投递身份(${plans.map((p) => p.reason).filter(Boolean).join(';') || '未登记'}),先用 relay_spawn 派出。`
      return out
    },
  }

  function reverseLookup(slot, agent) {
    if (!agent || !slot || !slot.roleAgents) return ''
    const id = String(agent.id || '')
    for (const role of Object.keys(slot.roleAgents)) if (String(slot.roleAgents[role]) === id) return role
    return ''
  }

  function roleBindings(slot) {
    const out = {}
    for (const k of Object.keys(slot.roleAgents || {})) {
      const id = slot.roleAgents[k]
      out[k] = { agentId: id, live: agentOf(id) !== undefined }
    }
    return out
  }

  function presetRows(roster, profile) {
    const byId = {}
    for (const r of roster) byId[String(r.id)] = r
    return profile.roles.map((role) => {
      const row = byId[role.preset]
      return {
        role: role.id,
        id: role.preset,
        installed: !!row,
        name: row && row.name ? String(row.name) : '',
        broken: row && row.broken ? String(row.broken) : '',
      }
    })
  }

  /** 台账投影尝试:一次被拒就记住(插件写不了工作区),之后直接返回指令,不再反复试。 */
  /**
   * 台账落盘尝试。两处语义:
   *   1) 与"会话 write 落盘"统一为**覆盖写** —— 追加快照(prev + --- + text),
   *      会话侧是覆盖,同一个审计件两种形状,盘上长什么样取决于哪条路跑过;
   *   2) 否定缓存按 root 分桶 + 带 TTL,"服务不可用"不进缓存(BUG-6)。
   */
  async function tryWriteLedger(root, rel, text) {
    if (cfg.ledgerAutoWrite === false) return { ok: false, reason: 'ledgerAutoWrite=false' }
    const cached = fsDenyFor(root)
    if (cached) return { ok: false, reason: `此前被拒(${cached.reason}),${Math.ceil((cached.until - Date.now()) / 1000)}s 后自动重试` }
    const svc = ctx.get('fs')
    if (!svc || typeof svc.resolve !== 'function' || typeof svc.writeText !== 'function') {
      // "服务不可用"是瞬时状态(apply 可能早于 fs 就绪,或该层没挂 fs)—— 不进缓存,下次照试
      return { ok: false, reason: 'fs 服务不可用(瞬时,下次仍会重试)' }
    }
    const key = String(root || '')
    try {
      const target = await svc.resolve(path.join(root, rel), { cwd: root })
      await svc.writeText(target, text)
      fsLedgerState.delete(key)
      return { ok: true }
    } catch (e) {
      const reason = String((e && e.message) || e)
      fsLedgerState.set(key, { reason, until: Date.now() + FS_DENY_TTL_MS })
      return { ok: false, reason }
    }
  }

  // ── relay_spawn ──────────────────────────────────────────────────────────
  const spawnTool = {
    name: 'relay_spawn',
    description:
      '【内部·dev-workflow】把一个角色登记为品牌 agent:用 subagents.startContinuable 派出带角色名的 agent 并绑定 durable id,供 relay 解析投递地址。'
      + '角色人格由当前 profile 的 persona **显式注入**(子会话只继承父会话的 preset,不会自动获得 wf-* 预设人格)。readonly 角色自动收敛为只读工具集。',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', description: '要派出的角色(按当前 profile 的角色 id;内置 standard = pm/arch/be/fe/qa)' },
        prompt: { type: 'string', description: '该角色的初始指令' },
        provider: { type: 'string', description: 'subagent provider 名;不传时按 profile/自动选择' },
        readonly: { type: 'boolean', description: 'true 时限制为只读工具集(默认取 profile 里该角色的设定)' },
        force: { type: 'boolean', description: '已登记时强制重派(兼容字符串 "true"/1)' },
        root: { type: 'string', description: '项目根目录;不传时取 agent cwd' },
        profile: { type: 'string', description: 'profile id;不传时用当前项目生效的 profile' },
        persona: { type: 'string', description: '覆盖 profile 里的角色人格文本' },
        model: { type: 'string', description: '覆盖模型 id(透传 agentOptions.model)' },
        reasoningEffort: { type: 'string', description: '覆盖该角色的 reasoning effort(透传 agentOptions.reasoningEffort;如 low/medium/high/max)。不传时取 profile 里该角色的默认档,profile 也没设就继承调度者 —— 可用于"便宜角色用便宜档"降本' },
      },
      required: ['role'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        const v = value || {}
        const lines = [`relay_spawn ${v.status || 'ok'}`]
        if (v.role) lines.push(`角色 @${v.role}${v.roleLabel ? `(${v.roleLabel})` : ''}`)
        if (v.provider) lines.push(`provider=${v.provider}`)
        if (v.agentId) lines.push(`agentId=${v.agentId}`)
        if (v.profileId) lines.push(`profile=${v.profileId}`)
        if (v.personaInjected) lines.push(`人格:✓ 已按 profile 注入 ${v.personaChars} 字(不再顶着父会话默认人格)`)
        /**
         * 派活成功回执里的 messageId / envNotesInjected
         * 一直只进 payload —— 屏幕上既没有这次开工消息的 id(无法与宿主日志对照),
         * 也没有"环境约束(ENV_NOTES)到底注没注进去"的回执。
         * 触发:`relay_spawn role=be`(成功路径)。
         */
        if (v.messageId) lines.push(`messageId=${v.messageId}(这次开工消息的 id,可与宿主日志对照)`)
        if (v.envNotesInjected) lines.push('环境约束(ENV_NOTES):✓ 已随 persona 注入(平台/沙箱/路径口径)')
        if (v.readonly) lines.push('工具集:只读')
        if (v.activated) lines.push('🔓 本项目已自动激活(不需要 .active 文件)')
        if (v.rootHint) lines.push('📌 项目根与调度者 cwd 不同:已在开场白里写明 root')
        if (v.staleRebind) lines.push(`♻️ 原绑定 @${v.staleRebind.role}(${v.staleRebind.oldAgentId.slice(0, 8)})已失效 —— ${v.staleRebind.reason};已自动重派`)
        /**
         * 这里不渲染 `if (v.staleBinding)` —— 那个分支**执行不到**:
         * 顶层 `staleBinding` 只由 **relay** 的 execute 写,也由 **relay 自己的
         * render** 渲染;spawnRole 在这条路径上写的是 `staleRebind`(上一行已渲染)。
         * 两个字段管的是两件事:relay 那条 = "要发的目标不是我们这个调度者的人,正文没送出";
         * spawn 这条 = "旧绑定失效,已经自动重派"。而派活本身是在**建**绑定,撞不上"归属失效" ——
         * 不留这条死渲染,是为了守住本文件的不变量
         * "render 读的字段必须有写入者",也免得读者误以为 relay_spawn 会报这一条。
         * 将来若 spawn 真需要报归属问题,在这里按当时的字段形状写回来,并补断言。
         */
        if (v.inheritedPreset) lines.push(`继承的父会话 preset:${v.inheritedPreset}(DSH 由父继承,与 wf-* 无关)`)
        // 把实际生效的档位写出来 —— 否则无从核对"这个角色花了多少钱的档"
        if (v.reasoningEffort) lines.push(`reasoning effort:${v.reasoningEffort}(未透传时继承调度者的档)`)
        if (v.note) lines.push(String(v.note))
        if (Array.isArray(v.providers)) lines.push(`可用 provider: ${v.providers.join(', ')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const a = args || {}
      const role = a.role
      // 角色集不能写死内置 5 个 —— 否则自定义档案的新角色(如 platform6 的 dba)
      // 会"派得出、叫不应":kickoff 按 profile.roles 遍历能派出它,这里却硬拒。
      // 改为只挡明显非法的角色名,真正的成员校验交给下游按 profile 判定。
      // (实测:provider 并不强制 schema 里的 enum,所以真正的拦截点就是这一行。)
      if (!/^[a-z][a-z0-9_-]*$/.test(String(role))) {
        return { status: 'invalid', note: `未知角色:${String(role)}(角色名须为小写字母开头的标识符)` }
      }
      const root = resolveRoot(a, exec)
      // reasoningEffort 透传(不传时 spawnRole 会回落 profile 里该角色的默认档)
      return spawnRole({ a, exec, root, role, reasoningEffort: a.reasoningEffort })
    },
  }

  /**
   * 派一个角色(relay_spawn 与 relay action=kickoff 共用)。
   * 成功即把项目记进插件状态(首用自动激活,不需要用户建 .active —— 插件写不了工作区)。
   */
  async function spawnRole(opts) {
    const a = opts.a || {}
    const exec = opts.exec
    const root = opts.root
    const role = opts.role
    const { profile, unknown, ids: profileIds, table: profileTableAll } = resolveProfile(root, a.profile)
    const roleDef = roleOf(profile, role)
    if (!roleDef) {
      // 同 send 路径 —— 补救必须带终止条件,否则模型只能一档一档试。
      const allIds = profileIds || Object.keys(profileTableAll || {})
      const holders = Object.keys(profileTableAll || {}).filter((id) => roleOf(profileTableAll[id], role))
      return {
        status: 'role_not_in_profile', role,
        available: allIds,
        profilesWithRole: holders,
        note: `profile=${profile.id} 不含角色 @${role};其角色集为 ${profile.roles.map((r) => r.id).join('/')};`
          + (holders.length > 0
            ? `**含 @${role} 的档:${holders.join('/')}** —— 用 relay action=profile profile=${holders[0]} 切换后再派`
            : `当前**没有任何一档含 @${role}**(可用档:${allIds.join('/')})—— 请换角色,或往 ~/.dsh/dev-workflow/profiles.json 里加一档`),
      }
    }
    // 派活路径同样带 caller —— 换过会话后这里也要先把残留等待图作废
    // `key` 是 **slotFor 实际用的那个键**(可能是归一化命中后的旧键,
    // 与调用方按原串重算的 `stateKey(profile.id, root)` 不一定相同)—— 所以这里必须用
    // 返回值里的 key 去取 coord,不能拿 root 再算一遍(实测:那样取到 undefined,踩 snapshot())
    const { slot, coord } = slotFor(profile, root, coordinators, exec && exec.agent)
    /**
     * "已登记"必须加一个前提 —— **还活着,而且是这个调度者的**。
     * 只看 key 存不存在就返回 exists,于是死绑定(上个进程的 / 别的父会话的)
     * 会让 kickoff 报"跳过已登记的 N 个"、status 报"人齐了",而第一次 relay 过去
     * 就是 UNAUTHORIZED。现在判失效就地清掉,当没登记过继续往下派。
     */
    let staleRebind = null
    /**
     * force 必须认字符串 `"true"`。
     * 别写成 `a.force !== true` —— provider 并不强制 schema 里的 boolean,模型把
     * `force:"true"` 传进来时被当成 false,`relay_spawn` **静默降级成 exists**:
     * 实测:回执只说"该角色已登记且仍在位;需要重派请传 force=true",
     * 而调用者刚刚写的就是 force=true —— 一个都没换新会话,人却以为重派过了。
     * 项目里本来就有 boolTrue()(noDeliver/skipDedupe 已在用),这里漏套了。
     */
    if (slot.roleAgents[role] && !boolTrue(a.force)) {
      const usable = bindingUsable(slot.roleAgents[role], exec && exec.agent)
      if (usable.ok) {
        return { status: 'exists', role, agentId: slot.roleAgents[role], note: '该角色已登记且仍在位;需要重派请传 force=true', profileId: profile.id }
      }
      staleRebind = { role, oldAgentId: String(slot.roleAgents[role]), reason: usable.reason }
      delete slot.roleAgents[role]
      activity.staleRebinds += 1
      bumpStat(slot, 'staleRebinds')
      staleRebindLog.push({ role, oldAgentId: staleRebind.oldAgentId, reason: usable.reason, at: makeTS() })
      if (staleRebindLog.length > 20) staleRebindLog.shift()
      /**
       * spawn 早退也必须落盘:删了绑定就必须**当场落盘**。
       *
       * 只 `delete slot.roleAgents[role]`(内存)不够 —— 落盘若全靠后面派活成功那一句,
       * `saveStore()`。而这个函数在删完之后有**四条早退路径**:subagents 服务不可用、
       * 没有已注册 provider、provider 名不认识、找不到发起者 agent —— 任何一条命中就直接
       * return,**盘上那份旧绑定原封不动**。下一次进程启动 `loadStore()` 把它读回来,
       * 于是"已清理的失效绑定"复活:kickoff 又把它当"已登记"跳过、
       * status 又报"人齐了",直到某次 relay 撞 UNAUTHORIZED 才重新发现它死了。
       *
       * 就地落盘(与 slotFor 的惰性 GC、send 路径的 staleBinding 清理同一做法):
       * 落盘失败不影响本次调用,内存里已经清干净了。
       */
      try { saveStore() } catch { /* 落盘失败不影响本次调用 */ }
    }
    const sub = ctx.get('subagents')
    if (!sub || typeof sub.startContinuable !== 'function') return { status: 'unavailable', role, note: 'subagents 服务不可用' }
    const available = providerNames()
    let provider = opts.provider || roleDef.provider || ''
    if (!provider) provider = available.filter((n) => String(n).toLowerCase().indexOf('spawn') !== -1)[0] || available[0]
    if (!provider) return { status: 'unavailable', role, note: '没有已注册的 subagent provider', providers: available }
    if (available.length > 0 && available.indexOf(provider) === -1) {
      return { status: 'unavailable', role, note: `未知 provider:${provider}`, providers: available }
    }
    const agentsSvc = ctx.get('agents')
    const parent = (exec && exec.agent) || (agentsSvc && agentsSvc.currentInitiator())
    if (!parent) return { status: 'unavailable', role, note: '找不到发起者 agent' }

    const persona = [String(opts.persona || roleDef.persona || ''), ENV_NOTES].filter((x) => x !== '').join('\n\n')
    const readonly = opts.readonly === undefined ? roleDef.readonly === true : opts.readonly === true
    const signal = lifetimeSignal.signal

    // 子会话的工作目录**继承父会话**(DSH 的 SubagentStartRequest 没有 cwd 字段,这是契约事实),
    // 所以项目根与父会话 cwd 不一致时,把根写进开场白 —— 与 rootOfRoleAgent 的自动反查互为兜底。
    const parentCwd = cwdOf(parent)
    let rootHint = ''
    try {
      if (root && parentCwd && path.resolve(String(root)) !== path.resolve(String(parentCwd))) {
        rootHint = `\n\n【项目根】${root}\n(你的工作目录继承自调度者,可能不是项目根:调用 relay / workflow_state_* / api_contract 时一律显式带 root=${root};产出文件也写在这个目录下。)`
      }
    } catch { rootHint = '' }

    const request = {
      parent,
      prompt: [{ type: 'text', text: (opts.prompt || `你是 dev-workflow 的 ${role} 角色。等待调度者的指令。`) + rootHint }],
    }
    if (persona) request.persona = persona
    if (readonly) request.toolFilter = { allow: READONLY_ALLOW }
    /**
     * 档位要能透传。
     * 只透传 agentOptions.model 会让所有角色都继承调度者的 agentReasoningEffort("max")
     *—— 派 @qa 跑一遍 checklist 也按 max 计费,没有"便宜角色用便宜档"的开关。
     * 优先级:调用参数 > profile 里该角色的默认档 > 不传(继承调度者,保持旧行为)。
     */
    const model = opts.model || roleDef.model || ''
    const effort = String(opts.reasoningEffort || roleDef.reasoningEffort || '')
    if (model || effort) {
      request.agentOptions = {}
      if (model) request.agentOptions.model = String(model)
      if (effort) request.agentOptions.reasoningEffort = effort
    }

    let res
    try {
      res = await sub.startContinuable({ provider, label: role, request, signal: realSignal(signal) })
    } catch (e) {
      return {
        status: 'error', role,
        note: `派出失败:${String((e && e.message) || e)}${(e && e.code) ? ` [${e.code}]` : ''}`,
        providers: available, profileId: profile.id,
      }
    }
    slot.roleAgents[role] = String(res.childId)
    // 用 slotFor 返回的 coord(见上面注释:不能再按 root 重算键)
    syncSlot(slot, coord)
    saveStore()
    /**
     * 派活成功必须把 profile **落盘**。
     * `a.profile` 若只参与本次 resolveProfile:派完之后 store.activeProfiles[root] 仍是空,
     * 而子会话的 header 不带 profile —— 它回来调 relay / workflow_state_* 时 resolveProfile
     * 就回落 standard 槽。实测证据:`relay_spawn profile=platform6`
     * 派出的 6 个角色全被登记进 standard 槽(绑定所在档与派它的档不一致),
     * 子会话第一条互呼必然 role_not_in_profile(回执写"profile=standard 不含角色 @dba")。
     * 只在"显式传了 a.profile 且真的解析到它"时写:不传时保持原解析链
     * (门声明 > 配置默认档),免得把 .active 里声明的档位永久压住。
     */
    if (a.profile && !unknown && String(profile.id) === String(a.profile)
      && String(store.activeProfiles[root] || '') !== String(profile.id)) {
      setActiveProfile(root, profile.id)
    }
    // 首用自动激活:派角色是"我要开工了"唯一无歧义的信号
    const activated = markActive(root, `relay_spawn:${role}`)
    activity.spawns += 1
    bumpStat(slot, 'spawns')
    activity.lastAt = makeTS()
    store.lifetime.spawns += 1
    return {
      status: 'spawned', role, roleLabel: roleDef.label, provider,
      agentId: String(res.childId), messageId: String(res.messageId || ''),
      profileId: profile.id,
      personaInjected: !!persona, personaChars: persona.length,
      envNotesInjected: true,
      readonly,
      activated,
      rootHint: rootHint !== '',
      inheritedPreset: presetOf(parent),
      // 如实回报实际生效的档位(空串=未透传,继承调度者),便于核对成本
      reasoningEffort: effort,
      staleRebind,
      note: `人格已随 request.persona 注入(末尾附本机环境约束);子会话 header.agentPreset 仍会继承父会话的 ${presetOf(parent) || '(未设)'},那是 DSH 的既有行为`
        + (activated ? ';本项目已自动激活(记在插件状态,不需要 .active 文件)' : ''),
    }
  }

  /**
   * 一句话开工:确保激活 → 按 profile 派齐角色 → 生成初始流程状态文档。
   * 省掉"逐条 relay_spawn + 手写每个角色的开场白"。
   */
  async function kickoff(opts) {
    const a = opts.a || {}
    const exec = opts.exec
    const root = opts.root
    const goal = String(a.goal || a.msg || '').trim()
    const { profile, unknown, ids } = resolveProfile(root, a.profile)
    const known = profile.roles.map((r) => r.id)
    let wanted = Array.isArray(a.roles) && a.roles.length > 0
      ? a.roles.map((r) => String(r)).filter((r) => r !== '')
      : known.slice()
    const rejected = wanted.filter((r) => known.indexOf(r) === -1)
    wanted = wanted.filter((r) => known.indexOf(r) !== -1)
    if (wanted.length === 0) wanted = known.slice()
    // 协调者必须在场:它是回话的入口(to-parent 原生边)
    let coordinatorAdded = false
    if (wanted.indexOf(profile.coordinator) === -1) { wanted.unshift(profile.coordinator); coordinatorAdded = true }

    const gate = gateStateOf(root)
    if (gate === 'off') {
      return {
        status: 'inactive', root, gate, profileId: profile.id,
        note: `${ACTIVE_REL} 写了 off:本项目被显式关闭,拒绝开工;去掉那行再试`,
      }
    }
    const wasActive = isActiveGate(gate)
    /**
     * 在**派活之前**就 markActive 是错的 —— 即使随后一个角色都没派成
     * (provider 缺失 / 服务抛错 / 绑定全失效),项目也已经被记成"已开工":
     * 用户下次 load/status 直接按开工走,还会拦住 `.active=off` 的清理。
     * 现在推到派活之后(见循环下面的 markActive),且真的有人在地上才记。
     */
    let activated = false

    const hasState = readMaybe(profile.state.file, root).exists
    const coordLabel = ROLE_LABELS[profile.coordinator] || profile.coordinator
    const others = wanted.filter((r) => r !== profile.coordinator)
    const spawned = []
    const skipped = []
    const failed = []
    for (const role of wanted) {
      const label = ROLE_LABELS[role] || role
      const isCoord = role === profile.coordinator
      const prompt = isCoord
        ? `【开工】${goal ? `用户需求:${goal}\n\n` : ''}你是本流程的协调者(@${role},${label})。按你的人设先做你那一棒。\n`
          + `需要别的角色的产出/确认时,直接用 relay 互呼(会自动投递,不需要调度者转述);不要自己替他们拍定。\n`
          + (hasState ? `项目已有流程状态文档,先 workflow_state_load 读回来再动手。\n` : `这是新流程:先理清需求并产出你的文档;需要用户拍板的地方停下来问。\n`)
          + `已就位:${others.map((r) => `@${r}`).join('、') || '(无)'}。`
        : `【开工】项目已按 profile=${profile.id} 派出角色,你是 @${role}(${label})。\n`
          + `等 @${profile.coordinator}(${coordLabel})的需求或指令;收到【互呼】消息就按你的人设干活,做完用 relay 回话闭合。\n`
          + (hasState ? `先 workflow_state_load 读流程状态。\n` : '')
          + `需要别人的产出时用 relay 互呼,不要等调度者转述。`
      /* eslint-disable no-await-in-loop */
      // 只透传"整批通用"的开关:persona/model/readonly 一律按 profile 里每个角色自己的设定,
      // 否则一个 persona 覆盖会把五个角色变成同一个人。
      // force 走 boolTrue(字符串 "true" 也算);reasoningEffort 是"整批通用"的
      // 成本开关(不传时按 profile 里该角色的默认档,再缺省才继承调度者)。
      const perRole = { profile: a.profile, force: boolTrue(a.force), provider: a.provider, reasoningEffort: a.reasoningEffort }
      const r = await spawnRole({ a: perRole, exec, root, role, prompt })
      if (r.status === 'spawned') spawned.push({ role, label, agentId: r.agentId, readonly: r.readonly === true })
      else if (r.status === 'exists') skipped.push({ role, label, agentId: r.agentId })
      else failed.push({ role, label, status: r.status, note: String(r.note || '') })
    }
    /**
     * kickoff 同样要落盘 profile。
     * 上面每个 spawnRole 只在**真的派出去**时才会写 activeProfiles;整批都已登记(skipped)
     * 或全派失败时一个字都不写 —— 而这两条路径之后,子会话照样要按 a.profile 解析自己的槽。
     * 与 spawnRole 同口径:只有显式传了 a.profile 且解析到它才写。
     */
    if (a.profile && !unknown && String(profile.id) === String(a.profile)
      && String(store.activeProfiles[root] || '') !== String(profile.id)) {
      setActiveProfile(root, profile.id)
    }

    // 有人真的在地上(spawned,或已登记可用的 skipped)才把项目记成"已开工"。
    if (spawned.length > 0 || skipped.length > 0) {
      markActive(root, `kickoff${goal ? `:${goal.slice(0, 40)}` : ''}`)
      /**
       * 判据不能取 markActive 的返回值 —— `spawnRole` 每派成一个角色就会顺手
       * markActive(root, 'relay_spawn:<角色>')(relay_spawn 的"首用自动激活"),
       * 于是这里再调必然返回 false(再调一次会返回 false)。
       * 真正要表达的是"这次 kickoff 之前项目没激活、现在激活了"。
       */
      activated = !wasActive && isActiveGate(gateStateOf(root))
    }
    // 协调者是唯一的回话入口(DSH 强制邻接,兄弟角色物理上不能直连)。
    // status 只看"有没有人派出去"时,协调者派失败也照报 started —— 而这一轮其实没人能给角色派活。
    const coordOk = spawned.some((s) => s.role === profile.coordinator) || skipped.some((s) => s.role === profile.coordinator)
    const coordFail = coordOk ? null : (failed.filter((f) => f.role === profile.coordinator)[0] || { role: profile.coordinator, status: 'missing', note: '协调者既没派成、也没有可用登记' })

    const out = {
      status: spawned.length > 0 ? 'started' : (skipped.length > 0 ? 'already' : 'failed'),
      root, gate: 'active', gateSource: gateLabelOf(root, gateStateOf(root)),
      profileId: profile.id, goal,
      roles: wanted,
      coordinator: profile.coordinator,
      coordinatorAdded,
      // 协调者到底派成没有。回执里若只能从 spawned 数组自己找,
      // 而 status 又只看"有没有人派出去",于是"协调者失败 + 其他角色成功"会被读成完全成功。
      coordinatorSpawned: coordOk,
      ...(coordFail ? { coordinatorFailure: coordFail, degraded: true } : {}),
      rejectedRoles: rejected,
      spawned, skipped, failed,
      activated: activated && !wasActive,
      autoActivated: activated && !wasActive,
      unknownProfile: unknown || '',
      availableProfiles: ids,
    }
    if (!hasState) {
      // 把**整段 goal 原文**塞进「待办」首条,一份需求书就能把状态文档撑成一大段话
      // (实测:初始文档里那条待办约 600 字)。待办是给人扫一眼的清单,
      // 取首行 + 截断;goal 原文照旧完整回传在 out.goal 里,不丢信息。
      const goalLine = goal.split(/\r?\n/)[0].trim()
      const goalBrief = goalLine.length > 60 ? `${goalLine.slice(0, 60)}…` : goalLine
      const todos = [`${coordLabel} 理需求${goalBrief ? `(${goalBrief})` : ''}`]
        .concat(others.map((r) => `${ROLE_LABELS[r] || r} 等 @${profile.coordinator} 派活`))
      const documentText = buildDocument(null, {
        projectName: path.basename(String(root || '')) || '项目',
        nextStep: `${coordLabel} 理需求`,
        todos,
        header: { coordinator: profile.coordinator },
      })
      out.documentText = documentText
      out.targetPath = path.join(root, profile.state.file)
      // 全只读档案(review)下没有任何角色持有 write,
      // 只写"主会话:…用 write 写入…"是给不存在的执行者下指令,流程会静默停在第一步。
      const allReadonly = profile.roles.every((r) => r.readonly === true)
      out.persistInstruction = allReadonly
        ? `【只读档案】${profile.roles.map((r) => `@${r.id}`).join('/')} 都是只读工具集,谁也不持有 write:`
          + `流程状态文档只能由主会话自己把 ${DOC_BEGIN} 与 ${DOC_END} 之间的全文写入 ${path.join(root, profile.state.file)}`
        : `主会话:把 ${DOC_BEGIN} 与 ${DOC_END} 之间的全文用 write 写入 ${path.join(root, profile.state.file)}`
      if (allReadonly) out.readonlyProfile = true
    } else {
      out.existingState = profile.state.file
    }
    // 协调者没派成时,这句必须**顶在最前面** —— 否则这种局面会渲染成
    // 「已派出 4 个角色」,而实际上没人能给这 4 个角色派活(协调者是唯一回话入口)。
    const coordWarn = coordOk ? '' : `⚠️ 协调者 @${profile.coordinator} **没派成**(status=${coordFail.status}${coordFail.note ? `:${String(coordFail.note).slice(0, 80)}` : ''}):它是唯一的回话入口,没它就没人能给其他角色派活。修好原因后用 relay_spawn role=${profile.coordinator} 补派。`
    out.note = (coordWarn ? `${coordWarn} ` : '') + (spawned.length > 0
      ? `已派出 ${spawned.length} 个角色${skipped.length > 0 ? `(跳过已登记的 ${skipped.length} 个)` : ''}${activated && !wasActive ? ';本项目已自动激活(不需要 .active 文件)' : ''}`
        + (rejected.length > 0 ? `;忽略不属于 profile=${profile.id} 的角色:${rejected.join('/')}` : '')
        + (coordinatorAdded ? `;协调者 @${profile.coordinator} 不在你给的 roles 里,已自动补上(回话入口)` : '')
      : (skipped.length > 0 ? '所有角色都已登记,未重复派出(要重派传 force=true)' : '一个角色都没派出去,看 failed 里的原因'))
    return out
  }

  // ── workflow_state_* ─────────────────────────────────────────────────────
  const ROOT_PROP = { root: { type: 'string', description: '项目根目录;不传时取 agent cwd / shell cwd' } }
  const STATE_OUTPUT = {
    schema: { type: 'object', additionalProperties: true },
    render(args, value) {
      const v = value || {}
      const lines = [`workflow_state_${v.op || '?'} → ${v.status || 'ok'}`]
      // 只在"部署了但没重启"时出声,不给每次调用加噪音
      if (versionMismatch) lines.push(`⚠️ 版本不一致:进程内 v${VERSION} ≠ 磁盘 v${diskVersion} —— 部署后没重启`) 
      // 有文件却读不出可用版本 = 这一层兜底不成立,不能沉默
      if (versionUnverifiable) lines.push(`⚠️ 版本自证失效:${diskVersionError} —— 进程内是 v${VERSION},但"磁盘有没有换版"无从判断`) 
      // root 若是"按 cwd 兜底"推断出来的,必须在这一行就点出来 ——
      // 把推断出来的目录当"项目根"直接印,模型看不出自己其实没传 root。
      if (v.root) lines.push(`项目根:${v.root}${v.rootInferred ? `(⚠️ 本次没传 root,按 ${v.rootSource || 'cwd'} 推断)` : ''}`)
      if (v.rootInferred) lines.push('⚠️ 上面这个根是**推断**的:可能不是你要的项目;要落到别的目录请显式传 root=<绝对路径> 后重试')
      if (v.profileId) lines.push(`profile:${v.profileId}`)
      if (v.targetPath) lines.push(`写入目标:${v.targetPath}`)
      if (v.gate) lines.push(`激活门:${v.gate}${v.gateSource ? `(${v.gateSource})` : ''}`)
      /**
       * status 的四个字段没有显示路径 ——
       * `hasState`(到底有没有真的状态文件)、`stateName`(落在哪份多流程文件上)、
       * `autoStart` / `gateReason`(这个门判定意味着什么)只能从 note / targetPath 反推。
       * hasState / autoStart / gateReason 只有 status 路径写,stateName 另有 save 路径,
       * 所以逐条按"字段在不在"渲染;autoStart=false(门写了 off)也要说清,那是"不会自动激活"。
       */
      if (typeof v.autoStart === 'boolean') {
        lines.push(v.autoStart
          ? '可直接开工:autoStart=true(不需要建任何文件,kickoff / relay_spawn 首用即自动激活)'
          : '不会自动激活:autoStart=false(本项目被显式关闭 —— 去掉 .active 里的 off 才恢复)')
      }
      if (v.gateReason) lines.push(`门判定:${v.gateReason}(gate=${v.gate || '?'})`)
      if (typeof v.hasState === 'boolean') lines.push(`状态文件:${v.hasState ? '已有(load/save 都落在它上面)' : '还没有(首次 save 才会生成)'}`)
      if (typeof v.stateName === 'string') lines.push(`需求名(stateName):${v.stateName === '' ? '(空值 → 主状态文件)' : v.stateName}`)
      // 静默激活的补口 —— 一行说清"项目已被记进激活记忆 + 怎么撤销"
      if (v.activationNote) lines.push(`🔓 ${v.activationNote}`)
      if (v.note) lines.push(String(v.note))
      if (v.progress) lines.push(`进度:${String(v.progress).replace(/\n/g, ' / ')}`)
      if (typeof v.todoOpen === 'number') lines.push(`未完成待办:${v.todoOpen} 项`)
      if (v.mergedFrom) lines.push(`合并来源:${v.mergedFrom}`)
      /**
       * render 一直只渲染"计数/路径/状态",而 `load` 真正取回的东西
       * (title/outputs/apiSpecs/todos/contractLog/risks/summary)与 `save` 的确认人反查结果
       * **一个字都没进模型上下文** —— 实测:render 里搜不到任一节内容,
       * 模型只能看到「未完成待办:N 项」这种计数,于是"跨会话续跑"实际读不回正文
       * (payload 里有、模型看不见 = 等于没有)。现在逐节渲染,并给每节设上限,免得回执被撑爆。
       */
      const STATE_CLIP = 1200
      const clip = (s, n) => {
        const t = String(s === undefined || s === null ? '' : s)
        const lim = Number(n || STATE_CLIP)
        return t.length > lim ? `${t.slice(0, lim)}…(共 ${t.length} 字,已截断)` : t
      }
      const sectionOf = (label, body) => {
        const t = String(body === undefined || body === null ? '' : body).trim()
        if (t === '' || t === '- (无)') return
        lines.push(`【${label}】`)
        for (const l of clip(t).split('\n')) lines.push(`  ${l}`)
      }
      if (v.title) lines.push(`标题:${clip(v.title, 200)}`)
      sectionOf('产出文件', v.outputs)
      sectionOf('API 契约', v.apiSpecs)
      // todos 只列**未完成**的前 20 条:已完成条目在"续跑"场景里没有决策价值,
      // 而实测一份长流程的状态文档里已完成条目能占满整屏(把真正要做的挤出去)。
      if (v.todos !== undefined && v.todos !== null && String(v.todos).trim() !== '') {
        const rows = String(v.todos).split('\n').filter((l) => l.trim() !== '')
        const open = rows.filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+\[\s*\]/.test(l))
        const shown = open.slice(0, 20)
        const hidden = open.length - shown.length
        lines.push(`【待办】(未完成 ${open.length} 项${rows.length !== open.length ? ` / 共 ${rows.length} 行` : ''}${hidden > 0 ? ',只列前 20 项' : ''})`)
        for (const l of shown) lines.push(`  ${clip(l, 300)}`)
        if (hidden > 0) lines.push(`  …还有 ${hidden} 项未完成(全文用 read 状态文件或看 workflow_state_load 的 payload)`)
      }
      sectionOf('契约修订台账', v.contractLog)
      sectionOf('遗留风险', v.risks)
      if (v.summary !== undefined && v.summary !== null && String(v.summary) !== '') {
        const full = String(v.summary)
        // summary = 状态文档全文。给前后各 1 KB:开头是标题/进度,结尾是最新一笔台账/风险,
        // 中间那截是历史记录、信息密度最低。
        lines.push(`【状态文档全文】(共 ${full.length} 字${full.length > 2048 ? ',只给前后各 1 KB' : ''})`)
        if (full.length > 2048) {
          lines.push(`  ${full.slice(0, 1024)}`)
          lines.push(`  …(中间省略 ${full.length - 2048} 字)…`)
          lines.push(`  ${full.slice(-1024)}`)
        } else {
          for (const l of full.split('\n')) lines.push(`  ${l}`)
        }
      }
      // save 的确认人反查(确认人有没有参与证据)只落在 payload 里 ——
      // "⚠️ 有确认人查不到证据"这件事从来没被读进上下文,台账栏位等于没人核。
      if (v.contractRevision && typeof v.contractRevision === 'object') {
        const cr = v.contractRevision
        lines.push(`【契约修订台账登记】${cr.content || '(未写内容)'}${cr.affected ? ` | 受影响:${cr.affected}` : ''} | 确认:${cr.confirmedBy || '(空)'}`)
        if (cr.note) lines.push(`  ${cr.note}`)
        const bad = Array.isArray(cr.unverified) ? cr.unverified : []
        for (const u of bad) lines.push(`  ⚠️ @${u.role}:${u.why}`)
        /**
         * 反查的**好消息**从不出声 —— 未通过的逐条 ⚠️ 渲染,
         * 通过的 `verified` 却没有任何读取点,于是"确认人确实有绑定会话 / 互呼记录"与
         * "一个确认人都没写"在屏幕上长得一模一样(坏消息才报、好消息不报)。
         * 触发:save 时 confirmedBy 写了有参与证据的角色(例如已派会话的 @be)。
         */
        if (Array.isArray(cr.verified) && cr.verified.length > 0) {
          lines.push(`  ✅ 已核对参与证据的确认人:${cr.verified.map((u) => `@${u.role}(${u.why})`).join(' ')}`)
        }
        if (Array.isArray(cr.nextActions)) for (const n of cr.nextActions) lines.push(`  → ${n}`)
      }
      if (typeof v.ledgerPending === 'number') lines.push(`协作台账:${v.ledgerPending} 行 → relay action=ledger 渲染投影`)
      /**
       * 各入口命中计数进状态面 —— 而且**未激活分支也要带**:
       * "预设命中却没激活"正是最需要看计数器的场景(静默失败时最需要它)。
       * 字段在不在按存在渲染:老 payload(比如别的工具写的回执)不受影响。
       */
      if (v.presetAuto && v.presetAuto.view) lines.push(String(v.presetAuto.view))
      if (v.apiSkill) lines.push(`API 契约:技能 ${v.apiSkill}${v.apiLint ? ` | 上次 lint ERROR ${v.apiLint.errors}/WARN ${v.apiLint.warnings} → ${v.apiLint.verdict}${v.apiLint.coverage ? `(覆盖 ${apiCoverageText(v.apiLint.coverage, true)})` : ''} @${v.apiLint.at}${v.apiLint.digest ? ` 指纹 ${String(v.apiLint.digest).slice(0, 12)}…` : ''}` : ' | 还没跑过 api_contract lint'}`)
      if (v.roleSkills) lines.push(`角色技能:${v.roleSkills} —— 角色人设里的「联动技能(按需加载)」就指这批,用 \`skill\` 按名加载`)
      if (v.persistInstruction) lines.push(v.persistInstruction)
      /**
       * workflow_state_use 空参分支写的 `existingState`
       * 在 STATE_OUTPUT 里没有读取点 —— 「回传的是磁盘上的真内容,还是空模板」不显示。
       * 这一格直接关系流程正确性:主会话照 persistInstruction 落盘,回传的若是不存在的空模板,
       * 照做就会把真实进度整份清空(同一个字段在 relay 的 kickoff 分支反而渲染了)。
       * 触发:有 / 无状态文件时 `workflow_state_use stateName=""`。
       */
      if (typeof v.existingState === 'boolean') {
        lines.push(v.existingState
          ? '回传内容:磁盘上的现有状态文件全文(不是空模板;照 persistInstruction 落盘不会清空进度)'
          : '⚠️ 回传内容:**空模板**(目标状态文件不存在或读不出来)—— 照 persistInstruction 落盘等于新建一份空文档')
      }
      if (v.documentText) { lines.push(DOC_BEGIN); lines.push(String(v.documentText)); lines.push(DOC_END) }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  }

  const stateTools = [
    {
      name: 'workflow_state_status',
      description: '检查项目是否已激活 dev-workflow(存在 docs/workflow/.active)并报告状态概况、当前 profile 与协作台账行数。开工第一步调用。',
      parameters: { type: 'object', properties: { ...ROOT_PROP, profile: { type: 'string' } }, required: [] },
      output: STATE_OUTPUT,
      async execute(args, exec) {
        const a = args || {}
        const root = resolveRoot(a, exec)
        const { profile, unknown } = resolveProfile(root, a.profile)
        const { slot } = slotFor(profile, root, coordinators)
        const gate = gateStateOf(root)
        if (!isActiveGate(gate)) {
          // 未激活不再是死路 —— 明确告诉模型"零设置就能开工",而不是让它去建文件
          return {
            op: 'status', status: 'inactive', root, gate, profileId: profile.id,
            autoStart: gate === 'none',
            gateReason: gateLabelOf(root, gate),
            // 未激活分支也要带计数 —— "什么都没发生"正是要看计数器的场景
            presetAuto: presetAutoPayload(),
            note: gate === 'off'
              ? `${ACTIVE_REL} 写了 off:本项目被**显式关闭**,不会自动激活;要去掉这行才恢复`
              : `未激活 —— 但**不需要建任何文件**:直接 relay action=kickoff goal="<一句话需求>" 一次派齐角色,`
                + `或 relay_spawn role=<角色> 逐个派,首用即自动开工(记在插件状态里)。`
                + `只有要固定 stateName=/profile= 才需要建 ${ACTIVE_REL}(内容 active);要显式关掉就写 off。`
                + autoActivateHint(exec),
          }
        }
        const rel = stateRelFor(profile, root)
        const cur = readMaybe(rel, root)
        if (!cur.exists) {
          return { op: 'status', status: 'active', root, gate: 'active', gateSource: gateLabelOf(root, gate), targetPath: rel, hasState: false, todoOpen: 0, progress: '', stateName: gateStateName(root), profileId: profile.id, ledgerPending: (slot.ledger || []).length, apiSkill: apiSkillSummary(root), roleSkills: roleSkillsSummary(root), apiLint: slot.apiLint || null, presetAuto: presetAutoPayload(), note: `已激活但尚无状态文件(profile=${profile.id}${unknown ? `,未知 profile ${unknown} 已回退 standard` : ''})` }
        }
        const s = summarize(cur.text)
        return {
          op: 'status', status: 'active', root, gate: 'active', gateSource: gateLabelOf(root, gate), targetPath: rel,
          hasState: true, todoOpen: s.todoOpen, progress: s.progress, stateName: gateStateName(root),
          profileId: profile.id, ledgerPending: (slot.ledger || []).length,
          apiSkill: apiSkillSummary(root), roleSkills: roleSkillsSummary(root), apiLint: slot.apiLint || null,
          // 激活了也要带计数 —— "谁把它开起来的"与"其余入口通不通"一次看全
          presetAuto: presetAutoPayload(),
          note: cur.size > 15360 ? '状态文件超 15KB,建议折叠早期记录' : '正常',
        }
      },
    },
    {
      name: 'workflow_state_load',
      description: '读取 docs/workflow/流程状态.md 并返回进度/产出/待办/契约台账/遗留风险,用于跨会话续跑。',
      parameters: { type: 'object', properties: { ...ROOT_PROP, stateName: { type: 'string', description: '多流程并行时的需求名' }, profile: { type: 'string' } }, required: [] },
      output: STATE_OUTPUT,
      async execute(args, exec) {
        const a = args || {}
        const root = resolveRoot(a, exec)
        const { profile } = resolveProfile(root, a.profile)
        const gate = gateStateOf(root)
        if (!isActiveGate(gate)) return { op: 'load', status: 'inactive', root, gate, profileId: profile.id, note: `${inactivePhrase(gate)}:不注入任何状态;要开工先 relay action=kickoff 或 relay_spawn(会自动激活)` }
        const rel = stateRelFor(profile, root, a.stateName)
        const cur = readMaybe(rel, root)
        if (!cur.exists) return { op: 'load', status: 'absent', root, gate: 'active', targetPath: rel, profileId: profile.id, note: '无状态文件:按新流程从 ① 项目经理开始' }
        const s = summarize(cur.text)
        return { op: 'load', status: 'loaded', root, gate: 'active', targetPath: rel, profileId: profile.id, title: s.title, progress: s.progress, outputs: s.outputs, apiSpecs: s.apiSpecs, todos: s.todos, todoOpen: s.todoOpen, contractLog: s.contractLog, risks: s.risks, summary: cur.text }
      },
    },
    {
      name: 'workflow_state_save',
      /**
       * 不能写「role/nextStep/outputs/todos/risks/contractRevision 均为**增量合并**项」——
       * 与实现不符,而且误导方向正是"丢数据"那一侧:buildDocument 里只有 contractRevision 真做
       * 增量(readSection + 追加一行),role/nextStep 是**改「当前进度」这一节**,
       * 而 outputs/todos/risks 一旦传入就 `replaceSection` **整段覆盖**(不传才保留磁盘原文)。
       * 模型照着"增量合并"的说明只传本次新增的几条 → 磁盘上原有的全部条目被静默替换掉。
       * 这里把口径改成实话(比"把四个数组也做成合并"改动小,且不会新增第二种语义)。
       */
      description: '渲染新的流程状态.md 全文并回传(BEGIN/END 之间),由主会话用 write 工具落盘(插件无工作区写权限)。合并口径:role/nextStep=改「当前进度」小节;outputs/apiSpecs/todos/risks=**整段覆盖**对应小节(传了就以你给的为准,不传才保留磁盘原文);contractRevision=在「契约修订台账」**追加一行**。',
      parameters: {
        type: 'object',
        properties: {
          ...ROOT_PROP,
          role: { type: 'string', description: '刚完成的角色(按当前 profile 的角色 id;内置 standard = pm/arch/be/fe/qa)' },
          stateName: { type: 'string', description: '多流程并行:写哪份状态文件(流程状态-<需求名>.md);留空=按激活门 .active 里的 stateName= 走,再留空=主状态文件' },
          nextStep: { type: 'string', description: '下一步要做什么(写进「当前进度」)' },
          projectName: { type: 'string', description: '项目名(写进标题)' },
          outputs: { type: 'array', items: { type: 'string' }, description: '产出文件条目(**整段覆盖**「产出文件」小节;要保留旧条目就得连同旧的一起传)' },
          apiSpecs: { type: 'array', items: { type: 'string' }, description: 'API 契约条目(**整段覆盖**「API 契约」小节),建议格式:docs/api/openapi.yaml | 类型=openapi | 版本=/v1 | lint=ERROR 0(verdict=pass,覆盖 M/M)' },
          todos: { type: 'array', items: { type: 'string' }, description: '待办条目(**整段覆盖**「待办」小节;未完成/已完成由你给的前缀标记决定)' },
          risks: { type: 'array', items: { type: 'string' }, description: '遗留风险条目(**整段覆盖**「遗留风险」小节)' },
          contractRevision: { type: 'object', additionalProperties: true, description: '{content, affected, confirmedBy} 契约修订台账一笔' },
          currentText: { type: 'string', description: '现状文档全文(插件读不到时由主会话 read 后传入)' },
          profile: { type: 'string' },
        },
        required: [],
      },
      output: STATE_OUTPUT,
      async execute(args, exec) {
        const a = args || {}
        const root = resolveRoot(a, exec)
        const { profile } = resolveProfile(root, a.profile)
        const gate = gateStateOf(root)
        // 保存状态本身就是"开工"行为 —— 不再因为缺 .active 就拒绝,而是顺手把项目记进插件状态
        /**
         * 这个"顺手激活"若**静默**, markActive 把 root 记进了插件私有状态
         * (activeProjects),而回执只写"落盘由主会话完成",一个字都没提项目已经被激活。
         * 于是用户以为"我只保存了一份文档",下次 load/status 却直接按已开工走(甚至拦住 .active=off 的清理)。
         * 现在把这次记录如实回执,并点名撤销动作(reverseActivated)。
         */
        let autoActivated = false
        if (!isActiveGate(gate)) {
          if (gate === 'off') {
            return { op: 'save', status: 'inactive', root, gate, profileId: profile.id, note: `${ACTIVE_REL} 写了 off:本项目被显式关闭,不生成任何文档;要去掉这行才恢复` }
          }
          autoActivated = markActive(root, 'workflow_state_save')
        }
        const rel = stateRelFor(profile, root, a.stateName)
        // 占位写法(空)/(空值) 与不传等价,回执里也就不能报成需求名。
        const nm = isBlankStateNameToken(a.stateName) ? '' : safeStateName(a.stateName)
        const gateNm = gateStateName(root)
        const cur = readMaybe(rel, root)
        /**
         * `currentText`(模型从会话里抄来的"现状全文")若**优先于磁盘**,
         * 且 `mergedFrom` 不做任何前提判断 —— 于是模型手上那份过期全文会把磁盘上的新进度整份盖掉,
         * 而回执照样写「合并来源:plugin-fs」(说的是从磁盘读的,做的却是覆盖磁盘)。
         * 实测风险最高的现场:子会话先 load 拿到全文,主会话随后 save 推进了进度,
         * 子会话再 save 一次(它手上的 currentText 是旧的)→ 进度回退,且没有任何告警。
         * 现在:磁盘读得到就以磁盘为准(前提判断);`currentText` 只在插件**读不到**磁盘文本时兜底。
         */
        const diskText = cur.exists ? cur.text : null
        const suppliedText = typeof a.currentText === 'string' && a.currentText !== '' ? a.currentText : ''
        const currentTextIgnored = suppliedText !== '' && diskText !== null
        const currentText = diskText !== null ? diskText : (suppliedText !== '' ? suppliedText : null)
        // 确认人反查要用到台账与绑定表,而它们都在槽里 —— 所以 slotFor 提到 buildDocument 之前。
        const { slot, coord } = slotFor(profile, root, coordinators)
        const contractVerification = (a.contractRevision && typeof a.contractRevision === 'object')
          ? verifyConfirmers(a.contractRevision.confirmedBy, {
            roles: profile.roles.map((r) => r.id),
            ledger: slot.ledger || [],
            roleAgents: slot.roleAgents || {},
            waiting: coord.waiting || {},
          })
          : null
        const documentText = buildDocument(currentText, Object.assign({}, a, {
          header: { coordinator: profile.coordinator },
          contractRevision: contractVerification ? Object.assign({}, a.contractRevision, { verification: contractVerification }) : a.contractRevision,
        }))
        // 落盘指令不能一律写"主会话:…",因为本工具**子会话也能调**(实测台账里
        // 就有 @arch / @pm 两条 `→(状态) ✅ 完成 workflow_state_save`)。子会话拿到这条
        // 指给主会话的指令,而主会话永远看不到它的工具结果 —— 这一步等于没做。
        const caller = exec && exec.agent
        // 子会话判定不能只看 header.parentSession —— 角色子会话还有一条更强的信号:
        // 它的 agent id 就在本项目的角色绑定表里(relay_spawn 登记的)。两条任一成立即按子会话走,
        // 于是落盘指示会交给"回得到协调者"的那条路,而不是给一个永远看不到这条结果的会话。
        const isChildCaller = parentSessionOf(caller) !== '' || roleSlotOfAgent(caller) !== null
        const s = summarize(documentText)
        // 合并来源必须与**实际用了谁**一致 —— diskText 有值就一定是 plugin-fs。
        const mergedFrom = diskText !== null ? 'plugin-fs' : (suppliedText !== '' ? 'session-currentText' : 'default-template')
        activity.stateSaves += 1
        bumpStat(slot, 'stateSaves')
        activity.lastAt = makeTS()
        activity.lastSaveAt = makeTS()
        store.lifetime.stateSaves += 1
        if (a.role) {
          pushLedger(slot, { ts: makeTS(), from: a.role, to: '(状态)', summary: a.nextStep ? `下一步:${a.nextStep}` : '状态保存', status: '✅ 完成', note: 'workflow_state_save' })
          syncSlot(slot, coord)
        }
        saveStore()
        // 显式给了 stateName 而激活门里还是别的(或空)时,必须把"顺手更新门"写进落盘指示 ——
        // 否则这一次 write 只是把内容写进子文件,而下一次 load/save/status 又会回到主文件。
        const gateHint = (nm && nm !== gateNm)
          ? `;并把 ${ACTIVE_REL} 写成 active / stateName=${nm}(这样后续 load/save/status 才会一致落在同一份文件上)`
          : ''
        return {
          op: 'save', status: 'rendered', root, gate: 'active', targetPath: rel, profileId: profile.id,
          stateName: nm || gateNm,
          documentText, mergedFrom, progress: s.progress, todoOpen: s.todoOpen,
          ledgerPending: (slot.ledger || []).length,
          // 传了 currentText 却因"磁盘读得到"而被忽略时**必须说出来** ——
          // 直接照用(把新进度盖回旧内容)且回执写「合并来源:plugin-fs」,两处都在骗人。
          ...(currentTextIgnored ? {
            currentTextIgnored: true,
            currentTextNote: `你传的 currentText(${suppliedText.length} 字)**未被采用**:插件读得到磁盘上的状态文件,以磁盘为准。`
              + '插件读不到磁盘文本时它才会兜底;若你确实要从会话里的全文重建,请先把状态文件删掉或用 workflow_state_use 换目标文件。',
          } : {}),
          // 把反查结果摆到回执里 —— 台账行里那一小段 ⚠️ 容易被读漏,
          // 而"确认人没确认过"是审计件里最要紧的一类事实。
          ...(contractVerification ? (() => {
            const bad = contractVerification.unverified
            const first = bad.length > 0 ? bad[0].role : ''
            // `mentioned` 为空 = 这一栏**一个角色都没认出来**(confirmedBy 空,
            // 或写的是"客户/甲方"这类非角色词)。此时反查什么都没做,不许落进"已核对"那句正面措辞。
            const named = Array.isArray(contractVerification.mentioned) ? contractVerification.mentioned : []
            return {
              contractRevision: {
                registered: true,
                content: String(a.contractRevision.content || ''),
                affected: String(a.contractRevision.affected || ''),
                confirmedBy: String(a.contractRevision.confirmedBy || ''),
                planned: contractVerification.planned === true,
                // 把"没有确认人可核"单独标出来,免得下游只看 unverified.length 又读成"全绿"。
                noConfirmer: named.length === 0,
                verified: contractVerification.verified,
                unverified: bad,
                note: bad.length > 0
                  ? `已写进「契约修订台账」,但**有 ${bad.length} 个确认人查不到参与证据**(${bad.map((u) => `@${u.role}:${u.why}`).join(';')})—— 这属于"计划中的确认人",不是"已完成的确认人";台账行里已标 ⚠️ 未验证`
                  : (contractVerification.planned
                    ? '按"计划/待确认"登记:本次未做参与度反查(文案里已明说还没确认,这一栏不再冒充已确认)'
                    : (named.length > 0
                      ? '确认人参与度已核对(有绑定会话或互呼记录)'
                      : (contractVerification.empty
                        // 空值不能落到上一行那句"已核对"。
                        ? 'confirmedBy 为**空**:这一笔没有登记任何确认人,也就没有任何参与度可核对 —— 不要当成"已确认";要落实确认人请把 confirmedBy 补上后重新登记这一笔'
                        : `confirmedBy 里认不出任何角色 id(${String(a.contractRevision.confirmedBy || '').slice(0, 40)}):本次**没有做**参与度反查,不等于"已核对"—— 请按 profile 的角色 id 写(@pm/@arch/…),或明写"计划/待确认"表示这一栏还没落实`))),
                nextActions: bad.length > 0
                  ? [
                    `relay action=send from=<你> to=${first} msg="请复核契约修订:${String(a.contractRevision.content || '').slice(0, 40)}"`,
                    '拿到复核回覆后再调 workflow_state_save 重新登记这一笔(或把 confirmedBy 改成含"计划/待确认"的写法,表示这一栏还没落实)',
                  ]
                  : (named.length === 0 && !contractVerification.planned
                    ? ['把 confirmedBy 写成真实的确认人(@pm/@arch/…),或明写"计划/待确认"表示这一栏还没落实,再调一次 workflow_state_save']
                    : []),
              },
            }
          })() : {}),
          persistVia: isChildCaller ? 'relay-to-coordinator' : 'session-write',
          persistInstruction: isChildCaller
            ? `你是角色子会话(结果回不到主会话):把 ${DOC_BEGIN} 与 ${DOC_END} 之间的全文用 relay action=send to=${profile.coordinator} 发回协调者,由协调者/主会话统一 write 落盘${gateHint}`
            : `主会话:把 ${DOC_BEGIN} 与 ${DOC_END} 之间的全文用 write 写入 ${path.join(root, rel)}${gateHint}`,
          note: '插件只负责计算与合并;落盘由主会话的 write 工具完成(插件发起的 fs 写入会被沙箱拒绝)'
            // 静默激活的补口 —— 这次调用真的把项目记进了激活记忆就说出来,
            // 否则用户以为"只是存了一份文档",下次直接按已开工走。
            + (autoActivated ? `。⚠️ 本次调用顺手把 ${root} 记进了**激活记忆**(下次 load/save/status 不需要 .active 文件也直接开工);要撤销用 relay action=deactivate` : '')
            // 你传的 currentText 被忽略这件事也必须进 note —— render 渲染的就是 note,
            // 只放在 payload 字段里等于没说(反过来:偷偷用了 currentText 还报"合并来源:plugin-fs")。
            + (currentTextIgnored ? `。⚠️ 你传的 currentText(${suppliedText.length} 字)**未被采用**:插件读得到磁盘上的状态文件,以磁盘为准(照用你的全文会把磁盘新进度盖掉)` : ''),
          ...(autoActivated ? {
            autoActivated: true,
            activationNote: `已把 ${root} 记入激活记忆(下次可直接开工,不需要 .active 文件);要撤销用 relay action=deactivate`,
          } : {}),
        }
      },
    },
    {
      name: 'workflow_state_use',
      description: '多流程并行:切换状态文件到 流程状态-<需求名>.md,返回需要落盘的内容与指示。',
      parameters: { type: 'object', properties: { ...ROOT_PROP, stateName: { type: 'string', description: '需求名;留空=切回主状态文件' }, profile: { type: 'string' } }, required: [] },
      output: STATE_OUTPUT,
      async execute(args, exec) {
        const a = args || {}
        const root = resolveRoot(a, exec)
        const { profile } = resolveProfile(root, a.profile)
        const gate = gateStateOf(root)
        if (!isActiveGate(gate)) return { op: 'use', status: 'inactive', root, gate, profileId: profile.id, note: `${inactivePhrase(gate)}:先 relay action=kickoff 或 relay_spawn(会自动激活)` }
        const base = profile.state.file
        const hdr = defaultHeader({ coordinator: profile.coordinator })
        // 占位写法 `(空)`/`(空值)` 与"不传"等价 —— 若把它洗净成 `空值` 拼进文件名。
        const nm = isBlankStateNameToken(a.stateName) ? '' : safeStateName(a.stateName)
        if (!a.stateName || nm === '') {
          // 切回主状态文件时**必须回传磁盘现有内容**。回传空模板 hdr 时,
          // 而落盘指令又让会话把它 write 下去 —— 照做就会把真实进度整份清空(中档与大档各自踩到过)。
          const curBase = readMaybe(base, root)
          // 文案用 `(空值)`。若写成 `stateName=(空)`,gateStateName 就会把 `(空)`
          // 当需求名(safeStateName → `空_`)—— 主会话照抄这条**自己下的**指示,状态文件就落到
          // `流程状态-空_.md`,status 随后报 hasState=false、协调者重开一轮流程。
          return { op: 'use', status: 'switch', root, gate: 'active', targetPath: base, profileId: profile.id, documentText: curBase && curBase.exists ? curBase.text : hdr, existingState: !!(curBase && curBase.exists), persistInstruction: `主会话:把 ${ACTIVE_REL} 写成 active / stateName=(空值),即切回主状态文件` }
        }
        const rel = withStateName(base, nm)
        return {
          op: 'use', status: 'switch', root, gate: 'active', targetPath: rel, profileId: profile.id,
          documentText: (() => { const c = readMaybe(rel, root); return (c && c.exists ? c.text : hdr).replace('# 流程状态', `# 流程状态:${nm}`) })(),
          persistInstruction: `主会话:若 ${rel} 不存在则写入上方文档;并把 ${ACTIVE_REL} 写成 active / stateName=${nm}`,
        }
      },
    },
  ]

  /**
   * 四个 `workflow_state_*` 工具的 root 都可能是"按 cwd 推断"出来的
   * (resolveRootInfo.inferred),而对推断出来的根**一个字都不提** —— 该说的那句"可能不是你要的项目"
   * 必须出现在**每一次**返回上(inactive/absent/rendered/switch 各分支都有 return,逐个分支改容易漏),
   * 所以在这里统一包一层:推断出来的根一律补 `rootInferred`/`rootSource` 字段与一句 `note` 告警。
   * 显式传 root 或由角色绑定反查到的根不打这个标(那不是猜的)。
   */
  for (const stTool of stateTools) {
    const stOriginal = stTool.execute
    stTool.execute = async function guardedStateRoot(args, exec) {
      const info = resolveRootInfo(args || {}, exec)
      const out = await stOriginal(args, exec)
      if (!info.inferred || !out || typeof out !== 'object') return out
      const warn = `⚠️ 项目根是**推断**的(${info.source},${info.root}):本次没传 root,插件按 cwd 用了它 —— 可能不是你要的项目(尤其是被推断成工作区根/主目录时)。要落到别的目录请显式传 root=<绝对路径> 后重试。`
      const patched = Object.assign({}, out, {
        rootInferred: true,
        rootSource: info.source,
        rootInferredNote: warn,
      })
      patched.note = out.note ? `${out.note} ${warn}` : warn
      return patched
    }
  }

  // ── api-architect 技能(provider 形态,沿激活门)──────────────────
  //
  // 插件可以把技能注册进 DSH 技能目录(见文件头硬事实)。这里用 registerProvider 而不是静态
  // register,是为了让 api-architect 跟着**激活门**走 —— 只有激活的项目里它才出现在技能目录里。
  // 注意:门只挡技能,**不挡工具** —— 7 个工具是 apply 时无条件注册的全局行,
  // 每个会话都看得见。详见文件头硬事实那段的说明与 `tools` 契约的核对结论。
  // cfg.apiSkill: 'active'(默认)| 'always' | 'off'(只管 api-architect)。
  // cfg.roleSkills: 'active'(默认)| 'always' | 'off'(管上面 ROLE_SKILLS 那批角色联动技能)。
  let apiSkillControl = null
  let apiSkillCache = null
  const apiSkillGate = new Map() // cwd → 上次算出的候选集指纹(变了就 invalidate 目录缓存)

  function readApiSkill() {
    if (apiSkillCache) return apiSkillCache
    const file = path.join(API_SKILL_DIR, 'SKILL.md')
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { return null }
    const parsed = parseSkillFrontmatter(text)
    apiSkillCache = {
      file,
      body: parsed.body,
      name: String(parsed.attrs.name || API_SKILL_NAME),
      description: String(parsed.attrs.description || '专家级 API 设计规范(REST / GraphQL / gRPC):契约、错误结构、版本化、限流、鉴权。'),
      whenToUse: String(parsed.attrs.whenToUse || ''),
      version: String(parsed.attrs.version || ''),
    }
    return apiSkillCache
  }

  function apiSkillMode() {
    const m = String(cfg.apiSkill || 'active')
    return m === 'always' || m === 'off' ? m : 'active'
  }

  /**
   * 角色联动技能。
   *
   * 与 api-architect 的两处差别,都是刻意的:
   *   · **按 mtime 重读**(api-architect 是进程内一次性缓存)。这一批有 18 份、正文常在改,
   *     沿用"参考件按 mtime 失效"口径更省心:改完 SKILL.md 立刻生效,不用重启;
   *   · rank 550(api-architect 是 60)。理由见 ROLE_SKILL_RANK 的注释。
   */
  const roleSkillCache = new Map() // name → { mtimeMs, ...读出来的正文 }
  let roleSkillMisses = 0

  function roleSkillDir(name) {
    return path.join(SKILLS_ROOT, name)
  }

  function readRoleSkill(name) {
    const key = String(name || '')
    if (key === '') return null
    const file = path.join(roleSkillDir(key), 'SKILL.md')
    let mtimeMs = 0
    try { mtimeMs = fs.statSync(file).mtimeMs } catch { return null }
    const hit = roleSkillCache.get(key)
    if (hit && hit.mtimeMs === mtimeMs) return hit
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { return null }
    const parsed = parseSkillFrontmatter(text)
    const entry = {
      file,
      mtimeMs,
      dir: roleSkillDir(key),
      body: parsed.body,
      name: String(parsed.attrs.name || key),
      // frontmatter 是随包正文的**唯一事实来源**:目录里显示的那行描述就来自这里
      // (没写 description 的技能在目录里等于一条没有说明的条目 —— 宁可不进目录)。
      description: String(parsed.attrs.description || ''),
      whenToUse: String(parsed.attrs.whenToUse || ''),
      version: String(parsed.attrs.version || ''),
    }
    if (entry.description === '') { roleSkillMisses += 1; return null }
    roleSkillCache.set(key, entry)
    return entry
  }

  function roleSkillsMode() {
    const m = String(cfg.roleSkills || 'active')
    return m === 'always' || m === 'off' ? m : 'active'
  }

  /**
   * 状态面与提供者必须走**同一条链**。
   *
   * 提供者那条链是:`candidatesForCwd(cwd)` → `skillRootForCwd(cwd)` → 拿**它**的档案收窄。
   * 而状态面若走「`isActive(root)` 或反查命中」判可见、却按**传入 root 的档案**数份数 ——
   * 两条链在"cwd 不是任何活跃项目根、但它恰好是某个活跃项目角色子会话的 cwd"时分叉。
   * 实测(活进程):
   *   ① 未激活的 root 报「激活:none(未激活)」与「23/23 个可见(档案 standard)」**并列**,
   *      而同一 cwd 的真实目录其实按反查到的项目(lean3)收窄 —— 实测 `excalidraw` 不可用;
   *   ② 角色子会话被停掉后提供者已返回空集(`ponytail` / `testing-strategy` 双双 unknown),
   *      回执照旧报「12/23 个可见(档案 review)」;
   *   ③ 派回一个角色子会话,同一个名字**立刻**可用。
   * 现在:可见性、收窄档案、份数**全部**以 `skillRootForCwd` 的结果为准;反查命中别的项目时,
   * 回执里**写明来路**(本 root 未激活 + 会话级目录按哪个项目的哪份档案走)。
   */
  function roleSkillRoot(root) {
    const r = String(root || '')
    if (r === '') return ''
    return skillRootForCwd(r)
  }

  function roleSkillsVisible(root) {
    const mode = roleSkillsMode()
    if (mode === 'off') return false
    if (mode === 'always') return true
    return roleSkillRoot(root) !== ''
  }

  /**
   * 当前根下该露出的角色技能(按档案的角色集收窄)。
   *
   * `resolveProfile` 拿不到"是谁在问"(技能提供者的 list() 只有 cwd),所以口径是
   * **这个项目用哪份档案、这份档案有哪些角色** —— 与 `relay_spawn` 能派谁完全一致:
   * lean3 里根本不存在的 arch/fe 两个角色,其技能也就不进目录。
   * 每份 SKILL.md 都读不出来时如实少列(不编条目);配置 `roleSkills=always` 可放开。
   *
   * 收窄基准取 `roleSkillRoot(root)` —— 反查命中别的项目时用**那个项目**的档案,
   * 与提供者 `candidatesForCwd` 逐字同源(按传入 root 的档案算会让状态行报的份数
   * 和真实目录对不上)。
   */
  function roleSkillNames(root) {
    if (!roleSkillsVisible(root)) return []
    const { profile } = resolveProfile(roleSkillRoot(root) || root, undefined)
    const ids = new Set((profile.roles || []).map((r) => String(r.id || '')))
    const out = []
    for (const s of ROLE_SKILLS) {
      if (!s.roles.some((r) => ids.has(r))) continue
      if (readRoleSkill(s.name)) out.push(s.name)
    }
    return out
  }

  /** status 里一行话讲清角色技能现状(有几个 / 本档案可见几个 / 为什么看不见)。 */
  function roleSkillsSummary(root) {
    const mode = roleSkillsMode()
    const r = String(root || '')
    // 基准 root 与提供者同源(见 roleSkillRoot 的注释)—— '' 表示"这个 cwd 上没有活跃项目的角色子会话"
    const basis = mode === 'always' ? (roleSkillRoot(r) || r) : roleSkillRoot(r)
    const visible = roleSkillsVisible(root)
    const names = roleSkillNames(root)
    const byRole = {}
    for (const s of ROLE_SKILLS) {
      for (const r2 of s.roles) byRole[r2] = (byRole[r2] || 0) + 1
    }
    const allBreakdown = ROLE_IDS.filter((x) => byRole[x]).map((x) => `${x} ${byRole[x]}`).join(' / ')
    if (mode === 'off') return `随包角色技能 ${ROLE_SKILLS.length} 个(${allBreakdown}):隐藏(roleSkills=off)`
    if (!visible) return `随包角色技能 ${ROLE_SKILLS.length} 个(${allBreakdown}):隐藏(本 root 未激活,且这个 cwd 上没有活跃项目的角色子会话)`
    const { profile } = resolveProfile(basis || r, undefined)
    const idSet = new Set((profile.roles || []).map((x) => String(x.id || '')))
    /**
     * 逐角色分布若**按全表**算,而前面那个"可见份数"按**本档案**算 ——
     * 两者并排时,`lean3` 项目会打出「21/23 个可见(档案 lean3):pm 1 / **arch 4** / be 13 …」:
     * `arch` 这个角色在 lean3 里**根本不存在**(它那 4 份技能一份都没进目录),读者却会合理地把
     * `arch 4` 读成"有 4 份 arch 技能可见"。与同一族问题一致 —— 回执里的数字必须
     * 说得出单位与来路,不许自相矛盾。现在:逐角色分布**只列本档案真有的角色**,并补一句点名
     * "哪些角色不在本档案、因此有多少份没进目录"。
     *
     * **收窄基准**也必须与提供者同源。反查命中**别的**活跃项目时
     * (本 root 自己没激活,但此 cwd 与那个项目的角色子会话同址),就在行里**写明来路** ——
     * 否则读者会把"按 l-platform 的 lean3 收窄"读成"本项目的档案是 lean3"。
     */
    const shown = ROLE_IDS.filter((x) => idSet.has(x) && byRole[x]).map((x) => `${x} ${byRole[x]}`).join(' / ')
    const absent = ROLE_IDS.filter((x) => !idSet.has(x))
    const hidden = ROLE_SKILLS.length - names.length
    const tail = absent.length > 0
      ? `;未进目录 ${hidden} 份(本档案没有 ${absent.join(' / ')} ${absent.length > 1 ? '这几个角色' : '这个角色'})`
      : ''
    const via = basis !== '' && basis !== r
      ? ` —— 本 root 未激活;此 cwd 与活跃项目 ${path.basename(basis)} 的角色子会话同址,会话级目录按它的档案走`
      : ''
    return `随包角色技能 ${names.length}/${ROLE_SKILLS.length} 个可见(档案 ${profile.id}${via}):${shown}${tail}`
      + (roleSkillMisses > 0 ? ` ⚠️ 有 ${roleSkillMisses} 份 SKILL.md 读不出或缺 description,已跳过` : '')
  }

  /**
   * 技能文本 frontmatter 里自称的版本(`SKILL.md` 的 `version:`)。
   * 技能版本读进来之后若**没有任何一处显示它**,它会停在 1.2.0 而插件走到
   * 新版本也无人发现。所以由 apiView.skill 与插件版本并排显示,不一致时点名。
   * 读不到技能 / 没写 version → 返回空串(调用处据此不显示,不编一个数出来)。
   */
  function apiSkillVersion() {
    const s = readApiSkill()
    return s ? String(s.version || '') : ''
  }

  function apiSkillVisible(root) {
    const mode = apiSkillMode()
    if (mode === 'off') return false
    if (mode === 'always') return true
    return skillRootForCwd(root) !== ''
  }

  /**
   * 技能提供者拿到的只有**调用方 cwd**,而角色子会话的 cwd 继承自调度者
   * (实测 = 调度者的 cwd,而项目根是它下面另一个目录)。直接拿 cwd 现算激活门,
   * 于是角色子会话永远加载不到随包技能,而 `relay action=status` 按项目根算、照样报「可见」——
   * status 与实际能力自相矛盾。这里补一条反查:某个**活跃项目**的角色绑定里,有 agent 的 cwd
   * 恰好等于这个 cwd,那就认为这个 cwd 属于该项目。
   */
  function skillRootForCwd(cwd) {
    const c = String(cwd || '')
    if (c === '') return ''
    if (isActive(c)) return c
    for (const key of Object.keys(store.projects)) {
      const slot = store.projects[key]
      if (!slot || slot.rootMissing === true) continue
      const r = String(slot.root || '')
      if (r === '' || !isActive(r)) continue
      for (const role of Object.keys(slot.roleAgents || {})) {
        const a = agentOf(slot.roleAgents[role])
        if (a && cwdOf(a) === c) return r
      }
    }
    return ''
  }

  function apiSkillFilePath() {
    return path.join(API_SKILL_DIR, 'SKILL.md')
  }

  /** status 里一行话讲清技能现状(可见性 + 版本)。 */
  function apiSkillSummary(root) {
    const skill = readApiSkill()
    if (!skill) return `api-architect(缺文件,预期 ${apiSkillFilePath()})`
    const mode = apiSkillMode()
    const visible = apiSkillVisible(root)
    return `api-architect v${skill.version || '?'} ${visible ? '可见' : `隐藏(${mode === 'off' ? 'apiSkill=off' : '项目未激活'})`}`
  }

  /**
   * 注册**一个**提供者,交出**两批**技能:
   *   · `api-architect`(cfg.apiSkill 管,rank 60)—— 与 `api_contract` 工具同源;
   *   · `ROLE_SKILLS` 那 18 份角色联动技能(cfg.roleSkills 管,rank 550)。
   *
   * 为什么是一个提供者而不是 19 个:提供者名在同一层里必须唯一(`skills.registerProvider`
   * 重名直接抛),19 个提供者就要 19 个名字;而 `get(candidate)` 本来就收 candidate,
   * 从 `candidate.locator.name` 分流比"注册 19 次"更省、也更容易守住"可见性一起翻转"这条不变量
   * (激活门一翻,两批技能在**同一次 list** 里一起出现/一起消失,不会出现半开状态)。
   */
  function registerBundledSkills() {
    const skills = ctx.get('skills')
    if (!skills || typeof skills.registerProvider !== 'function') {
      ctx.logger?.warn?.(`[${NAME}] skills 服务不可用:随包技能未注册(api_contract 工具仍可用)`)
      return false
    }
    const dispose = skills.registerProvider((control) => {
      apiSkillControl = control
      /** 按 cwd 现算候选集;指纹变了就 invalidate(激活门翻转 / 档案切换都会变)。 */
      function candidatesForCwd(cwd) {
        const root = skillRootForCwd(cwd)
        const out = []
        if (cfg.enableApi !== false && apiSkillVisible(cwd)) {
          const skill = readApiSkill()
          if (skill) {
            out.push({
              name: skill.name,
              description: skill.description,
              source: 'runtime',
              provider: NAME,
              invocation: { modelInvocable: true, userInvocable: true },
              resourceBase: { kind: 'directory', path: API_SKILL_DIR },
              path: skill.file,
              rank: 60,
              locator: { kind: 'dev-workflow-skill', name: skill.name, file: skill.file, version: skill.version },
              whenToUse: skill.whenToUse || undefined,
            })
          }
        }
        for (const name of roleSkillNames(root)) {
          const skill = readRoleSkill(name)
          if (!skill) continue
          out.push({
            name: skill.name,
            description: skill.description,
            source: 'runtime',
            provider: NAME,
            invocation: { modelInvocable: true, userInvocable: true },
            resourceBase: { kind: 'directory', path: skill.dir },
            path: skill.file,
            rank: ROLE_SKILL_RANK,
            locator: { kind: 'dev-workflow-skill', name: skill.name, file: skill.file, version: skill.version },
            whenToUse: skill.whenToUse || undefined,
          })
        }
        for (const c of out) if (c.whenToUse === undefined) delete c.whenToUse
        return out
      }
      return {
        // 提供者名带插件前缀,避免与 DSH 自带的 filesystem 提供者撞名
        name: NAME,
        async list(options) {
          const cwd = options && options.cwd ? String(options.cwd) : ''
          const candidates = candidatesForCwd(cwd)
          const signature = candidates.map((c) => c.name).join(',')
          const last = apiSkillGate.get(cwd)
          if (last !== undefined && last !== signature && apiSkillControl && typeof apiSkillControl.invalidate === 'function') {
            // 可见性翻了(.active 被建/被删、档案换了)→ 主动让目录缓存失效,下一次 list 就跟着变
            try { apiSkillControl.invalidate() } catch { /* ignore */ }
          }
          apiSkillGate.set(cwd, signature)
          return { candidates, complete: true }
        },
        /**
         * 按 `candidate.locator.name` 分流(见 registerBundledSkills 的注释)。
         * 拿不到 locator(理论上不会)时退回"按 candidate.name 找一遍"—— 宁可多花一次查找,
         * 也不要静默返回 undefined 让 `skill` 工具报"技能不可用"。
         */
        async get(candidate) {
          const loc = (candidate && candidate.locator) || {}
          const wanted = String(loc.name || (candidate && candidate.name) || '')
          const skill = wanted === API_SKILL_NAME ? readApiSkill() : readRoleSkill(wanted)
          if (!skill) return undefined
          const def = {
            name: skill.name,
            description: skill.description,
            source: 'runtime',
            provider: NAME,
            invocation: { modelInvocable: true, userInvocable: true },
            resourceBase: { kind: 'directory', path: skill.dir || API_SKILL_DIR },
            content: skill.body,
            path: skill.file,
          }
          if (skill.whenToUse) def.whenToUse = skill.whenToUse
          return def
        },
      }
    })
    ctx.effect(() => dispose)
    return true
  }

  // ── api_contract —— 技能的可执行一面 ──────────────────────────────
  const API_OUTPUT = {
    schema: { type: 'object', additionalProperties: true },
    render(args, value) {
      const v = value || {}
      const lines = [`api_contract ${v.op || '?'} → ${v.status || 'ok'}`]
      if (versionMismatch) lines.push(`⚠️ 版本不一致:进程内 v${VERSION} ≠ 磁盘 v${diskVersion} —— 部署后没重启`)
      if (versionUnverifiable) lines.push(`⚠️ 版本自证失效:${diskVersionError} —— 进程内是 v${VERSION},但"磁盘有没有换版"无从判断`)
      if (v.scanNote) lines.push(v.scanNote) 
      /**
       * `scanSkipped` / `scanSkippedNote` 在 lint/status 两条
       * 路径里都写好了,但 render 只输出 `scanNote` —— **结构化字段在、模型看不见**,
       * 与 `STATE_OUTPUT.render` 同一族缺陷。
       * 实测现场:paths 指向的目录里 1 个文件超 512 KB、1 个超 2 层深度(discoverApiSpecs 的
       * `found.skipped` 有 2 条),而回执一个字都没提 —— "契约明明在,插件却说扫不到"这个现场
       * 依然没法自查 —— 这件事修在了数据面、没修到显示面。
       */
      if (v.scanSkippedNote) lines.push(v.scanSkippedNote)
      if (v.root) lines.push(`项目根:${v.root}`)
      if (v.note) lines.push(String(v.note))
      if (v.skillName) lines.push(`技能 ${v.skillName}:${v.skillVisible ? '✓ 当前项目可见(激活门已开)' : `✗ 当前项目不可见(${v.skillHiddenReason || '未激活'})`}${!v.skillVisible && v.skillPath ? ` | 查找位置:${v.skillPath}` : ''}`)
      // 这几个字段若**没有任何显示路径**, 排查"扫不到/判给谁"时全靠猜。
      // 回显口径:短、且只在相关动作上出现,不给每次调用刷噪音。
      if (v.profileId && v.op !== 'guide' && v.op !== 'checklist') lines.push(`档案:${v.profileId}`)
      if (typeof v.scanned === 'number') {
        // 扫描行也要写清覆盖面 —— 只写"候选 N 个"时,被跳过的那几个候选
        // 等于不存在,读者无从判断这条结论覆盖了多少。
        // 口径 v2:有未展开子树时别说"候选 N 个文件" —— 那是一句没根据的话。
        const cov = v.scanCoverage
        const specsN = Array.isArray(v.specs) ? v.specs.length : 0
        // 明细被截断时,"候选 N 个文件"这种带精确总数的写法不成立(总数里少了
        // 那几条没有明细的)→ 与"有未展开子树"走同一条如实话术,并注明构成只按已留明细算。
        lines.push(cov && cov.skipped > 0
          ? (((cov.regions || 0) > 0 || cov.truncated)
            ? `扫描:已扫描 ${cov.covered} 个候选文件 + 跳过 ${apiSkipCountText(cov)} 处(${apiSkipBreakdown(cov)}${cov.truncated ? ',只按已留明细算' : ''})→ 契约 ${specsN} 个`
            : `扫描:候选 ${cov.total} 个文件(已扫描 ${cov.covered} / 跳过 ${cov.skipped})→ 契约 ${specsN} 个`)
          : `扫描:候选 ${v.scanned} 个文件 → 契约 ${specsN} 个`)
      }
      if (Array.isArray(v.specs) && v.specs.length > 0) {
        for (const s of v.specs) lines.push(`  - ${s.rel} [${s.kind}]`)
      }
      // "契约类型分布"与"到底扫了哪些目录"若不回显 ——
      // 而"契约明明在却扫不到"这种现场,第一件要核对的就是这两样(同一族)。
      if (v.kinds && typeof v.kinds === 'object' && Object.keys(v.kinds).length > 0) {
        lines.push(`契约类型:${Object.keys(v.kinds).map((k) => `${k} ${v.kinds[k]}`).join(' / ')}`)
      }
      if (Array.isArray(v.scanDirs) && v.scanDirs.length > 0 && ((Array.isArray(v.specs) && v.specs.length === 0) || (v.scanCoverage && v.scanCoverage.skipped > 0))) {
        lines.push(`候选目录(相对项目根,深度 ≤ ${API_SCAN_MAX_DEPTH}):${v.scanDirs.join(', ')}`)
      }
      if (typeof v.errors === 'number') {
        // 口径 v2:覆盖面的说法**只由 apiCoverageText 出** —— 有未展开子树时它不给分数,
        // 改成"已扫到的 M 个候选(另有 S 处未扫到,子树内容未知)";全是文件跳过时逐字同原有口径。
        const covTxt = v.scanCoverage && v.scanCoverage.skipped > 0 ? apiCoverageText(v.scanCoverage) : ''
        const cls = v.verdict === 'fail' ? '❌ FAIL'
          : (v.verdict === 'pass_with_skips'
            // 它是"ERROR 0 但覆盖面不全",不是通过
            ? `⚠️ 通过但**只覆盖 ${covTxt || '部分候选'}**(有跳过,**不算完整通过**)`
            : (v.verdict === 'pass_with_warnings' ? '⚠️ 通过但有告警'
              : (v.verdict === 'no_specs' ? '➖ 无契约可校验(**不算通过**)' : '✅ PASS')))
        lines.push(`结论:${cls} | ERROR ${v.errors} / WARN ${v.warnings} / INFO ${v.infos || 0}${covTxt ? ` | 覆盖面 ${covTxt}` : ''}`)
      }
      if (v.scanVerdictNote) lines.push(String(v.scanVerdictNote))
      if (Array.isArray(v.findings) && v.findings.length > 0) {
        for (const f of v.findings) {
          const mark = f.level === 'error' ? '❌' : (f.level === 'warn' ? '⚠️' : 'ℹ️')
          lines.push(`  ${mark} ${f.file}${f.line ? `:${f.line}` : ''} [${f.rule}] ${f.message}${f.fix ? ` → ${f.fix}` : ''}`)
        }
      }
      if (typeof v.truncated === 'number' && v.truncated > 0) lines.push(`  …另有 ${v.truncated} 条未列出`)
      if (v.apiLint) {
        // 口径 v2:有未展开子树时 apiCoverageText 里已经写了"另有 N 处未扫到",
        // 这里不再重复",跳过 N"(更早的记录没有 exactTotal,照旧带上,不改原有说法)。
        const lc = v.apiLint.coverage
        const covTail = lc ? `(覆盖 ${apiCoverageText(lc)}${lc.exactTotal === false ? '' : `,跳过 ${lc.skipped}`})` : ''
        lines.push(`上次 lint:${v.apiLint.at} | ERROR ${v.apiLint.errors} / WARN ${v.apiLint.warnings} → ${v.apiLint.verdict}${covTail}${v.apiLint.digest ? ` | 契约指纹 ${String(v.apiLint.digest).slice(0, 12)}…` : ' | ⚠️ 该记录没存指纹,无法核对是否同一批文件'}`)
      }
      if (v.specDrift) lines.push(`⚠️ 契约指纹漂移:磁盘当前 ${String(v.specDigest || '').slice(0, 12)}… ≠ 记录里的 ${String((v.apiLint && v.apiLint.digest) || '').slice(0, 12)}… —— 上次那句结论已经作废(它对应的文件已不在),请重跑 action=lint`) 
      if (v.assetPath) lines.push(`模板来源:${v.assetPath}(随包参考件;原样落盘会被归属校验判 ERROR)`)
      if (v.targetPath) lines.push(`落盘目标:${v.targetPath}`)
      if (v.persistInstruction) lines.push(v.persistInstruction)
      if (v.text) { lines.push(''); lines.push(String(v.text)) }
      if (v.documentText) { lines.push('-----BEGIN 模板-----'); lines.push(String(v.documentText)); lines.push('-----END 模板-----') }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  }

  const apiTool = {
    name: 'api_contract',
    description:
      'dev-workflow 的 API 契约工具(api-architect 技能的可执行一面):action=guide 选范式/信封/版本化;'
      + 'action=template 取 OpenAPI 3.1 / GraphQL SDL / .proto / 限流 / 安全模板全文(由主会话用 write 落到 docs/api/);'
      + 'action=lint 递归扫描项目里的契约文件做校验(ERROR / WARN 两级,ERROR>0 即 FAIL);'
      + 'action=checklist 出质检核对表;action=status 看项目里有哪些契约与上次 lint 结论。'
      + '插件无工作区写权限,模板与 spec 一律取全文交会话落盘。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['guide', 'template', 'checklist', 'lint', 'status'], description: 'guide=范式与规矩(默认);template=取模板;lint=校验;checklist=核对表;status=现状' },
        kind: { type: 'string', enum: ['openapi', 'graphql', 'proto', 'ratelimit', 'security'], description: 'template 要哪份模板(默认 openapi)' },
        paths: { type: 'array', items: { type: 'string' }, description: 'lint/status 额外扫描的路径(文件或目录,相对项目根)。⚠️ 语义是**追加**:结果 = 默认候选目录 ∪ paths(不是"只扫这里");想只覆盖某处就用 `relay`/`status` 回执里的「候选目录」核对。⚠️ 超过 512 KB 的文件**即便精确指到文件路径也会被跳过**,这类只能拆小或登记为未校验' },
        ...ROOT_PROP,
        profile: { type: 'string' },
      },
      required: [],
    },
    output: API_OUTPUT,
    async execute(args, exec) {
      const a = args || {}
      const action = a.action || 'guide'
      const root = resolveRoot(a, exec)
      const { profile } = resolveProfile(root, a.profile)
      const skill = readApiSkill()
      const skillVisible = apiSkillVisible(root)
      const base = {
        root, profileId: profile.id,
        skillName: API_SKILL_NAME,
        skillVisible,
        skillPath: apiSkillFilePath(),
      }
      if (!skillVisible) base.skillHiddenReason = apiSkillMode() === 'off' ? 'apiSkill=off' : inactivePhrase(gateStateOf(root))

      if (action === 'guide') {
        return Object.assign(base, {
          op: 'guide', status: 'ok',
          text: apiGuide(),
          note: skill ? `技能 ${API_SKILL_NAME} v${skill.version || '?'} 随包发布:${skill.file}` : `插件包内找不到 ${apiSkillFilePath()}(安装时 skills/ 目录没一起拷?)`,
        })
      }

      if (action === 'checklist') {
        return Object.assign(base, { op: 'checklist', status: 'ok', text: apiChecklist() })
      }

      if (action === 'template') {
        const kind = String(a.kind || 'openapi')
        const entry = API_TEMPLATES[kind]
        if (!entry) {
          return Object.assign(base, { op: 'template', status: 'invalid_kind', note: `未知模板 ${kind};可用:${Object.keys(API_TEMPLATES).join(', ')}` })
        }
        const asset = path.join(API_SKILL_DIR, 'references', entry[0])
        let text = ''
        try { text = fs.readFileSync(asset, 'utf8') } catch {
          return Object.assign(base, { op: 'template', status: 'missing_asset', assetPath: asset, note: `插件包内缺少参考件:${asset}` })
        }
        const rel = `${API_SPEC_DIR}/${entry[1]}`
        return Object.assign(base, {
          op: 'template', status: 'ok', kind, assetPath: asset,
          targetPath: path.join(root, rel),
          documentText: text,
          persistInstruction: `主会话:把 BEGIN/END 之间的模板用 write 落到 ${rel},再按项目改 base URL / 鉴权 / 错误结构;改完跑 api_contract action=lint。⚠️ 模板原文**不是**本项目的契约 —— lint 现在会做归属校验(与包内参考件逐行重合 ≥85% 直接判 ERROR),照抄落盘必挂。`,
        })
      }

      if (action === 'lint' || action === 'status') {
        const found = discoverApiSpecs(root, a.paths)
        const { slot, coord } = slotFor(profile, root, coordinators)
        const out = Object.assign(base, { op: action, scanned: found.length, scanDirs: API_SCAN_DIRS.slice() })
        // 把"静默跳过"摆到台面上 —— 否则"契约明明在,却报候选 0"根本没法自查。
        // 留痕必须带**覆盖面**,建议必须**按 reason 分支** —— 否则那句
        // "请用 paths 精确指路"对 oversize 是错的(size 守卫对 paths 同样生效),只列前 3 条
        // 也让第 4 条起永久不可见。
        // 第三个参数是**不封顶的计数**(`found.skipped` 只是明细,截断后它的
        // length 会小于真实跳过条数)。不传也不会错 —— apiSkipCoverage 会自己从数组上取。
        const coverage = apiSkipCoverage(found.skipped, found.length, found.skippedTotal)
        if (coverage.skipped > 0) {
          out.scanSkipped = coverage.entries
          out.scanCoverage = coverage
          out.scanSkippedNote = apiSkipNote(coverage)
        }
        // 扫描有 80 文件 / 512KB 上限,而且是按 readdir 顺序取的 —— 到了上限,
        // 新增一个无关文件就可能把某份契约挤出窗口,指纹随之变化,看起来"漂移"其实什么都没改。
        // 说清楚"这次扫描被截断",漂移才有得解释。
        if (found.length >= API_SCAN_MAX_FILES) {
          out.scanTruncated = true
          out.scanNote = `⚠️ 候选文件已达扫描上限 ${API_SCAN_MAX_FILES} 个:**本次结果只覆盖其中一部分**(按目录读取顺序取前 ${API_SCAN_MAX_FILES} 个)—— 指纹漂移可能只是"有契约被挤出窗口",不是文件被改。请用 paths 明确指定契约目录。`
        }
        // 盘上这批契约的**当前**指纹。lint 记录里存一份,status 拿它和记录对账 ——
        // spec 被整体换掉后再看"上次 lint ERROR 0",能立刻看出"那不是同一批文件"。
        const nowSpecs = found.filter((f) => f.kind !== 'generic').map((f) => ({ rel: f.rel, kind: f.kind, bytes: Buffer.byteLength(String(f.text || ''), 'utf8'), sha256: sha256Hex(f.text) }))
        const nowDigest = specDigest(nowSpecs)
        if (action === 'status') {
          const specs = found.filter((f) => f.kind !== 'generic').map((f) => ({ rel: f.rel, kind: f.kind, size: f.size }))
          out.specs = specs
          out.status = 'ok'
          out.apiLint = slot.apiLint || null
          out.specDigest = nowDigest
          // 磁盘指纹与上次 lint 时不一致 = 上次的结论已经不可复现(这就是留指纹要回答的问题)
          //
          // 记录里**没存指纹**时(更早写的记录),返回 false 就会渲染
          // "指纹 …,与磁盘一致" —— 它根本没有比对过任何东西(指纹位置是空的,
          // 却宣称一致;而同一屏的另一行却在说"无法核对是否同一批文件",自相矛盾)。
          // 现在这种情形返回 null(未知),不再冒充"已核对"。
          const recDigest = slot.apiLint && slot.apiLint.digest ? String(slot.apiLint.digest) : ''
          out.specDrift = recDigest && nowDigest ? recDigest !== nowDigest : null
          out.specDriftUnknown = !recDigest && !!slot.apiLint
          out.note = specs.length === 0
            ? (out.pathsGiven && out.pathsGiven.length > 0
              ? `你给的 paths(${out.pathsGiven.join(', ')})里没找到契约文件:先确认路径拼写、相对位置(相对项目根)与目录是否存在 —— 别把它读成"项目没写 spec"`
              : `没找到契约文件;先 action=template 取一份落到 ${API_SPEC_DIR}/,或把已有 spec 的目录用 paths 传进来`)
            : (!slot.apiLint
              ? `契约 ${specs.length} 个;还没跑过 lint(建议 action=lint)`
              : (out.specDrift === true
                ? `⚠️ 磁盘上的契约与上次 lint 时**不是同一批文件**(指纹 ${String(nowDigest).slice(0, 12)}… ≠ 记录的 ${recDigest.slice(0, 12)}…):上次那条「${slot.apiLint.verdict} @${slot.apiLint.at}」已经不成立,请重跑 action=lint`
                : (out.specDrift === null
                  ? `契约 ${specs.length} 个;上次 ${slot.apiLint.at} 判定 ${slot.apiLint.verdict},但**那条记录没存指纹**,无法核对是否同一批文件 —— 请重跑一次 action=lint 建立指纹`
                  // 这一行一直硬写着 `covered/total` —— 于是
                  // 口径 v2 明令"分母不精确时不给分数"的规矩在这**唯一一处**漏了:一棵装着 50 份
                  // 契约的子树会被当成 1 个候选塞进分母,"覆盖 1/20"照样打得出来。现在与面板同源
                  // (更早的记录没有 exactTotal 时 apiCoverageText 仍按原有写法给 `1/4`,不改原有结论)。
                  : `契约 ${specs.length} 个;上次 ${slot.apiLint.at} 判定 ${slot.apiLint.verdict}${slot.apiLint.coverage ? `(覆盖 ${apiCoverageText(slot.apiLint.coverage, true)})` : ''}(指纹 ${recDigest.slice(0, 12)}…,与磁盘一致)`)))
          return out
        }
        const res = lintApiFiles(found.map((f) => ({ rel: f.rel, text: f.text })))
        /**
         * 判定必须**跟着覆盖面走**。ERROR 0 只对"扫描到的那些候选"成立时,
         * 直接报 `✅ PASS` 会把"只覆盖 M/N 个候选"读成"整个项目已过门槛"(活体
         * 具体表现:上写「⚠️ 有 3 个候选被跳过」、下写「结论:✅ PASS | ERROR 0 / WARN 0」)。
         *
         * 降级只发生在**本来是"通过"的两种判定**上:`fail` 更紧急、`no_specs` 已经明说
         * "不算通过",这两者保持原判(覆盖面照样渲染出来,不掩盖)。
         */
        const degraded = coverage.skipped > 0 && (res.verdict === 'pass' || res.verdict === 'pass_with_warnings')
        const verdict = degraded ? 'pass_with_skips' : res.verdict
        if (degraded) {
          // 口径 v2:分母里有未展开的子树时**不许说"整体候选 N 个"** —— 那是未知数。
          out.scanVerdictNote = coverage.exactTotal
            ? `⚠️ 判定降级:ERROR 0 只对**已扫描到的 ${coverage.covered} 个候选**成立(整体候选 ${coverage.total} 个,跳过 ${coverage.skipped} 个)→ verdict=\`pass_with_skips\`,**不算通过**。`
            : `⚠️ 判定降级:ERROR 0 只对**已扫描到的 ${coverage.covered} 个候选**成立(跳过 ${apiSkipCountText(coverage)} 处:${apiSkipBreakdown(coverage)}${coverage.truncated ? ',只按已留明细算' : ''};子树里还有几个候选是未知数,**整体候选数无法确定**)→ verdict=\`pass_with_skips\`,**不算通过**。`
        }
        slot.apiLint = Object.assign(
          { at: makeTS(), root, files: res.files.length, errors: res.errors, warnings: res.warnings, verdict, digest: res.digest, specs: res.files },
          coverage.skipped > 0 ? { coverage: { covered: coverage.covered, skipped: coverage.skipped, total: coverage.total, files: coverage.files, regions: coverage.regions, exactTotal: coverage.exactTotal, reasons: coverage.reasons, skippedTotal: coverage.skippedTotal, missingDetail: coverage.missingDetail, truncated: coverage.truncated } } : {},
        )
        syncSlot(slot, coord)
        saveStore()
        out.status = 'ok'
        out.specs = res.files
        out.kinds = res.kinds
        out.errors = res.errors
        out.warnings = res.warnings
        out.infos = res.infos
        out.verdict = verdict
        out.specDigest = res.digest
        // 截断前必须把 **ERROR 排到前面**。按原顺序 `slice(0, 40)` 会让
        // 实测「11 份各 4 条 warn 的契约 + 第 12 份缺 info」时,唯一的 ERROR 被挤出可见集,
        // 而回执同时写着"ERROR 未清零:按 fix 逐条改完再跑一次",模型会把整轮花在改 warn 上,
        // 下一轮 ERROR 才浮出来。排序稳定,同级内部顺序不变。
        const findingsOrdered = res.findings.slice().sort((x, y) => (x.level === 'error' ? 0 : 1) - (y.level === 'error' ? 0 : 1))
        out.findings = findingsOrdered.slice(0, API_FINDINGS_INLINE_MAX)
        out.truncated = Math.max(0, res.findings.length - out.findings.length)
        // 若 ERROR 本身多到截断(>40 条),必须让模型知道"还有 ERROR 没列出来"
        out.truncatedErrors = Math.max(0, Number(res.errors || 0) - out.findings.filter((f) => f.level === 'error').length)
        // "paths 拼错/目录不存在"与"目录里确实没有 spec"若在回执里
        // **一字不差**,而这两件事的处理正好相反(一个去改 paths,一个去写 spec)。
        const pathsGiven = Array.isArray(a.paths)
          ? a.paths.map((x) => String(x === undefined || x === null ? '' : x).trim()).filter((x) => x !== '')
          : (a.paths === undefined || a.paths === null || String(a.paths).trim() === '' ? [] : [String(a.paths).trim()])
        out.pathsGiven = pathsGiven
        out.note = res.files.length === 0
          ? (pathsGiven.length > 0
            ? `你给的 paths(${pathsGiven.join(', ')})里**一个候选文件都没扫到**:先确认路径拼写、相对位置(相对项目根)与目录是否存在 —— 别把它读成"项目没写 spec"(这两件事的处理相反)。默认候选目录:${API_SCAN_DIRS.join(', ')}`
            : `没扫到契约文件(候选 ${found.length} 个):**此结果不算通过**,别拿它当 API 门槛的证据;先 action=template 取模板落到 ${API_SPEC_DIR}/,或把已有 spec 的目录用 paths 传进来`)
          : (verdict === 'fail'
            ? `ERROR 未清零:按 fix 逐条改完再跑一次,别带着 ERROR 写进「API 契约」小节${out.truncatedErrors > 0 ? `(⚠️ 另有 ${out.truncatedErrors} 条 ERROR 超出列表上限未列出,先按上面列出的 ERROR 改)` : ''}`
            : (degraded
              // 有跳过时**不是**"可以写了" —— 但也不该是死结:允许"显式登记为未校验"这条出口
              ? `**先别写进「API 契约」小节**:ERROR 0 ${coverage.exactTotal ? `只覆盖 ${coverage.covered}/${coverage.total} 个候选` : `只覆盖已扫到的 ${coverage.covered} 个候选(另有 ${apiSkipCountText(coverage)} 处未扫到:${apiSkipBreakdown(coverage)}${coverage.truncated ? `,只按已留明细算 —— 本次共 ${coverage.skippedTotal} 条跳过记录,其中 ${coverage.missingDetail} 条连明细都没有` : ''})`}(verdict=\`pass_with_skips\`)。按上面的跳过留痕逐类处理 —— depth 类用 paths **精确指到文件**(或它 2 层内的目录)补进结论;oversize 类拆到 ${fmtBytes(API_SCAN_MAX_BYTES)} 以下,或确认它不属于本项目契约并在该小节**显式登记为未校验 + 原因**(登记是允许的,静默算过不行)。`
              : `可以写进「API 契约」小节了:spec 路径 + 版本策略 + 本条 lint 结论(${slot.apiLint.at},verdict=\`${verdict}\`,覆盖 ${coverage.covered}/${coverage.total} 个候选)+ 指纹 ${String(res.digest).slice(0, 12)}…(契约被改写后指纹会变,届时那句结论自动作废)`))
        return out
      }

      return Object.assign(base, { op: String(action), status: 'invalid_action', note: `未知 action:${String(action)};可用:guide, template, checklist, lint, status` })
    },
  }

  // ── 注册 ─────────────────────────────────────────────────────────────────
  // 一个提供者同时交出两批技能(api-architect + 角色联动技能),所以"要不要注册"是
  // **两把开关的或**:`enableApi:false` 只该关掉 api 那一半,不该连角色技能一起关掉
  // (两半各自的可见性在 candidatesForCwd 里分别判)。
  const bundledSkillsRegistered = (cfg.enableApi !== false || roleSkillsMode() !== 'off') ? registerBundledSkills() : false
  // api_contract 工具的注册不能**嵌在 `enableRelay !== false` 里面** ——
  // 而 api-architect 技能在它外面注册 —— 于是 `enableRelay:false` 会造出一个
  // "技能还在、可它要求调用的工具没了"的错配。现在两半各自独立:relay 只管 relay 那套,
  // api 只管 api 那套。
  const registerAll = (all) => {
    if (all.length === 0) return
    if (typeof harness !== 'undefined' && harness.defineTool) {
      for (const t of all) harness.registerTool(ctx, harness.defineTool(t))
    } else {
      for (const t of all) ctx.tools.register(t)
    }
  }
  if (cfg.enableRelay !== false) registerAll([relayTool, spawnTool].concat(stateTools))
  if (cfg.enableApi !== false) registerAll([apiTool])

  // ── 预设自动激活────────────────────────────────────────────────────
  //
  // 主入口放在 `agent/created`:会话一发布就判定,于是"进入 dev-workflow 预设"这件事
  // 在**第一次工具调用之前**就已经落定 —— 连会话启动时构建的第一份技能目录都是对的
  // (技能可见性按 cwd 查门,而门此时已经是 remembered)。
  //
  // 事件是 scope 分发:`this: Scoped<Agent>` 的 emit 会到达宿主层这个监听器,与下面
  // tools/execute 同源(插件在 host 组合里,收得到所有 agent 的事件)。
  // 参数形状按 `payload: { agent }` 写,同时容一次"直接给 agent"—— 事件形状只保证在重启前
  // 无法实机验证,多一个容错分支比静默不生效强(不生效的表现是"预设下没自动激活",
  // 而这恰好是 tools/execute 兜底要盖住的场景)。
  ctx.on('agent/created', (payload) => {
    try {
      bumpPresetReached('agent/created')
      const agent = payload && payload.agent ? payload.agent : payload
      autoActivateByPreset(agent, 'agent/created')
    } catch (e) {
      ctx.logger?.warn?.(`[${NAME}] preset auto-activate failed: ${e && e.message ? e.message : e}`)
    }
  })

  // ── 预设提交入口────────────────────────────────────────────────
  //
  // 为什么必须有这一条:真宿主的 Web 时序是**先建会话、后提交预设** ——
  // 建会话时 header 写默认预设(`cordis`),用户选的预设在大约 2 秒后作为
  // `agent-preset/selected` 事件追加(实测:会话建立早期就会到达)。
  // 所以"会话一发布就判定"的 `agent/created` 在这条时序上**注定读不到**目标预设;
  // 而"预设提交"这一刻发生在**第一次模型请求之前**,正是技能目录还能被修正的时候。
  //
  // 两条投递形状都挂,是因为"哪条真到得了插件"在真宿主上还没被验证过
  // (`agent/created` 这条事件路径尤其如此):
  //   · `session/event(session, event)`:服务自己就挂在这条上(它据此 re-emit 下一条),
  //     带**活 Session** → cwd 直接读得到,不需要再查 agents;
  //   · `agent-preset/selected(sessionId, agentPreset)`:公开通知"只带稳定身份,不带活 Session",
  //     所以预设值取自**事件载荷**,再按 id 查活 agent 拿 cwd(查不到就交给上一条与 tools/execute)。
  // 重复到达由 `presetAutoSeen` 的复合键吸收,两条同时到也只记一笔。
  const onPresetSelected = (agentLike, presetRaw, via) => {
    try {
      // 先记"这条入口到过" —— 即使下面因为载荷不全而提前返回,
      // "入口通不通"这个读数也不能跟着一起消失(这正是最缺的那一格)。
      bumpPresetReached(via)
      const preset = presetRaw === undefined || presetRaw === null ? '' : String(presetRaw)
      if (preset === '' || !agentLike) return
      autoActivateByPreset(agentLike, via, preset)
    } catch (e) {
      ctx.logger?.warn?.(`[${NAME}] preset auto-activate failed(${via}): ${e && e.message ? e.message : e}`)
    }
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'agent-preset/selected' || !session) return
      const data = event.data || {}
      onPresetSelected({ id: session.id, session }, data.agentPreset, 'session/event')
    } catch (e) {
      ctx.logger?.warn?.(`[${NAME}] preset auto-activate failed(session/event): ${e && e.message ? e.message : e}`)
    }
  })

  ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
    try {
      // 这条形状只带稳定身份,所以"到了但查不到活会话"是一条**正常可能**的路径 ——
      // 在这里静默 return 会连"到过"都看不出来 —— 所以:到达计数 + 查不到会话计数。
      bumpPresetReached('agent-preset/selected')
      const id = String(sessionId || '')
      if (id === '' || agentPreset === undefined || agentPreset === null || String(agentPreset) === '') return
      const found = lookupAgent(id)
      if (!found.ok) { presetAutoStats.noAgent += 1; return } // 查不到活 agent 就不下结论 —— 另一条形状与 tools/execute 兜底
      onPresetSelected(found.agent, agentPreset, 'agent-preset/selected')
    } catch (e) {
      ctx.logger?.warn?.(`[${NAME}] preset auto-activate failed(agent-preset/selected): ${e && e.message ? e.message : e}`)
    }
  })

  // ── 活动记录 ──────────────────────────────────────────────────────────────
  //
  // 计数语义(避开"快照延迟"):
  //   `tools/execute`     = around-dispatch 瀑布,执行**前**触发 → 维护 inFlight(在飞)
  //   `tools/post-execute`= 执行**后**触发 → 维护 toolCalls(已完成)
  // 两个计数语义各自干净:在飞会把最终失败的调用也计入,已完成不会。
  // 读 status 时两个都报,不再有"看不到自己/落后一整批"的解释成本。
  ctx.on('tools/execute', async (exec, next) => {
    activity.inFlight += 1
    try {
      // 预设自动激活的兜底入口:agent/created 那次没赶上(header 未就绪、事件路径不可用)
      // 时,第一次工具调用补上。presetAutoSeen 保证每个 agent 只判一次,所以这里
      // 不是"每次调用都读盘";自动激活本身失败也绝不能挡住工具调用。
      try {
        bumpPresetReached('tools/execute')
        autoActivateByPreset(exec && exec.agent ? exec.agent : undefined, 'tools/execute')
      } catch { /* ignore */ }
      return await next()
    } finally {
      activity.inFlight -= 1
      if (activity.inFlight < 0) activity.inFlight = 0
    }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      activity.toolCalls += 1
      // store.lifetime.toolCalls 若**永远是 0** —— 只加 activity,从没落进 lifetime,
      // 于是 state.json 里它恒为 0 而 status 报 54,让人误读自己的运行数据。
      store.lifetime.toolCalls += 1
      activity.lastAt = makeTS()
      const toolName = exec && exec.name ? String(exec.name) : ''
      if (result && result.isError === true) {
        activity.lastError = `${toolName}: ${String((result.error && result.error.message) || 'error')}`
      } else if (toolName === 'workflow_state_save') {
        activity.lastSaveAt = makeTS()
      } else if (toolName === 'relay') {
        activity.lastRelayAt = makeTS()
      }
      if (activity.toolCalls % 25 === 0) saveStore()
    } catch (e) {
      ctx.logger?.warn?.(`[${NAME}] post-execute hook failed: ${e && e.message ? e.message : e}`)
    }
    return await next()
  })

  // 进程退出前尽力落盘(宿主正常关闭时生效;异常退出最多丢最后一次增量)
  ctx.effect(() => () => { try { saveStore() } catch { /* ignore */ } }, `${NAME}: flush state on dispose`)

  ctx.logger?.info?.(
    // 版本号必须进 ready 行 —— 否则"部署了但没重启"能瞒过所有人:
    // 因为日志里没有任何可比对的版本标识。这一行就是进程侧唯一的版本锚点。
    `[${NAME}] v${VERSION} ready: relay(自动投递+kickoff) / relay_spawn(persona 注入) / workflow_state_status|load|save|use / api_contract(api-architect)`
    + ` | profiles=${Object.keys(profiles).join('/')} | state=${storeHealth.blocked ? '🔒locked' : (storeHealth.ok === true ? 'file' : `memory(${storeHealth.error})`)}`
    + (storeHealth.blocked ? `(已锁存:${storeHealth.readError})` : '')
    + ` | 激活记忆=${Object.keys(store.activeProjects).length} 个项目 | skill ${API_SKILL_NAME}=${bundledSkillsRegistered && cfg.enableApi !== false ? `已注册(${apiSkillMode()})` : '未注册'}`
    // 自动激活清单进 ready 行 —— 这是"预设驱动"这条路径唯一的启动期自证。
    // 没有它,只能比对版本号,看不出这版到底带不带自动激活。
    + ` | autoActivate=${AUTO_ACTIVATE_PRESETS.length > 0 ? AUTO_ACTIVATE_PRESETS.join('/') : 'off'}`
    + ` | 角色技能=${bundledSkillsRegistered && roleSkillsMode() !== 'off' ? `${ROLE_SKILLS.length} 个已注册(${roleSkillsMode()})` : '未注册'}`
    + (versionMismatch ? ` | ⚠️ 版本不一致:进程内 v${VERSION} ≠ 磁盘 package.json v${diskVersion} —— 部署后没重启` : '')
    + (versionUnverifiable ? ` | ⚠️ 版本自证失效:${diskVersionError}` : '')
    + (sweptOnBoot.length > 0 ? ` | 🧹 启动清扫回收 ${sweptOnBoot.length} 个已删目录的死槽` : '')
    // 空槽回收数进 ready 行 —— 启动后第一眼就能看到 state.json 在缩
    + (sweptEmpty.length > 0 ? ` | 🧹 空槽 TTL 回收 ${sweptEmpty.length} 个(空置 ≥${Math.round(SWEEP_EMPTY_TTL_MS / 86400000)} 天)` : ''),
  )
}

export default { name, inject, apply }
