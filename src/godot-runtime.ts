// Node.js runtime helpers for Godot Companion: project discovery, filesystem scanning,
// Godot executable detection, LSP port probing, headless checks, and detached editor launch.

import { execFile, spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  joinRelPath,
  parseAddonCfg,
  parseExportPresets,
  parseGodotOutput,
  parseGodotShortVersion,
  parseProjectGodot,
  parseResourceHeader,
  parseSceneHeader,
  parseScriptHeader,
  relPathToResPath,
  resPathToRelPath
} from './godot-parser.ts'
import type {
  GodotAddonInfo,
  GodotBinaryInfo,
  GodotCodeFileItem,
  GodotExportPreset,
  GodotHeadlessCheckResult,
  GodotProjectData,
  GodotProjectSummary,
  GodotSceneItem,
  GodotTestRunnerKind
} from './types.ts'

const IGNORED_DIRS = new Set([
  '.git',
  '.godot',
  '.import',
  '.orca',
  '.vscode',
  '.idea',
  'node_modules',
  'builds',
  'build',
  'dist',
  '__pycache__'
])

const MAX_SCAN_FILES = 2500
const MAX_SCAN_DEPTH = 8
const HEADER_READ_BYTES = 16 * 1024

function toPosixPath(p: string): string {
  return p.split(path.sep).join('/')
}

/** Reads at most `maxBytes` from the start of a UTF-8 file (fast for large scenes/resources). */
async function readFileHead(filePath: string, maxBytes = HEADER_READ_BYTES): Promise<string> {
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = new Uint8Array(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    const mode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK
    await fs.access(filePath, mode)
    const st = await fs.stat(filePath)
    return st.isFile()
  } catch {
    return false
  }
}

export function execFileText(
  file: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<{ ok: boolean; exitCode: number | null; stdout: string; stderr: string; error: string | null }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 5000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ ok: true, exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '', error: null })
          return
        }
        const exitCode = typeof err.code === 'number' ? err.code : null
        resolve({
          ok: false,
          exitCode,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          error: err.message
        })
      }
    )
  })
}

async function probeGodotExecutable(
  candidate: string,
  source: GodotBinaryInfo['source']
): Promise<GodotBinaryInfo | null> {
  const res = await execFileText(candidate, ['--version'], { timeoutMs: 2500 })
  const combined = `${res.stdout}\n${res.stderr}`.trim()
  if (!res.ok && !combined) return null
  const firstLine = combined.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? null
  if (!firstLine) return null
  const shortVersion = parseGodotShortVersion(firstLine)
  if (!shortVersion) return null
  return {
    found: true,
    path: candidate,
    version: firstLine,
    shortVersion,
    source,
    error: null
  }
}

function getKnownGodotPaths(): string[] {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return [
      '/Applications/Godot.app/Contents/MacOS/Godot',
      '/Applications/Godot_mono.app/Contents/MacOS/Godot',
      path.join(home, 'Applications/Godot.app/Contents/MacOS/Godot'),
      '/opt/homebrew/bin/godot',
      '/usr/local/bin/godot'
    ]
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? ''
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    return [
      path.join(programFiles, 'Godot', 'Godot.exe'),
      path.join(programFilesX86, 'Steam', 'steamapps', 'common', 'Godot Engine', 'godot.windows.opt.tools.64.exe'),
      localAppData ? path.join(localAppData, 'Programs', 'Godot', 'Godot.exe') : ''
    ].filter(Boolean)
  }
  return [
    path.join(home, '.local/bin/godot'),
    path.join(home, '.local/bin/godot4'),
    path.join(home, '.local/share/Steam/steamapps/common/Godot Engine/godot.x11.opt.tools.64'),
    '/usr/local/bin/godot',
    '/usr/bin/godot',
    '/usr/bin/godot4'
  ]
}

/** Detects the Godot executable from settings, env vars, PATH, or standard install paths. */
export async function detectGodotBinary(configuredPath?: string): Promise<GodotBinaryInfo> {
  const trimmedConfigured = (configuredPath ?? '').trim()
  if (trimmedConfigured) {
    const info = await probeGodotExecutable(trimmedConfigured, 'setting')
    if (info) return info
    return {
      found: false,
      path: trimmedConfigured,
      version: null,
      shortVersion: null,
      source: 'setting',
      error: `Configured Godot binary could not be executed: ${trimmedConfigured}`
    }
  }

  for (const envKey of ['GODOT_BIN', 'GODOT4_BIN', 'GODOT_PATH']) {
    const val = process.env[envKey]?.trim()
    if (val) {
      const info = await probeGodotExecutable(val, 'env')
      if (info) return info
    }
  }

  for (const cmd of ['godot', 'godot4']) {
    const info = await probeGodotExecutable(cmd, 'path')
    if (info) return info
  }

  for (const knownPath of getKnownGodotPaths()) {
    if (await isExecutable(knownPath)) {
      const info = await probeGodotExecutable(knownPath, 'known-location')
      if (info) return info
    }
  }

  return {
    found: false,
    path: null,
    version: null,
    shortVersion: null,
    source: 'missing',
    error: 'Godot executable not found in PATH or standard install locations. Set "Godot Executable Path" in plugin Settings.'
  }
}

