/**
 * 把本包铺进一个 DSH profile(默认 `$DSH_HOME/profiles/web`),并把
 * 「工作流模式」预设按 profile 接好线。
 *
 * 做四件事:
 *   ① 复制包文件到 `<profile>/node_modules/dsh-plugin-dev-workflow/`;
 *   ② 「工作流模式」预设本体铺到 `<profile>/agent-presets/dev-workflow/`(已存在则不动);
 *   ③ 在 profile 的 `cordis.patch.yml` 里写一段**受管段**,把「名册的 profile 私有根」
 *      与「插件行的 presetRoot」一起接上;
 *   ④ 组合里已经有本插件那一行(走 `dsh.profile.bundles` 路线)时,只写 ③ 里
 *      「声明根」的那一半,不插行 —— 同一个插件挂两次会 id 冲突、工具重复注册。
 *
 * 为什么 ③ 不能省:名册的默认根 `$DSH_HOME/.agent-presets` 是**所有 profile 共用**
 * 的,而本插件是**按 profile 安装**的。两个方向都会漏:
 *   · 只声明插件行、不改名册根 → 没装插件的 profile 也会列出「工作流模式」;
 *   · 只铺预设、不声明根   → 装了插件的 profile 也看不到它。
 * 「装了才有、关掉就没有」这两条,必须由安装足迹自己兜住,而不是靠手写组合。
 *
 * ⚠️ 还有一层容易漏:桌面端(dsh-plugin-desktop)启动 profile 时会**追加一层
 * launcher patch**,把 id **恰为** `agent-presets` 的那一行 `config.roots` 强制
 * 覆写成它自己的两个根(shipped + `$DSH_HOME/.agent-presets`)。`config:` 是整体
 * 替换,所以直接给基座那行写 roots 是**永远不生效**的 —— 名册里不会出现预设。
 * 所以受管段把基座行**停用**,再用另一个 id(`agent-presets-profile`)插一行同包的
 * 自己的行:桌面端不认这个 id,roots 才留得住。
 *
 * 受管段用 `dev-workflow:managed:begin/end` 哨兵括起,`--uninstall` 整段删除,
 * 文件里其余内容一个字节不动 —— 不会吃掉你手写的其它 patch 条目。
 *
 * ⚠️ 组合层是**启动时**读的:写完要重启 DSH 才生效。
 *
 * 用法:
 *   node install.mjs                       # 铺进 $DSH_HOME/profiles/web
 *   node install.mjs --profile <dir>       # 铺进指定 profile
 *   node install.mjs --dry-run             # 只打印将要做什么
 *   node install.mjs --uninstall           # 撤掉受管段(包文件与预设本体不动)
 *   node install.mjs --take-over           # 接管旧的、手写的 dev-workflow insert 块
 *   node install.mjs --default-preset <id> # 覆盖受管段里继承来的 default 值
 *   node install.mjs --preset-source <dir> # 预设本体来源目录(默认 ./preset)
 */
import fs from 'node:fs'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-plugin-dev-workflow'
const SOURCE_DIR = dirname(fileURLToPath(import.meta.url))
const FILES = [
  'package.json', 'cordis.patch.yml', 'README.md', '使用说明.md', 'LICENSE',
  'selftest.mjs', 'smoke.mjs', 'switch.selftest.mjs', 'switch.smoke.mjs', 'install.mjs',
]
const DIRS = ['lib', 'skills']

/** 被开关管理的预设 id。 */
const PRESET_ID = 'dev-workflow'
/** profile 私有预设根:相对 profile 目录。 */
const PRESET_DIR_NAME = 'agent-presets'
/** 预设本体应有的文件。 */
const PRESET_FILES = ['agent.cordis.yml', 'preset.yml']
/** 名册那一行在基座里的 id。 */
const BASE_ROSTER_ROW_ID = 'agent-presets'
/** 我们自己的名册行 id —— **故意不叫** `agent-presets`,理由见受管段里的 §①。 */
const ROSTER_ROW_ID = 'agent-presets-profile'
/** 名册包名。 */
const ROSTER_PACKAGE = '@deepseek-ai/dsh-agent-presets'
/** 受管段的哨兵。 */
const MANAGED_BEGIN = '# ── dev-workflow:managed:begin ──────────────────────────────────'
const MANAGED_END = '# ── dev-workflow:managed:end ────────────────────────────────────'
/** 基座(bundle)里提供 agent-presets 行 config 的那个包。 */
const BASE_BUNDLE = '@deepseek-ai/dsh-web-app'
/** 组合层空壳的写法:空文件不是合法的顶层数组,会直接让宿主起不来。 */
const EMPTY_PATCH = '[]\n'

