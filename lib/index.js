/**
 * dev-workflow 插件入口 —— 总开关 + 功能挂载。
 *
 * 这个包里有**两个 half**:
 *
 *   · `lib/feature.js` —— 功能本体(relay 互呼 / 流程状态 / api_contract 七个工具、
 *     24 份随包技能、档案与自动激活)。它是普通的 Cordis 插件,但**不再是组合里的一行**。
 *   · 本文件 —— 组合里那一行 `id: dev-workflow` 真正加载的入口。它做两件事:
 *       ① 注册设置命名空间 `dev-workflow`(设置页「dev-workflow 预设」那张卡片的开关值);
 *       ② 按开关值**挂载 / 卸下**功能本体:`await import('./feature.js')` 之后
 *          `ctx.plugin(...)`;关掉时 `fiber.dispose()`。
 *
 * 为什么把功能做成"被挂载的插件"而不是另一行组合:开关必须永远活着 ——
 * 关掉之后还得有人能把它打开。若功能行自己在组合里,关闭它就等于关掉了开关本身
 * (它的浏览器半侧也随行下线,设置分区会一起消失)。所以这里的分工是:
 * **入口行常驻、功能按需挂载**。
 *
 * 由此得到的三条性质:
 *   ① 关闭 = 功能 fiber 释放 → 七个工具与随包技能当场注销;
 *   ② 关闭时**功能模块根本不会被 import**(不是"加载了再空转"),这是比"禁用组合行"更强的
 *      "不加载";
 *   ③ 重启后不需要任何"先挂载再卸下"的窗口 —— 启动对齐直接决定 import 与否。
 *
 * 预设名册那一面照旧:把 `<DSH_HOME>/.agent-presets/dev-workflow` 改名搬进同根的
 * `.disabled/`(discovery 只认匹配 `PRESET_ID` 的目录,点号开头直接跳过),名册每次
 * 读取都重扫根目录,所以不必重启。**只搬目录,不删任何文件。**
 */

import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 组合行 id;loader 日志里的名字。 */
export const name = 'dev-workflow'
/** 硬依赖:没有 settings 就没有开关的持久层。 */
export const inject = ['settings']

/** 设置命名空间(客户端半侧用同一字符串 bind,所以它是两侧的契约)。 */
export const NS = 'dev-workflow'
/** 被开关管理的预设目录名。 */
export const PRESET_ID = 'dev-workflow'
/** 隐藏预设时移入的子目录:点号开头 → 不匹配 PRESET_ID → discovery 跳过。 */
export const DISABLED_DIR = '.disabled'
/** 默认开关状态:保持安装前的行为(功能挂载、预设可见)。 */
export const DEFAULT_ENABLED = true

// ── 依赖:schemastery(设置 schema)───────────────────────────────────────────
// 取不到就退回一个同样可调用的保底 schema(settings.register 只要求 schema 是函数
// 并有 toJSON)。本插件出问题的代价必须只是"开关不工作",绝不能拖垮宿主启动。

let schemastery
try {
  const mod = await import('schemastery')
  schemastery = mod.default ?? mod
} catch {
  schemastery = undefined
}

/**
 * 设置 schema。优先 schemastery(与部署里其它命名空间同一种,设置页「插件配置」卡片
 * 按它的 toJSON 渲染);取不到时用保底实现。
 * @returns {object} 可调用的 schema。
 */
export function buildSchema() {
  if (schemastery?.object !== undefined && typeof schemastery.boolean === 'function') {
    return schemastery.object({ enabled: schemastery.boolean().default(DEFAULT_ENABLED) })
  }
  const schema = (raw) => ({
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : DEFAULT_ENABLED,
  })
  schema.toJSON = () => ({
    type: 'object',
    properties: { enabled: { type: 'boolean', default: DEFAULT_ENABLED } },
  })
  return schema
}

// ── 路径 ────────────────────────────────────────────────────────────────────

/**
 * 展开开头的 `~`。
 * @param {string} input - 可能以 `~` 开头的路径。
 * @returns {string} 绝对路径。
 */
export function expandHome(input) {
  if (input === '~') return homedir()
  if (input.startsWith(`~${sep}`) || input.startsWith('~/')) return join(homedir(), input.slice(2))
  return resolve(input)
}

/**
 * 解析开关要碰的路径:DSH_HOME 环境变量 → `~/.dsh`,预设根固定为 `<home>/.agent-presets`。
 * @param {object} options - 解析输入。
 * @param {object} [options.config] - 行配置(dshHome / presetRoot 可覆盖)。
 * @param {string} options.moduleUrl - 本模块的 import.meta.url(仅用于报错定位)。
 * @param {Record<string, string|undefined>} options.env - 环境变量(便于自测注入)。
 * @returns {{home: string, presetRoot: string, presetDir: string, hiddenPresetDir: string}} 解析结果。
 */
export function resolvePaths({ config = {}, env = {} }) {
  const home = expandHome(config.dshHome ?? env.DSH_HOME ?? join(homedir(), '.dsh'))
  const presetRoot = expandHome(config.presetRoot ?? join(home, '.agent-presets'))
  return {
    home,
    presetRoot,
    presetDir: join(presetRoot, PRESET_ID),
    hiddenPresetDir: join(presetRoot, DISABLED_DIR, PRESET_ID),
  }
}

// ── 预设可见性 ──────────────────────────────────────────────────────────────

/**
 * 让预设目录可见(打开)或隐藏(关闭)。幂等;返回一句人类可读的结果。
 * 只做改名搬迁:预设目录里的文件一个字节都不动。
 * @param {{presetDir: string, hiddenPresetDir: string, presetRoot: string}} paths - 解析好的路径。
 * @param {boolean} enabled - 目标状态。
 * @returns {string} 结果说明(进日志/自测断言)。
 */