/** Probes localhost TCP port to see if Godot Editor LSP (default 6005) is accepting connections. */
export function probeTcpPort(port: number, timeoutMs = 250): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }

    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => finish(true))
    socket.on('timeout', () => finish(false))
    socket.on('error', () => finish(false))
  })
}

/** Finds all `project.godot` directories inside a workspace (root first, then up to depth 2). */
export async function findGodotProjects(workspacePath: string): Promise<GodotProjectSummary[]> {
  const results: GodotProjectSummary[] = []
  const seen = new Set<string>()

  async function inspectDir(dirAbs: string, relPath: string, depth: number): Promise<void> {
    const projectFile = path.join(dirAbs, 'project.godot')
    try {
      const st = await fs.stat(projectFile)
      if (st.isFile() && !seen.has(relPath)) {
        seen.add(relPath)
        let name = relPath === '.' ? path.basename(dirAbs) : path.basename(relPath)
        try {
          const text = await readFileHead(projectFile, 4096)
          const parsed = parseProjectGodot(text)
          if (parsed.name) name = parsed.name
        } catch {
          // keep folder basename fallback
        }
        results.push({ name, relPath })
      }
    } catch {
      // no project.godot in this folder
    }

    if (depth >= 2 || results.length >= 12) return

    let entries: { name: string; isDirectory(): boolean }[]
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue
      const childAbs = path.join(dirAbs, entry.name)
      const childRel = relPath === '.' ? entry.name : `${relPath}/${entry.name}`
      await inspectDir(childAbs, childRel, depth + 1)
    }
  }

  await inspectDir(workspacePath, '.', 0)
  results.sort((a, b) => {
    if (a.relPath === '.') return -1
    if (b.relPath === '.') return 1
    return a.relPath.localeCompare(b.relPath)
  })
  return results
}