/**
 * 解析命令行。
 * @param {string[]} argv - process.argv.slice(2)。
 * @returns {{profile?: string, presetSource?: string, defaultPreset?: string, dryRun: boolean, uninstall: boolean, takeOver: boolean}} 选项。
 */
function parseArgs(argv) {
  const options = { profile: undefined, presetSource: undefined, defaultPreset: undefined, dryRun: false, uninstall: false, takeOver: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--take-over') options.takeOver = true
    else if (arg === '--profile') { options.profile = argv[index + 1]; index += 1 }
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
    else if (arg === '--preset-source') { options.presetSource = argv[index + 1]; index += 1 }
    else if (arg.startsWith('--preset-source=')) options.presetSource = arg.slice('--preset-source='.length)
    else if (arg === '--default-preset') { options.defaultPreset = argv[index + 1]; index += 1 }
    else if (arg.startsWith('--default-preset=')) options.defaultPreset = arg.slice('--default-preset='.length)
    else { console.error(`未知参数:${arg}`); process.exit(2) }
  }
  return options
}

/**
 * 递归复制目录(逐文件读写:cpSync 在 Windows 上会走 `\\?\` 扩展路径,某些目录会 EIO)。
 * @param {string} from - 源目录。
 * @param {string} to - 目标目录。
 * @returns {number} 复制的文件数。
 */
function copyDir(from, to) {
  mkdirSync(to, { recursive: true })
  let count = 0
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) count += copyDir(source, target)
    else { writeFileSync(target, readFileSync(source)); count += 1 }
  }
  return count
}

/** 路径统一成 YAML 里好写的正斜杠形式。 */
function yamlPath(value) {
  return resolve(value).replace(/\\/g, '/')
}

/**
 * 读一个 JSON 文件。容忍 UTF-8 BOM —— `JSON.parse` 见到开头的 `\uFEFF` 会直接抛
 * SyntaxError,而 profile 的 `package.json` 是编辑器写的还是工具写的都有可能带。
 * @param {string} file - 文件路径。
 * @returns {any} 解析结果。
 */
function readJson(file) {
  return JSON.parse(readText(file))
}

/**
 * 读一个文本文件并去掉开头的 UTF-8 BOM。
 *
 * BOM 会从两个方向咬人:`JSON.parse` 直接抛 SyntaxError;更要命的是它会让
 * 「这个文件是不是空的 / 是不是 `[]`」的判断失手 —— 于是 `[]` 后面又被追加了
 * 条目,写出一份**非法的顶层数组**,宿主启动即失败。PowerShell 的
 * `Set-Content -Encoding UTF8` 与不少 Windows 编辑器都会写 BOM,所以统一在这里清掉。
 * @param {string} file - 文件路径。
 * @returns {string} 文件内容(可能仍含 CRLF,由调用方决定是否归一)。
 */
function readText(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
}

/**
 * 从基座(bundle)patch 里读出 `- id: agent-presets` 那条的 `config:` 子行(**已去掉公共缩进**)。
 *
 * 用继承而不是重写:按 id 覆盖 `config` 是**整体替换**(app-boot 的 applyEntryPatches
 * 逐键赋值,不深合并),所以必须把基座的必填项原样带过去 —— 只写自己想加的 `roots`
 * 会把 `default` 抹掉,而它是 schema 里的 `z.string().required()`,后果是整棵插件树
 * 加载失败:
 *   invalid config: $.default missing required value (at default)
 * 逐字继承基座的块,将来基座新增必填项也不会被我们漏掉。
 * @param {string} profileDir - profile 目录。
 * @returns {{lines: string[], source: string}} 去掉公共缩进后的 config 子行,与来源文件。
 */
