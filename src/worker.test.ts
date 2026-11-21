import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { setWorkerDepsForTesting } from './worker'

let tempDir: string | null = null

async function createFixtureGodotWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-godot-test-'))
  tempDir = root

  await fs.mkdir(path.join(root, 'scenes'), { recursive: true })
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true })
  await fs.mkdir(path.join(root, 'addons', 'gut'), { recursive: true })

  await fs.writeFile(
    path.join(root, 'project.godot'),
    `config_version=5

[application]
config/name="Starforge Prototype"
config/description="Test Godot workspace"
run/main_scene="res://scenes/main.tscn"
config/features=PackedStringArray("4.7", "Forward Plus")

[autoload]
GameState="*res://scripts/game_state.gd"

[input]
jump={
"deadzone": 0.5,
"events": [Object(InputEventKey,"physical_keycode":32)]
}

[editor_plugins]
enabled=PackedStringArray("res://addons/gut/plugin.cfg")
`,
    'utf8'
  )

  await fs.writeFile(
    path.join(root, 'scenes', 'main.tscn'),
    `[gd_scene load_steps=2 format=3]
[ext_resource type="Script" path="res://scripts/main.gd" id="1"]
[node name="Main" type="Node3D"]
script = ExtResource("1")
[node name="Sun" type="DirectionalLight3D" parent="."]
`,
    'utf8'
  )

  await fs.writeFile(
    path.join(root, 'scripts', 'main.gd'),
    `class_name MainLevel\nextends Node3D\n`,
    'utf8'
  )

  await fs.writeFile(
    path.join(root, 'scripts', 'game_state.gd'),
    `extends Node\n`,
    'utf8'
  )

  await fs.writeFile(
    path.join(root, 'export_presets.cfg'),
    `[preset.0]
name="Linux/X11"
platform="Linux"
runnable=true
dedicated_server=false
export_path="builds/linux/starforge.x86_64"
`,
    'utf8'
  )

  await fs.writeFile(
    path.join(root, 'addons', 'gut', 'plugin.cfg'),
    `[plugin]\nname="GUT"\nversion="9.3.0"\n`,
    'utf8'
  )

  return root
}