async function scanAddons(
  projectAbsPath: string,
  projectRelPath: string,
  enabledPluginPaths: readonly string[]
): Promise<{ addons: GodotAddonInfo[]; testRunner: GodotTestRunnerKind }> {
  const addonsDir = path.join(projectAbsPath, 'addons')
  let entries: { name: string; isDirectory(): boolean }[]
  try {
    entries = await fs.readdir(addonsDir, { withFileTypes: true })
  } catch {
    return { addons: [], testRunner: null }
  }

  const enabledSet = new Set(
    enabledPluginPaths.map((p) => p.replace(/^res:\/\//, '').replace(/\/plugin\.cfg$/, ''))
  )
  const addons: GodotAddonInfo[] = []
  let testRunner: GodotTestRunnerKind = null

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const id = entry.name
    const cfgAbs = path.join(addonsDir, id, 'plugin.cfg')
    let name = id
    let version: string | null = null
    let cfgRel = joinRelPath(projectRelPath, `addons/${id}`)
    try {
      const text = await fs.readFile(cfgAbs, 'utf8')
      const parsed = parseAddonCfg(text)
      if (parsed.name) name = parsed.name
      version = parsed.version
      cfgRel = joinRelPath(projectRelPath, `addons/${id}/plugin.cfg`)
    } catch {
      // addon directory without plugin.cfg
    }

    const enabled = enabledSet.has(`addons/${id}`)
    addons.push({ id, name, version, enabled, relPath: cfgRel })

    const lower = id.toLowerCase()
    if (lower === 'gut') testRunner = 'gut'
    else if (lower === 'gdunit4' && !testRunner) testRunner = 'gdunit4'
  }

  addons.sort((a, b) => a.name.localeCompare(b.name))
  return { addons, testRunner }
}

/** Scans a Godot project folder and parses project.godot, presets, scenes, scripts, shaders, resources, and addons. */
export async function scanGodotProject(
  workspacePath: string,
  projectRelPath: string
): Promise<GodotProjectData> {
  const normalizedRel = projectRelPath === '.' ? '.' : toPosixPath(projectRelPath).replace(/^\/+|\/+$/g, '')
  const projectAbsPath =
    normalizedRel === '.' ? workspacePath : path.resolve(workspacePath, normalizedRel)

  const projectFileAbs = path.join(projectAbsPath, 'project.godot')
  const projectText = await fs.readFile(projectFileAbs, 'utf8')
  const parsedProject = parseProjectGodot(projectText)

  // Parse export_presets.cfg if present
  let exportPresets: GodotExportPreset[] = []
  try {
    const presetsText = await fs.readFile(path.join(projectAbsPath, 'export_presets.cfg'), 'utf8')
    exportPresets = parseExportPresets(presetsText)
  } catch {
    // optional file
  }

  // Remap autoloads to workspace-relative paths
  const autoloads = parsedProject.autoloads.map((a) => ({
    ...a,
    relPath: joinRelPath(normalizedRel, a.relPath)
  }))

  const mainSceneProjectRel = parsedProject.mainSceneResPath
    ? resPathToRelPath(parsedProject.mainSceneResPath)
    : null
  const mainSceneRelPath = mainSceneProjectRel
    ? joinRelPath(normalizedRel, mainSceneProjectRel)
    : null

  // Walk project directory for scenes, scripts, shaders, resources
  const sceneFiles: { abs: string; projRel: string }[] = []
  const codeFileTargets: { abs: string; projRel: string; kind: GodotCodeFileItem['kind'] }[] = []
  let scannedFiles = 0
  let truncated = false

  async function walk(dirAbs: string, relDir: string, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH || scannedFiles >= MAX_SCAN_FILES) {
      if (scannedFiles >= MAX_SCAN_FILES) truncated = true
      return
    }
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[]
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (scannedFiles >= MAX_SCAN_FILES) {
        truncated = true
        return
      }
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        const nextRel = relDir ? `${relDir}/${entry.name}` : entry.name
        await walk(path.join(dirAbs, entry.name), nextRel, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      scannedFiles++

      const ext = path.extname(entry.name).toLowerCase()
      const projRel = relDir ? `${relDir}/${entry.name}` : entry.name
      const abs = path.join(dirAbs, entry.name)

      if (ext === '.tscn' || ext === '.scn') {
        sceneFiles.push({ abs, projRel })
      } else if (ext === '.gd') {
        codeFileTargets.push({ abs, projRel, kind: 'gdscript' })
      } else if (ext === '.cs') {
        codeFileTargets.push({ abs, projRel, kind: 'csharp' })
      } else if (ext === '.gdshader' || ext === '.gdshaderinc') {
        codeFileTargets.push({ abs, projRel, kind: 'shader' })
      } else if (ext === '.tres') {
        codeFileTargets.push({ abs, projRel, kind: 'resource' })
      }
    }
  }

  await walk(projectAbsPath, '', 0)

  // Parse scene headers (bounded concurrency in chunks of 24)
  const scenes: GodotSceneItem[] = []
  for (let i = 0; i < sceneFiles.length; i += 24) {
    const batch = sceneFiles.slice(i, i + 24)
    const parsedBatch = await Promise.all(
      batch.map(async ({ abs, projRel }): Promise<GodotSceneItem> => {
        const resPath = relPathToResPath(projRel)
        const relPath = joinRelPath(normalizedRel, projRel)
        const isMain = parsedProject.mainSceneResPath === resPath
        if (projRel.endsWith('.scn')) {
          return {
            name: path.basename(projRel),
            resPath,
            relPath,
            rootName: null,
            rootType: 'BinaryScene',
            scriptResPath: null,
            scriptRelPath: null,
            nodeCount: 0,
            isMain
          }
        }
        try {
          const head = await readFileHead(abs, HEADER_READ_BYTES)
          const meta = parseSceneHeader(head)
          const scriptProjRel = meta.scriptResPath ? resPathToRelPath(meta.scriptResPath) : null
          return {
            name: path.basename(projRel),
            resPath,
            relPath,
            rootName: meta.rootName,
            rootType: meta.rootType,
            scriptResPath: meta.scriptResPath,
            scriptRelPath: scriptProjRel ? joinRelPath(normalizedRel, scriptProjRel) : null,
            nodeCount: meta.nodeCount,
            isMain
          }
        } catch {
          return {
            name: path.basename(projRel),
            resPath,
            relPath,
            rootName: null,
            rootType: null,
            scriptResPath: null,
            scriptRelPath: null,
            nodeCount: 0,
            isMain
          }
        }
      })
    )
    scenes.push(...parsedBatch)
  }

  scenes.sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1
    return a.resPath.localeCompare(b.resPath)
  })

  // Parse script / shader / resource headers in batches
  const codeFiles: GodotCodeFileItem[] = []
  for (let i = 0; i < codeFileTargets.length; i += 24) {
    const batch = codeFileTargets.slice(i, i + 24)
    const parsedBatch = await Promise.all(
      batch.map(async ({ abs, projRel, kind }): Promise<GodotCodeFileItem> => {
        const resPath = relPathToResPath(projRel)
        const relPath = joinRelPath(normalizedRel, projRel)
        const name = path.basename(projRel)

        if (kind === 'shader') {
          let shaderType: string | null = null
          try {
            const head = await readFileHead(abs, 1024)
            shaderType = head.match(/\bshader_type\s+([a-z_]+)/)?.[1] ?? null
          } catch {
            // ignore
          }
          return { name, resPath, relPath, kind, className: null, extendsType: shaderType, isTool: false }
        }

        if (kind === 'resource') {
          try {
            const head = await readFileHead(abs, 2048)
            const meta = parseResourceHeader(head)
            return {
              name,
              resPath,
              relPath,
              kind,
              className: meta.scriptClass,
              extendsType: meta.resourceType,
              isTool: false
            }
          } catch {
            return { name, resPath, relPath, kind, className: null, extendsType: null, isTool: false }
          }
        }

        try {
          const head = await readFileHead(abs, 4096)
          const meta = parseScriptHeader(head, kind === 'csharp')
          return {
            name,
            resPath,
            relPath,
            kind,
            className: meta.className,
            extendsType: meta.extendsType,
            isTool: meta.isTool
          }
        } catch {
          return { name, resPath, relPath, kind, className: null, extendsType: null, isTool: false }
        }
      })
    )
    codeFiles.push(...parsedBatch)
  }

  codeFiles.sort((a, b) => a.resPath.localeCompare(b.resPath))

  const { addons, testRunner } = await scanAddons(
    projectAbsPath,
    normalizedRel,
    parsedProject.enabledPluginPaths
  )

  const scriptCount = codeFiles.filter((f) => f.kind === 'gdscript' || f.kind === 'csharp').length
  const shaderCount = codeFiles.filter((f) => f.kind === 'shader').length
  const resourceCount = codeFiles.filter((f) => f.kind === 'resource').length

  return {
    name: parsedProject.name,
    description: parsedProject.description,
    rootRelPath: normalizedRel,
    projectFileRelPath: joinRelPath(normalizedRel, 'project.godot'),
    mainSceneResPath: parsedProject.mainSceneResPath,
    mainSceneRelPath,
    features: parsedProject.features,
    godotVersionHint: parsedProject.godotVersionHint,
    renderer: parsedProject.renderer,
    viewportWidth: parsedProject.viewportWidth,
    viewportHeight: parsedProject.viewportHeight,
    physicsTicksPerSecond: parsedProject.physicsTicksPerSecond,
    autoloads,
    inputActions: parsedProject.inputActions,
    layerNames: parsedProject.layerNames,
    scenes,
    codeFiles,
    exportPresets,
    addons,
    testRunner,
    counts: {
      scenes: scenes.length,
      scripts: scriptCount,
      shaders: shaderCount,
      resources: resourceCount,
      autoloads: autoloads.length,
      inputActions: parsedProject.inputActions.length,
      exportPresets: exportPresets.length,
      addons: addons.length,
      truncated
    }
  }
}

