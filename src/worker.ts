// Trusted Node worker for Godot Companion.
// Bridges Orca workspaces, terminals, editor tabs, settings, storage, and status bar with Godot.

import * as path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  buildShellCommand,
  hasExitMarker,
  isGodot3Version,
  parseGodotOutput,
  splitCliArgs,
  stripExitMarker,
  withExitMarker
} from './godot-parser.ts'
import {
  detectGodotBinary,
  ensureExportOutputDir,
  findGodotProjects,
  probeTcpPort,
  runHeadlessProjectCheck,
  scanGodotProject,
  spawnGodotEditorDetached
} from './godot-runtime.ts'
import type {
  GodotActionResult,
  GodotActiveSession,
  GodotBinaryInfo,
  GodotHeadlessCheckResult,
  GodotLogsResult,
  GodotProjectData,
  GodotProjectSummary,
  GodotSettings,
  GodotSnapshot,
  GodotWorkspaceInfo
} from './types.ts'

const STORAGE_PINNED_PREFIX = 'pinnedScenes:'
const STORAGE_SELECTED_PROJECT_PREFIX = 'selectedProject:'
const STORAGE_SESSION_PREFIX = 'activeSession:'
const SESSION_WATCH_INTERVAL_MS = 2000

const DEFAULT_SETTINGS: GodotSettings = {
  godotBinary: '',
  extraRunArgs: '',
  lspPort: 6005,
  openEditorDetached: true,
  notifyOnComplete: true
}

export type WorkerDeps = {
  detectBinary: (configuredPath?: string) => Promise<GodotBinaryInfo>
  probeLspPort: (port: number) => Promise<boolean>
  findProjects: (workspacePath: string) => Promise<GodotProjectSummary[]>
  scanProject: (workspacePath: string, projectRelPath: string) => Promise<GodotProjectData>
  runHeadlessCheck: (
    godotPath: string,
    projectAbsPath: string,
    timeoutMs?: number,
    godotVersion?: string | null,
    projectRootRelPath?: string
  ) => Promise<GodotHeadlessCheckResult>
  spawnEditor: (
    godotPath: string,
    projectAbsPath: string,
    sceneResPath?: string
  ) => Promise<{ pid?: number; error?: string }> | { pid?: number; error?: string }
  ensureExportDir: (projectAbsPath: string, exportPath: string) => Promise<string>
  platform: string
}

const defaultDeps: WorkerDeps = {
  detectBinary: detectGodotBinary,
  probeLspPort: probeTcpPort,
  findProjects: findGodotProjects,
  scanProject: scanGodotProject,
  runHeadlessCheck: runHeadlessProjectCheck,
  spawnEditor: spawnGodotEditorDetached,
  ensureExportDir: ensureExportOutputDir,
  platform: process.platform
}

let activeDeps: WorkerDeps = defaultDeps

