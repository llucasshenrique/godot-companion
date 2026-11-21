import { afterEach, assert, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panelModule from './panel'
import type { GodotHeadlessCheckResult, GodotSnapshot } from './types'

let panel: TestPanel | undefined

afterEach(async () => {
  if (panel) {
    await panel.unmount()
    panel = undefined
  }
})

function makeSnapshot(overrides: Partial<GodotSnapshot> = {}): GodotSnapshot {
  return {
    workspace: {
      id: 'ws-1',
      name: 'protocolo-v-0-id',
      branch: 'main',
      path: '/workspace/protocolo-v-0-id',
      hostId: 'local',
      kind: 'worktree'
    },
    project: {
      name: 'Protocol Void',
      description: 'FPS PvE cooperativo',
      rootRelPath: '.',
      projectFileRelPath: 'project.godot',
      mainSceneResPath: 'res://scenes/levels/ship_base.tscn',
      mainSceneRelPath: 'scenes/levels/ship_base.tscn',
      features: ['4.7', 'Forward Plus'],
      godotVersionHint: '4.7',
      renderer: 'Forward Plus',
      viewportWidth: 1920,
      viewportHeight: 1080,
      physicsTicksPerSecond: 120,
      autoloads: [
        {
          name: 'GameManager',
          resPath: 'res://scripts/autoload/game_manager.gd',
          relPath: 'scripts/autoload/game_manager.gd',
          singleton: true
        }
      ],
      inputActions: [
        { name: 'move_forward', deadzone: 0.5, bindings: ['W'] },
        { name: 'shoot', deadzone: 0.5, bindings: ['LMB'] }
      ],
      layerNames: [{ domain: '3d_physics', index: 1, name: 'world' }],
      scenes: [
        {
          name: 'ship_base.tscn',
          resPath: 'res://scenes/levels/ship_base.tscn',
          relPath: 'scenes/levels/ship_base.tscn',
          rootName: 'ShipBase',
          rootType: 'Node3D',
          scriptResPath: 'res://scripts/levels/ship_controller.gd',
          scriptRelPath: 'scripts/levels/ship_controller.gd',
          nodeCount: 14,
          isMain: true
        },
        {
          name: 'player.tscn',
          resPath: 'res://scenes/characters/player.tscn',
          relPath: 'scenes/characters/player.tscn',
          rootName: 'Player',
          rootType: 'CharacterBody3D',
          scriptResPath: null,
          scriptRelPath: null,
          nodeCount: 8,
          isMain: false
        }
      ],
      codeFiles: [
        {
          name: 'game_manager.gd',
          resPath: 'res://scripts/autoload/game_manager.gd',
          relPath: 'scripts/autoload/game_manager.gd',
          kind: 'gdscript',
          className: 'GameManager',
          extendsType: 'Node',
          isTool: false
        },
        {
          name: 'hardsurface.gdshader',
          resPath: 'res://shaders/hardsurface.gdshader',
          relPath: 'shaders/hardsurface.gdshader',
          kind: 'shader',
          className: null,
          extendsType: 'spatial',
          isTool: false
        }
      ],
      exportPresets: [
        {
          index: 0,
          name: 'Linux/X11',
          platform: 'Linux',
          runnable: true,
          dedicatedServer: false,
          exportPath: 'builds/linux/game.x86_64'
        }
      ],
      addons: [
        {
          id: 'gut',
          name: 'GUT',
          version: '9.3.0',
          enabled: true,
          relPath: 'addons/gut/plugin.cfg'
        }
      ],
      testRunner: 'gut',
      counts: {
        scenes: 2,
        scripts: 1,
        shaders: 1,
        resources: 0,
        autoloads: 1,
        inputActions: 2,
        exportPresets: 1,
        addons: 1,
        truncated: false
      }
    },
    availableProjects: [{ name: 'Protocol Void', relPath: '.' }],
    selectedProjectRelPath: '.',
    binary: {
      found: true,
      path: '/usr/local/bin/godot',
      version: '4.7.2.stable.official',
      shortVersion: '4.7.2',
      source: 'path',
      error: null
    },
    editorLspActive: true,
    activeSession: null,
    pinnedScenes: [],
    lastCheck: null,
    logs: null,
    settings: {
      godotBinary: '',
      extraRunArgs: '',
      lspPort: 6005,
      openEditorDetached: true,
      notifyOnComplete: true
    },
    refreshedAt: 1700000000000,
    remoteWorkspaceWarning: null,
    ...overrides
  }
}

describe('GodotPanel UI', () => {
  test('renders project overview, runs scenes, filters scenes, pins scenes, and navigates all tabs', async () => {
    const calls: { name: string; input?: unknown }[] = []
    let pinned: string[] = []
    const snap = makeSnapshot()

    const checkResult: GodotHeadlessCheckResult = {
      ok: false,
      exitCode: 1,
      durationMs: 320,
      checkedAt: 1700000000000,
      errorCount: 1,
      warningCount: 0,
      diagnostics: [
        {
          severity: 'error',
          message: 'Parse Error: Unexpected end of line',
          resPath: 'res://scripts/autoload/game_manager.gd',
          relPath: 'scripts/autoload/game_manager.gd',
          line: 45,
          raw: 'ERROR: res://scripts/autoload/game_manager.gd:45'
        }
      ],
      rawOutput: 'ERROR: res://scripts/autoload/game_manager.gd:45'
    }

    const host = mockHost({
      requests: {
        'godot.snapshot': () => ({ ...snap, pinnedScenes: [...pinned] }),
        'godot.run': (input) => {
          calls.push({ name: 'godot.run', input })
          return { ok: true, terminalId: 'term-1', message: 'Started Godot: Protocol Void' }
        },
        'godot.openEditor': (input) => {
          calls.push({ name: 'godot.openEditor', input })
          return { ok: true, pid: 1001, message: 'Launched Godot Editor' }
        },
        'godot.openFile': (input) => {
          calls.push({ name: 'godot.openFile', input })
          return { ok: true, message: 'Opened file' }
        },
        'godot.togglePinScene': ({ resPath }) => {
          pinned = pinned.includes(resPath)
            ? pinned.filter((p) => p !== resPath)
            : [...pinned, resPath]
          return { pinnedScenes: [...pinned] }
        },
        'godot.exportPreset': (input) => {
          calls.push({ name: 'godot.exportPreset', input })
          return { ok: true, terminalId: 'term-exp', message: 'Started Linux/X11 export' }
        },
        'godot.checkHeadless': () => {
          calls.push({ name: 'godot.checkHeadless' })
          return checkResult
        }
      }
    })

    panel = await mount(panelModule, { host })

    // Overview renders project title and version badge
    assert.ok(panel.find({ type: 'Heading', text: 'Protocol Void' }))
    assert.ok(panel.find({ text: 'v4.7.2' }))
    assert.ok(panel.find({ text: 'LSP' }))

    // Primary Run button triggers godot.run
    await panel.press({ role: 'button', text: 'Run' })
    assert.equal(calls.some((c) => c.name === 'godot.run'), true)

    // Switch to Scenes tab, filter by "player", and pin it
    await panel.select({ label: 'Godot sections' }, 'scenes')
    await panel.type({ label: 'Filter scenes' }, 'player')
    assert.ok(panel.find({ text: 'player.tscn' }))
    assert.equal(panel.find({ text: 'ship_base.tscn' }), null)

    await panel.press({ label: 'Pin player.tscn' })
    assert.deepEqual(pinned, ['res://scenes/characters/player.tscn'])

    // Switch to Scripts tab and activate a row to open it in Orca
    await panel.select({ label: 'Godot sections' }, 'scripts')
    await panel.activateRow({ label: 'Godot scripts and resources' }, 'scripts/autoload/game_manager.gd')
    assert.equal(
      calls.some(
        (c) =>
          c.name === 'godot.openFile' &&
          (c.input as { relPath?: string })?.relPath === 'scripts/autoload/game_manager.gd'
      ),
      true
    )

    // Switch to Config tab and trigger Export Release
    await panel.select({ label: 'Godot sections' }, 'config')
    await panel.press({ role: 'button', text: 'Export Release' })
    assert.equal(
      calls.some(
        (c) =>
          c.name === 'godot.exportPreset' &&
          (c.input as { presetName?: string; mode?: string })?.presetName === 'Linux/X11'
      ),
      true
    )

    // Trigger Headless Check, receive updated diagnostics via worker post, and open diagnostic file
    await panel.press({ role: 'button', text: 'Check' })
    await panel.post('godot.updated', makeSnapshot({ lastCheck: checkResult }))
    assert.ok(panel.find({ text: /Unexpected end of line/ }))
    await panel.press({ role: 'button', text: 'Open :45' })

    assert.deepEqual(panel.errors, [])
    assert.deepEqual(panel.warnings, [])
    assert.deepEqual(panel.refusals, [])
  })

  test('renders empty state cleanly when workspace has no project.godot', async () => {
    const host = mockHost({
      requests: {
        'godot.snapshot': () =>
          makeSnapshot({
            project: null,
            availableProjects: []
          })
      }
    })

    panel = await mount(panelModule, { host })
    assert.ok(panel.find({ type: 'EmptyState', label: 'No Godot project found' }))
    assert.deepEqual(panel.errors, [])
    assert.deepEqual(panel.warnings, [])
    assert.deepEqual(panel.refusals, [])
  })

  test('supports scene tree view, active session controls, multi-project switching, and version mismatch warning', async () => {
    const calls: { name: string; input?: unknown }[] = []
    const snap = makeSnapshot({
      availableProjects: [
        { name: 'Protocol Void', relPath: '.' },
        { name: 'Sandbox', relPath: 'sandbox' }
      ],
      binary: {
        found: true,
        path: '/usr/local/bin/godot',
        version: '4.3.0.stable.official',
        shortVersion: '4.3.0',
        source: 'path',
        error: null
      },
      activeSession: {
        terminalId: 'term-active-1',
        label: 'ship_base.tscn',
        kind: 'run',
        startedAt: 1700000000000,
        sceneResPath: 'res://scenes/levels/ship_base.tscn'
      }
    })

    const host = mockHost({
      requests: {
        'godot.snapshot': () => snap,
        'godot.selectProject': (input) => {
          calls.push({ name: 'godot.selectProject', input })
          return { ...snap, selectedProjectRelPath: input.projectRelPath }
        },
        'godot.focusTerminal': () => {
          calls.push({ name: 'godot.focusTerminal' })
          return { ok: true, message: 'Focused ship_base.tscn' }
        },
        'godot.stopRun': () => {
          calls.push({ name: 'godot.stopRun' })
          return { ok: true, message: 'Stopped ship_base.tscn' }
        },
        'godot.openFile': (input) => {
          calls.push({ name: 'godot.openFile', input })
          return { ok: true, message: 'Opened file' }
        }
      }
    })

    panel = await mount(panelModule, { host })

    // Version mismatch warning shown (project 4.7 vs binary 4.3.0)
    assert.ok(panel.find({ type: 'Callout', label: 'Version mismatch' }))

    // Focus and Stop active session controls work
    await panel.press({ label: 'Focus Godot terminal' })
    await panel.press({ label: 'Stop Godot session' })
    assert.equal(calls.some((c) => c.name === 'godot.focusTerminal'), true)
    assert.equal(calls.some((c) => c.name === 'godot.stopRun'), true)

    // Switch sub-project in multi-project workspace
    await panel.select({ label: 'Godot Project' }, 'sandbox')
    assert.equal(
      calls.some(
        (c) =>
          c.name === 'godot.selectProject' &&
          (c.input as { projectRelPath?: string })?.projectRelPath === 'sandbox'
      ),
      true
    )

    // Switch to Scenes -> Tree view, expand folders, and activate scene
    await panel.select({ label: 'Godot sections' }, 'scenes')
    await panel.select({ label: 'Scene view' }, 'tree')
    await panel.expand({ label: 'Scene tree' }, 'dir:scenes')
    await panel.expand({ label: 'Scene tree' }, 'dir:scenes/levels')
    await panel.activateItem({ label: 'Scene tree' }, 'res://scenes/levels/ship_base.tscn')
    assert.equal(
      calls.some(
        (c) =>
          c.name === 'godot.openFile' &&
          (c.input as { relPath?: string })?.relPath === 'scenes/levels/ship_base.tscn'
      ),
      true
    )

    assert.deepEqual(panel.errors, [])
    assert.deepEqual(panel.warnings, [])
    assert.deepEqual(panel.refusals, [])
  })
})