afterEach(async () => {
  setWorkerDepsForTesting(null)
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

describe('godot-companion worker', () => {
  test('scans a real Godot workspace, runs scenes, exports presets, pins scenes, and runs headless checks', async () => {
    const wsPath = await createFixtureGodotWorkspace()
    const launchedEditors: { godotPath: string; projectAbsPath: string; scene?: string }[] = []

    setWorkerDepsForTesting({
      detectBinary: async () => ({
        found: true,
        path: '/usr/local/bin/godot',
        version: '4.7.2.stable.official',
        shortVersion: '4.7.2',
        source: 'path',
        error: null
      }),
      probeLspPort: async () => true,
      spawnEditor: (godotPath, projectAbsPath, scene) => {
        launchedEditors.push({ godotPath, projectAbsPath, scene })
        return { pid: 4242 }
      },
      runHeadlessCheck: async () => ({
        ok: false,
        exitCode: 1,
        durationMs: 210,
        checkedAt: 1700000000000,
        errorCount: 1,
        warningCount: 0,
        diagnostics: [
          {
            severity: 'error',
            message: 'Parse Error: Bad token',
            resPath: 'res://scripts/main.gd',
            relPath: 'scripts/main.gd',
            line: 12,
            raw: 'ERROR: res://scripts/main.gd:12 - Parse Error: Bad token'
          }
        ],
        rawOutput: 'ERROR: res://scripts/main.gd:12 - Parse Error: Bad token'
      }),
      platform: 'linux'
    })

    const host = mockHost({
      results: {
        'workspace.readContext': {
          workspaceId: 'ws-1',
          branch: 'main',
          displayName: 'starforge',
          terminals: [{ id: 'term-1', title: 'Godot: Starforge Prototype' }]
        },
        'workspace.list': {
          workspaces: [
            {
              id: 'ws-1',
              kind: 'worktree',
              name: 'starforge',
              path: wsPath,
              branch: 'main',
              hostId: 'local'
            }
          ],
          truncated: false
        },
        'terminal.list': {
          terminals: [{ id: 'term-1', title: 'Godot: Starforge Prototype' }],
          truncated: false
        },
        'terminal.create': { terminalId: 'term-1' },
        'terminal.read': {
          lines: [
            'Godot Engine v4.7.2',
            'ERROR: res://scripts/main.gd:4 - Missing node'
          ],
          truncated: false
        },
        'terminal.focus': { focused: true },
        'terminal.close': { closed: true },
        'editor.open': { opened: true },
        'notifications.show': { delivered: true },
        'statusBar.update': { ok: true }
      }
    })

    const worker = await mountWorker(main, { host })

    // 1. Snapshot scans the fixture project accurately
    const snap = await worker.request('godot.snapshot', {})
    assert.equal(snap.project?.name, 'Starforge Prototype')
    assert.equal(snap.project?.counts.scenes, 1)
    assert.equal(snap.project?.counts.scripts, 2)
    assert.equal(snap.project?.autoloads[0].name, 'GameState')
    assert.equal(snap.project?.testRunner, 'gut')
    assert.equal(snap.editorLspActive, true)
    assert.equal(snap.binary.shortVersion, '4.7.2')

    // 2. Pin & unpin scene persists to storage
    const pinned1 = await worker.request('godot.togglePinScene', { resPath: 'res://scenes/main.tscn' })
    assert.deepEqual(pinned1.pinnedScenes, ['res://scenes/main.tscn'])
    const pinned2 = await worker.request('godot.togglePinScene', { resPath: 'res://scenes/main.tscn' })
    assert.deepEqual(pinned2.pinnedScenes, [])

    // 3. Run main scene opens an Orca terminal with quoted godot command
    const runRes = await worker.request('godot.run', {})
    assert.equal(runRes.ok, true)
    assert.equal(runRes.terminalId, 'term-1')
    const createCalls = host.callsOf('terminal.create') as { command?: string }[]
    assert.equal(createCalls.length, 1)
    assert.match(String(createCalls[0].command), /\/usr\/local\/bin\/godot --path/)

    // 4. Read logs parses Godot error lines
    const logs = await worker.request('godot.readLogs', { maxLines: 50 })
    assert.equal(logs.active, true)
    assert.equal(logs.diagnostics.length, 1)
    assert.equal(logs.diagnostics[0].relPath, 'scripts/main.gd')

    // 5. Open file in Orca editor
    const openRes = await worker.request('godot.openFile', { relPath: 'scripts/main.gd' })
    assert.equal(openRes.ok, true)
    assert.equal(host.callsOf('editor.open').length, 1)

    // 6. Launch detached Godot Editor
    const edRes = await worker.request('godot.openEditor', { sceneResPath: 'res://scenes/main.tscn' })
    assert.equal(edRes.ok, true)
    assert.equal(edRes.pid, 4242)
    assert.equal(launchedEditors.length, 1)

    // 7. Export preset creates output folder and runs --export-release
    const exportRes = await worker.request('godot.exportPreset', {
      presetName: 'Linux/X11',
      mode: 'release'
    })
    assert.equal(exportRes.ok, true)
    const afterExportCalls = host.callsOf('terminal.create') as { command?: string }[]
    assert.match(String(afterExportCalls[1].command), /--export-release Linux\/X11/)

    // 8. Run GUT tests
    const testRes = await worker.request('godot.runTests')
    assert.equal(testRes.ok, true)
    const afterTestsCalls = host.callsOf('terminal.create') as { command?: string }[]
    assert.match(String(afterTestsCalls[2].command), /addons\/gut\/gut_cmdln\.gd/)

    // 9. Headless check notifies and reports diagnostics
    const checkRes = await worker.request('godot.checkHeadless')
    assert.equal(checkRes.ok, false)
    assert.equal(checkRes.errorCount, 1)
    assert.ok(host.callsOf('notifications.show').length >= 1)

    // 10. Focus and Stop active session
    const focusRes = await worker.request('godot.focusTerminal')
    assert.equal(focusRes.ok, true)
    const stopRes = await worker.request('godot.stopRun')
    assert.equal(stopRes.ok, true)
    assert.equal(host.callsOf('terminal.close').length, 1)

    // 11. Command palette command works
    const cmdOut = await worker.command('godot.refresh')
    assert.match(String(cmdOut), /Refreshed Starforge Prototype/)

    // 12. Zero host refusals across the whole lifecycle
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  })

  test('handles remote workspaces gracefully without local filesystem scanning', async () => {
    setWorkerDepsForTesting({
      detectBinary: async () => ({
        found: false,
        path: null,
        version: null,
        shortVersion: null,
        source: 'missing',
        error: 'Not found'
      }),
      probeLspPort: async () => false
    })

    const host = mockHost({
      results: {
        'workspace.readContext': {
          workspaceId: 'ws-remote',
          branch: 'main',
          displayName: 'remote-game',
          terminals: []
        },
        'workspace.list': {
          workspaces: [
            {
              id: 'ws-remote',
              kind: 'worktree',
              name: 'remote-game',
              path: '/srv/remote-game',
              branch: 'main',
              hostId: 'ssh:buildbox'
            }
          ],
          truncated: false
        },
        'statusBar.update': { ok: true }
      }
    })

    const worker = await mountWorker(main, { host })
    const snap = await worker.request('godot.snapshot', {})
    assert.equal(snap.project, null)
    assert.match(snap.remoteWorkspaceWarning ?? '', /ssh:buildbox/)
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  })

  test('isolates active sessions per workspace, matches uid:// main scenes, supports Godot 3 flags, and handles spawn errors', async () => {
    const wsPath = await createFixtureGodotWorkspace()

    // Update project.godot to use Godot 4.4+ uid:// main scene reference
    await fs.writeFile(
      path.join(wsPath, 'project.godot'),
      `config_version=5

[application]
config/name="UID Game"
run/main_scene="uid://mainscene123"
config/features=PackedStringArray("4.4", "Forward Plus")
`,
      'utf8'
    )
    await fs.writeFile(
      path.join(wsPath, 'scenes', 'main.tscn'),
      `[gd_scene load_steps=2 format=3 uid="uid://mainscene123"]
[node name="Main" type="Node3D"]
`,
      'utf8'
    )

    let activeWorkspaceId = 'ws-a'

    setWorkerDepsForTesting({
      detectBinary: async () => ({
        found: true,
        path: '/usr/local/bin/godot3',
        version: '3.5.3.stable.official',
        shortVersion: '3.5.3',
        source: 'path',
        error: null
      }),
      probeLspPort: async () => false,
      spawnEditor: async () => ({ error: 'ENOENT: godot3 not found' }),
      platform: 'linux'
    })

    const host = mockHost({
      results: {
        'workspace.readContext': () => ({
          workspaceId: activeWorkspaceId,
          branch: 'main',
          displayName: activeWorkspaceId,
          terminals: activeWorkspaceId === 'ws-a' ? [{ id: 'term-a', title: 'Godot: UID Game' }] : []
        }),
        'workspace.list': {
          workspaces: [
            { id: 'ws-a', kind: 'worktree', name: 'ws-a', path: wsPath, branch: 'main', hostId: 'local' },
            { id: 'ws-b', kind: 'worktree', name: 'ws-b', path: wsPath, branch: 'main', hostId: 'local' }
          ],
          truncated: false
        },
        'terminal.list': (params: { workspaceId?: string }) => ({
          terminals: params.workspaceId === 'ws-a' ? [{ id: 'term-a', title: 'Godot: UID Game' }] : [],
          truncated: false
        }),
        'terminal.create': { terminalId: 'term-a' },
        'terminal.read': { lines: [], truncated: false },
        'statusBar.update': { ok: true }
      }
    })

    const worker = await mountWorker(main, { host })

    // 1. uid:// main scene resolves to res://scenes/main.tscn and marks isMain
    const snapA = await worker.request('godot.snapshot', {})
    assert.equal(snapA.project?.mainSceneResPath, 'res://scenes/main.tscn')
    assert.equal(snapA.project?.mainSceneRelPath, 'scenes/main.tscn')
    assert.equal(snapA.project?.scenes[0]?.isMain, true)

    // 2. Spawn error returns ok: false without throwing
    const edErr = await worker.request('godot.openEditor', {})
    assert.equal(edErr.ok, false)
    assert.match(edErr.message, /ENOENT/)

    // 3. Godot 3.x export uses --no-window and --export
    const expRes = await worker.request('godot.exportPreset', {
      presetName: 'Linux/X11',
      mode: 'release'
    })
    assert.equal(expRes.ok, true)
    const createCalls = host.callsOf('terminal.create') as { command?: string }[]
    assert.match(String(createCalls[0].command), /--no-window --path .* --export Linux\/X11/)

    // 4. Switching to ws-b does NOT erase ws-a's active session
    activeWorkspaceId = 'ws-b'
    const snapB = await worker.request('godot.snapshot', { forceRefresh: true })
    assert.equal(snapB.activeSession, null)

    activeWorkspaceId = 'ws-a'
    const snapAReturn = await worker.request('godot.snapshot', { forceRefresh: true })
    assert.equal(snapAReturn.activeSession?.terminalId, 'term-a')

    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  })

  test('ends the session when Godot exits but its terminal stays open', async () => {
    const wsPath = await createFixtureGodotWorkspace()
    let godotExited = false

    setWorkerDepsForTesting({
      detectBinary: async () => ({
        found: true,
        path: '/usr/local/bin/godot',
        version: '4.7.2.stable.official',
        shortVersion: '4.7.2',
        source: 'path',
        error: null
      }),
      probeLspPort: async () => false,
      platform: 'linux'
    })

    const host = mockHost({
      results: {
        'workspace.readContext': {
          workspaceId: 'ws-1',
          branch: 'main',
          displayName: 'starforge',
          terminals: [{ id: 'term-1', title: 'Godot: Starforge Prototype' }]
        },
        'workspace.list': {
          workspaces: [
            { id: 'ws-1', kind: 'worktree', name: 'starforge', path: wsPath, branch: 'main', hostId: 'local' }
          ],
          truncated: false
        },
        'terminal.list': {
          terminals: [{ id: 'term-1', title: 'Godot: Starforge Prototype' }],
          truncated: false
        },
        'terminal.create': { terminalId: 'term-1' },
        'terminal.read': () => ({
          lines: godotExited
            ? ['Godot Engine v4.7.2', 'GODOT_COMPANION_EXITED', '$ ']
            : ['Godot Engine v4.7.2'],
          truncated: false
        }),
        'statusBar.update': { ok: true }
      }
    })

    const worker = await mountWorker(main, { host })

    await worker.request('godot.run', {})
    const createCalls = host.callsOf('terminal.create') as { command?: string }[]
    assert.match(String(createCalls[0].command), /; echo GODOT_COMPANION_EXITED$/)

    const running = await worker.request('godot.snapshot', {})
    assert.equal(running.activeSession?.terminalId, 'term-1')

    godotExited = true
    const ended = await worker.request('godot.snapshot', {})
    assert.equal(ended.activeSession, null)
    assert.equal(ended.logs?.active, false)
    assert.deepEqual(ended.logs?.lines, ['Godot Engine v4.7.2', '$ '])

    const logs = await worker.request('godot.readLogs', {})
    assert.equal(logs.active, false)
    assert.equal(logs.lines[0], 'Godot Engine v4.7.2')

    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  })
})