/** Runs `godot --headless --path <projectRoot> --quit` and parses structured diagnostics. */
export async function runHeadlessProjectCheck(
  godotPath: string,
  projectAbsPath: string,
  timeoutMs = 30000
): Promise<GodotHeadlessCheckResult> {
  const startedAt = Date.now()
  const res = await execFileText(
    godotPath,
    ['--headless', '--path', projectAbsPath, '--quit'],
    { cwd: projectAbsPath, timeoutMs }
  )
  const durationMs = Date.now() - startedAt
  const combined = [res.stdout, res.stderr].filter((s) => s.trim().length > 0).join('\n')
  const lines = combined.split(/\r?\n/)
  const diagnostics = parseGodotOutput(lines)
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length
  const warningCount = diagnostics.filter((d) => d.severity === 'warning').length
  const ok = res.ok && errorCount === 0

  return {
    ok,
    exitCode: res.exitCode,
    durationMs,
    checkedAt: Date.now(),
    errorCount,
    warningCount,
    diagnostics,
    rawOutput: combined.slice(0, 12000)
  }
}

/** Launches the Godot Editor as a detached process so it stays open independently of Orca terminals. */
export function spawnGodotEditorDetached(
  godotPath: string,
  projectAbsPath: string,
  sceneResPath?: string
): { pid?: number } {
  const args = ['-e', '--path', projectAbsPath]
  if (sceneResPath) args.push(sceneResPath)
  const child = spawn(godotPath, args, {
    cwd: projectAbsPath,
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  child.unref()
  return { pid: child.pid }
}

/** Ensures the parent output directory for an export path exists before invoking Godot export. */
export async function ensureExportOutputDir(
  projectAbsPath: string,
  exportPath: string
): Promise<string> {
  const resolved = path.isAbsolute(exportPath)
    ? exportPath
    : path.resolve(projectAbsPath, exportPath)
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  return resolved
}
