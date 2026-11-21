// Godot Companion — Orca Components Sidebar Panel (no build step).
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Code,
  CodeView,
  Collapsible,
  EmptyState,
  Grid,
  Heading,
  IconButton,
  Input,
  KeyValue,
  List,
  ListItem,
  plugin,
  read,
  RelativeTime,
  Row,
  Select,
  Separator,
  set,
  Skeleton,
  Spinner,
  Stack,
  Switch,
  Tab,
  Table,
  Tabs,
  Text,
  Toolbar,
  Tree,
  update,
  type OrcaNode,
  type PanelContext,
  type TableColumn,
  type TableRow,
  type TableSort,
  type TreeItem
} from 'orca'
import type {
  GodotCodeFileItem,
  GodotDiagnostic,
  GodotSceneItem,
  GodotSnapshot,
  GodotStatusBanner
} from './types'

// --- Panel Atoms (keyed atoms survive hot reload) ---
const snapshotAtom = atom<GodotSnapshot | null>(null)
const loadingAtom = atom<boolean>(true)
const busyActionAtom = atom<string | null>(null)
const bannerAtom = atom<GodotStatusBanner | null>(null)

const activeTabAtom = atom<string>('tab', 'overview')
const sceneQueryAtom = atom<string>('sceneQuery', '')
const pinnedOnlyAtom = atom<boolean>('pinnedOnly', false)
const sceneViewModeAtom = atom<'list' | 'tree'>('sceneViewMode', 'list')
const selectedTreeKeyAtom = atom<string>('selectedTreeKey', '')
const expandedTreeKeysAtom = atom<string[]>('expandedTreeKeys', ['dir:scenes'])

const codeQueryAtom = atom<string>('codeQuery', '')
const codeKindFilterAtom = atom<string>('codeKindFilter', 'all')
const codeSortAtom = atom<TableSort>('codeSort', { column: 'name', direction: 'asc' })
const selectedCodeKeysAtom = atom<string[]>('selectedCodeKeys', [])

const inputQueryAtom = atom<string>('inputQuery', '')

const MAX_LIST_SCENES = 60
const MAX_TABLE_ROWS = 150

// --- Actions ---
async function refreshSnapshot(forceRefresh = false): Promise<void> {
  if (!read(snapshotAtom)) set(loadingAtom, true)
  try {
    const snap = await plugin.request('godot.snapshot', { forceRefresh })
    set(snapshotAtom, snap)
  } catch (err) {
    set(bannerAtom, {
      busy: false,
      tone: 'danger',
      message: err instanceof Error ? err.message : 'Failed to load Godot workspace state.'
    })
  } finally {
    set(loadingAtom, false)
  }
}

async function runAction<T>(
  label: string,
  fn: () => Promise<T>,
  onDone?: (result: T) => void
): Promise<void> {
  set(busyActionAtom, label)
  try {
    const result = await fn()
    onDone?.(result)
  } catch (err) {
    set(bannerAtom, {
      busy: false,
      tone: 'danger',
      message: err instanceof Error ? err.message : `${label} failed.`
    })
  } finally {
    set(busyActionAtom, null)
  }
}

function showResultBanner(res: { ok: boolean; message: string }): void {
  set(bannerAtom, {
    busy: false,
    tone: res.ok ? 'success' : 'danger',
    message: res.message
  })
}

async function handleSelectProject(projectRelPath: string): Promise<void> {
  await runAction(
    'Switching project',
    () => plugin.request('godot.selectProject', { projectRelPath }),
    (snap) => {
      set(bannerAtom, null)
      set(snapshotAtom, snap)
    }
  )
}

async function handleRun(sceneResPath?: string): Promise<void> {
  const input = sceneResPath ? { sceneResPath } : {}
  await runAction('Running Godot', () => plugin.request('godot.run', input), showResultBanner)
}

async function handleOpenEditor(sceneResPath?: string): Promise<void> {
  const input = sceneResPath ? { sceneResPath } : {}
  await runAction(
    'Opening Godot Editor',
    () => plugin.request('godot.openEditor', input),
    showResultBanner
  )
}

async function handleStopRun(): Promise<void> {
  await runAction('Stopping Godot', () => plugin.request('godot.stopRun'), showResultBanner)
}

async function handleFocusTerminal(): Promise<void> {
  await runAction('Focusing terminal', () => plugin.request('godot.focusTerminal'), showResultBanner)
}

async function handleCheckHeadless(): Promise<void> {
  set(activeTabAtom, 'output')
  await runAction(
    'Running headless check',
    () => plugin.request('godot.checkHeadless'),
    (res) => {
      set(bannerAtom, {
        busy: false,
        tone: res.ok ? 'success' : 'danger',
        message: res.ok
          ? `Headless check passed (${res.warningCount} warnings, ${res.durationMs}ms)`
          : `Headless check failed: ${res.errorCount} error(s), ${res.warningCount} warning(s)`
      })
    }
  )
}

async function handleReadLogs(): Promise<void> {
  await runAction(
    'Refreshing logs',
    () => plugin.request('godot.readLogs', { maxLines: 150 }),
    (logs) => {
      update(snapshotAtom, (prev) => (prev ? { ...prev, logs } : prev))
    }
  )
}