function readBaseAgentPresetsConfig(profileDir) {
  const profilesRoot = dirname(profileDir)
  const candidates = [
    join(profilesRoot, 'node_modules', ...BASE_BUNDLE.split('/'), 'cordis.patch.yml'),
    join(profileDir, 'node_modules', ...BASE_BUNDLE.split('/'), 'cordis.patch.yml'),
    join(profilesRoot, '.dsh-module-fallback', 'node_modules', ...BASE_BUNDLE.split('/'), 'cordis.patch.yml'),
  ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const lines = readText(file).replace(/\r\n/g, '\n').split('\n')
    const idAt = lines.findIndex(line => /^\s*-\s*id:\s*agent-presets\s*$/.test(line))
    if (idAt === -1) continue
    const configAt = lines.findIndex((line, index) => index > idAt && /^\s*config:\s*$/.test(line))
    if (configAt === -1) continue
    const indent = /^(\s*)/.exec(lines[configAt])[1]
    const block = []
    for (let index = configAt + 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim() === '') continue
      if (!line.startsWith(`${indent} `)) break
      block.push(line)
    }
    if (block.length === 0) continue
    // 去掉块内的公共缩进。按**实际最小缩进**算,而不是按 config 的缩进宽度加常数 ——
    // 基座换个嵌套宽度(4 空格 / 2 空格)就不会把继承来的行写歪。
    const childIndent = Math.min(...block.map(line => /^(\s*)/.exec(line)[1].length))
    return { lines: block.map(line => line.slice(childIndent)), source: file }
  }
  return { lines: [], source: '' }
}

/**
 * 生成受管段。
 * @param {object} input - 生成输入。
 * @param {string} input.profileDir - profile 目录。
 * @param {string[]} input.baseConfig - 从基座继承来的 config 子行(无缩进)。
 * @param {string | undefined} input.defaultPreset - 覆盖 default 的值。
 * @param {boolean} input.includeRow - 是否连插件行一起插(bundle 路线不插)。
 * @returns {string} 受管段全文(含哨兵)。
 */
function renderManagedSection({ profileDir, baseConfig, defaultPreset, includeRow }) {
  const presetRoot = yamlPath(join(profileDir, PRESET_DIR_NAME))
  const alreadyHasRoots = baseConfig.some(line => /^roots:/.test(line))
  const configLines = baseConfig.map(line => {
    const overridden = defaultPreset !== undefined ? line.replace(/^(default:\s*).*$/, `$1${defaultPreset}`) : line
    return `        ${overridden}`
  })
  const rootsLines = alreadyHasRoots
    ? []
    : ['        roots:', `          - path: ${presetRoot}`, '            trust: user']

  const parts = [
    MANAGED_BEGIN,
    '# 本段由 dsh-plugin-dev-workflow/install.mjs 生成与维护,请勿手改。',
    '# 撤销:node install.mjs --uninstall(整段删除,文件里其余内容不动)。',
    '#',
    '# ① 名册根:本 profile 私有的预设根 —— 以及**为什么这里要换一个 id**。',
    '#    桌面端(dsh-plugin-desktop)启动时会追加一层 launcher patch,把 id **恰为**',
    '#    `agent-presets` 的那一行 config.roots 强制覆写成它自己的两个根',
    '#    (shipped + $DSH_HOME/.agent-presets)。而 `config:` 是整体替换,所以那一层',
    '#    之后不管 profile 里写了什么 roots 都会被丢掉 —— 预设就永远显示不出来。',
    '#    对策:把基座那一行**停用**(覆写打在它身上,无害),再用另一个 id 插一行',
    '#    同包的自己的行;它的 config 桌面端不认识,roots 这才生效。',
    '#    ⚠️ 下面把基座的 config 逐字继承过来:按 id 覆盖 config 是整体替换,漏掉',
    '#    schema 里必填的 default 会让整棵插件树加载失败',
    '#    ($.default missing required value)。',
    `- id: ${BASE_ROSTER_ROW_ID}`,
    '  disabled: true',
    '',
    '- insert:',
    `    - id: ${ROSTER_ROW_ID}`,
    `      name: '${ROSTER_PACKAGE}'`,
    '      config:',
    ...configLines,
    ...rootsLines,
  ]

  if (includeRow) {
    parts.push(
      '',
      '    # ② 插件行(presetRoot 指向 ① 的 profile 根,设置里的总开关才管得到预设)。',
      `    - id: ${PRESET_ID}`,
      `      name: ./node_modules/${PACKAGE_NAME}/lib/index.js`,
      '      config:',
      `        presetRoot: ${presetRoot}`,
    )
  }
  parts.push(MANAGED_END)
  return `${parts.join('\n')}\n`
}

