import { assert, describe, test } from 'orca/testing'
import {
  buildShellCommand,
  isGodot3Version,
  parseAddonCfg,
  parseExportPresets,
  parseGodotOutput,
  parseGodotShortVersion,
  parseProjectGodot,
  parseResourceHeader,
  parseSceneHeader,
  parseScriptHeader,
  resPathToRelPath,
  splitCliArgs
} from './godot-parser'

describe('godot-parser', () => {
  test('parses project.godot with application, autoload, multi-line input, layers and plugins', () => {
    const sample = `
; Engine configuration file.
config_version=5

[application]
config/name="Protocol Void"
config/description="FPS PvE cooperativo"
run/main_scene="res://scenes/levels/ship_base.tscn"
config/features=PackedStringArray("4.7", "Forward Plus")
config/icon="res://icon.svg"

[autoload]
GameManager="*res://scripts/autoload/game_manager.gd"
AudioBus="res://scripts/autoload/audio_bus.gd"

[display]
window/size/viewport_width=1920
window/size/viewport_height=1080

[input]
move_forward={
"deadzone": 0.5,
"events": [Object(InputEventKey,"physical_keycode":87,"unicode":119)
]
}
shoot={
"deadzone": 0.25,
"events": [Object(InputEventMouseButton,"button_index":1,"pressed":true)
]
}
sprint={
"deadzone": 0.5,
"events": [Object(InputEventKey,"physical_keycode":4194325)
]
}

[layer_names]
3d_physics/layer_1="world"
3d_physics/layer_2="player"

[physics]
common/physics_ticks_per_second=120

[editor_plugins]
enabled=PackedStringArray("res://addons/gut/plugin.cfg")
`
    const parsed = parseProjectGodot(sample)
    assert.equal(parsed.name, 'Protocol Void')
    assert.equal(parsed.description, 'FPS PvE cooperativo')
    assert.equal(parsed.mainSceneResPath, 'res://scenes/levels/ship_base.tscn')
    assert.deepEqual(parsed.features, ['4.7', 'Forward Plus'])
    assert.equal(parsed.godotVersionHint, '4.7')
    assert.equal(parsed.renderer, 'Forward Plus')
    assert.equal(parsed.viewportWidth, 1920)
    assert.equal(parsed.viewportHeight, 1080)
    assert.equal(parsed.physicsTicksPerSecond, 120)

    assert.equal(parsed.autoloads.length, 2)
    assert.deepEqual(parsed.autoloads[0], {
      name: 'GameManager',
      resPath: 'res://scripts/autoload/game_manager.gd',
      relPath: 'scripts/autoload/game_manager.gd',
      singleton: true
    })
    assert.equal(parsed.autoloads[1].singleton, false)

    assert.equal(parsed.inputActions.length, 3)
    assert.deepEqual(parsed.inputActions[0], {
      name: 'move_forward',
      deadzone: 0.5,
      bindings: ['W']
    })
    assert.deepEqual(parsed.inputActions[1], {
      name: 'shoot',
      deadzone: 0.25,
      bindings: ['LMB']
    })
    assert.deepEqual(parsed.inputActions[2], {
      name: 'sprint',
      deadzone: 0.5,
      bindings: ['Shift']
    })

    assert.deepEqual(parsed.layerNames, [
      { domain: '3d_physics', index: 1, name: 'world' },
      { domain: '3d_physics', index: 2, name: 'player' }
    ])
    assert.deepEqual(parsed.enabledPluginPaths, ['res://addons/gut/plugin.cfg'])
  })

  test('parses export_presets.cfg sections in index order', () => {
    const cfg = `
[preset.1]
name="Linux/X11"
platform="Linux"
runnable=true
dedicated_server=false
export_path="builds/linux/game.x86_64"

[preset.0]
name="Windows Desktop"
platform="Windows Desktop"
runnable=true
dedicated_server=false
export_path="builds/windows/game.exe"

[preset.0.options]
binary_format/embed_pck=false
`
    const presets = parseExportPresets(cfg)
    assert.equal(presets.length, 2)
    assert.equal(presets[0].name, 'Windows Desktop')
    assert.equal(presets[0].exportPath, 'builds/windows/game.exe')
    assert.equal(presets[1].name, 'Linux/X11')
    assert.equal(presets[1].runnable, true)
  })

  test('parses .tscn root node, attached script, and node count', () => {
    const tscn = `
[gd_scene load_steps=4 format=3 uid="uid://abc123"]

[ext_resource type="Script" path="res://scripts/player.gd" id="1_script"]
[ext_resource type="Texture2D" path="res://icon.svg" id="2_tex"]

[node name="Player" type="CharacterBody3D"]
script = ExtResource("1_script")

[node name="Camera3D" type="Camera3D" parent="."]

[node name="CollisionShape3D" type="CollisionShape3D" parent="."]
`
    const meta = parseSceneHeader(tscn)
    assert.equal(meta.uid, 'uid://abc123')
    assert.equal(meta.rootName, 'Player')
    assert.equal(meta.rootType, 'CharacterBody3D')
    assert.equal(meta.scriptResPath, 'res://scripts/player.gd')
    assert.equal(meta.nodeCount, 3)
  })

  test('parses GDScript, C#, .tres, and plugin.cfg headers', () => {
    const gd = `@tool\nclass_name WeaponResource\nextends Resource\n@export var damage: int = 10`
    assert.deepEqual(parseScriptHeader(gd, false), {
      className: 'WeaponResource',
      extendsType: 'Resource',
      isTool: true
    })

    const cs = `using Godot;\n[Tool]\npublic partial class EnemyAI : CharacterBody3D {}`
    assert.deepEqual(parseScriptHeader(cs, true), {
      className: 'EnemyAI',
      extendsType: 'CharacterBody3D',
      isTool: true
    })

    const tres = `[gd_resource type="Resource" script_class="WeaponResource" load_steps=2 format=3]`
    assert.deepEqual(parseResourceHeader(tres), {
      resourceType: 'Resource',
      scriptClass: 'WeaponResource'
    })

    const cfg = `[plugin]\nname="GUT"\nversion="9.3.0"\n`
    assert.deepEqual(parseAddonCfg(cfg), { name: 'GUT', version: '9.3.0' })
  })

  test('parses Godot errors and warnings with res:// file and line extraction', () => {
    const lines = [
      'Godot Engine v4.7.2.stable.official',
      'SCRIPT ERROR: Invalid get index "hp" (on base: "Nil").',
      '          at: _process (res://scripts/enemies/enemy_base.gd:142)',
      'ERROR: res://scripts/player.gd:19 - Parse Error: Unexpected token.',
      'WARNING: Unused signal "on_fired".',
      '     at: GDScript::reload (res://scripts/weapons/rifle.gd:7)'
    ]
    const diags = parseGodotOutput(lines)
    assert.equal(diags.length, 3)

    assert.equal(diags[0].severity, 'error')
    assert.equal(diags[0].resPath, 'res://scripts/enemies/enemy_base.gd')
    assert.equal(diags[0].relPath, 'scripts/enemies/enemy_base.gd')
    assert.equal(diags[0].line, 142)

    assert.equal(diags[1].severity, 'error')
    assert.equal(diags[1].relPath, 'scripts/player.gd')
    assert.equal(diags[1].line, 19)

    assert.equal(diags[2].severity, 'warning')
    assert.equal(diags[2].relPath, 'scripts/weapons/rifle.gd')
    assert.equal(diags[2].line, 7)
  })

  test('rejects path traversal and non-res schemes, and safely quotes CLI commands', () => {
    assert.equal(resPathToRelPath('res://scenes/main.tscn'), 'scenes/main.tscn')
    assert.equal(resPathToRelPath('res://../etc/passwd'), null)
    assert.equal(resPathToRelPath('uid://abc123def'), null)
    assert.equal(resPathToRelPath('user://save.dat'), null)
    assert.equal(parseGodotShortVersion('4.7.2.stable.official.ed1daf0bf'), '4.7.2')
    assert.equal(isGodot3Version('3.5.3'), true)
    assert.equal(isGodot3Version('4.4.0'), false)
    assert.equal(isGodot3Version(null), false)

    assert.deepEqual(splitCliArgs('--verbose --resolution "1280x720"'), [
      '--verbose',
      '--resolution',
      '1280x720'
    ])

    const cmd = buildShellCommand(
      '/home/user/Steam/Godot Engine/godot',
      ['--path', '/tmp/my game', '--export-release', 'Linux/X11', '/tmp/out/game.x86_64'],
      'linux'
    )
    assert.equal(
      cmd,
      `'/home/user/Steam/Godot Engine/godot' --path '/tmp/my game' --export-release Linux/X11 /tmp/out/game.x86_64`
    )
  })

  test('strips ANSI codes in Godot output and prefixes sub-project diagnostic paths', () => {
    const ansiLines = [
      '\x1b[1;31mERROR:\x1b[0m \x1b[33mres://scripts/player.gd:42\x1b[0m - Parse Error: Bad syntax',
      '\x1b[1;33mWARNING:\x1b[0m Unused variable "foo".',
      '     at: GDScript::reload (\x1b[36mres://scripts/hud.gd:9\x1b[0m)'
    ]
    const diags = parseGodotOutput(ansiLines, 'client')
    assert.equal(diags.length, 2)
    assert.equal(diags[0].severity, 'error')
    assert.equal(diags[0].relPath, 'client/scripts/player.gd')
    assert.equal(diags[0].line, 42)
    assert.equal(diags[1].severity, 'warning')
    assert.equal(diags[1].relPath, 'client/scripts/hud.gd')
    assert.equal(diags[1].line, 9)
  })

  test('handles multi-line PackedStringArray and escaped backslashes before quotes', () => {
    const sample = `
[application]
config/name="Path\\\\"
config/features=PackedStringArray(
  "4.4",
  "Forward Plus"
)
`
    const parsed = parseProjectGodot(sample)
    assert.equal(parsed.name, 'Path\\')
    assert.deepEqual(parsed.features, ['4.4', 'Forward Plus'])
  })
})
