/**
 * 把本包铺进一个 DSH profile(默认 `$DSH_HOME/profiles/web`)。
 *
 * 做两件事:
 *   1. 复制包文件到 `<profile>/node_modules/dsh-plugin-dev-workflow/`;
 *   2. 检查组合里有没有本插件那一行 —— **没有才插**(profile 走 `dsh.profile.bundles`
 *      路线时那一行由随包 patch 提供,这里就不动文件)。
 *
 * 用法:
 *   node install.mjs                    # 铺进 $DSH_HOME/profiles/web
 *   node install.mjs --profile <dir>    # 铺进指定 profile
 *   node install.mjs --dry-run          # 只打印将要做什么
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

/** 手工路线要写进 profile 的那一行(只有组合里完全没有本插件时才插)。 */
const ROW_LINES = [
  '# ── dev-workflow:host 静态行(与随包 dsh.bundle 路线二选一)──────────────',
  '# 这一行加载的是入口 lib/index.js:它常驻并注册设置里的总开关「dev-workflow 预设」,',
  '# 功能本体 lib/feature.js 由它按开关值挂载 / 卸下 —— 所以始终只需要这一行。',
  '- insert:',
  `    - id: dev-workflow`,
  `      name: ./node_modules/${PACKAGE_NAME}/lib/index.js`,
]

/**
 * 解析命令行。
 * @param {string[]} argv - process.argv.slice(2)。
 * @returns {{profile?: string, dryRun: boolean}} 选项。
 */
function parseArgs(argv) {
  const options = { profile: undefined, dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--profile') { options.profile = argv[index + 1]; index += 1 }
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
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

const options = parseArgs(process.argv.slice(2))
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = options.profile !== undefined ? resolve(options.profile) : join(home, 'profiles', 'web')
const packageDir = join(profileDir, 'node_modules', PACKAGE_NAME)
const patchFile = join(profileDir, 'cordis.patch.yml')

console.log(`profile      ${profileDir}`)
console.log(`package dir  ${packageDir}`)
console.log(`patch file   ${patchFile}`)
console.log(`mode         ${options.dryRun ? 'dry-run' : 'install'}`)

if (!existsSync(profileDir)) {
  console.error(`\n✗ profile 目录不存在:${profileDir}`)
  process.exit(1)
}
if (!existsSync(join(SOURCE_DIR, 'lib', 'index.js')) || !existsSync(join(SOURCE_DIR, 'lib', 'feature.js'))) {
  console.error('\n✗ 源包不完整:需要 lib/index.js(入口)与 lib/feature.js(功能本体)')
  process.exit(1)
}

// ① 铺包
if (options.dryRun) {
  console.log('• 将复制 lib/ 与 skills/ 及包内文档')
} else {
  let copied = 0
  for (const dir of DIRS) copied += copyDir(join(SOURCE_DIR, dir), join(packageDir, dir))
  for (const file of FILES) {
    const from = join(SOURCE_DIR, file)
    if (existsSync(from)) { writeFileSync(join(packageDir, file), readFileSync(from)); copied += 1 }
  }
  const version = JSON.parse(readFileSync(join(SOURCE_DIR, 'package.json'), 'utf8')).version
  console.log(`✓ 已复制 ${copied} 个文件(版本 ${version})→ ${packageDir}`)
}

// ② 组合行:只在完全没有时才补(有 insert 行 / 有 bundles 声明都算有)
const patchText = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
const manifestPath = join(profileDir, 'package.json')
const bundles = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, 'utf8')).dsh?.profile?.bundles ?? [])
  : []
const hasRow = /^[ \t]*-[ \t]*id:[ \t]*dev-workflow[ \t]*$/m.test(patchText)
const inBundles = Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)

if (hasRow) console.log('• 组合行已存在(profile 的 cordis.patch.yml)')
else if (inBundles) console.log('• 本包已在 dsh.profile.bundles 里,组合行由随包 patch 提供')
else if (options.dryRun) console.log('• 将向 profile 的 cordis.patch.yml 插入组合行')
else {
  const body = patchText.replace(/\r\n/g, '\n').trim()
  const block = `${ROW_LINES.join('\n')}\n`
  const next = body === '' || body === '[]'
    ? block
    : `${patchText.replace(/\s*$/, '')}\n\n${block}`
  const backup = `${patchFile}.install-dev-workflow.bak`
  if (patchText !== '' && !existsSync(backup)) writeFileSync(backup, patchText, 'utf8')
  const temporary = `${patchFile}.install.tmp`
  writeFileSync(temporary, next, 'utf8')
  renameSync(temporary, patchFile)
  console.log('✓ 已插入组合行(原文件备份为 .install-dev-workflow.bak)')
}

console.log('\n重启 DSH 后生效(设置右上角的「重启」);之后设置里会出现「dev-workflow 预设」总开关。')