/**
 * 去掉受管段后,文本里是否还留着 dev-workflow 的行(旧的手写 insert)。
 * 有就不动文件:两条 insert 同时存在会把同一个插件挂两次。
 * @param {string} text - 组合层原文。
 * @returns {boolean} 是否存在段外的行。
 */
function hasLegacyRow(text) {
  const stripped = stripManagedSection(text).text
  return new RegExp(`^\\s*-\\s*id:\\s*${PRESET_ID}\\s*$`, 'm').test(stripped)
}

/**
 * 受管段之外是否还有 `- id: agent-presets` 覆盖。
 * 只提醒、不擅自删:那可能是使用者有意加的另一个名册根,删掉会改变他的名册。
 * @param {string} text - 组合层原文。
 * @returns {boolean} 是否存在段外的同名覆盖。
 */
function hasForeignAgentPresetsOverride(text) {
  return /^\s*-\s*id:\s*agent-presets\s*$/m.test(stripManagedSection(text).text)
}

/**
 * 找出所有顶层 `- insert:` 块的起止行号。
 * @param {string[]} lines - 组合层按行拆开。
 * @returns {Array<{from: number, to: number}>} 每个块的 [起始行, 结束行) 区间。
 */
function insertBlocks(lines) {
  const blocks = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^- insert:\s*$/.test(lines[index])) continue
    let end = index + 1
    while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end += 1
    blocks.push({ from: index, to: end })
  }
  return blocks
}

/**
 * 摘掉旧的、手写的 dev-workflow insert 块(`--take-over`)。
 * 只认「顶层 `- insert:` + 块内出现 `id: dev-workflow`」这一种形状,连同紧邻其上的
 * 注释一起删;找不到这种形状就原样返回,交给调用方报错。
 * @param {string} text - 组合层原文。
 * @returns {{text: string, removed: boolean}} 处理后的文本与是否真的删掉了。
 */
function stripLegacyRow(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const block = insertBlocks(lines)
    .find(candidate => lines.slice(candidate.from, candidate.to)
      .some(line => new RegExp(`^\\s*-\\s*id:\\s*${PRESET_ID}\\s*$`).test(line)))
  if (block === undefined) return { text, removed: false }
  let from = block.from
  while (from > 0 && /^#/.test(lines[from - 1])) from -= 1
  lines.splice(from, block.to - from)
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+/, ''), removed: true }
}

/**
 * 删除受管段。删空时留下 `[]` —— 空文件不是合法的顶层数组。
 * @param {string} text - 组合层原文。
 * @returns {{text: string, removed: boolean}} 结果与是否真的删掉了。
 */
function stripManagedSection(text) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const begin = normalized.indexOf(MANAGED_BEGIN)
  const end = normalized.indexOf(MANAGED_END)
  if (begin === -1 || end === -1 || end < begin) return { text, removed: false }
  const before = normalized.slice(0, begin).replace(/\s*$/, '')
  const after = normalized.slice(end + MANAGED_END.length).replace(/^\s*/, '')
  if (before === '' && after === '') return { text: EMPTY_PATCH, removed: true }
  if (before === '') return { text: after, removed: true }
  if (after === '') return { text: `${before}\n`, removed: true }
  return { text: `${before}\n\n${after}`, removed: true }
}