export function reconcilePreset(paths, enabled) {
  const { presetDir, hiddenPresetDir, presetRoot } = paths
  if (enabled) {
    if (!existsSync(presetDir) && existsSync(hiddenPresetDir)) {
      mkdirSync(presetRoot, { recursive: true })
      renameSync(hiddenPresetDir, presetDir)
      return 'preset:restored'
    }
    return existsSync(presetDir) ? 'preset:visible' : 'preset:missing'
  }
  if (existsSync(presetDir)) {
    if (existsSync(hiddenPresetDir)) {
      throw new Error(`预设目录两处同时存在,拒绝覆盖:${presetDir} 与 ${hiddenPresetDir}`)
    }
    mkdirSync(join(presetRoot, DISABLED_DIR), { recursive: true })
    renameSync(presetDir, hiddenPresetDir)
    return 'preset:hidden'
  }
  return existsSync(hiddenPresetDir) ? 'preset:hidden' : 'preset:missing'
}

// ── 功能本体的挂载 ──────────────────────────────────────────────────────────

/**
 * 造一个日志函数:优先 cordis logger,取不到退回 console。
 * @param {object} ctx - 插件上下文。
 * @returns {(text: string) => void} 记一行(按文本里的关键词分派 error/info)。
 */
function makeLog(ctx) {
  /** 按文本里的关键词分派级别:带"失败/error"的走 stderr(两条路径口径一致)。 */
  const levelOf = (text) => (text.includes('失败') || text.includes('error') ? 'error' : 'info')
  const fallback = (level, text) => {
    if (level === 'error') console.error(`[dev-workflow] ${text}`)
    else console.log(`[dev-workflow] ${text}`)
  }
  let logger
  try {
    logger = ctx.get?.('logger')
  } catch {
    logger = undefined
  }
  if (logger === undefined || logger === null) return (text) => { fallback(levelOf(text), text) }
  const scoped = typeof logger === 'function' ? logger('dev-workflow') : logger
  return (text) => {
    const level = levelOf(text)
    const write = scoped?.[level]
    if (typeof write === 'function') write.call(scoped, text)
    else fallback(level, text)
  }
}

/** 错误转一行文本。 */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 解析要挂载的功能模块地址。默认 `./feature.js`;`config.feature` 是给自测用的接缝
 * (指向一个夹具模块,免得单测真去 import 那份 40 万字节的实现)。
 * @param {object} config - 行配置。
 * @returns {string} 模块 URL。
 */
export function featureSpecifier(config = {}) {
  if (typeof config.feature === 'string' && config.feature !== '') {
    return pathToFileURL(expandHome(config.feature)).href
  }
  return new URL('./feature.js', import.meta.url).href
}

// ── 插件本体 ────────────────────────────────────────────────────────────────

/**
 * 注册命名空间并接线:开着就挂载功能本体 + 让预设可见,关掉就卸下 + 藏起来。
 *
 * 整个函数体包在一层 try/catch 里:本插件是宿主组合里的一行,apply 抛错会让那一行的
 * fiber 失败,而启动期的失败是**响亮**的(可能直接让宿主起不来)。一个"开关"绝不该
 * 有这个代价 —— 出问题就只让开关不工作,并留下日志。
 * @param {object} ctx - 插件上下文。
 * @param {object} [config] - 行配置(dshHome / presetRoot / feature 可覆盖推导)。
 */
export function apply(ctx, config = {}) {
  const log = makeLog(ctx)
  try {
    const cfg = config ?? {}
    const paths = resolvePaths({ config: cfg, env: process.env })
    const specifier = featureSpecifier(cfg)
    const scope = ctx.settings.register(NS, buildSchema(), {
      base: { enabled: DEFAULT_ENABLED },
      applies: 'live',
    })
    /** 已挂载的功能 fiber;undefined = 没挂载。 */
    let feature
    /** reconcile 串行化:开关点得快时,后一次等前一次落地。 */
    let tail = Promise.resolve()

    /** 挂载功能本体(先 import,再 ctx.plugin)。 */
    const mount = async () => {
      if (feature !== undefined) return 'feature:loaded'
      const mod = await import(specifier)
      const fiber = ctx.plugin(mod)
      await fiber?.await?.()
      feature = fiber
      return 'feature:mounted'
    }
    /** 卸下功能本体:fiber 释放 → 它注册的工具/技能/监听一起注销。 */
    const unmount = async () => {
      if (feature === undefined) return 'feature:absent'
      const fiber = feature
      feature = undefined
      await fiber?.dispose?.()
      return 'feature:unmounted'
    }

    const run = (reason) => {
      const enabled = scope.get().enabled !== false
      tail = tail
        .then(async () => {
          const notes = [reconcilePreset(paths, enabled)]
          notes.push(enabled ? await mount() : await unmount())
          log(`${reason} → ${enabled ? '开' : '关'} | ${notes.join(' ')}`)
        })
        .catch(error => { log(`${reason} 失败:${message(error)}`) })
      return tail
    }

    ctx.effect(
      () => scope.watch((next) => { void run(`设置变更(${next.enabled === false ? '关' : '开'})`) }),
      'dev-workflow: watch settings',
    )
    // 本行被释放时把功能一起带走,别留一个孤儿 fiber。
    ctx.effect(() => () => { void unmount() }, 'dev-workflow: unmount feature on dispose')
    void run('启动对齐')
  } catch (error) {
    log(`接线失败,开关未生效(其余功能不受影响):${message(error)}`)
  }
}

/** 供自测引用,避免测试文件自己拼 URL。 */
export const FEATURE_URL = new URL('./feature.js', import.meta.url).href
/** fileURLToPath 也转出去:自测里要把夹具路径转成 URL。 */
export { fileURLToPath }