async function handleExportPreset(presetName: string, mode: 'debug' | 'release'): Promise<void> {
  await runAction(
    `Exporting ${presetName}`,
    () => plugin.request('godot.exportPreset', { presetName, mode }),
    showResultBanner
  )
}

async function handleOpenFile(relPath: string): Promise<void> {
  await runAction(
    'Opening file',
    () => plugin.request('godot.openFile', { relPath }),
    (res) => {
      if (!res.ok) showResultBanner(res)
    }
  )
}

async function handleTogglePin(resPath: string): Promise<void> {
  await runAction(
    'Updating pins',
    () => plugin.request('godot.togglePinScene', { resPath }),
    ({ pinnedScenes }) => {
      update(snapshotAtom, (prev) => (prev ? { ...prev, pinnedScenes } : prev))
    }
  )
}

async function handleRunTests(): Promise<void> {
  await runAction('Running tests', () => plugin.request('godot.runTests'), showResultBanner)
}

// --- Tree Builder for Scenes ---
function buildSceneTree(scenes: readonly GodotSceneItem[]): TreeItem[] {
  type FolderNode = {
    key: string
    label: string
    folders: Map<string, FolderNode>
    files: TreeItem[]
  }

  const root: FolderNode = { key: '', label: '', folders: new Map(), files: [] }

  for (const scene of scenes) {
    const clean = scene.resPath.replace(/^res:\/\//, '')
    const parts = clean.split('/')
    const fileName = parts.pop() ?? scene.name
    let node = root
    let acc = ''
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part
      let child = node.folders.get(part)
      if (!child) {
        child = { key: `dir:${acc}`, label: part, folders: new Map(), files: [] }
        node.folders.set(part, child)
      }
      node = child
    }
    const descParts: string[] = []
    if (scene.isMain) descParts.push('Main')
    if (scene.rootType) descParts.push(scene.rootType)
    node.files.push({
      key: scene.resPath,
      label: fileName,
      description: descParts.join(' · ') || undefined,
      icon: scene.isMain ? 'star' : 'layers'
    })
  }

  function toItems(folder: FolderNode): TreeItem[] {
    const dirs = Array.from(folder.folders.values())
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((dir): TreeItem => ({
        key: dir.key,
        label: dir.label,
        icon: 'folder',
        children: toItems(dir)
      }))
    const files = [...folder.files].sort((a, b) => a.label.localeCompare(b.label))
    return [...dirs, ...files]
  }

  return toItems(root)
}

function versionMismatch(projectHint: string | null, binaryShort: string | null): boolean {
  if (!projectHint || !binaryShort) return false
  const projMinor = projectHint.split('.').slice(0, 2).join('.')
  const binMinor = binaryShort.split('.').slice(0, 2).join('.')
  return projMinor !== binMinor
}

function kindLabel(kind: GodotCodeFileItem['kind']): string {
  switch (kind) {
    case 'gdscript':
      return 'GDScript'
    case 'csharp':
      return 'C#'
    case 'shader':
      return 'Shader'
    case 'resource':
      return 'Resource'
  }
}

// --- Sub-views ---
/** Compact bordered section; tighter than Card for a narrow sidebar. */
function Section(props: { title: string; aside?: OrcaNode; children?: OrcaNode }) {
  return (
    <Box border radius="md" padding="sm" gap="xs" background="card">
      <Row justify="between" align="center" gap="xs">
        <Text size="sm" weight="semibold">
          {props.title}
        </Text>
        {props.aside ?? null}
      </Row>
      {props.children}
    </Box>
  )
}

