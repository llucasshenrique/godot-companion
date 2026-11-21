// Scenarios for `orca-ide plugin check` and `orca-ide plugin shot --scenario <name>`.
import { defineCheck } from 'orca/testing'
import type { GodotSnapshot } from './types'

const sampleSnapshot: GodotSnapshot = {
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
    description: 'FPS PvE cooperativo de extracao ambientado no espaco',
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
      { name: 'shoot', deadzone: 0.5, bindings: ['LMB'] },
      { name: 'jump', deadzone: 0.5, bindings: ['Space'] }
    ],
    layerNames: [
      { domain: '3d_physics', index: 1, name: 'world' },
      { domain: '3d_physics', index: 2, name: 'player' }
    ],
    scenes: [
      {
        name: 'ship_base.tscn',
        resPath: 'res://scenes/levels/ship_base.tscn',
        relPath: 'scenes/levels/ship_base.tscn',
        rootName: 'ShipBase',
        rootType: 'Node3D',
        scriptResPath: 'res://scripts/levels/ship_controller.gd',
        scriptRelPath: 'scripts/levels/ship_controller.gd',
        nodeCount: 18,
        isMain: true
      },
      {
        name: 'player.tscn',
        resPath: 'res://scenes/characters/player/player.tscn',
        relPath: 'scenes/characters/player/player.tscn',
        rootName: 'Player',
        rootType: 'CharacterBody3D',
        scriptResPath: 'res://scripts/characters/player/player_controller.gd',
        scriptRelPath: 'scripts/characters/player/player_controller.gd',
        nodeCount: 12,
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
        exportPath: 'builds/linux/ProtocoloVoid.x86_64'
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
      inputActions: 3,
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
  pinnedScenes: ['res://scenes/levels/ship_base.tscn'],
  lastCheck: null,
  logs: null,
  settings: {
    godotBinary: '',
    extraRunArgs: '',
    lspPort: 6005,
    openEditorDetached: true,
    notifyOnComplete: true
  },
  refreshedAt: Date.now() - 20_000,
  remoteWorkspaceWarning: null
}

const runningWithDiagnosticsSnapshot: GodotSnapshot = {
  ...sampleSnapshot,
  activeSession: {
    terminalId: 'term-godot-1',
    label: 'ship_base.tscn',
    kind: 'run',
    startedAt: Date.now() - 4 * 60_000,
    sceneResPath: 'res://scenes/levels/ship_base.tscn'
  },
  lastCheck: {
    ok: false,
    exitCode: 1,
    durationMs: 412,
    checkedAt: Date.now() - 90_000,
    errorCount: 1,
    warningCount: 1,
    diagnostics: [
      {
        severity: 'error',
        message: 'Parse Error: Identifier "missing_var" not declared in the current scope.',
        resPath: 'res://scripts/characters/player/player_controller.gd',
        relPath: 'scripts/characters/player/player_controller.gd',
        line: 84,
        raw: 'ERROR: res://scripts/characters/player/player_controller.gd:84 - Parse Error'
      },
      {
        severity: 'warning',
        message: 'Unused parameter "delta" in function "_process".',
        resPath: 'res://scripts/levels/ship_controller.gd',
        relPath: 'scripts/levels/ship_controller.gd',
        line: 22,
        raw: 'WARNING: res://scripts/levels/ship_controller.gd:22 - Unused parameter'
      }
    ],
    rawOutput:
      'Godot Engine v4.7.2.stable\nERROR: res://scripts/characters/player/player_controller.gd:84 - Parse Error'
  }
}

export default defineCheck({
  noWorkspace: {
    results: {
      'workspace.readContext': null,
      'workspace.list': { workspaces: [], truncated: false }
    }
  },
  noGodotProject: {
    requests: {
      'godot.snapshot': {
        ...sampleSnapshot,
        project: null,
        availableProjects: []
      }
    }
  },
  activeProject: {
    requests: {
      'godot.snapshot': sampleSnapshot
    }
  },
  runningWithDiagnostics: {
    theme: 'dark',
    requests: {
      'godot.snapshot': runningWithDiagnosticsSnapshot
    }
  },
  missingBinary: {
    requests: {
      'godot.snapshot': {
        ...sampleSnapshot,
        editorLspActive: false,
        binary: {
          found: false,
          path: null,
          version: null,
          shortVersion: null,
          source: 'missing',
          error: 'Godot executable not found in PATH.'
        }
      }
    }
  }
})
