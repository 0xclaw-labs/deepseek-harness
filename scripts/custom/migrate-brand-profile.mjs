#!/usr/bin/env node
/**
 * Safely migrate or reset an installed 随身搭子 desktop profile whose default
 * Workspace still points at the upstream/shared
 * `~/Documents/deepseek-harness/default-workspace`.
 *
 * The tool is deliberately conservative:
 *   - dry-run is the default; only `--apply` writes;
 *   - the user must choose `--mode reset` or `--mode migrate`;
 *   - both desktop apps must be quit before apply;
 *   - the old profile is backed up (private modes) before any change;
 *   - the upstream shared directory is never moved, renamed or deleted;
 *   - Sessions are never rewritten. A Workspace whose record already owns
 *     Sessions keeps its old path (and therefore keeps them visible); a new
 *     brand-path Workspace becomes the default instead of silently filtering
 *     those Sessions out.
 *
 * Run `--help` for usage. This file has no package dependencies so it can be
 * executed by the app's bundled Electron runtime through the .sh wrapper.
 */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import {
  access, chmod, copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath,
  rename, rm, stat, statfs, symlink, utimes,
} from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { homedir, platform } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL = 'migrate-brand-profile'
const TOOL_VERSION = '1.0.0'
const BACKUP_SCHEMA = 'suishendazi-profile-migration-backup/v1'
const APP_ID = 'cc.suishendazi.app'
const PRODUCT_NAME = '随身搭子'
const OFFICIAL_APP_ID = 'com.deepseek.dsh'
const OFFICIAL_APP = '/Applications/DeepSeek Harness.app'
const BRAND_APP = '/Applications/随身搭子.app'
const LEGACY_IDENTITY_ID = 'com.deepseek.harness'
const PRESERVED_ON_RESET = ['.credentials.yaml', '.anonymous-user-id']
const WORKSPACE_VERSION = 2
const DEFAULT_TARGET = ['随身搭子', 'default-workspace']
const DEFAULT_LEGACY = ['deepseek-harness', 'default-workspace']

const EXIT_OK = 0
const EXIT_BLOCKED = 1
const EXIT_USAGE = 2