/** Test hook to override runtime side effects without monkey-patching Node modules. */
export function setWorkerDepsForTesting(overrides: Partial<WorkerDeps> | null): void {
  activeDeps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asPort(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
    ? value
    : fallback
}

async function readSettings(orca: OrcaWorkerApi): Promise<GodotSettings> {
  try {
    const raw = await orca.settings.get()
    return {
      godotBinary: asString(raw.godotBinary, DEFAULT_SETTINGS.godotBinary),
      extraRunArgs: asString(raw.extraRunArgs, DEFAULT_SETTINGS.extraRunArgs),
      lspPort: asPort(raw.lspPort, DEFAULT_SETTINGS.lspPort),
      openEditorDetached: asBoolean(raw.openEditorDetached, DEFAULT_SETTINGS.openEditorDetached),
      notifyOnComplete: asBoolean(raw.notifyOnComplete, DEFAULT_SETTINGS.notifyOnComplete)
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

async function resolveFocusedWorkspace(orca: OrcaWorkerApi): Promise<GodotWorkspaceInfo | null> {
  let ctx: { workspaceId?: string; branch: string; displayName: string; terminals: { id: string; title?: string }[] } | null = null
  try {
    ctx = await orca.host.call('workspace.readContext')
  } catch {
    return null
  }
  if (!ctx) return null

  let listed: {
    workspaces: {
      id: string
      kind: 'worktree' | 'folder'
      name: string
      path: string
      branch: string | null
      hostId: string | null
    }[]
  } | null = null

  try {
    if (orca.host.has('workspace.list')) {
      listed = await orca.host.call('workspace.list')
    }
  } catch {
    listed = null
  }

  const workspaces = listed?.workspaces ?? []
  const matched =
    (ctx.workspaceId ? workspaces.find((w) => w.id === ctx.workspaceId) : undefined) ??
    workspaces.find((w) => w.name === ctx.displayName && (w.branch ?? '') === ctx.branch) ??
    workspaces.find((w) => w.name === ctx.displayName)

  if (!matched) {
    return null
  }

  return {
    id: matched.id,
    name: matched.name || ctx.displayName,
    branch: matched.branch ?? ctx.branch ?? '',
    path: matched.path,
    hostId: matched.hostId ?? null,
    kind: matched.kind
  }
}

function projectStorageKey(workspace: GodotWorkspaceInfo, projectRelPath: string): string {
  return `${workspace.path}::${projectRelPath}`
}

async function readPinnedScenes(
  orca: OrcaWorkerApi,
  workspace: GodotWorkspaceInfo | null,
  projectRelPath: string
): Promise<string[]> {
  if (!workspace) return []
  try {
    const val = await orca.storage.get(STORAGE_PINNED_PREFIX + projectStorageKey(workspace, projectRelPath))
    if (Array.isArray(val)) {
      return val.filter((v): v is string => typeof v === 'string')
    }
  } catch {
    // ignore storage failures
  }
  return []
}

function sessionStorageKey(workspace: GodotWorkspaceInfo): string {
  return STORAGE_SESSION_PREFIX + workspace.id
}

async function readStoredSession(
  orca: OrcaWorkerApi,
  workspace: GodotWorkspaceInfo | null
): Promise<GodotActiveSession | null> {
  if (!workspace) return null
  try {
    const val = await orca.storage.get(sessionStorageKey(workspace))
    if (!val || typeof val !== 'object' || Array.isArray(val)) return null
    const rec = val as Record<string, unknown>
    if (typeof rec.terminalId !== 'string' || typeof rec.label !== 'string') return null
    const kind = rec.kind
    if (
      kind !== 'run' &&
      kind !== 'scene' &&
      kind !== 'editor' &&
      kind !== 'export' &&
      kind !== 'tests' &&
      kind !== 'check'
    ) {
      return null
    }
    return {
      terminalId: rec.terminalId,
      label: rec.label,
      kind,
      startedAt: typeof rec.startedAt === 'number' ? rec.startedAt : Date.now(),
      sceneResPath: typeof rec.sceneResPath === 'string' ? rec.sceneResPath : null
    }
  } catch {
    return null
  }
}

async function verifyActiveSession(
  orca: OrcaWorkerApi,
  workspace: GodotWorkspaceInfo | null,
  session: GodotActiveSession | null
): Promise<GodotActiveSession | null> {
  if (!session || !workspace) return null
  try {
    if (orca.host.has('terminal.list')) {
      const res = await orca.host.call('terminal.list', { workspaceId: workspace.id })
      if (!res.terminals.some((t) => t.id === session.terminalId)) {
        await orca.storage.delete(sessionStorageKey(workspace)).catch(() => undefined)
        return null
      }
      return session
    }
    const ctx = await orca.host.call('workspace.readContext')
    if (ctx && ctx.terminals.length > 0 && !ctx.terminals.some((t) => t.id === session.terminalId)) {
      return null
    }
  } catch {
    // keep session if terminal list is unavailable
  }
  return session
}

async function updateStatusBar(orca: OrcaWorkerApi, snapshot: GodotSnapshot): Promise<void> {
  if (!orca.host.has('statusBar.update')) return
  try {
    if (!snapshot.project) {
      await orca.host.call('statusBar.update', {
        id: 'godot-status',
        text: 'Godot',
        tone: 'neutral',
        tooltip: 'Godot Companion — no Godot project in focused workspace',
        visible: false
      })
      return
    }

    const version = snapshot.binary.shortVersion ?? snapshot.project.godotVersionHint ?? ''
    let text = version ? `Godot ${version}` : 'Godot'
    let tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' = 'neutral'
    let tooltip = `${snapshot.project.name} (${snapshot.project.counts.scenes} scenes, ${snapshot.project.counts.scripts} scripts)`

    if (snapshot.activeSession) {
      text = `Running: ${snapshot.activeSession.label}`
      tone = 'accent'
      tooltip = `Godot session active (${snapshot.activeSession.label})`
    } else if (!snapshot.binary.found) {
      text = 'Godot: missing'
      tone = 'danger'
      tooltip = snapshot.binary.error ?? 'Godot executable not found'
    } else if (snapshot.lastCheck && !snapshot.lastCheck.ok) {
      text = `Godot (${snapshot.lastCheck.errorCount} err)`
      tone = 'danger'
      tooltip = `Last headless check found ${snapshot.lastCheck.errorCount} error(s)`
    } else if (snapshot.editorLspActive) {
      tone = 'success'
      tooltip = `${snapshot.project.name} — Godot Editor LSP connected on port ${snapshot.settings.lspPort}`
    }

    await orca.host.call('statusBar.update', {
      id: 'godot-status',
      text,
      tone,
      tooltip,
      visible: true
    })
  } catch {
    // statusBar.update is desktop-only and best-effort
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  let cachedBinary: { configuredPath: string; info: GodotBinaryInfo; at: number } | null = null
  let lastChecksByProject = new Map<string, GodotHeadlessCheckResult>()
  let lastSnapshot: GodotSnapshot | null = null
  let inFlightSnapshot: Promise<GodotSnapshot> | null = null
  /** Output of the last session that exited, per workspace id, so Logs keeps showing it. */
  const endedLogsByWorkspace = new Map<string, GodotLogsResult>()
  let sessionWatchTimer: ReturnType<typeof setTimeout> | null = null

  async function getBinary(settings: GodotSettings, forceRefresh = false): Promise<GodotBinaryInfo> {
    const now = Date.now()
    if (
      !forceRefresh &&
      cachedBinary &&
      cachedBinary.configuredPath === settings.godotBinary &&
      now - cachedBinary.at < 30000
    ) {
      return cachedBinary.info
    }
    const info = await activeDeps.detectBinary(settings.godotBinary)
    cachedBinary = { configuredPath: settings.godotBinary, info, at: now }
    return info
  }

  async function readSessionLogs(
    session: GodotActiveSession | null,
    maxLines = 150,
    projectRootRelPath = '.'
  ): Promise<GodotLogsResult> {
    if (!session) {
      return {
        lines: [],
        diagnostics: [],
        truncated: false,
        active: false,
        terminalId: null,
        label: null
      }
    }
    try {
      const res = await orca.host.call('terminal.read', {
        terminalId: session.terminalId,
        maxLines: Math.min(Math.max(maxLines, 20), 500)
      })
      const exited = hasExitMarker(res.lines)
      const lines = stripExitMarker(res.lines)
      const diagnostics = parseGodotOutput(lines, projectRootRelPath)
      return {
        lines,
        diagnostics,
        truncated: res.truncated,
        active: !exited,
        terminalId: session.terminalId,
        label: session.label
      }
    } catch {
      return {
        lines: [],
        diagnostics: [],
        truncated: false,
        active: false,
        terminalId: session.terminalId,
        label: session.label
      }
    }
  }

  async function buildSnapshotImpl(options: {
    forceRefresh?: boolean
    selectProjectRelPath?: string
  } = {}): Promise<GodotSnapshot> {
    const settings = await readSettings(orca)
    const [workspace, binary, editorLspActive] = await Promise.all([
      resolveFocusedWorkspace(orca),
      getBinary(settings, options.forceRefresh),
      activeDeps.probeLspPort(settings.lspPort)
    ])

    let availableProjects: GodotProjectSummary[] = []
    let selectedProjectRelPath = '.'
    let project: GodotProjectData | null = null
    let remoteWorkspaceWarning: string | null = null

    if (workspace) {
      const isRemote = Boolean(workspace.hostId && workspace.hostId !== 'local')
      if (isRemote) {
        remoteWorkspaceWarning = `Workspace "${workspace.name}" is hosted on ${workspace.hostId}. Local filesystem scanning only inspects local workspaces.`
      } else {
        availableProjects = await activeDeps.findProjects(workspace.path)
        if (availableProjects.length > 0) {
          const storageKey = STORAGE_SELECTED_PROJECT_PREFIX + workspace.path
          if (options.selectProjectRelPath) {
            selectedProjectRelPath = options.selectProjectRelPath
            await orca.storage.set(storageKey, selectedProjectRelPath).catch(() => undefined)
          } else {
            const stored = await orca.storage.get(storageKey).catch(() => null)
            if (typeof stored === 'string' && availableProjects.some((p) => p.relPath === stored)) {
              selectedProjectRelPath = stored
            } else {
              selectedProjectRelPath = availableProjects[0].relPath
            }
          }

          if (!availableProjects.some((p) => p.relPath === selectedProjectRelPath)) {
            selectedProjectRelPath = availableProjects[0].relPath
          }

          try {
            project = await activeDeps.scanProject(workspace.path, selectedProjectRelPath)
          } catch (err) {
            orca.log(`Failed to scan Godot project: ${err instanceof Error ? err.message : String(err)}`)
            project = null
          }
        }
      }
    }

    const storedSession = await readStoredSession(orca, workspace)
    let activeSession = await verifyActiveSession(orca, workspace, storedSession)
    const pinnedScenes = await readPinnedScenes(orca, workspace, selectedProjectRelPath)
    const checkKey = workspace ? projectStorageKey(workspace, selectedProjectRelPath) : ''
    const lastCheck = checkKey ? lastChecksByProject.get(checkKey) ?? null : null
    let logs = activeSession ? await readSessionLogs(activeSession, 120, selectedProjectRelPath) : null
    if (workspace && activeSession && logs && !logs.active && logs.terminalId) {
      // Godot exited (e.g. the game window was closed) while its terminal stays open.
      endedLogsByWorkspace.set(workspace.id, logs)
      await orca.storage.delete(sessionStorageKey(workspace)).catch(() => undefined)
      activeSession = null
    }
    if (!activeSession) {
      logs = workspace ? endedLogsByWorkspace.get(workspace.id) ?? null : null
    }

    const snapshot: GodotSnapshot = {
      workspace,
      project,
      availableProjects,
      selectedProjectRelPath,
      binary,
      editorLspActive,
      activeSession,
      pinnedScenes,
      lastCheck,
      logs,
      settings,
      refreshedAt: Date.now(),
      remoteWorkspaceWarning
    }

    lastSnapshot = snapshot
    await updateStatusBar(orca, snapshot)
    if (activeSession) scheduleSessionWatch()
    return snapshot
  }

  async function buildSnapshot(options: {
    forceRefresh?: boolean
    selectProjectRelPath?: string
  } = {}): Promise<GodotSnapshot> {
    if (!options.selectProjectRelPath && inFlightSnapshot) {
      return inFlightSnapshot
    }
    const promise = buildSnapshotImpl(options)
    if (!options.selectProjectRelPath) {
      inFlightSnapshot = promise
      promise.finally(() => {
        if (inFlightSnapshot === promise) inFlightSnapshot = null
      })
    }
    return promise
  }

  function resolveProjectAbsPath(snapshot: GodotSnapshot): string | null {
    if (!snapshot.workspace || !snapshot.project) return null
    return snapshot.project.rootRelPath === '.'
      ? snapshot.workspace.path
      : path.resolve(snapshot.workspace.path, snapshot.project.rootRelPath)
  }

  async function ensureReady(forceRefresh = false): Promise<{
    snapshot: GodotSnapshot
    projectAbsPath: string
    godotPath: string
  } | { error: string }> {
    const snapshot = forceRefresh || !lastSnapshot ? await buildSnapshot({ forceRefresh }) : lastSnapshot
    if (!snapshot.workspace) {
      return { error: 'No Orca workspace is currently focused.' }
    }
    if (!snapshot.project) {
      return { error: 'No project.godot found in the focused workspace.' }
    }
    if (!snapshot.binary.found || !snapshot.binary.path) {
      return { error: snapshot.binary.error ?? 'Godot executable not found.' }
    }
    const projectAbsPath = resolveProjectAbsPath(snapshot)
    if (!projectAbsPath) {
      return { error: 'Could not resolve Godot project path.' }
    }
    return { snapshot, projectAbsPath, godotPath: snapshot.binary.path }
  }

  async function saveActiveSession(
    workspace: GodotWorkspaceInfo,
    session: GodotActiveSession
  ): Promise<void> {
    endedLogsByWorkspace.delete(workspace.id)
    await orca.storage.set(sessionStorageKey(workspace), session).catch(() => undefined)
  }

  /** Polls the active session's terminal until Godot exits or the terminal goes away. */
  function scheduleSessionWatch(): void {
    if (sessionWatchTimer) return
    sessionWatchTimer = setTimeout(() => {
      sessionWatchTimer = null
      void watchSessionTick()
    }, SESSION_WATCH_INTERVAL_MS)
    ;(sessionWatchTimer as unknown as { unref?: () => void }).unref?.()
  }

  async function watchSessionTick(): Promise<void> {
    const session = lastSnapshot?.activeSession
    if (!session) return
    let ended = false
    try {
      const res = await orca.host.call('terminal.read', { terminalId: session.terminalId, maxLines: 40 })
      ended = hasExitMarker(res.lines)
    } catch {
      ended = true
    }
    if (!ended) {
      scheduleSessionWatch()
      return
    }
    try {
      const updated = await buildSnapshot()
      orca.panels.post('godot.updated', updated)
      if (!updated.activeSession) {
        orca.panels.post('godot.status', {
          busy: false,
          message: `${session.label} exited`,
          tone: 'neutral'
        })
      }
    } catch (err) {
      orca.log(`session watch refresh failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function runGodot(input?: { sceneResPath?: string; headless?: boolean }): Promise<GodotActionResult> {
    const ready = await ensureReady()
    if ('error' in ready) return { ok: false, message: ready.error }

    const { snapshot, projectAbsPath, godotPath } = ready
    const args: string[] = []
    if (input?.headless) {
      args.push(isGodot3Version(snapshot.binary.shortVersion) ? '--no-window' : '--headless')
    }
    args.push('--path', projectAbsPath)
    if (input?.sceneResPath) args.push(input.sceneResPath)
    const extra = splitCliArgs(snapshot.settings.extraRunArgs)
    if (extra.length > 0) args.push(...extra)

    const label = input?.sceneResPath
      ? path.basename(input.sceneResPath)
      : snapshot.project!.name
    const title = input?.sceneResPath ? `Godot: ${label}` : `Godot: ${snapshot.project!.name}`
    const command = buildShellCommand(godotPath, args, activeDeps.platform)

    const created = await orca.host.call('terminal.create', {
      workspaceId: snapshot.workspace!.id,
      title,
      command: withExitMarker(command, activeDeps.platform)
    })

    const session: GodotActiveSession = {
      terminalId: created.terminalId,
      label,
      kind: input?.sceneResPath ? 'scene' : 'run',
      startedAt: Date.now(),
      sceneResPath: input?.sceneResPath ?? snapshot.project!.mainSceneResPath
    }
    await saveActiveSession(snapshot.workspace!, session)

    const updated = await buildSnapshot()
    orca.panels.post('godot.updated', updated)
    orca.panels.post('godot.status', {
      busy: false,
      message: `Started ${title}`,
      tone: 'success'
    })
    return { ok: true, terminalId: created.terminalId, message: `Started ${title}` }
  }

  async function openGodotEditor(input?: { sceneResPath?: string }): Promise<GodotActionResult> {
    const ready = await ensureReady()
    if ('error' in ready) return { ok: false, message: ready.error }

    const { snapshot, projectAbsPath, godotPath } = ready
    const sceneLabel = input?.sceneResPath ? ` (${path.basename(input.sceneResPath)})` : ''

    if (snapshot.settings.openEditorDetached) {
      const spawned = await activeDeps.spawnEditor(godotPath, projectAbsPath, input?.sceneResPath)
      if (spawned.error) {
        const message = `Failed to launch Godot Editor: ${spawned.error}`
        orca.panels.post('godot.status', { busy: false, message, tone: 'danger' })
        return { ok: false, message }
      }
      const message = `Launched Godot Editor${sceneLabel}`
      orca.panels.post('godot.status', { busy: false, message, tone: 'success' })
      return { ok: true, pid: spawned.pid, message }
    }

    const args = ['-e', '--path', projectAbsPath]
    if (input?.sceneResPath) args.push(input.sceneResPath)
    const command = buildShellCommand(godotPath, args, activeDeps.platform)
    const title = `Godot Editor${sceneLabel}`

    const created = await orca.host.call('terminal.create', {
      workspaceId: snapshot.workspace!.id,
      title,
      command: withExitMarker(command, activeDeps.platform)
    })

    const session: GodotActiveSession = {
      terminalId: created.terminalId,
      label: title,
      kind: 'editor',
      startedAt: Date.now(),
      sceneResPath: input?.sceneResPath ?? null
    }
    await saveActiveSession(snapshot.workspace!, session)
    const updated = await buildSnapshot()
    orca.panels.post('godot.updated', updated)
    return { ok: true, terminalId: created.terminalId, message: `Opened ${title}` }
  }

  async function stopActiveRun(): Promise<GodotActionResult> {
    const workspace = lastSnapshot?.workspace ?? (await resolveFocusedWorkspace(orca))
    const session = await readStoredSession(orca, workspace)
    if (!workspace || !session) {
      return { ok: false, message: 'No active Godot session to stop.' }
    }

    try {
      await orca.host.call('terminal.close', { terminalId: session.terminalId })
    } catch (err) {
      await orca.storage.delete(sessionStorageKey(workspace)).catch(() => undefined)
      const updated = await buildSnapshot()
      orca.panels.post('godot.updated', updated)
      return {
        ok: false,
        message: `Could not close terminal (${err instanceof Error ? err.message : 'already closed'}). Cleared session.`
      }
    }

    await orca.storage.delete(sessionStorageKey(workspace)).catch(() => undefined)
    const updated = await buildSnapshot()
    orca.panels.post('godot.updated', updated)
    orca.panels.post('godot.status', {
      busy: false,
      message: `Stopped ${session.label}`,
      tone: 'neutral'
    })
    return { ok: true, message: `Stopped ${session.label}` }
  }

  async function focusActiveTerminal(): Promise<GodotActionResult> {
    const workspace = lastSnapshot?.workspace ?? (await resolveFocusedWorkspace(orca))
    const session = await readStoredSession(orca, workspace)
    if (!session) {
      return { ok: false, message: 'No active Godot terminal to focus.' }
    }
    const res = await orca.host.call('terminal.focus', { terminalId: session.terminalId })
    return {
      ok: res.focused,
      message: res.focused ? `Focused ${session.label}` : 'Terminal could not be focused.'
    }
  }

  async function runCheckHeadless(): Promise<GodotHeadlessCheckResult> {
    const ready = await ensureReady()
    if ('error' in ready) {
      return {
        ok: false,
        exitCode: null,
        durationMs: 0,
        checkedAt: Date.now(),
        errorCount: 1,
        warningCount: 0,
        diagnostics: [
          {
            severity: 'error',
            message: ready.error,
            resPath: null,
            relPath: null,
            line: null,
            raw: ready.error
          }
        ],
        rawOutput: ready.error
      }
    }

    const { snapshot, projectAbsPath, godotPath } = ready
    orca.panels.post('godot.status', {
      busy: true,
      message: 'Running Godot headless validation...',
      tone: 'accent'
    })

    const result = await activeDeps.runHeadlessCheck(
      godotPath,
      projectAbsPath,
      30000,
      snapshot.binary.shortVersion,
      snapshot.project!.rootRelPath
    )
    const key = projectStorageKey(snapshot.workspace!, snapshot.project!.rootRelPath)
    lastChecksByProject.set(key, result)

    const updated = await buildSnapshot()
    orca.panels.post('godot.updated', updated)

    const summary = result.ok
      ? `Headless check passed (${result.warningCount} warnings, ${result.durationMs}ms)`
      : `Headless check found ${result.errorCount} error(s), ${result.warningCount} warning(s)`

    orca.panels.post('godot.status', {
      busy: false,
      message: summary,
      tone: result.ok ? 'success' : 'danger'
    })

    if (snapshot.settings.notifyOnComplete) {
      void orca.host
        .call('notifications.show', {
          title: `Godot Check — ${snapshot.project!.name}`,
          body: summary
        })
        .catch(() => undefined)
    }

    return result
  }

  async function runExportPreset(input: {
    presetName: string
    mode: 'debug' | 'release'
  }): Promise<GodotActionResult> {
    const ready = await ensureReady()
    if ('error' in ready) return { ok: false, message: ready.error }

    const { snapshot, projectAbsPath, godotPath } = ready
    const preset = snapshot.project!.exportPresets.find((p) => p.name === input.presetName)
    if (!preset) {
      return { ok: false, message: `Export preset "${input.presetName}" not found in export_presets.cfg.` }
    }
    if (!preset.exportPath) {
      return {
        ok: false,
        message: `Preset "${preset.name}" has no export_path set in export_presets.cfg.`
      }
    }

    const resolvedOut = await activeDeps.ensureExportDir(projectAbsPath, preset.exportPath)
    const isGodot3 = isGodot3Version(snapshot.binary.shortVersion)
    const headlessFlag = isGodot3 ? '--no-window' : '--headless'
    const flag =
      input.mode === 'debug' ? '--export-debug' : isGodot3 ? '--export' : '--export-release'
    const command = buildShellCommand(
      godotPath,
      [headlessFlag, '--path', projectAbsPath, flag, preset.name, resolvedOut],
      activeDeps.platform
    )
    const title = `Godot Export: ${preset.name} (${input.mode})`

    const created = await orca.host.call('terminal.create', {
      workspaceId: snapshot.workspace!.id,
      title,
      command: withExitMarker(command, activeDeps.platform)
    })

    const session: GodotActiveSession = {
      terminalId: created.terminalId,
      label: `Export ${preset.name}`,
      kind: 'export',
      startedAt: Date.now(),
      sceneResPath: null
    }
    await saveActiveSession(snapshot.workspace!, session)

    const updated = await buildSnapshot()
    orca.panels.post('godot.updated', updated)
    orca.panels.post('godot.status', {
      busy: false,
      message: `Started ${title}`,
      tone: 'accent'
    })

    if (snapshot.settings.notifyOnComplete) {
      void orca.host
        .call('notifications.show', {
          title: `Godot Export Started`,
          body: `${preset.name} (${input.mode}) → ${preset.exportPath}`
        })
        .catch(() => undefined)
    }

    return { ok: true, terminalId: created.terminalId, message: `Started ${title}` }
  }

  async function runTests(): Promise<GodotActionResult> {
    const ready = await ensureReady()
    if ('error' in ready) return { ok: false, message: ready.error }

    const { snapshot, projectAbsPath, godotPath } = ready
    const runner = snapshot.project!.testRunner
    if (!runner) {
      return {
        ok: false,
        message: 'No GUT or gdUnit4 addon detected in addons/.'
      }
    }

    const headlessFlag = isGodot3Version(snapshot.binary.shortVersion) ? '--no-window' : '--headless'
    const args =
      runner === 'gut'
        ? [headlessFlag, '--path', projectAbsPath, '-s', 'addons/gut/gut_cmdln.gd', '-gexit']
        : [headlessFlag, '--path', projectAbsPath, '-s', 'addons/gdUnit4/bin/GdUnitCmdTool.gd', '-a', 'res://']

    const command = buildShellCommand(godotPath, args, activeDeps.platform)
    const title = `Godot Tests (${runner.toUpperCase()})`

    const created = await orca.host.call('terminal.create', {
      workspaceId: snapshot.workspace!.id,
      title,
      command: withExitMarker(command, activeDeps.platform)
    })

    const session: GodotActiveSession = {
      terminalId: created.terminalId,
      label: title,
      kind: 'tests',
      startedAt: Date.now(),
      sceneResPath: null
    }
    await saveActiveSession(snapshot.workspace!, session)

    const updated = await buildSnapshot()
    orca.panels.post('godot.updated', updated)
    return { ok: true, terminalId: created.terminalId, message: `Started ${title}` }
  }

  async function openWorkspaceFile(relPath: string): Promise<GodotActionResult> {
    const snapshot = lastSnapshot ?? (await buildSnapshot())
    if (!snapshot.workspace) {
      return { ok: false, message: 'No focused Orca workspace.' }
    }
    const cleanRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!cleanRel || cleanRel.split('/').includes('..')) {
      return { ok: false, message: 'Invalid relative file path.' }
    }

    await orca.host.call('editor.open', {
      workspaceId: snapshot.workspace.id,
      path: cleanRel
    })
    return { ok: true, message: `Opened ${cleanRel}` }
  }

  // --- Panel Request Handlers ---
  orca.panels.handle('godot.snapshot', async (input) =>
    buildSnapshot({ forceRefresh: input?.forceRefresh })
  )

  orca.panels.handle('godot.selectProject', async ({ projectRelPath }) =>
    buildSnapshot({ forceRefresh: true, selectProjectRelPath: projectRelPath })
  )

  orca.panels.handle('godot.run', async (input) => runGodot(input))
  orca.panels.handle('godot.openEditor', async (input) => openGodotEditor(input))
  orca.panels.handle('godot.stopRun', async () => stopActiveRun())
  orca.panels.handle('godot.focusTerminal', async () => focusActiveTerminal())

  orca.panels.handle('godot.readLogs', async (input) => {
    const workspace = lastSnapshot?.workspace ?? (await resolveFocusedWorkspace(orca))
    const session = await readStoredSession(orca, workspace)
    const rootRel = lastSnapshot?.project?.rootRelPath ?? '.'
    if (!session && workspace) {
      const ended = endedLogsByWorkspace.get(workspace.id)
      if (ended) return ended
    }
    return readSessionLogs(session, input?.maxLines ?? 150, rootRel)
  })

  orca.panels.handle('godot.checkHeadless', async () => runCheckHeadless())
  orca.panels.handle('godot.exportPreset', async (input) => runExportPreset(input))
  orca.panels.handle('godot.openFile', async ({ relPath }) => openWorkspaceFile(relPath))

  orca.panels.handle('godot.togglePinScene', async ({ resPath }) => {
    const snapshot = lastSnapshot ?? (await buildSnapshot())
    if (!snapshot.workspace || !snapshot.project) {
      return { pinnedScenes: [] }
    }
    const key = STORAGE_PINNED_PREFIX + projectStorageKey(snapshot.workspace, snapshot.project.rootRelPath)
    const current = await readPinnedScenes(orca, snapshot.workspace, snapshot.project.rootRelPath)
    const next = current.includes(resPath)
      ? current.filter((p) => p !== resPath)
      : [...current, resPath]
    await orca.storage.set(key, next)
    if (lastSnapshot) {
      lastSnapshot = { ...lastSnapshot, pinnedScenes: next }
      orca.panels.post('godot.updated', lastSnapshot)
    }
    return { pinnedScenes: next }
  })

  orca.panels.handle('godot.runTests', async () => runTests())

  // --- Command Palette Handlers ---
  orca.commands.register('godot.runProject', async () => (await runGodot()).message)
  orca.commands.register('godot.openEditor', async () => (await openGodotEditor()).message)
  orca.commands.register('godot.checkHeadless', async () => {
    const res = await runCheckHeadless()
    return res.ok
      ? `Godot check passed (${res.warningCount} warnings)`
      : `Godot check failed: ${res.errorCount} error(s), ${res.warningCount} warning(s)`
  })
  orca.commands.register('godot.stopRun', async () => (await stopActiveRun()).message)
  orca.commands.register('godot.refresh', async () => {
    const snap = await buildSnapshot({ forceRefresh: true })
    orca.panels.post('godot.updated', snap)
    return snap.project
      ? `Refreshed ${snap.project.name} (${snap.project.counts.scenes} scenes)`
      : 'Refreshed: no Godot project in focused workspace'
  })

  // --- Workspace & Settings Subscriptions ---
  orca.events.on('workspace.changed', async () => {
    try {
      const snap = await buildSnapshot({ forceRefresh: true })
      orca.panels.post('godot.updated', snap)
    } catch (err) {
      orca.log(`workspace.changed refresh failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  orca.settings.onDidChange(() => {
    cachedBinary = null
    void buildSnapshot({ forceRefresh: true })
      .then((snap) => orca.panels.post('godot.updated', snap))
      .catch(() => undefined)
  })
}