/**
 * 写入或替换受管段。空文件与 `[]` 视为空壳 —— 段必须独占文件,不能与 `[]` 并存。
 * @param {string} text - 组合层原文。
 * @param {string} section - 受管段全文。
 * @returns {{text: string, mode: 'appended' | 'replaced'}} 结果与动作。
 */
function upsertManagedSection(text, section) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const begin = normalized.indexOf(MANAGED_BEGIN)
  const end = normalized.indexOf(MANAGED_END)
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = normalized.slice(0, begin).replace(/\s*$/, '')
    const after = normalized.slice(end + MANAGED_END.length).replace(/^\s*/, '')
    const head = before === '' ? '' : `${before}\n\n`
    const tail = after === '' ? '' : `\n${after}`
    return { text: `${head}${section}${tail}`.replace(/\s*$/, '\n'), mode: 'replaced' }
  }
  const body = normalized.replace(/^\uFEFF/, '')
  const trimmed = body.trim()
  if (trimmed === '' || trimmed === '[]') return { text: section, mode: 'appended' }
  return { text: `${body.replace(/\s*$/, '')}\n\n${section}`, mode: 'appended' }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const options = parseArgs(process.argv.slice(2))
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = options.profile !== undefined ? resolve(options.profile) : join(home, 'profiles', 'web')
const packageDir = join(profileDir, 'node_modules', PACKAGE_NAME)
const patchFile = join(profileDir, 'cordis.patch.yml')
const presetRoot = join(profileDir, PRESET_DIR_NAME)
const presetDir = join(presetRoot, PRESET_ID)
const presetSource = options.presetSource !== undefined ? resolve(options.presetSource) : join(SOURCE_DIR, 'preset')

console.log(`profile      ${profileDir}`)
console.log(`package dir  ${packageDir}`)
console.log(`preset dir   ${presetDir}`)
console.log(`patch file   ${patchFile}`)
console.log(`mode         ${options.uninstall ? 'uninstall' : options.dryRun ? 'dry-run' : 'install'}`)

if (!existsSync(profileDir)) {
  console.error(`\n✗ profile 目录不存在:${profileDir}`)
  process.exit(1)
}

const patchText = existsSync(patchFile) ? readText(patchFile) : ''

// ── --uninstall:只撤受管段,包文件与预设本体都不动 ──────────────────────────
if (options.uninstall) {
  const result = stripManagedSection(patchText)
  if (!result.removed) {
    console.log('• 组合里没有受管段,无需撤销')
  } else if (options.dryRun) {
    console.log('• 将删除受管段')
  } else {
    writeFileSync(`${patchFile}.uninstall-dev-workflow.bak`, patchText, 'utf8')
    const temporary = `${patchFile}.install.tmp`
    writeFileSync(temporary, result.text, 'utf8')
    renameSync(temporary, patchFile)
    console.log('✓ 已删除受管段(原文件备份为 .uninstall-dev-workflow.bak)')
  }
  if (hasLegacyRow(result.text)) {
    console.log('⚠️ 组合里还留着**手写**的 dev-workflow 行,请自行删除(本工具不猜形状)')
  }
  console.log('\n重启 DSH 后生效。')
  process.exit(0)
}

// ── ① 铺包 ──────────────────────────────────────────────────────────────────
if (options.dryRun) {
  console.log('• 将复制 lib/ 与 skills/ 及包内文档')
} else {
  let copied = 0
  for (const dir of DIRS) copied += copyDir(join(SOURCE_DIR, dir), join(packageDir, dir))
  for (const file of FILES) {
    const from = join(SOURCE_DIR, file)
    if (existsSync(from)) { writeFileSync(join(packageDir, file), readFileSync(from)); copied += 1 }
  }
  const version = readJson(join(SOURCE_DIR, 'package.json')).version
  console.log(`✓ 已复制 ${copied} 个文件(版本 ${version})→ ${packageDir}`)
}