/** Parse the small, dependency-free command line. */
function parseArgs(argv) {
  const options = {
    mode: undefined,
    apply: false,
    dryRun: false,
    json: false,
    help: false,
    home: undefined,
    profile: undefined,
    dshHome: undefined,
    target: undefined,
    legacyWorkspace: undefined,
    officialHome: undefined,
    source: undefined,
    title: undefined,
    backupRoot: undefined,
    rollback: undefined,
    noCopy: false,
    restoreCredentials: false,
    verify: 'size',
  }
  const valueFlags = new Map([
    ['--mode', 'mode'],
    ['--home', 'home'],
    ['--profile', 'profile'],
    ['--dsh-home', 'dshHome'],
    ['--target', 'target'],
    ['--legacy-workspace', 'legacyWorkspace'],
    ['--official-home', 'officialHome'],
    ['--source', 'source'],
    ['--title', 'title'],
    ['--backup-root', 'backupRoot'],
    ['--rollback', 'rollback'],
    ['--verify', 'verify'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (arg === '--apply') { options.apply = true; continue }
    if (arg === '--dry-run') { options.dryRun = true; continue }
    if (arg === '--json') { options.json = true; continue }
    if (arg === '--no-copy') { options.noCopy = true; continue }
    if (arg === '--restore-credentials') { options.restoreCredentials = true; continue }
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    const key = valueFlags.get(flag)
    if (key !== undefined) {
      const value = inline ?? argv[index + 1]
      if (value === undefined || value === '' || (inline === undefined && value.startsWith('-'))) {
        throw usageError(`missing value for ${flag}`)
      }
      if (inline === undefined) index += 1
      options[key] = value
      continue
    }
    throw usageError(`unknown argument: ${arg}`)
  }
  if (options.help) return options
  if (options.apply && options.dryRun) throw usageError('--apply and --dry-run are mutually exclusive')
  if (options.rollback !== undefined && options.mode !== undefined) throw usageError('--rollback and --mode are mutually exclusive')
  if (options.rollback === undefined && options.mode === undefined) {
    throw usageError('choose an explicit mode: --mode reset or --mode migrate')
  }
  if (options.mode !== undefined && options.mode !== 'reset' && options.mode !== 'migrate') {
    throw usageError("--mode must be 'reset' or 'migrate'")
  }
  if (options.source !== undefined && options.noCopy) throw usageError('--source and --no-copy are mutually exclusive')
  if (options.verify !== 'size' && options.verify !== 'hash') throw usageError("--verify must be 'size' or 'hash'")
  return options
}

function usageError(message) {
  const error = new Error(message)
  error.usage = true
  return error
}

function usage() {
  return `随身搭子已有 profile 迁移/重置工具 ${TOOL_VERSION}

用法:
  scripts/custom/migrate-brand-profile.sh --mode migrate [--dry-run|--apply]
  scripts/custom/migrate-brand-profile.sh --mode reset   [--dry-run|--apply]
  scripts/custom/migrate-brand-profile.sh --rollback <备份目录> [--dry-run|--apply]
  scripts/custom/migrate-brand-profile.sh --help

默认是 --dry-run，不会写任何文件。选择模式后先看计划，再显式加 --apply。

模式:
  migrate  保留旧工作区与会话；复制共享工作区内容到品牌目录（不删除源），
           新增品牌路径工作区并设为默认。旧工作区没有会话时原地改路径。
  reset    备份旧品牌 dsh-home 后清空（保留 .credentials.yaml /
           .anonymous-user-id），让新包下次启动在品牌路径重建默认工作区。

关键安全门:
  - --apply 前必须退出随身搭子和官方 DeepSeek Harness；
  - 官方 ~/.dsh、官方 userData、~/Documents/deepseek-harness 不会被移动/删除；
  - session 日志、session.lock、attachments、session_projcache 不会被改写；
  - 凭据文件只复制/保留，不读取内容、不打印 token。

常用选项:
  --target <dir>            品牌目标工作区 (默认
                            ~/Documents/随身搭子/default-workspace)
  --source <dir>            显式复制源目录 (默认仅复制旧共享默认工作区)
  --no-copy                 只切换注册，不复制工作区文件
  --title <name>            新工作区标题 (默认 default-workspace)
  --verify size|hash        复制后校验方式 (默认 size；金标测试用 hash)
  --json                    机器可读输出
  --restore-credentials     rollback 时用备份里的旧凭据覆盖当前凭据
                            (默认保留回滚前当前凭据，避免把用户登出)

退出码: 0 成功/无需操作；1 被阻断或执行失败；2 用法错误。`
}

/** Resolve one CLI path against the supplied home and cwd. */
function expandPath(value, home) {
  if (value === '~') return home
  if (value.startsWith('~/')) return join(home, value.slice(2))
  return resolve(value)
}

function appDataRoot(home) {
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support')
  if (platform() === 'win32') return process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
  return process.env.XDG_CONFIG_HOME ?? join(home, '.config')
}

/** The OS Documents directory; a fake `--home` never calls osascript. */
function documentsRoot(home, fakeHome) {
  if (process.platform === 'darwin' && !fakeHome) {
    try {
      const stdout = execFileSync('osascript', [
        '-e', 'POSIX path of (path to documents folder from user domain without folder creation)',
      ], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      const value = stdout.trim()
      if (value !== '') return value
    } catch {
      // Fall back to the conventional path; this is a read-only lookup.
    }
  }
  return join(home, 'Documents')
}

function resolvePaths(options) {
  const fakeHome = options.home !== undefined
  const home = fakeHome ? resolve(expandPath(options.home, process.cwd())) : homedir()
  const profile = options.profile !== undefined
    ? expandPath(options.profile, home)
    : join(appDataRoot(home), APP_ID)
  const dshHome = options.dshHome !== undefined ? expandPath(options.dshHome, home) : join(profile, 'dsh-home')
  const docs = documentsRoot(home, fakeHome)
  const target = options.target !== undefined
    ? expandPath(options.target, home)
    : join(docs, ...DEFAULT_TARGET)
  const legacyWorkspace = options.legacyWorkspace !== undefined
    ? expandPath(options.legacyWorkspace, home)
    : join(docs, ...DEFAULT_LEGACY)
  const officialHome = options.officialHome !== undefined
    ? expandPath(options.officialHome, home)
    : join(home, '.dsh')
  const backupRoot = options.backupRoot !== undefined
    ? expandPath(options.backupRoot, home)
    : join(dirname(profile), `${APP_ID}.migration-backups`)
  return {
    home,
    fakeHome,
    profile,
    dshHome,
    target,
    legacyWorkspace,
    officialHome,
    backupRoot,
    brandApp: process.env.DSH_MIGRATION_BRAND_APP ?? BRAND_APP,
    officialApp: process.env.DSH_MIGRATION_OFFICIAL_APP ?? OFFICIAL_APP,
    scriptPath: fileURLToPath(import.meta.url),
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function lowerPath(value) {
  return process.platform === 'darwin' || process.platform === 'win32' ? value.toLowerCase() : value
}

function samePath(left, right) {
  return lowerPath(resolve(left)) === lowerPath(resolve(right))
}

function isSubpath(parent, child) {
  const rel = relative(lowerPath(resolve(parent)), lowerPath(resolve(child)))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function lstatSafe(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function statSafe(path) {
  try {
    return await stat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function nearestExistingDirectory(path) {
  let current = resolve(path)
  for (;;) {
    const info = await lstatSafe(current)
    if (info !== undefined) return info.isDirectory() ? current : dirname(current)
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function realpathIfExists(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Canonicalize a path that may not exist yet by resolving its deepest existing
 * ancestor and appending the missing segments unchanged.
 */
async function canonicalFuturePath(path) {
  const absolute = resolve(path)
  let current = absolute
  const missing = []
  for (;;) {
    try {
      const canonical = await realpath(current)
      return missing.length === 0 ? canonical : join(canonical, ...missing.reverse())
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) return absolute
      missing.push(basename(current))
      current = parent
    }
  }
}

async function fileMode(path) {
  const info = await lstatSafe(path)
  return info === undefined ? undefined : info.mode & 0o777
}

async function readJson(path) {
  const text = await readFile(path, 'utf8')
  return JSON.parse(text)
}

function shortPath(path, home) {
  if (path === home) return '~'
  if (path.startsWith(`${home}${sep}`)) return `~${path.slice(home.length)}`
  return path
}

/** Throwing registry validation for the brand profile before any mutation. */
function validateRegistry(data, label = 'workspace.json') {
  if (!isObject(data) || !isObject(data.unit) || data.unit.name !== 'workspace'
    || !Number.isInteger(data.unit.version)) {
    throw new Error(`${label}: missing or foreign workspace unit header`)
  }
  if (data.unit.version !== WORKSPACE_VERSION) {
    throw new Error(`${label}: workspace unit version ${data.unit.version} is newer/older than supported ${WORKSPACE_VERSION}`)
  }
  if (!isObject(data.global)) throw new Error(`${label}: global state is missing`)
  if (typeof data.global.initialized !== 'boolean') throw new Error(`${label}: global.initialized must be boolean`)
  if (!Array.isArray(data.global.workspaceIds) || data.global.workspaceIds.some(id => typeof id !== 'string')) {
    throw new Error(`${label}: global.workspaceIds must be a string array`)
  }
  if (data.global.defaultWorkspaceId !== undefined && typeof data.global.defaultWorkspaceId !== 'string') {
    throw new Error(`${label}: global.defaultWorkspaceId must be a string when present`)
  }
  for (const field of ['archivedSessionIds', 'pinnedSessionIds']) {
    const value = data.global[field]
    if (value !== undefined && (!Array.isArray(value) || value.some(id => typeof id !== 'string'))) {
      throw new Error(`${label}: global.${field} must be a string array`)
    }
  }
  if (!isObject(data.tables) || !isObject(data.tables.workspaces) || Array.isArray(data.tables.workspaces)) {
    throw new Error(`${label}: tables.workspaces is missing`)
  }
  const table = data.tables.workspaces
  const tableIds = Object.keys(table)
  const order = data.global.workspaceIds
  if (new Set(order).size !== order.length) throw new Error(`${label}: workspaceIds repeats an id`)
  for (const id of order) {
    if (!Object.prototype.hasOwnProperty.call(table, id)) {
      throw new Error(`${label}: workspaceIds references missing workspace ${id}`)
    }
  }
  if (data.global.initialized) {
    for (const id of tableIds) {
      if (!order.includes(id)) throw new Error(`${label}: workspace ${id} is absent from registry order`)
    }
  }
  const paths = new Map()
  const accounted = new Map()
  for (const [id, record] of Object.entries(table)) {
    if (!isObject(record)) throw new Error(`${label}: workspace ${id} is not an object`)
    if (typeof record.path !== 'string' || !isAbsolute(record.path)) {
      throw new Error(`${label}: workspace ${id} has no absolute path`)
    }
    if (typeof record.title !== 'string') throw new Error(`${label}: workspace ${id} has no title`)
    if (!Array.isArray(record.sessionIds) || record.sessionIds.some(sessionId => typeof sessionId !== 'string')) {
      throw new Error(`${label}: workspace ${id} has invalid sessionIds`)
    }
    if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') {
      throw new Error(`${label}: workspace ${id} has invalid timestamps`)
    }
    const pathKey = lowerPath(resolve(record.path))
    const holder = paths.get(pathKey)
    if (holder !== undefined) {
      throw new Error(`${label}: path ${record.path} is claimed by both ${holder} and ${id}`)
    }
    paths.set(pathKey, id)
    for (const sessionId of record.sessionIds) {
      const owner = accounted.get(sessionId)
      if (owner !== undefined) {
        throw new Error(`${label}: session ${sessionId} is accounted by both ${owner} and ${id}`)
      }
      accounted.set(sessionId, id)
    }
  }
  return data
}

function summarizeRegistry(data) {
  const table = data.tables.workspaces
  const workspaces = data.global.workspaceIds.map((id) => {
    const record = table[id]
    return {
      id,
      path: record.path,
      title: record.title,
      sessionIds: [...record.sessionIds],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  })
  const defaultId = data.global.defaultWorkspaceId
  const defaultRecord = defaultId === undefined ? undefined : table[defaultId]
  return {
    initialized: data.global.initialized,
    workspaceIds: [...data.global.workspaceIds],
    defaultWorkspaceId: defaultId,
    defaultPath: defaultRecord?.path,
    archivedSessionCount: (data.global.archivedSessionIds ?? []).length,
    pinnedSessionCount: (data.global.pinnedSessionIds ?? []).length,
    workspaces,
    totalAccountedSessions: workspaces.reduce((sum, workspace) => sum + workspace.sessionIds.length, 0),
    defaultMissing: defaultId !== undefined && defaultRecord === undefined,
  }
}

async function readBrandRegistry(dshHome) {
  const path = join(dshHome, 'storages', 'workspace.json')
  const info = await lstatSafe(path)
  if (info === undefined) return { path, exists: false, data: undefined, summary: undefined, error: undefined }
  try {
    const data = validateRegistry(await readJson(path))
    return { path, exists: true, data, summary: summarizeRegistry(data), error: undefined }
  } catch (error) {
    return { path, exists: true, data: undefined, summary: undefined, error: error.message }
  }
}

/** Loose path extraction for the official home: never mutates or validates it. */
async function readOfficialPaths(officialHome) {
  const path = join(officialHome, 'storages', 'workspace.json')
  const info = await lstatSafe(path)
  if (info === undefined) return { path, exists: false, paths: [], error: undefined }
  try {
    const data = await readJson(path)
    const table = isObject(data) && isObject(data.tables) ? data.tables.workspaces : undefined
    if (!isObject(table)) return { path, exists: true, paths: [], error: 'official workspace.json has no workspaces table' }
    const paths = []
    for (const [id, record] of Object.entries(table)) {
      if (isObject(record) && typeof record.path === 'string') paths.push({ id, path: record.path })
    }
    return { path, exists: true, paths, error: undefined }
  } catch (error) {
    return { path, exists: true, paths: [], error: `official workspace.json could not be parsed: ${error.message}` }
  }
}

function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const char = String.fromCharCode(code)
    if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) out += char
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** Exact copy of the session persistence project-key algorithm. */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const char = String.fromCharCode(code)
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
      readable += char
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

async function countSessionDirsForPath(dshHome, cwd) {
  if (cwd === undefined) return 0
  const root = join(dshHome, 'sessions', projectKey(cwd))
  const info = await lstatSafe(root)
  if (info === undefined || !info.isDirectory()) return 0
  const entries = await readdir(root, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).length
}

async function countSessions(dshHome) {
  const root = join(dshHome, 'sessions')
  const info = await lstatSafe(root)
  if (info === undefined || !info.isDirectory()) return { projectDirs: 0, sessionDirs: 0, files: 0, bytes: 0 }
  let projectDirs = 0
  let sessionDirs = 0
  let files = 0
  let bytes = 0
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    projectDirs += 1
    const projectPath = join(root, project.name)
    for (const session of await readdir(projectPath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      sessionDirs += 1
      const sessionPath = join(projectPath, session.name)
      for (const entry of await readdir(sessionPath, { withFileTypes: true })) {
        const entryPath = join(sessionPath, entry.name)
        const entryInfo = await lstatSafe(entryPath)
        if (entryInfo?.isFile()) { files += 1; bytes += entryInfo.size }
      }
    }
  }
  return { projectDirs, sessionDirs, files, bytes }
}

async function countProjectCache(dshHome) {
  const root = join(dshHome, 'storages', 'session_projcache', 'sessions')
  const info = await lstatSafe(root)
  if (info === undefined || !info.isDirectory()) return 0
  return (await readdir(root)).length
}

async function countAttachments(dshHome) {
  const root = join(dshHome, 'attachments', 'v1')
  const info = await lstatSafe(root)
  if (info === undefined || !info.isDirectory()) return { files: 0, bytes: 0 }
  const tree = await scanTree(root)
  return { files: tree.files, bytes: tree.bytes }
}

/** Walk a tree without following symlinks; optionally hash every file. */
async function scanTree(root, options = {}) {
  const entries = []
  let files = 0
  let dirs = 0
  let symlinks = 0
  let bytes = 0
  let visited = 0
  const hash = options.hash === true
  const progress = options.progress
  async function walk(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) {
        symlinks += 1
        const link = await readlink(absolute)
        entries.push({ path: rel, type: 'symlink', target: link })
      } else if (info.isDirectory()) {
        dirs += 1
        entries.push({ path: rel, type: 'dir', mode: info.mode & 0o777 })
        await walk(absolute, rel)
      } else if (info.isFile()) {
        files += 1
        bytes += info.size
        const item = { path: rel, type: 'file', size: info.size, mode: info.mode & 0o777 }
        if (hash) item.sha256 = await sha256File(absolute)
        entries.push(item)
        visited += 1
        if (progress !== undefined && visited % 200 === 0) progress(visited, bytes)
      } else {
        entries.push({ path: rel, type: 'other', mode: info.mode & 0o777 })
      }
    }
  }
  const rootInfo = await lstatSafe(root)
  if (rootInfo === undefined) return { exists: false, entries, files, dirs, symlinks, bytes }
  if (!rootInfo.isDirectory()) {
    if (rootInfo.isFile()) {
      const item = { path: '.', type: 'file', size: rootInfo.size, mode: rootInfo.mode & 0o777 }
      if (hash) item.sha256 = await sha256File(root)
      entries.push(item)
      return { exists: true, entries, files: 1, dirs: 0, symlinks: 0, bytes: rootInfo.size }
    }
    return { exists: true, entries, files: 0, dirs: 0, symlinks: 0, bytes: 0 }
  }
  await walk(root, '')
  return { exists: true, entries, files, dirs, symlinks, bytes }
}

async function sha256File(path) {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

/** Content equality for an existing target file; size alone is never enough. */
async function sameFileContent(source, target) {
  try {
    const [left, right] = await Promise.all([sha256File(source), sha256File(target)])
    return left === right
  } catch {
    // An unreadable existing target is a conflict, not permission to overwrite it.
    return false
  }
}

function entryMap(tree) {
  return new Map(tree.entries.map(entry => [entry.path, entry]))
}

/** Merge-copy a directory tree; never overwrites an existing target entry. */
async function copyTreeMerge(source, target, options = {}) {
  const copied = []
  const identical = []
  const conflicts = []
  let files = 0
  let bytes = 0
  const progress = options.progress
  async function copyDir(from, to, prefix) {
    await mkdir(to, { recursive: true, mode: 0o700 })
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const sourcePath = join(from, entry.name)
      const targetPath = join(to, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const sourceInfo = await lstat(sourcePath)
      if (sourceInfo.isSymbolicLink()) {
        const link = await readlink(sourcePath)
        const targetInfo = await lstatSafe(targetPath)
        if (targetInfo !== undefined) {
          const same = targetInfo.isSymbolicLink() && (await readlink(targetPath)) === link
          ;(same ? identical : conflicts).push(rel)
          continue
        }
        await symlink(link, targetPath)
        copied.push(rel)
        continue
      }
      if (sourceInfo.isDirectory()) {
        const targetInfo = await lstatSafe(targetPath)
        if (targetInfo !== undefined && !targetInfo.isDirectory()) {
          conflicts.push(rel)
          continue
        }
        await copyDir(sourcePath, targetPath, rel)
        continue
      }
      if (!sourceInfo.isFile()) {
        conflicts.push(rel)
        continue
      }
      const targetInfo = await lstatSafe(targetPath)
      if (targetInfo !== undefined) {
        const same = targetInfo.isFile() && targetInfo.size === sourceInfo.size
          && await sameFileContent(sourcePath, targetPath)
        ;(same ? identical : conflicts).push(rel)
        continue
      }
      try {
        await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL)
      } catch (error) {
        if (error.code === 'EEXIST') { conflicts.push(rel); continue }
        throw error
      }
      await chmod(targetPath, sourceInfo.mode & 0o777)
      await utimes(targetPath, sourceInfo.atime, sourceInfo.mtime)
      copied.push(rel)
      files += 1
      bytes += sourceInfo.size
      if (progress !== undefined && files % 200 === 0) progress(files, bytes)
    }
  }
  await copyDir(source, target, '')
  return { copied, identical, conflicts, files, bytes }
}

async function verifyCopied(source, target, copiedPaths, mode) {
  const problems = []
  for (const rel of copiedPaths) {
    const sourcePath = join(source, ...rel.split('/'))
    const targetPath = join(target, ...rel.split('/'))
    const sourceInfo = await lstatSafe(sourcePath)
    const targetInfo = await lstatSafe(targetPath)
    if (targetInfo === undefined) { problems.push(`${rel}: missing after copy`); continue }
    if (sourceInfo === undefined) { problems.push(`${rel}: disappeared from source`); continue }
    if (sourceInfo.isSymbolicLink() || targetInfo.isSymbolicLink()) {
      if (!sourceInfo.isSymbolicLink() || !targetInfo.isSymbolicLink()) {
        problems.push(`${rel}: type mismatch`)
      } else if (await readlink(sourcePath) !== await readlink(targetPath)) {
        problems.push(`${rel}: symlink target mismatch`)
      }
      continue
    }
    if (sourceInfo.isFile()) {
      if (!targetInfo.isFile() || sourceInfo.size !== targetInfo.size) {
        problems.push(`${rel}: size/type mismatch`)
        continue
      }
      if (mode === 'hash') {
        const [left, right] = await Promise.all([sha256File(sourcePath), sha256File(targetPath)])
        if (left !== right) problems.push(`${rel}: content hash mismatch`)
      }
    }
  }
  return problems
}

async function chmodTreePrivate(root) {
  const info = await lstatSafe(root)
  if (info === undefined) return
  if (info.isSymbolicLink()) return
  if (info.isDirectory()) {
    await chmod(root, (info.mode & 0o700) | 0o700)
    for (const entry of await readdir(root)) await chmodTreePrivate(join(root, entry))
    return
  }
  await chmod(root, info.mode & 0o700)
}

async function writeTextAtomic(path, text, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now()}`)
  const handle = await open(temp, 'wx', mode)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, path)
    await fsyncDirectory(dirname(path))
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

async function writeJsonAtomic(path, value, mode = 0o600) {
  await writeTextAtomic(path, `${JSON.stringify(value, undefined, 2)}\n`, mode)
}

async function fsyncDirectory(path) {
  if (process.platform === 'win32') return
  try {
    const handle = await open(path, 'r')
    try { await handle.sync() } finally { await handle.close() }
  } catch {
    // Directory fsync is best effort on filesystems that reject it.
  }
}

function timestampCompact(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

async function uniqueDirectory(parent, name) {
  await mkdir(parent, { recursive: true, mode: 0o700 })
  let candidate = join(parent, name)
  let suffix = 2
  while (await exists(candidate)) {
    candidate = join(parent, `${name}-${suffix}`)
    suffix += 1
  }
  return candidate
}


/** Read a profile patch and rewrite any workspace-controller default path. */
function transformPatch(text, target) {
  const lines = text.split('\n')
  const replacements = []
  let currentId
  for (let index = 0; index < lines.length; index += 1) {
    const idMatch = /^\s*-\s*id:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/.exec(lines[index])
    if (idMatch !== null) currentId = idMatch[1] ?? idMatch[2] ?? idMatch[3]
    if (currentId !== 'workspace-controller') continue
    const pathMatch = /^(\s*)defaultWorkspacePath:\s*(.*)$/.exec(lines[index])
    if (pathMatch === null) continue
    const next = `${pathMatch[1]}defaultWorkspacePath: ${JSON.stringify(target)}`
    if (lines[index] !== next) {
      replacements.push({ line: index + 1, before: lines[index].trim(), after: next.trim() })
      lines[index] = next
    }
  }
  return { changed: replacements.length > 0, text: lines.join('\n'), replacements }
}

/** List desktop processes, matching the private/official profile paths. */
function detectProcesses(paths) {
  if (process.platform === 'win32') {
    return { supported: false, brand: [], official: [] }
  }
  let output
  try {
    output = execFileSync('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10_000,
    })
  } catch {
    return { supported: false, brand: [], official: [] }
  }
  const brandNeedle = paths.dshHome
  const brandProfile = paths.profile
  const officialNeedle = join(paths.officialHome, 'profiles', 'desktop')
  const brand = []
  const official = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const command = match[2]
    if (pid === process.pid || command.includes(TOOL)) continue
    const isBrand = command.includes(brandNeedle)
      || (command.includes(brandProfile) && (command.includes('Contents/MacOS') || command.includes('user-data-dir')))
    if (isBrand) {
      brand.push({ pid, command: command.slice(0, 240) })
      continue
    }
    const isOfficial = command.includes(officialNeedle)
      || (command.includes(paths.officialHome) && command.includes('dsh-desktop-host'))
    if (isOfficial) official.push({ pid, command: command.slice(0, 240) })
  }
  return { supported: true, brand, official }
}

async function inspectOfficial(paths, sourcePath) {
  const registry = await readOfficialPaths(paths.officialHome)
  const references = []
  const referencesLegacy = []
  const legacyCanonical = (await realpathIfExists(paths.legacyWorkspace)) ?? resolve(paths.legacyWorkspace)
  const sourceCanonical = sourcePath === undefined
    ? undefined
    : (await realpathIfExists(sourcePath)) ?? resolve(sourcePath)
  for (const entry of registry.paths) {
    const canonical = (await realpathIfExists(entry.path)) ?? resolve(entry.path)
    if (samePath(canonical, legacyCanonical)) referencesLegacy.push(entry)
    if (sourceCanonical !== undefined && samePath(canonical, sourceCanonical)) references.push(entry)
  }
  const sessions = await countSessions(paths.officialHome)
  return { ...registry, referencesSource: references, referencesLegacy, sessions }
}

async function readCredentialsInfo(dshHome) {
  const path = join(dshHome, '.credentials.yaml')
  const info = await lstatSafe(path)
  return { path, present: info !== undefined, mode: info === undefined ? undefined : info.mode & 0o777 }
}

async function inspectState(paths, options) {
  const profileStat = await lstatSafe(paths.profile)
  const dshHomeStat = await lstatSafe(paths.dshHome)
  const registry = await readBrandRegistry(paths.dshHome)
  const summary = registry.summary
  const targetStat = await lstatSafe(paths.target)
  const targetCanonical = await canonicalFuturePath(paths.target)
  const legacyStat = await lstatSafe(paths.legacyWorkspace)
  const legacyCanonical = (await realpathIfExists(paths.legacyWorkspace)) ?? resolve(paths.legacyWorkspace)
  const defaultRecord = summary?.defaultWorkspaceId === undefined
    ? undefined
    : summary.workspaces.find(workspace => workspace.id === summary.defaultWorkspaceId)
  let sourcePath
  const sourceExplicit = options.source !== undefined
  if (options.source !== undefined) sourcePath = expandPath(options.source, paths.home)
  else if (options.noCopy === false && defaultRecord !== undefined) {
    const recordCanonical = (await realpathIfExists(defaultRecord.path)) ?? resolve(defaultRecord.path)
    if (samePath(recordCanonical, legacyCanonical)) sourcePath = defaultRecord.path
    else if (isSubpath(dirname(paths.legacyWorkspace), defaultRecord.path)) {
      // A shared-path Workspace that is not the documented default: do not
      // copy automatically, but name it so the user can decide with --source.
      sourcePath = undefined
    }
  }
  const sourceStat = sourcePath === undefined ? undefined : await lstatSafe(sourcePath)
  const official = await inspectOfficial(paths, sourcePath)
  const running = detectProcesses(paths)
  const sessions = await countSessions(paths.dshHome)
  const oldProfileNoHome = profileStat !== undefined && dshHomeStat === undefined
  const legacyIdentityPath = join(dirname(paths.profile), LEGACY_IDENTITY_ID)
  const legacyArchivePath = join(dirname(paths.profile), '_legacy-identity-20261022')
  return {
    paths,
    profileExists: profileStat !== undefined,
    profileIsDirectory: profileStat?.isDirectory() === true,
    dshHomeExists: dshHomeStat !== undefined,
    dshHomeIsDirectory: dshHomeStat?.isDirectory() === true,
    registry,
    summary,
    defaultRecord,
    targetExists: targetStat !== undefined,
    targetIsDirectory: targetStat?.isDirectory() === true,
    targetCanonical,
    legacyWorkspace: paths.legacyWorkspace,
    legacyExists: legacyStat !== undefined,
    legacyIsDirectory: legacyStat?.isDirectory() === true,
    sourcePath,
    sourceExplicit,
    sourceExists: sourceStat !== undefined,
    sourceIsDirectory: sourceStat?.isDirectory() === true,
    official,
    running,
    sessions,
    projectCacheCount: await countProjectCache(paths.dshHome),
    attachments: await countAttachments(paths.dshHome),
    credentials: await readCredentialsInfo(paths.dshHome),
    oldProfileNoHome,
    oldBrandAppInstalled: await exists(join(dirname(paths.brandApp), `${PRODUCT_NAME}-harness.app`)),
    legacyIdentityExists: await exists(legacyIdentityPath),
    legacyArchiveExists: await exists(legacyArchivePath),
    brandAppInstalled: await exists(paths.brandApp),
    officialAppInstalled: await exists(paths.officialApp),
  }
}

function migrateBlockers(state) {
  const blockers = []
  if (!state.running.supported) {
    // Process detection is a safety gate; an unsupported platform must not
    // silently claim the apps are stopped.
    if (process.platform === 'win32') blockers.push('当前平台不支持进程检测，无法确认应用已退出；请在 macOS 上运行或人工确认进程')
  }
  if (state.running.brand.length > 0) {
    blockers.push(`随身搭子仍在运行（pid ${state.running.brand.map(entry => entry.pid).join(', ')}）；请先退出应用再 --apply`)
  }
  if (state.running.official.length > 0) {
    blockers.push(`官方 DeepSeek Harness 仍在运行（pid ${state.running.official.map(entry => entry.pid).join(', ')}）；它可能正在写 ~/.dsh 或共享工作区，请先退出`)
  }
  return blockers
}

function registryMutation(registryData, options) {
  const {
    targetCanonical, targetPath, targetTitle, hasSessions, oldDefaultId,
  } = options
  const now = new Date().toISOString()
  if (registryData === undefined) {
    if (options.brandSessionDirs > 0) {
      return {
        kind: 'blocked', reason: 'workspace.json 缺失但品牌 profile 已有 sessions；先启动一次随身搭子让 Host 重建 registry，或改用 --mode reset',
      }
    }
    const id = randomUUID()
    const record = {
      path: targetCanonical,
      title: targetTitle,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
    const next = {
      unit: { name: 'workspace', version: WORKSPACE_VERSION },
      global: {
        initialized: true,
        workspaceIds: [id],
        archivedSessionIds: [],
        pinnedSessionIds: [],
        defaultWorkspaceId: id,
      },
      tables: { workspaces: { [id]: record } },
    }
    return {
      kind: 'create-fresh', next, id, newDefaultId: id, newDefaultPath: targetCanonical,
      keptOldWorkspace: false, oldDefaultId: undefined, oldPath: undefined,
    }
  }
  const next = structuredClone(registryData)
  next.global.archivedSessionIds ??= []
  next.global.pinnedSessionIds ??= []
  next.global.initialized = true
  const table = next.tables.workspaces
  const targetRecordId = Object.keys(table).find(id => samePath(table[id].path, targetCanonical))
  const defaultId = next.global.defaultWorkspaceId
  const defaultRecord = defaultId === undefined ? undefined : table[defaultId]
  const oldDefaultPath = defaultRecord?.path
  if (targetRecordId !== undefined) {
    if (next.global.defaultWorkspaceId === targetRecordId) {
      return { kind: 'none', next, newDefaultId: targetRecordId, newDefaultPath: table[targetRecordId].path }
    }
    next.global.defaultWorkspaceId = targetRecordId
    return {
      kind: 'set-default-existing', next, id: targetRecordId, newDefaultId: targetRecordId,
      newDefaultPath: table[targetRecordId].path, keptOldWorkspace: defaultRecord !== undefined,
      oldDefaultId: defaultId, oldPath: oldDefaultPath,
    }
  }
  if (defaultRecord !== undefined && !hasSessions) {
    const autoTitle = defaultRecord.title === basename(oldDefaultPath) || defaultRecord.title === 'default-workspace'
    defaultRecord.path = targetCanonical
    defaultRecord.title = options.titleExplicit ? targetTitle : (autoTitle ? targetTitle : defaultRecord.title)
    defaultRecord.updatedAt = now
    next.global.defaultWorkspaceId = defaultId
    return {
      kind: 'rewrite-empty', next, id: defaultId, newDefaultId: defaultId,
      newDefaultPath: targetCanonical, keptOldWorkspace: false, oldDefaultId: defaultId,
      oldPath: oldDefaultPath, title: defaultRecord.title,
    }
  }
  const id = randomUUID()
  table[id] = {
    path: targetCanonical,
    title: targetTitle,
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
  }
  next.global.workspaceIds = [id, ...next.global.workspaceIds]
  next.global.defaultWorkspaceId = id
  return {
    kind: 'add-new-default', next, id, newDefaultId: id, newDefaultPath: targetCanonical,
    keptOldWorkspace: defaultRecord !== undefined, oldDefaultId: defaultId,
    oldPath: oldDefaultPath,
  }
}

async function planCopy(state, options) {
  const warnings = []
  const blockers = []
  if (options.noCopy || state.sourcePath === undefined) {
    return { kind: 'none', warnings, blockers }
  }
  if (!state.sourceExists || !state.sourceIsDirectory) {
    if (state.sourceExplicit) blockers.push(`--source 不是存在的目录: ${state.sourcePath}`)
    else warnings.push(`旧共享工作区不存在，跳过内容复制: ${shortPath(state.sourcePath, state.paths.home)}`)
    return { kind: 'none', warnings, blockers }
  }
  if (state.targetExists && !state.targetIsDirectory) {
    blockers.push(`目标路径已存在但不是目录: ${state.paths.target}`)
    return { kind: 'none', warnings, blockers }
  }
  const sourceCanonical = (await realpathIfExists(state.sourcePath)) ?? resolve(state.sourcePath)
  const targetCanonical = state.targetExists
    ? (await realpathIfExists(state.paths.target)) ?? resolve(state.paths.target)
    : state.targetCanonical
  if (samePath(sourceCanonical, targetCanonical)) {
    blockers.push('复制源与目标相同；拒绝复制（可能把工作区复制进自身）')
    return { kind: 'none', warnings, blockers }
  }
  if (isSubpath(sourceCanonical, targetCanonical) || isSubpath(targetCanonical, sourceCanonical)) {
    blockers.push('复制源与目标互相嵌套；拒绝复制，请换一个 --target')
    return { kind: 'none', warnings, blockers }
  }
  const sourceTree = await scanTree(state.sourcePath)
  const targetTree = state.targetExists ? await scanTree(state.paths.target) : { entries: [], files: 0, bytes: 0 }
  const targetEntries = entryMap(targetTree)
  const toCreate = []
  const identical = []
  const conflicts = []
  for (const entry of sourceTree.entries) {
    const existing = targetEntries.get(entry.path)
    if (existing === undefined) { toCreate.push(entry); continue }
    if (existing.type === entry.type) {
      if (entry.type === 'file' && existing.size === entry.size
        && await sameFileContent(
          join(state.sourcePath, ...entry.path.split('/')),
          join(state.paths.target, ...entry.path.split('/')),
        )) identical.push(entry.path)
      else if (entry.type === 'symlink' && existing.target === entry.target) identical.push(entry.path)
      else if (entry.type === 'dir') identical.push(entry.path)
      else conflicts.push(entry.path)
    } else conflicts.push(entry.path)
  }
  const bytes = toCreate.filter(entry => entry.type === 'file').reduce((sum, entry) => sum + entry.size, 0)
  const files = toCreate.filter(entry => entry.type === 'file').length
  const symlinks = toCreate.filter(entry => entry.type === 'symlink').length
  let freeBytes
  try {
    const parent = await nearestExistingDirectory(state.targetExists ? state.paths.target : dirname(state.paths.target))
    const info = await statfs(parent)
    freeBytes = Number(info.bavail) * Number(info.bsize)
    if (freeBytes < bytes + 64 * 1024 * 1024) {
      blockers.push(`目标磁盘可用空间不足（需要约 ${formatBytes(bytes)}，可用 ${formatBytes(freeBytes)}）`)
    }
  } catch {
    warnings.push('无法读取目标磁盘可用空间；复制前请自行确认空间')
  }
  if (sourceTree.symlinks > 0) {
    warnings.push(`源目录含 ${sourceTree.symlinks} 个符号链接；会按链接原样复制（不会跟随/不会解引用）`)
  }
  if (conflicts.length > 0) {
    warnings.push(`目标已有 ${conflicts.length} 个同名但内容/类型不同的条目，将保留目标原文件并跳过（不覆盖）: ${conflicts.slice(0, 8).join(', ')}${conflicts.length > 8 ? ' …' : ''}`)
  }
  if (state.sourceExplicit && state.official.referencesSource.length > 0) {
    warnings.push('指定的复制源被官方 workspace.json 引用；本工具只读取/复制，绝不移动/删除源目录')
  }
  return {
    kind: 'copy',
    source: state.sourcePath,
    sourceCanonical,
    target: state.paths.target,
    sourceTree,
    targetTree,
    sourceFiles: sourceTree.files,
    sourceBytes: sourceTree.bytes,
    toCreate,
    identical,
    conflicts,
    files,
    bytes,
    symlinks,
    freeBytes,
    warnings,
    blockers,
  }
}

async function planPatch(state, target) {
  const path = join(state.paths.dshHome, 'profiles', 'desktop', 'cordis.patch.yml')
  const info = await lstatSafe(path)
  if (info === undefined) return { path, exists: false, changed: false, replacements: [], text: undefined }
  const text = await readFile(path, 'utf8')
  const transformed = transformPatch(text, target)
  return { path, exists: true, changed: transformed.changed, replacements: transformed.replacements, text: transformed.text }
}

async function planMigrate(state, options) {
  const blockers = migrateBlockers(state)
  const warnings = []
  const notes = []
  const targetPath = state.paths.target
  if (state.targetExists && !state.targetIsDirectory) blockers.push(`目标路径已存在但不是目录: ${targetPath}`)
  if (state.registry.error !== undefined) blockers.push(`品牌 workspace.json 无法安全解析: ${state.registry.error}`)
  if (state.dshHomeExists && !state.dshHomeIsDirectory) blockers.push('品牌 dsh-home 不是目录')
  if (state.registry.data !== undefined && state.registry.data.global.initialized === false
    && state.sessions.sessionDirs > 0) {
    blockers.push('workspace registry 尚未初始化但品牌 profile 已有 sessions；请先启动一次 app 让它完成 bootstrap，或改用 --mode reset')
  }
  if (state.sourcePath !== undefined && !state.sourceExists) {
    if (state.sourceExplicit) blockers.push(`--source 不存在: ${state.sourcePath}`)
    else warnings.push(`旧共享工作区不存在: ${shortPath(state.sourcePath, state.paths.home)}`)
  }
  if (state.sourcePath !== undefined && state.sourceExists && !state.sourceIsDirectory) {
    blockers.push(`旧共享工作区不是目录: ${state.sourcePath}`)
  }
  const copy = await planCopy(state, options)
  blockers.push(...copy.blockers)
  warnings.push(...copy.warnings)

  let hasSessions = false
  if (state.defaultRecord !== undefined) {
    hasSessions = state.defaultRecord.sessionIds.length > 0
      || (await countSessionDirsForPath(state.paths.dshHome, state.defaultRecord.path)) > 0
  }
  const targetTitle = options.title ?? basename(targetPath)
  let mutation
  try {
    mutation = registryMutation(state.registry.data, {
      targetCanonical: state.targetCanonical,
      targetPath,
      targetTitle,
      titleExplicit: options.title !== undefined,
      hasSessions,
      oldDefaultId: state.summary?.defaultWorkspaceId,
      brandSessionDirs: state.sessions.sessionDirs,
    })
  } catch (error) {
    blockers.push(`无法构造 workspace 变更: ${error.message}`)
    mutation = { kind: 'none' }
  }
  if (mutation.kind === 'blocked') blockers.push(mutation.reason)
  if (mutation.next !== undefined) {
    try {
      validateRegistry(mutation.next, 'planned workspace.json')
    } catch (error) {
      blockers.push(`计划中的 workspace.json 校验失败: ${error.message}`)
    }
  }
  const patch = await planPatch(state, targetPath)
  if (patch.replacements.length > 0) {
    warnings.push(`profile patch 中 workspace-controller 的旧 defaultWorkspacePath 将被改写为品牌路径（${patch.replacements.length} 行）`)
  }
  if (state.summary?.defaultMissing) warnings.push('registry 的 defaultWorkspaceId 指向不存在的记录；将修正为品牌路径')
  if (state.targetExists && state.targetIsDirectory && copy.kind === 'copy' && copy.conflicts.length === 0) {
    warnings.push('目标目录已存在；复制会保留已有文件，只补齐缺失内容')
  }
  if (mutation.kind === 'add-new-default' && state.defaultRecord !== undefined && hasSessions) {
    warnings.push(`旧默认工作区仍登记 ${state.defaultRecord.sessionIds.length} 个会话；将保留旧工作区（会话继续可见），新增品牌工作区并设为默认`)
  }
  if (mutation.kind === 'rewrite-empty') {
    warnings.push('旧默认工作区没有登记会话；将原地改写其 path/title，不新增重复工作区')
  }
  if (mutation.kind === 'none' && state.summary?.defaultPath !== undefined
    && samePath(state.summary.defaultPath, state.targetCanonical)) {
    notes.push('当前默认工作区已是品牌路径，无需迁移注册')
    if (patch.changed) notes.push('仅 profile patch 仍有旧 defaultWorkspacePath，需要更新')
  }
  if (state.credentials.present) {
    warnings.push('凭据文件存在：只保留/备份，不读取内容、不迁移 token')
  } else {
    warnings.push('品牌 dsh-home 没有 .credentials.yaml；迁移不会创建凭据，登录状态保持现状')
  }
  if (state.oldProfileNoHome) {
    warnings.push('检测到旧品牌 Electron profile 但没有 dsh-home：旧包共享 ~/.dsh 的数据属于官方/混合 home，本工具不会复制或删除')
  }
  if (state.legacyIdentityExists) {
    warnings.push(`检测到旧身份 profile「${LEGACY_IDENTITY_ID}」；它不属于当前品牌，本工具不迁移、不删除`)
  }
  if (state.official.referencesLegacy.length > 0) {
    warnings.push('官方 workspace.json 仍引用共享工作区；本工具只读取/复制源，绝不移动/删除官方目录')
  }
  if (state.officialAppInstalled && state.official.referencesLegacy.length === 0
    && state.official.referencesSource.length > 0) {
    warnings.push('官方 app 仍安装并引用该工作区；迁移只复制文件，源目录保留，官方不受影响')
  }
  if (state.registry.exists && state.summary !== undefined && mutation.kind !== 'none') {
    const after = summarizeRegistry(mutation.next)
    notes.push(`变更后 registry: ${after.workspaces.length} 个工作区，default=${shortPath(after.defaultPath ?? '', state.paths.home)}`)
  }
  const actions = []
  if (mutation.kind !== 'none') actions.push({ kind: 'workspace-registry', change: mutation.kind })
  if (copy.kind === 'copy') actions.push({ kind: 'copy-workspace', files: copy.files, bytes: copy.bytes })
  if (patch.changed) actions.push({ kind: 'profile-patch', replacements: patch.replacements.length })
  if (!state.targetExists) actions.push({ kind: 'ensure-target-dir', path: targetPath })
  return {
    mode: 'migrate', blocked: blockers, warnings, notes, actions, noop: actions.length === 0,
    copy, mutation, patch, targetPath, targetCanonical: state.targetCanonical, hasSessions,
  }
}

async function planReset(state) {
  const blockers = migrateBlockers(state)
  const warnings = []
  const notes = []
  const entries = state.dshHomeExists ? await readdir(state.paths.dshHome) : []
  const preserved = entries.filter(name => PRESERVED_ON_RESET.includes(name))
  const remove = entries.filter(name => !PRESERVED_ON_RESET.includes(name))
  if (state.targetExists && !state.targetIsDirectory) blockers.push(`目标路径已存在但不是目录: ${state.paths.target}`)
  if (state.dshHomeExists && !state.dshHomeIsDirectory) blockers.push('品牌 dsh-home 不是目录')
  if (state.registry.error !== undefined) {
    warnings.push(`当前 workspace.json 已损坏（${state.registry.error}）；reset 会备份后移除它`)
  }
  if (state.sessions.sessionDirs > 0) {
    warnings.push(`reset 将移除品牌私有 ${state.sessions.sessionDirs} 个 session；备份后可回滚`)
  }
  if (state.attachments.files > 0) warnings.push(`reset 将移除品牌私有 ${state.attachments.files} 个附件；备份后可回滚`)
  if (!state.credentials.present) warnings.push('没有 .credentials.yaml，reset 后需要重新登录')
  else warnings.push('将保留 .credentials.yaml 与 .anonymous-user-id（不读取内容）')
  if (state.oldProfileNoHome) warnings.push('此 profile 没有 dsh-home（旧包共享 ~/.dsh）；reset 只处理品牌私有数据，不会碰 ~/.dsh')
  if (state.running.official.length > 0) warnings.push('官方 app 正在运行；apply 会被阻断')
  if (state.official.referencesLegacy.length > 0) warnings.push('官方仍引用共享工作区；reset 只清品牌私有 dsh-home，不碰官方目录')
  notes.push('reset 后由新包启动时初始化品牌默认工作区；旧数据只在备份目录，不在活动 profile 中')
  const noop = (!state.dshHomeExists || remove.length === 0) && state.targetExists
  return {
    mode: 'reset',
    blocked: blockers,
    warnings,
    notes,
    entries,
    preserved,
    remove,
    actions: noop ? [] : [
      ...(state.dshHomeExists ? [{ kind: 'backup-and-reset-dsh-home', remove, preserve: preserved }] : []),
      ...(!state.targetExists ? [{ kind: 'ensure-target-dir', path: state.paths.target }] : []),
    ],
    noop,
    targetPath: state.paths.target,
  }
}

async function planRollback(paths, options) {
  const backupDir = resolve(expandPath(options.rollback, paths.home))
  const blockers = []
  const warnings = []
  const manifestPath = join(backupDir, 'manifest.json')
  const manifestInfo = await lstatSafe(manifestPath)
  if (manifestInfo === undefined) throw new Error(`备份目录没有 manifest.json: ${backupDir}`)
  const manifest = await readJson(manifestPath)
  if (manifest.schema !== BACKUP_SCHEMA) throw new Error(`不认识的备份 schema: ${manifest.schema}`)
  if (!Array.isArray(manifest.files)) throw new Error('备份 manifest 缺少 files 清单')
  const backupHome = join(backupDir, 'dsh-home')
  if (manifest.dshHomeBackup === null || !(await exists(backupHome))) {
    blockers.push('该备份不包含 dsh-home（创建时品牌 profile 尚无 dsh-home），没有可回滚的 profile')
  }
  const running = detectProcesses(paths)
  if (running.brand.length > 0) blockers.push('随身搭子仍在运行；请先退出再回滚')
  if (running.official.length > 0) blockers.push('官方 DeepSeek Harness 仍在运行；请先退出再回滚')
  const currentCredentials = join(paths.dshHome, '.credentials.yaml')
  const preserveCredentials = options.restoreCredentials !== true && (await exists(currentCredentials))
  if (preserveCredentials) warnings.push('回滚默认保留当前 .credentials.yaml（避免把迁移后重新登录的用户登出）；加 --restore-credentials 可恢复备份中的旧凭据')
  if (!(await exists(paths.dshHome))) warnings.push('当前品牌 dsh-home 不存在；直接恢复备份')
  if (typeof manifest.dshHome === 'string' && !samePath(manifest.dshHome, paths.dshHome)) {
    warnings.push(`备份来自另一个 dsh-home（${manifest.dshHome}）；将恢复到当前路径 ${paths.dshHome}`)
  }
  if (typeof manifest.brandProfile === 'string' && !samePath(manifest.brandProfile, paths.profile)) {
    warnings.push(`备份来自另一个品牌 profile（${manifest.brandProfile}）；只恢复 dsh-home，不动当前 Electron userData`)
  }
  return {
    mode: 'rollback',
    blocked: blockers,
    warnings,
    notes: ['回滚会把当前 dsh-home 移入备份隔离目录，不删除；目标工作区中复制出的文件不会自动删除'],
    actions: [
      ...(await exists(paths.dshHome) ? [{ kind: 'quarantine-current-dsh-home' }] : []),
      { kind: 'restore-dsh-home-from-backup', backupDir },
      ...(preserveCredentials ? [{ kind: 'preserve-current-credentials' }] : []),
    ],
    noop: false,
    backupDir,
    manifest,
    preserveCredentials,
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

async function createBackup(paths, plan, options) {
  const stamp = timestampCompact()
  const dir = await uniqueDirectory(paths.backupRoot, `${stamp}-${plan.mode}`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  let method = 'none'
  let quarantine
  try {
  if (paths.dshHome !== undefined && await exists(paths.dshHome)) {
    if (plan.mode === 'reset') {
      try {
        await rename(paths.dshHome, join(dir, 'dsh-home'))
        method = 'moved'
      } catch (error) {
        if (error.code !== 'EXDEV') throw error
        const copied = await copyTreeMerge(paths.dshHome, join(dir, 'dsh-home'))
        if (copied.conflicts.length > 0) {
          throw new Error(`备份复制出现冲突，未执行 reset: ${copied.conflicts.slice(0, 5).join(', ')}`)
        }
        const verification = await verifyCopied(paths.dshHome, join(dir, 'dsh-home'), copied.copied, 'hash')
        if (verification.length > 0) throw new Error(`备份校验失败: ${verification.slice(0, 5).join('; ')}`)
        quarantine = join(paths.profile, `dsh-home.pre-reset-${stamp}`)
        await rename(paths.dshHome, quarantine)
        method = 'copied+quarantined'
      }
    } else {
      const copied = await copyTreeMerge(paths.dshHome, join(dir, 'dsh-home'))
      if (copied.conflicts.length > 0) {
        throw new Error(`备份复制出现冲突，未执行迁移: ${copied.conflicts.slice(0, 5).join(', ')}`)
      }
      const verification = await verifyCopied(paths.dshHome, join(dir, 'dsh-home'), copied.copied, 'hash')
      if (verification.length > 0) throw new Error(`备份校验失败: ${verification.slice(0, 5).join('; ')}`)
      method = 'copied'
    }
  }
  await chmodTreePrivate(dir)
  const tree = await scanTree(join(dir, 'dsh-home'), {
    hash: true,
    progress: options.json ? undefined : (count, bytes) => process.stderr.write(`\r  备份校验中… ${count} 文件 / ${formatBytes(bytes)}`),
  })
  if (!options.json && tree.files > 0) process.stderr.write('\n')
  const manifest = {
    schema: BACKUP_SCHEMA,
    tool: TOOL,
    toolVersion: TOOL_VERSION,
    createdAt: new Date().toISOString(),
    mode: plan.mode,
    home: paths.home,
    brandProfile: paths.profile,
    dshHome: paths.dshHome,
    target: paths.target,
    legacyWorkspace: paths.legacyWorkspace,
    officialHome: paths.officialHome,
    dshHomeBackup: paths.dshHome === undefined || method === 'none' ? null : 'dsh-home',
    method,
    quarantine: quarantine ?? null,
    preserved: PRESERVED_ON_RESET,
    files: tree.entries,
    counts: { files: tree.files, dirs: tree.dirs, symlinks: tree.symlinks, bytes: tree.bytes },
    source: plan.copy?.source ?? null,
    copiedFiles: plan.copy?.toCreate?.map(entry => entry.path) ?? [],
  }
  await writeJsonAtomic(join(dir, 'manifest.json'), manifest)
  await writeTextAtomic(join(dir, 'RESTORE.md'), rollbackInstructions(dir, paths, manifest))
  return { dir, manifest, method, quarantine }
  } catch (error) {
    // A reset moves dsh-home before its manifest exists; put it back if any
    // later step fails, so a failed backup never leaves the profile missing.
    if (plan.mode === 'reset') {
      try {
        if (method === 'moved' && !(await exists(paths.dshHome))) {
          await rename(join(dir, 'dsh-home'), paths.dshHome)
        } else if (method === 'copied+quarantined' && quarantine !== undefined
          && !(await exists(paths.dshHome))) {
          await rename(quarantine, paths.dshHome)
        }
        await rm(dir, { recursive: true, force: true })
      } catch (restoreError) {
        throw new Error(`${error.message}; 恢复原 dsh-home 失败: ${restoreError.message}; 原数据在 ${dir}`)
      }
    } else {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    throw error
  }
}

function rollbackInstructions(dir, paths, manifest) {
  const script = paths.scriptPath
  return `# 回滚说明 — ${planModeLabel(manifest.mode)}

此目录由 ${TOOL} v${TOOL_VERSION} 在 ${manifest.createdAt} 生成。
- 品牌 profile: ${paths.profile}
- 品牌 dsh-home: ${paths.dshHome}
- 模式: ${manifest.mode}
- 备份内容: ${manifest.dshHomeBackup === null ? '（无 dsh-home）' : 'dsh-home/'}
- 复制出的目标工作区（回滚不会删除）: ${manifest.target}

## 推荐回滚（先退出随身搭子和官方 app）

    node ${JSON.stringify(script)} --rollback ${JSON.stringify(dir)} --apply

默认保留当前 .credentials.yaml，避免把迁移后重新登录的用户登出；
如需恢复备份里的旧凭据，加 --restore-credentials。

## 手动回滚

1. 退出两个 app。
2. 把当前品牌 dsh-home 移走（不要删除）：
       mv ${JSON.stringify(paths.dshHome)} ${JSON.stringify(join(dir, 'dsh-home.current'))}
3. 恢复备份：
       cp -R ${JSON.stringify(join(dir, 'dsh-home'))} ${JSON.stringify(paths.dshHome)}
4. 如需保留当前登录，把第 2 步移走的 .credentials.yaml 复制回来。
5. 目标工作区 ${JSON.stringify(manifest.target)} 中由本工具复制的文件不会被自动删除；
   复制清单在 manifest.json 的 copiedFiles 字段。源共享目录从未被移动/删除。

## 安全边界

- 官方 ~/.dsh、官方 userData、~/Documents/deepseek-harness 不在此备份/回滚范围内。
- 本工具不读取、不打印凭据内容。
`
}

function planModeLabel(mode) {
  return mode === 'reset' ? '干净重置' : mode === 'migrate' ? '保留数据迁移' : mode
}

async function ensureDirectory(path) {
  const info = await lstatSafe(path)
  if (info === undefined) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    return
  }
  if (!info.isDirectory()) throw new Error(`期望目录但发现其他类型: ${path}`)
}

async function applyMigrate(state, plan, options) {
  const running = detectProcesses(state.paths)
  const lateBlockers = migrateBlockers({ ...state, running })
  if (lateBlockers.length > 0) return { ok: false, blocked: lateBlockers, mode: 'migrate' }
  const backup = await createBackup(state.paths, plan, options)
  const afterBackup = migrateBlockers({ running: detectProcesses(state.paths) })
  if (afterBackup.length > 0) {
    return { ok: false, blocked: afterBackup, mode: 'migrate', backup: backup.dir }
  }
  let copyResult
  try {
    await ensureDirectory(state.paths.target)
    const actualTargetCanonical = await realpath(state.paths.target)
    let mutation = plan.mutation
    if (!samePath(actualTargetCanonical, plan.targetCanonical)) {
      mutation = registryMutation(state.registry.data, {
        targetCanonical: actualTargetCanonical,
        targetPath: state.paths.target,
        targetTitle: options.title ?? basename(state.paths.target),
        titleExplicit: options.title !== undefined,
        hasSessions: plan.hasSessions,
        oldDefaultId: state.summary?.defaultWorkspaceId,
        brandSessionDirs: state.sessions.sessionDirs,
      })
      if (mutation.kind === 'blocked') throw new Error(mutation.reason)
      validateRegistry(mutation.next, 'planned workspace.json')
    }
    if (plan.copy.kind === 'copy') {
      const copied = await copyTreeMerge(plan.copy.source, plan.copy.target, {
        progress: options.json ? undefined : (count, bytes) => {
          process.stderr.write(`\r  复制中… ${count} 文件 / ${formatBytes(bytes)}`)
        },
      })
      if (!options.json) process.stderr.write('\n')
      const verifyPaths = [...copied.copied, ...copied.identical]
      const verification = await verifyCopied(plan.copy.source, plan.copy.target, verifyPaths, options.verify)
      if (verification.length > 0) throw new Error(`复制校验失败: ${verification.slice(0, 10).join('; ')}`)
      copyResult = { ...copied, verification }
      await writeJsonAtomic(join(backup.dir, 'copy-manifest.json'), {
        target: state.paths.target,
        copied: copied.copied,
        identical: copied.identical,
        conflicts: copied.conflicts,
        files: copied.files,
        bytes: copied.bytes,
        verification,
      })
    }
    if (mutation.kind !== 'none') {
      await writeJsonAtomic(join(state.paths.dshHome, 'storages', 'workspace.json'), mutation.next)
    }
    if (plan.patch.changed) {
      const mode = (await fileMode(plan.patch.path)) ?? 0o600
      await writeTextAtomic(plan.patch.path, plan.patch.text, mode)
    }
    const applyLog = {
      schema: 'suishendazi-profile-migration-apply/v1',
      tool: TOOL,
      toolVersion: TOOL_VERSION,
      at: new Date().toISOString(),
      mode: 'migrate',
      backup: backup.dir,
      target: state.paths.target,
      registryChange: mutation.kind,
      newDefaultId: mutation.newDefaultId,
      oldWorkspaceKept: mutation.keptOldWorkspace === true,
      copied: copyResult === undefined ? null : {
        files: copyResult.files, bytes: copyResult.bytes,
        copied: copyResult.copied.length, identical: copyResult.identical.length,
        conflicts: copyResult.conflicts,
      },
      patchReplacements: plan.patch.replacements,
      warnings: plan.warnings,
    }
    await writeJsonAtomic(join(backup.dir, 'apply-log.json'), applyLog)
    return {
      ok: true,
      mode: 'migrate',
      backup: backup.dir,
      registryChange: mutation.kind,
      newDefaultId: mutation.newDefaultId,
      newDefaultPath: mutation.newDefaultPath,
      keptOldWorkspace: mutation.keptOldWorkspace === true,
      copied: copyResult === undefined ? undefined : {
        files: copyResult.files, bytes: copyResult.bytes,
        conflicts: copyResult.conflicts.length,
      },
    }
  } catch (error) {
    return {
      ok: false,
      mode: 'migrate',
      error: error.message,
      backup: backup.dir,
      rollbackHint: `node ${JSON.stringify(state.paths.scriptPath)} --rollback ${JSON.stringify(backup.dir)} --apply`,
    }
  }
}

async function applyReset(state, plan, options) {
  const running = detectProcesses(state.paths)
  const lateBlockers = migrateBlockers({ ...state, running })
  if (lateBlockers.length > 0) return { ok: false, blocked: lateBlockers, mode: 'reset' }
  const backup = await createBackup(state.paths, plan, options)
  const afterBackup = migrateBlockers({ running: detectProcesses(state.paths) })
  if (afterBackup.length > 0) {
    // No profile change happened yet beyond moving dsh-home into the backup;
    // put it back and discard this incomplete backup when possible.
    try {
      if (backup.method === 'moved') await rename(join(backup.dir, 'dsh-home'), state.paths.dshHome)
      else if (backup.method === 'copied+quarantined' && backup.quarantine !== undefined) {
        await rename(backup.quarantine, state.paths.dshHome)
      }
      await rm(backup.dir, { recursive: true, force: true })
    } catch {
      return {
        ok: false,
        blocked: afterBackup,
        mode: 'reset',
        backup: backup.dir,
        rollbackHint: `node ${JSON.stringify(state.paths.scriptPath)} --rollback ${JSON.stringify(backup.dir)} --apply`,
      }
    }
    return { ok: false, blocked: afterBackup, mode: 'reset' }
  }
  try {
    await ensureDirectory(state.paths.dshHome)
    for (const name of PRESERVED_ON_RESET) {
      const source = join(backup.dir, 'dsh-home', name)
      if (!(await exists(source))) continue
      const target = join(state.paths.dshHome, name)
      await copyFile(source, target)
      const info = await stat(source)
      await chmod(target, info.mode & 0o700)
    }
    await ensureDirectory(state.paths.target)
    const applyLog = {
      schema: 'suishendazi-profile-migration-apply/v1',
      tool: TOOL,
      toolVersion: TOOL_VERSION,
      at: new Date().toISOString(),
      mode: 'reset',
      backup: backup.dir,
      target: state.paths.target,
      removed: plan.remove,
      preserved: plan.preserved,
      warnings: plan.warnings,
    }
    await writeJsonAtomic(join(backup.dir, 'apply-log.json'), applyLog)
    return {
      ok: true,
      mode: 'reset',
      backup: backup.dir,
      removed: plan.remove,
      preserved: plan.preserved,
      target: state.paths.target,
    }
  } catch (error) {
    return {
      ok: false,
      mode: 'reset',
      error: error.message,
      backup: backup.dir,
      rollbackHint: `node ${JSON.stringify(state.paths.scriptPath)} --rollback ${JSON.stringify(backup.dir)} --apply`,
    }
  }
}

async function verifyBackupManifest(backupDir, manifest) {
  const root = join(backupDir, 'dsh-home')
  const tree = await scanTree(root, { hash: true })
  const expected = new Map(manifest.files.map(entry => [entry.path, entry]))
  const problems = []
  for (const entry of tree.entries) {
    const wanted = expected.get(entry.path)
    if (wanted === undefined) { problems.push(`${entry.path}: unexpected entry in backup`); continue }
    if (wanted.type !== entry.type) problems.push(`${entry.path}: type changed`)
    else if (entry.type === 'file' && (wanted.size !== entry.size || wanted.sha256 !== entry.sha256)) {
      problems.push(`${entry.path}: file hash/size changed`)
    } else if (entry.type === 'symlink' && wanted.target !== entry.target) {
      problems.push(`${entry.path}: symlink target changed`)
    }
  }
  for (const entry of manifest.files) {
    if (!tree.entries.some(candidate => candidate.path === entry.path)) problems.push(`${entry.path}: missing from backup`)
  }
  return problems
}

async function applyRollback(state, plan, options) {
  const running = detectProcesses(state.paths)
  const blockers = []
  if (running.brand.length > 0) blockers.push('随身搭子仍在运行；请先退出再回滚')
  if (running.official.length > 0) blockers.push('官方 DeepSeek Harness 仍在运行；请先退出再回滚')
  if (blockers.length > 0) return { ok: false, blocked: blockers, mode: 'rollback' }
  const backupHome = join(plan.backupDir, 'dsh-home')
  const verification = await verifyBackupManifest(plan.backupDir, plan.manifest)
  if (verification.length > 0) {
    return { ok: false, mode: 'rollback', error: `备份完整性校验失败: ${verification.slice(0, 10).join('; ')}` }
  }
  const stamp = timestampCompact()
  const quarantine = join(plan.backupDir, `rollback-current-${stamp}`)
  const currentExists = await exists(state.paths.dshHome)
  const restoring = `${state.paths.dshHome}.restoring-${stamp}-${randomUUID().slice(0, 8)}`
  try {
    if (currentExists) {
      await mkdir(quarantine, { recursive: true, mode: 0o700 })
      await rename(state.paths.dshHome, join(quarantine, 'dsh-home'))
    }
    const copied = await copyTreeMerge(backupHome, restoring)
    if (copied.conflicts.length > 0) throw new Error(`恢复复制冲突: ${copied.conflicts.slice(0, 5).join(', ')}`)
    if (plan.preserveCredentials && currentExists) {
      const currentCredentials = join(quarantine, 'dsh-home', '.credentials.yaml')
      if (await exists(currentCredentials)) {
        await copyFile(currentCredentials, join(restoring, '.credentials.yaml'))
        const info = await stat(currentCredentials)
        await chmod(join(restoring, '.credentials.yaml'), info.mode & 0o700)
      }
    }
    await rename(restoring, state.paths.dshHome)
    await writeJsonAtomic(join(plan.backupDir, `rollback-log-${stamp}.json`), {
      schema: 'suishendazi-profile-migration-rollback/v1',
      tool: TOOL,
      toolVersion: TOOL_VERSION,
      at: new Date().toISOString(),
      backup: plan.backupDir,
      quarantine: currentExists ? join(quarantine, 'dsh-home') : null,
      preservedCredentials: plan.preserveCredentials,
      targetFilesNote: `Copied target files are retained at ${plan.manifest.target}`,
    })
    return {
      ok: true,
      mode: 'rollback',
      restored: state.paths.dshHome,
      quarantine: currentExists ? join(quarantine, 'dsh-home') : undefined,
      preservedCredentials: plan.preserveCredentials,
    }
  } catch (error) {
    // If restore failed before publishing the new home, put the user's current
    // profile back rather than leaving them with no active dsh-home.
    if (currentExists && !(await exists(state.paths.dshHome)) && await exists(join(quarantine, 'dsh-home'))) {
      await rename(join(quarantine, 'dsh-home'), state.paths.dshHome).catch(() => {})
    }
    await rm(restoring, { recursive: true, force: true }).catch(() => {})
    return {
      ok: false,
      mode: 'rollback',
      error: error.message,
      quarantine: currentExists ? join(quarantine, 'dsh-home') : undefined,
      backup: plan.backupDir,
    }
  }
}

function printHuman(state, plan, options) {
  const home = state.paths.home
  const line = text => process.stdout.write(`${text}\n`)
  line(`${PRODUCT_NAME} 已有 profile ${plan.mode === 'reset' ? '重置' : plan.mode === 'migrate' ? '迁移' : '回滚'}计划  (${TOOL} v${TOOL_VERSION})`)
  line(options.apply ? '模式: APPLY（会写文件）' : '模式: DRY-RUN（不写任何文件）')
  line('')
  line('[本机状态]')
  line(`  品牌 profile : ${shortPath(state.paths.profile, home)} ${state.profileExists ? '(存在)' : '(不存在)'}`)
  line(`  品牌 DSH_HOME: ${shortPath(state.paths.dshHome, home)} ${state.dshHomeExists ? '(存在)' : '(不存在)'}`)
  if (state.summary !== undefined) {
    line(`  workspace    : default=${state.summary.defaultPath === undefined ? '(none)' : shortPath(state.summary.defaultPath, home)}`)
    line(`                  ${state.summary.workspaces.length} 个工作区, 登记 ${state.summary.totalAccountedSessions} 个会话`)
  } else if (state.registry.exists) {
    line(`  workspace    : 无法解析 (${state.registry.error})`)
  } else {
    line('  workspace    : (尚无 workspace.json)')
  }
  line(`  品牌 sessions: ${state.sessions.sessionDirs} 个会话目录, ${state.attachments.files} 个附件`)
  line(`  旧共享工作区 : ${shortPath(state.paths.legacyWorkspace, home)} ${state.legacyExists ? '(存在)' : '(不存在)'}`)
  line(`  官方 home    : ${shortPath(state.paths.officialHome, home)} ${state.official.exists ? '(存在)' : '(不存在)'}; 官方引用共享源: ${state.official.referencesLegacy.length > 0 || state.official.referencesSource.length > 0 ? '是' : '否'}`)
  line(`  目标工作区   : ${shortPath(state.paths.target, home)} ${state.targetExists ? '(存在)' : '(将创建)'}`)
  line(`  凭据         : ${state.credentials.present ? '存在（保留/备份，不读取内容）' : '不存在'}`)
  line(`  运行中       : 随身搭子=${state.running.brand.length > 0 ? '是' : '否'}, 官方=${state.running.official.length > 0 ? '是' : '否'}`)
  line('')
  if (plan.warnings.length > 0) {
    line('[提示]')
    for (const warning of plan.warnings) line(`  - ${warning}`)
    line('')
  }
  if (plan.blocked.length > 0) {
    line('[阻断]')
    for (const blocker of plan.blocked) line(`  - ${blocker}`)
    line('')
  }
  line('[计划]')
  if (plan.actions.length === 0) {
    line('  无需操作（目标已是品牌路径，且 profile patch 无需更新）')
  } else {
    for (const action of plan.actions) {
      if (action.kind === 'workspace-registry') {
        line(`  - 更新 workspace.json (${action.change})`)
      } else if (action.kind === 'copy-workspace') {
        line(`  - 复制 ${shortPath(plan.copy.source, home)} → ${shortPath(plan.copy.target, home)} (${plan.copy.files} 文件 / ${formatBytes(plan.copy.bytes)}; 不删除源)`)
      } else if (action.kind === 'profile-patch') {
        line(`  - 改写 ${shortPath(plan.patch.path, home)} 的 workspace-controller.defaultWorkspacePath`)
      } else if (action.kind === 'ensure-target-dir') {
        line(`  - 确保目标目录存在: ${shortPath(action.path, home)}`)
      } else if (action.kind === 'backup-and-reset-dsh-home') {
        line(`  - 备份并重置 dsh-home；移除 ${action.remove.length} 项，保留 ${action.preserve.join(', ') || '无'}`)
      } else if (action.kind === 'quarantine-current-dsh-home') {
        line('  - 当前 dsh-home 移入备份隔离目录（不删除）')
      } else if (action.kind === 'restore-dsh-home-from-backup') {
        line(`  - 从备份恢复 dsh-home: ${shortPath(plan.backupDir, home)}`)
      } else if (action.kind === 'preserve-current-credentials') {
        line('  - 保留当前 .credentials.yaml（回滚后仍保持登录）')
      } else {
        line(`  - ${action.kind}`)
      }
    }
  }
  if (plan.mutation?.kind !== undefined && plan.mutation.kind !== 'none') {
    line('')
    line('[workspace 变更]')
    line(`  kind=${plan.mutation.kind}, default=${plan.mutation.newDefaultPath === undefined ? '?' : shortPath(plan.mutation.newDefaultPath, home)}`)
    if (plan.mutation.keptOldWorkspace) line('  旧工作区及其会话保留，不重写 session header')
  }
  if (plan.notes !== undefined && plan.notes.length > 0) {
    line('')
    line('[预计结果]')
    for (const note of plan.notes) line(`  - ${note}`)
  }
  line('')
  if (plan.noop && plan.blocked.length === 0) line('结论: 无需变更。')
  else if (!options.apply) line('结论: 以上仅为 dry-run，未写任何文件。确认后加 --apply。')
}

function resultHuman(result) {
  if (result === undefined) return
  const line = text => process.stdout.write(`${text}\n`)
  line('')
  if (result.ok) {
    line(`[完成] ${result.mode}`)
    if (result.backup !== undefined) line(`  备份: ${result.backup}`)
    if (result.registryChange !== undefined) line(`  workspace: ${result.registryChange}${result.newDefaultPath === undefined ? '' : ` → ${result.newDefaultPath}`}`)
    if (result.copied !== undefined) line(`  复制: ${result.copied.files} 文件 / ${formatBytes(result.copied.bytes)}${result.copied.conflicts > 0 ? `, 跳过冲突 ${result.copied.conflicts}` : ''}`)
    if (result.removed !== undefined) line(`  重置移除: ${result.removed.length} 项；保留: ${result.preserved.join(', ') || '无'}`)
    if (result.restored !== undefined) line(`  已恢复: ${result.restored}`)
    line('  未操作官方 ~/.dsh、官方 userData 或 ~/Documents/deepseek-harness。')
    if (result.backup !== undefined) {
      line('  回滚: 运行 `scripts/custom/migrate-brand-profile.sh --rollback "<备份目录>" --apply`')
    }
    line('  请启动随身搭子，确认默认工作区与历史会话；旧共享工作区源目录保留未动。')
  } else if (result.blocked !== undefined) {
    line('[未执行] 被安全门阻断:')
    for (const reason of result.blocked) line(`  - ${reason}`)
    if (result.backup !== undefined) line(`  已创建备份，但未修改 profile: ${result.backup}`)
    else line('  未写任何文件。')
  } else {
    line(`[失败] ${result.error}`)
    if (result.backup !== undefined) line(`  已创建备份: ${result.backup}`)
    if (result.rollbackHint !== undefined) line(`  回滚: ${result.rollbackHint}`)
    if (result.quarantine !== undefined) line(`  当前数据隔离在: ${result.quarantine}`)
  }
}

function jsonOutput(state, plan, options, result) {
  return {
    tool: TOOL,
    toolVersion: TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    apply: options.apply,
    dryRun: !options.apply,
    mode: plan.mode,
    paths: {
      home: state.paths.home,
      profile: state.paths.profile,
      dshHome: state.paths.dshHome,
      target: state.paths.target,
      legacyWorkspace: state.paths.legacyWorkspace,
      officialHome: state.paths.officialHome,
      backupRoot: state.paths.backupRoot,
    },
    state: {
      profileExists: state.profileExists,
      dshHomeExists: state.dshHomeExists,
      registry: state.summary ?? { exists: state.registry.exists, error: state.registry.error },
      sessions: state.sessions,
      projectCacheCount: state.projectCacheCount,
      attachments: state.attachments,
      credentials: { present: state.credentials.present, mode: state.credentials.mode },
      target: { exists: state.targetExists, isDirectory: state.targetIsDirectory, canonical: state.targetCanonical },
      legacy: { exists: state.legacyExists, isDirectory: state.legacyIsDirectory },
      official: {
        exists: state.official.exists,
        registryExists: state.official.exists,
        referencesSource: state.official.referencesSource,
        referencesLegacy: state.official.referencesLegacy,
        error: state.official.error,
        sessions: state.official.sessions,
      },
      running: {
        supported: state.running.supported,
        brand: state.running.brand.map(entry => ({ pid: entry.pid })),
        official: state.running.official.map(entry => ({ pid: entry.pid })),
      },
      oldProfileNoHome: state.oldProfileNoHome,
      legacyIdentityExists: state.legacyIdentityExists,
      legacyArchiveExists: state.legacyArchiveExists,
      apps: { brandInstalled: state.brandAppInstalled, officialInstalled: state.officialAppInstalled },
    },
    plan: {
      blocked: plan.blocked,
      warnings: plan.warnings,
      notes: plan.notes ?? [],
      actions: plan.actions,
      noop: plan.noop === true,
      registryChange: plan.mutation === undefined ? undefined : {
        kind: plan.mutation.kind,
        newDefaultId: plan.mutation.newDefaultId,
        newDefaultPath: plan.mutation.newDefaultPath,
        keptOldWorkspace: plan.mutation.keptOldWorkspace,
        oldPath: plan.mutation.oldPath,
      },
      copy: plan.copy === undefined ? undefined : {
        kind: plan.copy.kind,
        source: plan.copy.source,
        target: plan.copy.target,
        files: plan.copy.files,
        bytes: plan.copy.bytes,
        conflicts: plan.copy.conflicts,
        identical: plan.copy.identical?.length,
      },
      patch: plan.patch === undefined ? undefined : {
        path: plan.patch.path,
        exists: plan.patch.exists,
        changed: plan.patch.changed,
        replacements: plan.patch.replacements,
      },
      backupDir: plan.backupDir,
      preserveCredentials: plan.preserveCredentials,
    },
    result: result ?? null,
  }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${TOOL}: ${error.message}\n\n${usage()}\n`)
    process.exitCode = EXIT_USAGE
    return
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    process.exitCode = EXIT_OK
    return
  }
  const paths = resolvePaths(options)
  if (isSubpath(paths.dshHome, paths.backupRoot) || isSubpath(paths.target, paths.backupRoot)
    || isSubpath(paths.backupRoot, paths.target)) {
    process.stderr.write(`${TOOL}: --backup-root 不能与 dsh-home 或目标工作区重叠\n`)
    process.exitCode = EXIT_USAGE
    return
  }
  if (isSubpath(paths.legacyWorkspace, paths.backupRoot)) {
    process.stderr.write(`${TOOL}: --backup-root 不能位于官方共享工作区内（避免向官方目录写文件）\n`)
    process.exitCode = EXIT_USAGE
    return
  }
  const overlaps = (left, right) => isSubpath(left, right) || isSubpath(right, left)
  if (overlaps(paths.dshHome, paths.officialHome)) {
    process.stderr.write(`${TOOL}: 品牌 dsh-home 与官方 ~/.dsh 重叠；拒绝操作，避免写官方目录\n`)
    process.exitCode = EXIT_USAGE
    return
  }
  if (overlaps(paths.target, paths.officialHome) || overlaps(paths.target, paths.legacyWorkspace)) {
    process.stderr.write(`${TOOL}: 目标工作区与官方 home/共享工作区重叠；请换一个 --target\n`)
    process.exitCode = EXIT_USAGE
    return
  }
  if (overlaps(paths.backupRoot, paths.officialHome)) {
    process.stderr.write(`${TOOL}: --backup-root 不能位于官方 home 内\n`)
    process.exitCode = EXIT_USAGE
    return
  }
  if (options.rollback !== undefined) {
    const rollbackDir = expandPath(options.rollback, paths.home)
    if (overlaps(rollbackDir, paths.officialHome) || overlaps(rollbackDir, paths.legacyWorkspace)) {
      process.stderr.write(`${TOOL}: --rollback 备份目录不能位于官方 home 或共享工作区内\n`)
      process.exitCode = EXIT_USAGE
      return
    }
  }
  let state
  let plan
  if (options.rollback !== undefined) {
    state = await inspectState(paths, { ...options, noCopy: true })
    try {
      plan = await planRollback(paths, options)
    } catch (error) {
      process.stderr.write(`${TOOL}: ${error.message}\n`)
      process.exitCode = EXIT_BLOCKED
      return
    }
  } else {
    state = await inspectState(paths, options)
    plan = options.mode === 'reset' ? await planReset(state) : await planMigrate(state, options)
  }
  if (!options.apply) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(jsonOutput(state, plan, options, null), undefined, 2)}\n`)
    } else {
      printHuman(state, plan, options)
    }
    process.exitCode = EXIT_OK
    return
  }
  if (!options.json) printHuman(state, plan, options)
  if (plan.blocked.length > 0) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(jsonOutput(state, plan, options, { ok: false, blocked: plan.blocked }), undefined, 2)}\n`)
    } else {
      resultHuman({ ok: false, blocked: plan.blocked })
    }
    process.exitCode = EXIT_BLOCKED
    return
  }
  if (plan.noop) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(jsonOutput(state, plan, options, { ok: true, mode: plan.mode, noop: true }), undefined, 2)}\n`)
    } else {
      process.stdout.write('\n结论: 已经是目标状态，无需操作。\n')
    }
    process.exitCode = EXIT_OK
    return
  }
  const result = plan.mode === 'reset'
    ? await applyReset(state, plan, options)
    : plan.mode === 'rollback'
      ? await applyRollback(state, plan, options)
      : await applyMigrate(state, plan, options)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(jsonOutput(state, plan, options, result), undefined, 2)}\n`)
  } else {
    resultHuman(result)
  }
  process.exitCode = result.ok ? EXIT_OK : EXIT_BLOCKED
}

main().catch((error) => {
  process.stderr.write(`${TOOL}: ${error.stack ?? error.message}\n`)
  process.exitCode = EXIT_BLOCKED
})