function StatTile(props: { label: string; value: number }) {
  return (
    <Box border radius="sm" paddingX="sm" paddingY="xs" background="card">
      <Text size="md" weight="semibold">
        {props.value}
      </Text>
      <Text size="xs" muted>
        {props.label}
      </Text>
    </Box>
  )
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

function SceneRowCard(props: {
  scene: GodotSceneItem
  pinned: boolean
  canRun: boolean
}) {
  const { scene, pinned, canRun } = props
  const meta = [scene.rootType, scene.resPath.replace(/^res:\/\//, '')].filter(Boolean).join(' · ')
  return (
    <Box key={scene.resPath} border radius="sm" padding="xs" gap="xs" background="card">
      <Row justify="between" align="center" gap="xs">
        <Box grow shrink minWidth={0}>
          <Row gap="xs" align="center">
            <Text size="sm" weight="medium" truncate>
              {scene.name}
            </Text>
            {scene.isMain ? <Badge tone="accent">Main</Badge> : null}
          </Row>
          <Text size="xs" muted truncate>
            {meta}
          </Text>
        </Box>
        <Box direction="row" gap="none" align="center" shrink={false}>
          <IconButton
            icon="star"
            label={pinned ? `Unpin ${scene.name}` : `Pin ${scene.name}`}
            tooltip={pinned ? 'Unpin scene' : 'Pin scene'}
            variant="ghost"
            tone={pinned ? 'warning' : 'neutral'}
            size="xs"
            onPress={() => void handleTogglePin(scene.resPath)}
          />
          <IconButton
            icon="code"
            label={`Open ${scene.name} in Orca`}
            tooltip="Open scene source in Orca"
            variant="ghost"
            size="xs"
            onPress={() => void handleOpenFile(scene.relPath)}
          />
          <IconButton
            icon="open-external"
            label={`Open ${scene.name} in Godot`}
            tooltip="Open scene in Godot Editor"
            variant="ghost"
            size="xs"
            disabled={!canRun}
            onPress={() => void handleOpenEditor(scene.resPath)}
          />
          <IconButton
            icon="play"
            label={`Run ${scene.name}`}
            tooltip={`Run scene (${scene.resPath})`}
            variant="solid"
            tone="accent"
            size="xs"
            disabled={!canRun}
            onPress={() => void handleRun(scene.resPath)}
          />
        </Box>
      </Row>
      {scene.scriptRelPath ? (
        <Row align="center" gap="xs">
          <Button
            variant="ghost"
            size="xs"
            icon="file-text"
            tooltip={`Open ${scene.scriptResPath ?? scene.scriptRelPath}`}
            onPress={() => void handleOpenFile(scene.scriptRelPath!)}
          >
            {baseName(scene.scriptRelPath)}
          </Button>
        </Row>
      ) : null}
    </Box>
  )
}

function DiagnosticRow(props: { diag: GodotDiagnostic; index: number }) {
  const { diag, index } = props
  const isError = diag.severity === 'error'
  return (
    <Box
      key={`${diag.severity}-${index}-${diag.resPath ?? ''}-${diag.line ?? ''}`}
      border={isError ? 'danger' : 'warning'}
      radius="sm"
      padding="xs"
      gap="xs"
    >
      <Row justify="between" align="center" gap="xs">
        <Badge tone={isError ? 'danger' : 'warning'}>{isError ? 'Error' : 'Warning'}</Badge>
        {diag.relPath ? (
          <Button
            variant="ghost"
            size="xs"
            icon="code"
            onPress={() => void handleOpenFile(diag.relPath!)}
          >
            {diag.line ? `Open :${diag.line}` : 'Open File'}
          </Button>
        ) : null}
      </Row>
      <Text size="xs">{diag.message}</Text>
      {diag.resPath ? (
        <Text size="xs" muted truncate>
          {diag.resPath}
          {diag.line ? `:${diag.line}` : ''}
        </Text>
      ) : null}
    </Box>
  )
}

// --- Lifecycle ---
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('godot.updated', (snap) => {
      const prev = read(snapshotAtom)
      if (
        prev &&
        (prev.workspace?.id !== snap.workspace?.id ||
          prev.selectedProjectRelPath !== snap.selectedProjectRelPath)
      ) {
        set(bannerAtom, null)
      }
      set(snapshotAtom, snap)
      set(loadingAtom, false)
    })
  )
  ctx.subscriptions.push(
    plugin.on('godot.status', (status) => {
      set(bannerAtom, status)
    })
  )
  void refreshSnapshot(false)
}

// --- Main Panel ---
export default function GodotPanel() {
  const loading = read(loadingAtom)
  const snap = read(snapshotAtom)
  const busyAction = read(busyActionAtom)
  const banner = read(bannerAtom)
  const activeTab = read(activeTabAtom)

  if (loading && !snap) {
    return (
      <Stack gap="md">
        <Row justify="between" align="center">
          <Heading level={2}>Godot</Heading>
          <Spinner label="Loading Godot project" labelHidden />
        </Row>
        <Skeleton shape="block" label="Loading project metadata" />
        <Skeleton shape="text" lines={4} label="Loading scenes" />
      </Stack>
    )
  }

  if (!snap || !snap.workspace) {
    return (
      <Stack gap="md">
        <Row justify="between" align="center">
          <Heading level={2}>Godot</Heading>
          <IconButton
            icon="refresh"
            label="Refresh"
            variant="ghost"
            size="xs"
            onPress={() => void refreshSnapshot(true)}
          />
        </Row>
        <EmptyState
          title="No workspace focused"
          description="Focus a local Godot workspace in Orca to inspect scenes, scripts, autoloads, and run or export your project."
          icon="blocks"
        >
          <Button variant="outline" icon="refresh" onPress={() => void refreshSnapshot(true)}>
            Check Again
          </Button>
        </EmptyState>
      </Stack>
    )
  }

  if (snap.remoteWorkspaceWarning) {
    return (
      <Stack gap="md">
        <Row justify="between" align="center">
          <Heading level={2}>Godot</Heading>
          <IconButton
            icon="refresh"
            label="Refresh"
            variant="ghost"
            size="xs"
            onPress={() => void refreshSnapshot(true)}
          />
        </Row>
        <Callout tone="warning" title="Remote workspace" icon="globe">
          <Text size="sm">{snap.remoteWorkspaceWarning}</Text>
        </Callout>
      </Stack>
    )
  }

  if (!snap.project) {
    return (
      <Stack gap="md">
        <Row justify="between" align="center">
          <Heading level={2}>Godot</Heading>
          <IconButton
            icon="refresh"
            label="Refresh"
            variant="ghost"
            size="xs"
            onPress={() => void refreshSnapshot(true)}
          />
        </Row>
        <EmptyState
          title="No Godot project found"
          description={`No project.godot was found in "${snap.workspace.name}".`}
          icon="folder"
        >
          <Button variant="outline" icon="refresh" onPress={() => void refreshSnapshot(true)}>
            Rescan Workspace
          </Button>
        </EmptyState>
        <Section title="Engine Detection">
          <KeyValue
            items={[
              {
                label: 'Godot Binary',
                value: snap.binary.found
                  ? snap.binary.shortVersion ?? 'Detected'
                  : 'Not found',
                tone: snap.binary.found ? 'success' : 'warning'
              },
              {
                label: 'Path',
                value: snap.binary.path ?? '—',
                code: Boolean(snap.binary.path)
              }
            ]}
          />
        </Section>
      </Stack>
    )
  }

  const project = snap.project
  const canRun = snap.binary.found && !busyAction
  const pinnedSet = new Set(snap.pinnedScenes)
  const hasMismatch = versionMismatch(project.godotVersionHint, snap.binary.shortVersion)

  // Filtered scenes
  const sceneQuery = read(sceneQueryAtom).trim().toLowerCase()
  const pinnedOnly = read(pinnedOnlyAtom)
  const sceneViewMode = read(sceneViewModeAtom)
  const selectedTreeKey = read(selectedTreeKeyAtom)
  const expandedTreeKeys = read(expandedTreeKeysAtom)

  const filteredScenes = project.scenes.filter((scene) => {
    if (pinnedOnly && !pinnedSet.has(scene.resPath)) return false
    if (!sceneQuery) return true
    return (
      scene.name.toLowerCase().includes(sceneQuery) ||
      scene.resPath.toLowerCase().includes(sceneQuery) ||
      (scene.rootType?.toLowerCase().includes(sceneQuery) ?? false) ||
      (scene.scriptResPath?.toLowerCase().includes(sceneQuery) ?? false)
    )
  })
  const visibleScenes = filteredScenes.slice(0, MAX_LIST_SCENES)
  const pinnedSceneItems = project.scenes.filter((s) => pinnedSet.has(s.resPath))
  const mainSceneItem = project.scenes.find((s) => s.isMain) ?? null
  const selectedTreeScene = project.scenes.find((s) => s.resPath === selectedTreeKey) ?? null

  // Filtered & sorted code/resources table
  const codeQuery = read(codeQueryAtom).trim().toLowerCase()
  const codeKindFilter = read(codeKindFilterAtom)
  const codeSort = read(codeSortAtom)
  const selectedCodeKeys = read(selectedCodeKeysAtom)

  const filteredCode = project.codeFiles
    .filter((f) => {
      if (codeKindFilter !== 'all' && f.kind !== codeKindFilter) return false
      if (!codeQuery) return true
      return (
        f.name.toLowerCase().includes(codeQuery) ||
        f.resPath.toLowerCase().includes(codeQuery) ||
        (f.className?.toLowerCase().includes(codeQuery) ?? false) ||
        (f.extendsType?.toLowerCase().includes(codeQuery) ?? false)
      )
    })
    .sort((a, b) => {
      const dir = codeSort.direction === 'asc' ? 1 : -1
      if (codeSort.column === 'kind') return a.kind.localeCompare(b.kind) * dir
      if (codeSort.column === 'type') {
        const at = a.className ?? a.extendsType ?? ''
        const bt = b.className ?? b.extendsType ?? ''
        return at.localeCompare(bt) * dir
      }
      return a.name.localeCompare(b.name) * dir
    })

  const codeColumns: TableColumn[] = [
    { key: 'name', label: 'File', sortable: true, minWidth: 'sm' },
    { key: 'kind', label: 'Kind', width: 'sm', sortable: true },
    { key: 'type', label: 'Class / Base', hideBelow: 'sm', sortable: true }
  ]

  const codeRows: TableRow[] = filteredCode.slice(0, MAX_TABLE_ROWS).map((f) => ({
    key: f.relPath,
    cells: {
      name: f.isTool ? `${f.name} (@tool)` : f.name,
      kind: kindLabel(f.kind),
      type: f.className
        ? f.extendsType
          ? `${f.className} : ${f.extendsType}`
          : f.className
        : f.extendsType ?? '—'
    }
  }))

  const selectedCodeItem =
    selectedCodeKeys.length > 0
      ? project.codeFiles.find((f) => f.relPath === selectedCodeKeys[0]) ?? null
      : null

  // Input map rows
  const inputQuery = read(inputQueryAtom).trim().toLowerCase()
  const filteredInputs = project.inputActions.filter((action) => {
    if (!inputQuery) return true
    return (
      action.name.toLowerCase().includes(inputQuery) ||
      action.bindings.some((b) => b.toLowerCase().includes(inputQuery))
    )
  })
  const inputColumns: TableColumn[] = [
    { key: 'action', label: 'Action', minWidth: 'sm' },
    { key: 'bindings', label: 'Bindings' }
  ]
  const inputRows: TableRow[] = filteredInputs.map((a) => ({
    key: a.name,
    cells: {
      action: a.name,
      bindings: a.bindings.length > 0 ? a.bindings.join(', ') : '(unbound)'
    }
  }))

  // Diagnostics aggregation (headless check + active terminal)
  const checkDiagnostics = snap.lastCheck?.diagnostics ?? []
  const liveDiagnostics = snap.logs?.diagnostics ?? []
  const totalErrors =
    checkDiagnostics.filter((d) => d.severity === 'error').length +
    liveDiagnostics.filter((d) => d.severity === 'error').length

  return (
    <Stack gap="sm">
      {/* Header */}
      <Row justify="between" align="center" gap="xs">
        <Stack gap="none">
          <Row gap="xs" align="center" wrap>
            <Heading level={2}>{project.name}</Heading>
            {snap.binary.found && snap.binary.shortVersion ? (
              <Badge tone={hasMismatch ? 'warning' : 'success'}>
                {`v${snap.binary.shortVersion}`}
              </Badge>
            ) : (
              <Badge tone="danger">No Godot</Badge>
            )}
            {snap.editorLspActive ? <Badge tone="accent">LSP</Badge> : null}
          </Row>
          {project.description ? (
            <Text size="xs" muted truncate>
              {project.description}
            </Text>
          ) : null}
        </Stack>
        <IconButton
          icon="refresh"
          label="Refresh project"
          tooltip="Rescan Godot project and engine status"
          variant="ghost"
          size="xs"
          disabled={Boolean(busyAction)}
          onPress={() => void refreshSnapshot(true)}
        />
      </Row>

      {/* Multi-project selector */}
      {snap.availableProjects.length > 1 ? (
        <Select
          label="Godot Project"
          labelHidden
          value={snap.selectedProjectRelPath}
          options={snap.availableProjects.map((p) => ({
            value: p.relPath,
            label: p.relPath === '.' ? `${p.name} (root)` : `${p.name} (${p.relPath})`
          }))}
          onChange={(val) => void handleSelectProject(val)}
        />
      ) : null}

      {/* Primary Action Toolbar */}
      <Toolbar label="Godot actions" gap="xs">
        <Button
          variant="solid"
          tone="accent"
          size="xs"
          icon="play"
          tooltip="Run main scene in an Orca terminal (Mod+F5)"
          disabled={!canRun}
          onPress={() => void handleRun()}
        >
          Run
        </Button>
        <Button
          variant="outline"
          size="xs"
          icon="open-external"
          tooltip="Launch Godot Editor for this project"
          disabled={!canRun}
          onPress={() => void handleOpenEditor()}
        >
          Editor
        </Button>
        <Button
          variant="outline"
          size="xs"
          icon="check"
          tooltip="Run headless validation (--headless --quit)"
          disabled={!canRun}
          onPress={() => void handleCheckHeadless()}
        >
          Check
        </Button>
        <IconButton
          icon="file-text"
          label="Open project.godot"
          tooltip="Open project.godot in Orca editor"
          variant="ghost"
          size="xs"
          onPress={() => void handleOpenFile(project.projectFileRelPath)}
        />
      </Toolbar>

      {/* Active Session Strip */}
      {snap.activeSession ? (
        <Box border="accent" background="accent" radius="sm" padding="xs" gap="xs">
          <Row justify="between" align="center" gap="xs">
            <Row gap="xs" align="center">
              <Badge tone="accent">Active</Badge>
              <Text size="xs" weight="medium" truncate>
                {snap.activeSession.label}
              </Text>
              <Text size="xs" muted>
                <RelativeTime at={snap.activeSession.startedAt} format="duration" />
              </Text>
            </Row>
            <Row gap="xs">
              <IconButton
                icon="terminal"
                label="Focus Godot terminal"
                tooltip="Focus Godot terminal pane"
                variant="ghost"
                size="xs"
                onPress={() => void handleFocusTerminal()}
              />
              <IconButton
                icon="stop"
                label="Stop Godot session"
                tooltip="Stop running Godot terminal"
                variant="ghost"
                tone="danger"
                size="xs"
                onPress={() => void handleStopRun()}
              />
            </Row>
          </Row>
        </Box>
      ) : null}

      {/* Missing Binary Warning */}
      {!snap.binary.found ? (
        <Callout tone="danger" title="Godot executable not found" icon="warning">
          <Text size="xs">{snap.binary.error ?? 'Configure Godot Executable Path in plugin Settings.'}</Text>
        </Callout>
      ) : null}

      {/* Version Mismatch Hint */}
      {hasMismatch ? (
        <Callout tone="warning" title="Version mismatch" icon="info">
          <Text size="xs">
            Project targets Godot {project.godotVersionHint}, while detected binary is{' '}
            {snap.binary.shortVersion}.
          </Text>
        </Callout>
      ) : null}

      {/* Transient Status Banner */}
      {banner ? (
        <Callout
          tone={banner.tone}
          icon={banner.tone === 'danger' ? 'error' : banner.tone === 'success' ? 'check' : 'info'}
        >
          <Row justify="between" align="center" gap="xs">
            <Text size="xs">{banner.message}</Text>
            <IconButton
              icon="close"
              label="Dismiss notice"
              variant="ghost"
              size="xs"
              onPress={() => set(bannerAtom, null)}
            />
          </Row>
        </Callout>
      ) : null}

      {/* Busy Indicator */}
      {busyAction ? (
        <Row gap="xs" align="center">
          <Spinner label={busyAction} labelHidden />
          <Text size="xs" muted>
            {busyAction}...
          </Text>
        </Row>
      ) : null}

      {/* Tabs */}
      <Tabs
        label="Godot sections"
        value={activeTab}
        onChange={(next) => set(activeTabAtom, next)}
      >
        {/* OVERVIEW TAB */}
        <Tab value="overview" label="Info">
          <Stack gap="sm">
            <Grid columns={3} gap="xs">
              <StatTile label="Scenes" value={project.counts.scenes} />
              <StatTile label="Scripts" value={project.counts.scripts} />
              <StatTile
                label="Resources"
                value={project.counts.resources + project.counts.shaders}
              />
            </Grid>

            <Section title="Project">
              <KeyValue
                items={[
                  {
                    label: 'Main Scene',
                    value: project.mainSceneResPath ?? 'Not configured',
                    code: Boolean(project.mainSceneResPath)
                  },
                  {
                    label: 'Engine',
                    value:
                      project.features.length > 0 ? project.features.join(' · ') : 'Unknown'
                  },
                  {
                    label: 'Viewport',
                    value:
                      project.viewportWidth && project.viewportHeight
                        ? `${project.viewportWidth}×${project.viewportHeight}`
                        : 'Default'
                  },
                  {
                    label: 'Physics',
                    value: project.physicsTicksPerSecond
                      ? `${project.physicsTicksPerSecond} Hz`
                      : '60 Hz (default)'
                  },
                  {
                    label: 'Editor LSP',
                    value: snap.editorLspActive
                      ? `Connected (:${snap.settings.lspPort})`
                      : `Offline (:${snap.settings.lspPort})`,
                    tone: snap.editorLspActive ? 'success' : 'neutral'
                  }
                ]}
              />
            </Section>

            {/* Quick Launch: Pinned & Main Scene */}
            {pinnedSceneItems.length > 0 || mainSceneItem ? (
              <Section title={pinnedSceneItems.length > 0 ? 'Pinned Scenes' : 'Main Scene'}>
                <Stack gap="xs">
                  {(pinnedSceneItems.length > 0
                    ? pinnedSceneItems
                    : mainSceneItem
                      ? [mainSceneItem]
                      : []
                  ).map((scene) => (
                    <SceneRowCard
                      key={scene.resPath}
                      scene={scene}
                      pinned={pinnedSet.has(scene.resPath)}
                      canRun={canRun}
                    />
                  ))}
                </Stack>
              </Section>
            ) : null}

            {/* Autoloads */}
            {project.autoloads.length > 0 ? (
              <Collapsible
                title={`Autoloads (${project.autoloads.length})`}
                defaultOpen={project.autoloads.length <= 6}
              >
                <List label="Autoload singletons">
                  {project.autoloads.map((auto) => (
                    <ListItem
                      key={auto.name}
                      title={auto.name}
                      description={auto.resPath}
                      icon="zap"
                      onPress={() => void handleOpenFile(auto.relPath)}
                    />
                  ))}
                </List>
              </Collapsible>
            ) : null}

            {/* Addons & Tests */}
            {project.addons.length > 0 ? (
              <Collapsible
                title={`Addons (${project.addons.length})`}
                defaultOpen={Boolean(project.testRunner)}
              >
                <Stack gap="xs">
                  {project.testRunner ? (
                    <Button
                      variant="outline"
                      size="xs"
                      icon="bug"
                      disabled={!canRun}
                      onPress={() => void handleRunTests()}
                    >
                      Run {project.testRunner.toUpperCase()} Tests
                    </Button>
                  ) : null}
                  <List label="Godot addons">
                    {project.addons.map((addon) => (
                      <ListItem
                        key={addon.id}
                        title={addon.version ? `${addon.name} (${addon.version})` : addon.name}
                        description={addon.enabled ? 'Enabled in project.godot' : 'Installed'}
                        icon="puzzle"
                        onPress={() => void handleOpenFile(addon.relPath)}
                      />
                    ))}
                  </List>
                </Stack>
              </Collapsible>
            ) : null}

            <Text size="xs" muted>
              Updated <RelativeTime at={snap.refreshedAt} format="short" />
              {project.counts.truncated ? ' · scan capped at 2,500 files' : ''}
            </Text>
          </Stack>
        </Tab>

        {/* SCENES TAB */}
        <Tab value="scenes" label="Scenes">
          <Stack gap="sm">
            <Row gap="xs" align="center">
              <Box grow>
                <Input
                  label="Filter scenes"
                  labelHidden
                  type="search"
                  placeholder="Search scenes…"
                  value={read(sceneQueryAtom)}
                  onChange={(val) => set(sceneQueryAtom, val)}
                />
              </Box>
              <Select
                label="Scene view"
                labelHidden
                value={sceneViewMode}
                options={[
                  { value: 'list', label: 'List' },
                  { value: 'tree', label: 'Tree' }
                ]}
                onChange={(val) => set(sceneViewModeAtom, val === 'tree' ? 'tree' : 'list')}
              />
            </Row>

            <Row justify="between" align="center">
              <Switch
                label="Pinned only"
                checked={pinnedOnly}
                onChange={(checked) => set(pinnedOnlyAtom, checked)}
              />
              <Text size="xs" muted>
                {filteredScenes.length} of {project.counts.scenes}
              </Text>
            </Row>

            {filteredScenes.length === 0 ? (
              <EmptyState
                title="No matching scenes"
                description={
                  pinnedOnly
                    ? 'Star scenes to pin them for one-click launch.'
                    : 'Try adjusting your search query.'
                }
                icon="layers"
              />
            ) : sceneViewMode === 'tree' ? (
              <Stack gap="xs">
                <Tree
                  label="Scene tree"
                  items={buildSceneTree(filteredScenes)}
                  selected={selectedTreeKey}
                  expanded={expandedTreeKeys}
                  maxHeight="md"
                  onSelect={({ key }) => set(selectedTreeKeyAtom, key)}
                  onToggle={({ key, expanded }) =>
                    update(expandedTreeKeysAtom, (prev) =>
                      expanded ? [...prev.filter((k) => k !== key), key] : prev.filter((k) => k !== key)
                    )
                  }
                  onAction={({ key }) => {
                    const target = project.scenes.find((s) => s.resPath === key)
                    if (target) void handleOpenFile(target.relPath)
                  }}
                />
                {selectedTreeScene ? (
                  <SceneRowCard
                    scene={selectedTreeScene}
                    pinned={pinnedSet.has(selectedTreeScene.resPath)}
                    canRun={canRun}
                  />
                ) : (
                  <Text size="xs" muted>
                    Select a scene to run or open it. Press Enter to open source in Orca.
                  </Text>
                )}
              </Stack>
            ) : (
              <Stack gap="xs">
                {visibleScenes.map((scene) => (
                  <SceneRowCard
                    key={scene.resPath}
                    scene={scene}
                    pinned={pinnedSet.has(scene.resPath)}
                    canRun={canRun}
                  />
                ))}
                {filteredScenes.length > MAX_LIST_SCENES ? (
                  <Text size="xs" muted>
                    Showing first {MAX_LIST_SCENES} scenes — refine your search to see more.
                  </Text>
                ) : null}
              </Stack>
            )}
          </Stack>
        </Tab>

        {/* SCRIPTS & RESOURCES TAB */}
        <Tab value="scripts" label="Code">
          <Stack gap="sm">
            <Row gap="xs">
              <Box grow>
                <Input
                  label="Filter scripts and resources"
                  labelHidden
                  type="search"
                  placeholder="Search code…"
                  value={read(codeQueryAtom)}
                  onChange={(val) => set(codeQueryAtom, val)}
                />
              </Box>
              <Select
                label="File kind"
                labelHidden
                value={codeKindFilter}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'gdscript', label: 'GDScript' },
                  { value: 'csharp', label: 'C#' },
                  { value: 'shader', label: 'Shaders' },
                  { value: 'resource', label: 'Resources' }
                ]}
                onChange={(val) => set(codeKindFilterAtom, val)}
              />
            </Row>

            {selectedCodeItem ? (
              <Row justify="between" align="center" gap="xs">
                <Text size="xs" muted truncate>
                  {selectedCodeItem.resPath}
                </Text>
                <Button
                  variant="outline"
                  size="xs"
                  icon="code"
                  onPress={() => void handleOpenFile(selectedCodeItem.relPath)}
                >
                  Open in Orca
                </Button>
              </Row>
            ) : null}

            <Table
              label="Godot scripts and resources"
              columns={codeColumns}
              rows={codeRows}
              sort={codeSort}
              selectionMode="single"
              selected={selectedCodeKeys}
              maxHeight="lg"
              emptyText="No scripts, shaders, or resources match your filter."
              onSortChange={(next) => set(codeSortAtom, next)}
              onSelectionChange={({ keys }) => set(selectedCodeKeysAtom, keys)}
              onRowAction={({ key }) => void handleOpenFile(key)}
            />

            {filteredCode.length > MAX_TABLE_ROWS ? (
              <Text size="xs" muted>
                Showing {MAX_TABLE_ROWS} of {filteredCode.length} files — narrow your search.
              </Text>
            ) : null}
          </Stack>
        </Tab>

        {/* CONFIG & EXPORTS TAB */}
        <Tab value="config" label="Config">
          <Stack gap="sm">
            <Section title={`Export Presets (${project.exportPresets.length})`}>
              {project.exportPresets.length === 0 ? (
                <Text size="xs" muted>
                  No export_presets.cfg found. Configure export presets in the Godot Editor first.
                </Text>
              ) : (
                <Stack gap="xs">
                  {project.exportPresets.map((preset) => (
                    <Box key={preset.index} border radius="sm" padding="xs" gap="xs">
                      <Row justify="between" align="center" gap="xs">
                        <Stack gap="none">
                          <Row gap="xs" align="center">
                            <Text size="sm" weight="medium">
                              {preset.name}
                            </Text>
                            <Badge tone="neutral">{preset.platform}</Badge>
                          </Row>
                          <Text size="xs" muted truncate>
                            {preset.exportPath || 'No output path configured'}
                          </Text>
                        </Stack>
                      </Row>
                      <Row gap="xs">
                        <Button
                          variant="solid"
                          tone="accent"
                          size="xs"
                          icon="package"
                          disabled={!canRun || !preset.exportPath}
                          onPress={() => void handleExportPreset(preset.name, 'release')}
                        >
                          Export Release
                        </Button>
                        <Button
                          variant="outline"
                          size="xs"
                          icon="bug"
                          disabled={!canRun || !preset.exportPath}
                          onPress={() => void handleExportPreset(preset.name, 'debug')}
                        >
                          Export Debug
                        </Button>
                      </Row>
                    </Box>
                  ))}
                </Stack>
              )}
            </Section>

            <Collapsible
              title={`Input Map (${project.inputActions.length})`}
              defaultOpen={project.inputActions.length > 0 && project.inputActions.length <= 12}
            >
              <Stack gap="xs">
                <Input
                  label="Filter input actions"
                  labelHidden
                  type="search"
                  placeholder="Filter actions or keys..."
                  value={read(inputQueryAtom)}
                  onChange={(val) => set(inputQueryAtom, val)}
                />
                <Table
                  label="Godot Input Map"
                  columns={inputColumns}
                  rows={inputRows}
                  maxHeight="md"
                  emptyText="No input actions found in project.godot."
                />
              </Stack>
            </Collapsible>

            {project.layerNames.length > 0 ? (
              <Collapsible title={`Physics & Render Layers (${project.layerNames.length})`}>
                <KeyValue
                  items={project.layerNames.map((l) => ({
                    label: `${l.domain} #${l.index}`,
                    value: l.name
                  }))}
                />
              </Collapsible>
            ) : null}
          </Stack>
        </Tab>

        {/* OUTPUT & DIAGNOSTICS TAB */}
        <Tab
          value="output"
          label={totalErrors > 0 ? `Logs · ${totalErrors}` : 'Logs'}
        >
          <Stack gap="sm">
            <Row gap="xs" align="center" justify="between">
              <Button
                variant="outline"
                size="xs"
                icon="check"
                disabled={!canRun}
                onPress={() => void handleCheckHeadless()}
              >
                Run Headless Check
              </Button>
              {snap.activeSession ? (
                <Row gap="none">
                  <IconButton
                    icon="refresh"
                    label="Refresh Logs"
                    tooltip="Re-read output from the Godot terminal"
                    variant="ghost"
                    size="xs"
                    onPress={() => void handleReadLogs()}
                  />
                  <IconButton
                    icon="terminal"
                    label="Focus Terminal"
                    tooltip="Focus Godot terminal pane"
                    variant="ghost"
                    size="xs"
                    onPress={() => void handleFocusTerminal()}
                  />
                </Row>
              ) : null}
            </Row>

            {/* Headless check result */}
            {snap.lastCheck ? (
              <Callout
                tone={snap.lastCheck.ok ? 'success' : 'danger'}
                title={
                  snap.lastCheck.ok
                    ? 'Headless validation passed'
                    : `Validation failed (${snap.lastCheck.errorCount} errors, ${snap.lastCheck.warningCount} warnings)`
                }
                icon={snap.lastCheck.ok ? 'check' : 'error'}
              >
                <Text size="xs" muted>
                  Ran in {snap.lastCheck.durationMs}ms ·{' '}
                  <RelativeTime at={snap.lastCheck.checkedAt} format="short" />
                </Text>
              </Callout>
            ) : (
              <Text size="xs" muted>
                Run a headless check to catch GDScript parse errors and broken scenes without leaving Orca.
              </Text>
            )}

            {/* Structured Diagnostics */}
            {checkDiagnostics.length > 0 ? (
              <Stack gap="xs">
                <Heading level={3}>Headless Diagnostics ({checkDiagnostics.length})</Heading>
                {checkDiagnostics.slice(0, 25).map((d, i) => (
                  <DiagnosticRow key={`chk-${i}`} diag={d} index={i} />
                ))}
              </Stack>
            ) : null}

            {liveDiagnostics.length > 0 ? (
              <Stack gap="xs">
                <Separator />
                <Heading level={3}>Live Terminal Diagnostics ({liveDiagnostics.length})</Heading>
                {liveDiagnostics.slice(0, 25).map((d, i) => (
                  <DiagnosticRow key={`live-${i}`} diag={d} index={i} />
                ))}
              </Stack>
            ) : null}

            {/* Raw Logs */}
            {snap.logs && snap.logs.lines.length > 0 ? (
              <Collapsible title={`Terminal Output (${snap.logs.lines.length} lines)`} defaultOpen>
                <CodeView
                  label="Godot terminal output"
                  code={snap.logs.lines.join('\n')}
                  wrap
                  maxHeight="md"
                />
              </Collapsible>
            ) : snap.lastCheck && snap.lastCheck.rawOutput ? (
              <Collapsible title="Headless Check Output" defaultOpen={!snap.lastCheck.ok}>
                <CodeView
                  label="Godot headless check output"
                  code={snap.lastCheck.rawOutput}
                  wrap
                  maxHeight="md"
                />
              </Collapsible>
            ) : null}
          </Stack>
        </Tab>
      </Tabs>
    </Stack>
  )
}