// ── ② 铺预设本体(已存在则一字不动) ────────────────────────────────────────
if (existsSync(presetDir)) {
  console.log(`• 预设本体已存在,保持不动:${presetDir}`)
} else if (!existsSync(join(presetSource, PRESET_ID))) {
  console.log(`⚠️ 没找到预设来源 ${join(presetSource, PRESET_ID)},跳过 —— 装了插件也看不到预设`)
} else if (options.dryRun) {
  console.log(`• 将把预设本体铺到 ${presetDir}`)
} else {
  mkdirSync(presetDir, { recursive: true })
  for (const name of PRESET_FILES) {
    const from = join(presetSource, PRESET_ID, name)
    if (existsSync(from)) writeFileSync(join(presetDir, name), readFileSync(from))
  }
  console.log(`✓ 已铺预设本体 → ${presetDir}`)
}

// ── ③ 组合层 ────────────────────────────────────────────────────────────────
const manifestPath = join(profileDir, 'package.json')
const bundles = existsSync(manifestPath)
  ? (readJson(manifestPath).dsh?.profile?.bundles ?? [])
  : []
const inBundles = Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)

let working = patchText
if (hasLegacyRow(working)) {
  if (!options.takeOver) {
    console.error('\n✗ 组合里已经有一处**手写**的 dev-workflow 行(受管段之外)。')
    console.error('  同一个插件挂两次会 id 冲突 / 工具重复注册,所以本工具不覆盖它。')
    console.error('  确认那处可以删除后,加 --take-over 让本工具接管;或自行删除后重跑。')
    process.exit(1)
  }
  const stripped = stripLegacyRow(working)
  if (!stripped.removed) {
    console.error('\n✗ 那个手写块的形状本工具不认识,请自行删除后重跑。')
    process.exit(1)
  }
  working = stripped.text
  console.log('• --take-over:已摘掉旧的手写 dev-workflow insert 块')
}

const base = readBaseAgentPresetsConfig(profileDir)
const inherited = base.lines.length > 0
if (!inherited && options.defaultPreset === undefined) {
  console.error(`\n✗ 没找到基座(${BASE_BUNDLE})里 agent-presets 行的 config,无法继承 default。`)
  console.error('  按 id 覆盖 config 是整体替换,漏掉必填的 default 会让整棵插件树加载失败。')
  console.error('  请用 --default-preset <预设id> 显式给出,或确认该 profile 确实加载了 web bundle。')
  process.exit(1)
}
const section = renderManagedSection({
  profileDir,
  baseConfig: inherited ? base.lines : [`default: ${options.defaultPreset}`],
  defaultPreset: options.defaultPreset,
  includeRow: !inBundles,
})
const next = upsertManagedSection(working, section)

console.log(`• 基座 config 来源:${inherited ? base.source : '(兜底:--default-preset)'}`)
console.log(`• 受管段:${next.mode === 'replaced' ? '替换已有段' : '追加'}${inBundles ? '(bundle 路线:只声明名册根,不插行)' : ''}`)
if (hasForeignAgentPresetsOverride(working)) {
  console.log('⚠️ 受管段之外还有一处**你自己的** `- id: agent-presets` 覆盖。')
  console.log('   两处都按 id 覆盖同一行 config,谁在后谁生效 —— 建议删掉那处,只留本段。')
}
if (options.dryRun) {
  console.log('\n--- 将写入的受管段 ---------------------------------------------')
  process.stdout.write(section)
  console.log('----------------------------------------------------------------')
} else {
  const backup = `${patchFile}.install-dev-workflow.bak`
  if (patchText !== '' && !existsSync(backup)) writeFileSync(backup, patchText, 'utf8')
  const temporary = `${patchFile}.install.tmp`
  writeFileSync(temporary, next.text, 'utf8')
  renameSync(temporary, patchFile)
  console.log(`✓ 已写入组合层${patchText === '' ? '' : '(原文件备份为 .install-dev-workflow.bak)'}`)
}

console.log('\n重启 DSH 后生效(设置右上角的「重启」);之后设置里会出现「dev-workflow 预设」总开关,')
console.log('名册里会出现「工作流模式」—— 且只在已经装了本插件的 profile 里。')
