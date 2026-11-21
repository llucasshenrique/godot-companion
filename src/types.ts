// Shared JSON-serializable domain types for Godot Companion (panel + worker).

export type GodotWorkspaceInfo = {
  id: string
  name: string
  branch: string
  path: string
  hostId: string | null
  kind: 'worktree' | 'folder'
}

export type GodotAutoload = {
  name: string
  resPath: string
  relPath: string
  singleton: boolean
}

export type GodotInputAction = {
  name: string
  deadzone: number
  bindings: string[]
}

export type GodotLayerName = {
  domain: string
  index: number
  name: string
}

export type GodotSceneItem = {
  name: string
  resPath: string
  relPath: string
  rootName: string | null
  rootType: string | null
  scriptResPath: string | null
  scriptRelPath: string | null
  nodeCount: number
  isMain: boolean
}

export type GodotCodeFileKind = 'gdscript' | 'csharp' | 'shader' | 'resource'

export type GodotCodeFileItem = {
  name: string
  resPath: string
  relPath: string
  kind: GodotCodeFileKind
  className: string | null
  extendsType: string | null
  isTool: boolean
}

export type GodotExportPreset = {
  index: number
  name: string
  platform: string
  runnable: boolean
  dedicatedServer: boolean
  exportPath: string
}

export type GodotAddonInfo = {
  id: string
  name: string
  version: string | null
  enabled: boolean
  relPath: string
}

export type GodotTestRunnerKind = 'gut' | 'gdunit4' | null

export type GodotProjectSummary = {
  name: string
  relPath: string
}

export type GodotProjectData = {
  name: string
  description: string
  rootRelPath: string
  projectFileRelPath: string
  mainSceneResPath: string | null
  mainSceneRelPath: string | null
  features: string[]
  godotVersionHint: string | null
  renderer: string | null
  viewportWidth: number | null
  viewportHeight: number | null
  physicsTicksPerSecond: number | null
  autoloads: GodotAutoload[]
  inputActions: GodotInputAction[]
  layerNames: GodotLayerName[]
  scenes: GodotSceneItem[]
  codeFiles: GodotCodeFileItem[]
  exportPresets: GodotExportPreset[]
  addons: GodotAddonInfo[]
  testRunner: GodotTestRunnerKind
  counts: {
    scenes: number
    scripts: number
    shaders: number
    resources: number
    autoloads: number
    inputActions: number
    exportPresets: number
    addons: number
    truncated: boolean
  }
}

export type GodotBinaryInfo = {
  found: boolean
  path: string | null
  version: string | null
  shortVersion: string | null
  source: 'setting' | 'env' | 'path' | 'known-location' | 'missing'
  error: string | null
}

export type GodotDiagnostic = {
  severity: 'error' | 'warning'
  message: string
  resPath: string | null
  relPath: string | null
  line: number | null
  raw: string
}

export type GodotHeadlessCheckResult = {
  ok: boolean
  exitCode: number | null
  durationMs: number
  checkedAt: number
  errorCount: number
  warningCount: number
  diagnostics: GodotDiagnostic[]
  rawOutput: string
}

export type GodotActiveSession = {
  terminalId: string
  label: string
  kind: 'run' | 'scene' | 'editor' | 'export' | 'tests' | 'check'
  startedAt: number
  sceneResPath: string | null
}

export type GodotLogsResult = {
  lines: string[]
  diagnostics: GodotDiagnostic[]
  truncated: boolean
  active: boolean
  terminalId: string | null
  label: string | null
}

export type GodotSettings = {
  godotBinary: string
  extraRunArgs: string
  lspPort: number
  openEditorDetached: boolean
  notifyOnComplete: boolean
}

export type GodotSnapshot = {
  workspace: GodotWorkspaceInfo | null
  project: GodotProjectData | null
  availableProjects: GodotProjectSummary[]
  selectedProjectRelPath: string
  binary: GodotBinaryInfo
  editorLspActive: boolean
  activeSession: GodotActiveSession | null
  pinnedScenes: string[]
  lastCheck: GodotHeadlessCheckResult | null
  logs: GodotLogsResult | null
  settings: GodotSettings
  refreshedAt: number
  remoteWorkspaceWarning: string | null
}

export type GodotActionResult = {
  ok: boolean
  message: string
  terminalId?: string
  pid?: number
}

export type GodotStatusBanner = {
  busy: boolean
  message: string
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
}
