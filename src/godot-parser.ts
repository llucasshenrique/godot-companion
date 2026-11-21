// Pure parsers for Godot 3/4 project files, scenes, scripts, resources, export presets, and logs.
// Zero Node.js or Orca host dependencies so this module is fast and trivially unit-testable.

import type {
  GodotAutoload,
  GodotDiagnostic,
  GodotExportPreset,
  GodotInputAction,
  GodotLayerName
} from './types'

export type ParsedProjectGodot = {
  name: string
  description: string
  mainSceneResPath: string | null
  features: string[]
  godotVersionHint: string | null
  renderer: string | null
  icon: string | null
  viewportWidth: number | null
  viewportHeight: number | null
  physicsTicksPerSecond: number | null
  autoloads: GodotAutoload[]
  inputActions: GodotInputAction[]
  layerNames: GodotLayerName[]
  enabledPluginPaths: string[]
}

export type ParsedSceneHeader = {
  rootName: string | null
  rootType: string | null
  scriptResPath: string | null
  nodeCount: number
}

export type ParsedScriptHeader = {
  className: string | null
  extendsType: string | null
  isTool: boolean
}

export type ParsedResourceHeader = {
  resourceType: string | null
  scriptClass: string | null
}

export type ParsedAddonCfg = {
  name: string | null
  version: string | null
}

/** Converts a `res://foo/bar.tscn` path to a normalized relative path (`foo/bar.tscn`). */
export function resPathToRelPath(resPath: string): string | null {
  const trimmed = resPath.trim().replace(/^"|"$/g, '')
  if (!trimmed) return null
  const withoutScheme = trimmed.startsWith('res://') ? trimmed.slice('res://'.length) : trimmed
  const normalized = withoutScheme.replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (parts.length === 0 || parts.some((segment) => segment === '..')) return null
  return parts.join('/')
}

/** Converts a project-relative path (`scenes/main.tscn`) into `res://scenes/main.tscn`. */
export function relPathToResPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  return `res://${normalized}`
}

/** Joins a project sub-folder relative path with a project-relative file path cleanly. */
export function joinRelPath(prefixRelPath: string, childRelPath: string): string {
  const cleanPrefix = prefixRelPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const cleanChild = childRelPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleanPrefix || cleanPrefix === '.') return cleanChild
  if (!cleanChild) return cleanPrefix
  return `${cleanPrefix}/${cleanChild}`
}

/** Unquotes a Godot ConfigFile string literal like `"Protocol Void"`. */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .replace(/\\n/g, '\n')
  }
  return trimmed
}

/** Parses `PackedStringArray("4.7", "Forward Plus")` or `PoolStringArray(...)`. */
function parseStringArray(raw: string): string[] {
  const match = raw.match(/(?:PackedStringArray|PoolStringArray)\(([\s\S]*)\)/)
  const body = match ? match[1] : raw
  const out: string[] = []
  const re = /"((?:\\.|[^"\\])*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    out.push(m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
  }
  return out
}

function parseOptionalInt(raw: string | undefined): number | null {
  if (!raw) return null
  const n = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(n) ? n : null
}

/** Splits an INI / Godot ConfigFile into sections, preserving multi-line brace/bracket values. */
export function parseConfigSections(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>()
  let currentSection = ''
  const getSection = (name: string): Map<string, string> => {
    let map = sections.get(name)
    if (!map) {
      map = new Map<string, string>()
      sections.set(name, map)
    }
    return map
  }

  const lines = text.split(/\r?\n/)
  let activeKey: string | null = null
  let activeValueLines: string[] = []
  let braceDepth = 0

  const countBalance = (line: string): number => {
    let delta = 0
    let inString = false
    let escaped = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\' && inString) {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (!inString) {
        if (ch === '{' || ch === '[') delta++
        else if (ch === '}' || ch === ']') delta--
      }
    }
    return delta
  }

  const flush = () => {
    if (activeKey !== null) {
      getSection(currentSection).set(activeKey, activeValueLines.join('\n').trim())
      activeKey = null
      activeValueLines = []
      braceDepth = 0
    }
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (activeKey !== null && braceDepth > 0) {
      activeValueLines.push(rawLine)
      braceDepth += countBalance(rawLine)
      if (braceDepth <= 0) flush()
      continue
    }

    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) {
      continue
    }

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      flush()
      currentSection = trimmed.slice(1, -1).trim()
      getSection(currentSection)
      continue
    }

    const eqIdx = rawLine.indexOf('=')
    if (eqIdx === -1) continue
    flush()
    const key = rawLine.slice(0, eqIdx).trim()
    const val = rawLine.slice(eqIdx + 1).trim()
    activeKey = key
    activeValueLines = [val]
    braceDepth = countBalance(val)
    if (braceDepth <= 0) flush()
  }

  flush()
  return sections
}

const GODOT_SPECIAL_KEYS: Record<number, string> = {
  32: 'Space',
  4194305: 'Esc',
  4194306: 'Tab',
  4194307: 'Backtab',
  4194308: 'Backspace',
  4194309: 'Enter',
  4194310: 'KP Enter',
  4194311: 'Insert',
  4194312: 'Delete',
  4194319: 'Left',
  4194320: 'Up',
  4194321: 'Right',
  4194322: 'Down',
  4194323: 'PageUp',
  4194324: 'PageDown',
  4194325: 'Shift',
  4194326: 'Ctrl',
  4194327: 'Meta',
  4194328: 'Alt',
  4194332: 'F1',
  4194333: 'F2',
  4194334: 'F3',
  4194335: 'F4',
  4194336: 'F5',
  4194337: 'F6',
  4194338: 'F7',
  4194339: 'F8',
  4194340: 'F9',
  4194341: 'F10',
  4194342: 'F11',
  4194343: 'F12'
}

const MOUSE_BUTTON_NAMES: Record<number, string> = {
  1: 'LMB',
  2: 'RMB',
  3: 'MMB',
  4: 'Wheel Up',
  5: 'Wheel Down',
  6: 'Wheel Left',
  7: 'Wheel Right',
  8: 'Mouse 4',
  9: 'Mouse 5'
}

function decodeKeycode(code: number): string | null {
  if (!Number.isFinite(code) || code <= 0) return null
  if (GODOT_SPECIAL_KEYS[code]) return GODOT_SPECIAL_KEYS[code]
  if (code >= 33 && code <= 126) return String.fromCharCode(code).toUpperCase()
  return `Key(${code})`
}

/** Extracts human-readable binding labels from a Godot `[input]` action block. */
export function parseInputBindings(rawBlock: string): { deadzone: number; bindings: string[] } {
  const dzMatch = rawBlock.match(/"deadzone"\s*:\s*([0-9.]+)/)
  const deadzone = dzMatch ? Number.parseFloat(dzMatch[1]) : 0.5
  const bindings: string[] = []

  const objectRe = /Object\((InputEvent[A-Za-z0-9_]+),([^)]*(?:\([^)]*\)[^)]*)*)\)/g
  let m: RegExpExecArray | null
  while ((m = objectRe.exec(rawBlock)) !== null) {
    const kind = m[1]
    const body = m[2]

    if (kind === 'InputEventKey') {
      const prefixes: string[] = []
      if (/"ctrl_pressed"\s*:\s*true/.test(body)) prefixes.push('Ctrl')
      if (/"alt_pressed"\s*:\s*true/.test(body)) prefixes.push('Alt')
      if (/"shift_pressed"\s*:\s*true/.test(body)) prefixes.push('Shift')
      if (/"meta_pressed"\s*:\s*true/.test(body)) prefixes.push('Meta')

      const physMatch = body.match(/"physical_keycode"\s*:\s*(\d+)/)
      const keyMatch = body.match(/"keycode"\s*:\s*(\d+)/)
      const labelMatch = body.match(/"key_label"\s*:\s*(\d+)/)
      const unicodeMatch = body.match(/"unicode"\s*:\s*(\d+)/)

      const keyName =
        decodeKeycode(physMatch ? Number(physMatch[1]) : 0) ??
        decodeKeycode(keyMatch ? Number(keyMatch[1]) : 0) ??
        decodeKeycode(labelMatch ? Number(labelMatch[1]) : 0) ??
        decodeKeycode(unicodeMatch ? Number(unicodeMatch[1]) : 0)

      if (keyName) {
        const label = prefixes.length > 0 ? `${prefixes.join('+')}+${keyName}` : keyName
        if (!bindings.includes(label)) bindings.push(label)
      }
    } else if (kind === 'InputEventMouseButton') {
      const btnMatch = body.match(/"button_index"\s*:\s*(\d+)/)
      const btnIdx = btnMatch ? Number(btnMatch[1]) : 0
      const label = MOUSE_BUTTON_NAMES[btnIdx] ?? `Mouse ${btnIdx}`
      if (!bindings.includes(label)) bindings.push(label)
    } else if (kind === 'InputEventJoypadButton') {
      const btnMatch = body.match(/"button_index"\s*:\s*(\d+)/)
      const label = btnMatch ? `Joy Btn ${btnMatch[1]}` : 'Joypad Button'
      if (!bindings.includes(label)) bindings.push(label)
    } else if (kind === 'InputEventJoypadMotion') {
      const axisMatch = body.match(/"axis"\s*:\s*(\d+)/)
      const valMatch = body.match(/"axis_value"\s*:\s*(-?[0-9.]+)/)
      const sign = valMatch && Number(valMatch[1]) < 0 ? '-' : '+'
      const label = axisMatch ? `Joy Axis ${axisMatch[1]}${sign}` : 'Joypad Axis'
      if (!bindings.includes(label)) bindings.push(label)
    }
  }

  return { deadzone: Number.isFinite(deadzone) ? deadzone : 0.5, bindings }
}

/** Parses a Godot `project.godot` file into structured metadata. */
export function parseProjectGodot(text: string): ParsedProjectGodot {
  const sections = parseConfigSections(text)
  const app = sections.get('application') ?? new Map<string, string>()
  const display = sections.get('display') ?? new Map<string, string>()
  const physics = sections.get('physics') ?? new Map<string, string>()
  const autoloadSection = sections.get('autoload') ?? new Map<string, string>()
  const inputSection = sections.get('input') ?? new Map<string, string>()
  const layerSection = sections.get('layer_names') ?? new Map<string, string>()
  const pluginsSection = sections.get('editor_plugins') ?? new Map<string, string>()

  const features = parseStringArray(app.get('config/features') ?? '')
  const godotVersionHint = features.find((f) => /^\d+\.\d+/.test(f)) ?? null
  const renderer =
    features.find((f) => /forward|mobile|compatibility|vulkan|gl/i.test(f)) ?? null

  const mainSceneRaw = app.get('run/main_scene')
  const mainSceneResPath = mainSceneRaw ? unquote(mainSceneRaw) : null

  const autoloads: GodotAutoload[] = []
  for (const [name, rawVal] of autoloadSection.entries()) {
    const clean = unquote(rawVal)
    const singleton = clean.startsWith('*')
    const resPath = singleton ? clean.slice(1) : clean
    const relPath = resPathToRelPath(resPath) ?? resPath
    autoloads.push({ name, resPath, relPath, singleton })
  }

  const inputActions: GodotInputAction[] = []
  for (const [name, rawVal] of inputSection.entries()) {
    const { deadzone, bindings } = parseInputBindings(rawVal)
    inputActions.push({ name, deadzone, bindings })
  }

  const layerNames: GodotLayerName[] = []
  for (const [key, rawVal] of layerSection.entries()) {
    const match = key.match(/^(.+)\/layer_(\d+)$/)
    if (!match) continue
    layerNames.push({
      domain: match[1],
      index: Number.parseInt(match[2], 10),
      name: unquote(rawVal)
    })
  }
  layerNames.sort((a, b) => a.domain.localeCompare(b.domain) || a.index - b.index)

  const enabledPluginPaths = parseStringArray(pluginsSection.get('enabled') ?? '')

  return {
    name: unquote(app.get('config/name') ?? 'Untitled Godot Project'),
    description: unquote(app.get('config/description') ?? ''),
    mainSceneResPath: mainSceneResPath || null,
    features,
    godotVersionHint,
    renderer,
    icon: app.get('config/icon') ? unquote(app.get('config/icon')!) : null,
    viewportWidth: parseOptionalInt(display.get('window/size/viewport_width')),
    viewportHeight: parseOptionalInt(display.get('window/size/viewport_height')),
    physicsTicksPerSecond: parseOptionalInt(physics.get('common/physics_ticks_per_second')),
    autoloads,
    inputActions,
    layerNames,
    enabledPluginPaths
  }
}

/** Parses Godot's `export_presets.cfg`. */
export function parseExportPresets(text: string): GodotExportPreset[] {
  const sections = parseConfigSections(text)
  const presets: GodotExportPreset[] = []

  for (const [sectionName, entries] of sections.entries()) {
    const match = sectionName.match(/^preset\.(\d+)$/)
    if (!match) continue
    const index = Number.parseInt(match[1], 10)
    const name = unquote(entries.get('name') ?? `Preset ${index}`)
    const platform = unquote(entries.get('platform') ?? 'Unknown')
    const runnable = (entries.get('runnable') ?? 'false').trim() === 'true'
    const dedicatedServer = (entries.get('dedicated_server') ?? 'false').trim() === 'true'
    const exportPath = unquote(entries.get('export_path') ?? '')
    presets.push({ index, name, platform, runnable, dedicatedServer, exportPath })
  }

  presets.sort((a, b) => a.index - b.index)
  return presets
}

/** Parses root node type, attached script, and node count from a `.tscn` file. */
export function parseSceneHeader(text: string): ParsedSceneHeader {
  const extScripts = new Map<string, string>()
  const extRe = /\[ext_resource\s+([^\]]+)\]/g
  let m: RegExpExecArray | null
  while ((m = extRe.exec(text)) !== null) {
    const attrs = m[1]
    const typeMatch = attrs.match(/\btype="([^"]+)"/)
    if (typeMatch?.[1] !== 'Script') continue
    const pathMatch = attrs.match(/\bpath="([^"]+)"/)
    const idMatch = attrs.match(/\bid="([^"]+)"/) ?? attrs.match(/\bid=(\d+)/)
    if (pathMatch && idMatch) {
      extScripts.set(idMatch[1], pathMatch[1])
    }
  }

  let rootName: string | null = null
  let rootType: string | null = null
  let scriptResPath: string | null = null
  let nodeCount = 0

  const nodeRe = /\[node\s+([^\]]+)\]/g
  let firstNodeEnd = -1
  let secondNodeStart = text.length

  while ((m = nodeRe.exec(text)) !== null) {
    nodeCount++
    if (nodeCount === 1) {
      const attrs = m[1]
      rootName = attrs.match(/\bname="([^"]+)"/)?.[1] ?? null
      rootType = attrs.match(/\btype="([^"]+)"/)?.[1] ?? null
      firstNodeEnd = m.index + m[0].length
    } else if (nodeCount === 2) {
      secondNodeStart = m.index
    }
  }

  if (firstNodeEnd !== -1) {
    const rootBody = text.slice(firstNodeEnd, secondNodeStart)
    const scriptExt = rootBody.match(/^\s*script\s*=\s*ExtResource\(\s*"?([^")\s]+)"?\s*\)/m)
    if (scriptExt) {
      scriptResPath = extScripts.get(scriptExt[1]) ?? null
    }
  }

  return { rootName, rootType, scriptResPath, nodeCount }
}

/** Parses `class_name`, `extends`, and `@tool` from a GDScript or C# script. */
export function parseScriptHeader(text: string, isCSharp = false): ParsedScriptHeader {
  if (isCSharp) {
    const isTool = /\[Tool\]/.test(text)
    const classMatch = text.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([A-Za-z0-9_.]+))?/)
    return {
      className: classMatch?.[1] ?? null,
      extendsType: classMatch?.[2] ?? null,
      isTool
    }
  }

  const isTool = /^\s*(?:@tool|tool)\b/m.test(text)
  const classMatch = text.match(/^\s*class_name\s+([A-Za-z_][A-Za-z0-9_]*)/m)
  const extendsMatch = text.match(/^\s*extends\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_.]*)/m)
  return {
    className: classMatch?.[1] ?? null,
    extendsType: extendsMatch ? unquote(extendsMatch[1]) : null,
    isTool
  }
}

/** Parses `[gd_resource ...]` header from a `.tres` file. */
export function parseResourceHeader(text: string): ParsedResourceHeader {
  const header = text.match(/\[gd_resource\s+([^\]]+)\]/)
  if (!header) return { resourceType: null, scriptClass: null }
  const attrs = header[1]
  return {
    resourceType: attrs.match(/\btype="([^"]+)"/)?.[1] ?? null,
    scriptClass: attrs.match(/\bscript_class="([^"]+)"/)?.[1] ?? null
  }
}

/** Parses `addons/<name>/plugin.cfg`. */
export function parseAddonCfg(text: string): ParsedAddonCfg {
  const sections = parseConfigSections(text)
  const plugin = sections.get('plugin')
  if (!plugin) return { name: null, version: null }
  return {
    name: plugin.get('name') ? unquote(plugin.get('name')!) : null,
    version: plugin.get('version') ? unquote(plugin.get('version')!) : null
  }
}

/** Parses Godot CLI / runtime stdout+stderr lines into structured clickable diagnostics. */
export function parseGodotOutput(lines: readonly string[]): GodotDiagnostic[] {
  const diagnostics: GodotDiagnostic[] = []
  const seen = new Set<string>()
  const resLocRe = /(res:\/\/[^\s:)"']+):(\d+)/

  const pushUnique = (diag: GodotDiagnostic) => {
    const key = `${diag.severity}|${diag.resPath ?? ''}|${diag.line ?? ''}|${diag.message}`
    if (seen.has(key)) return
    seen.add(key)
    diagnostics.push(diag)
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (!raw) continue

    const isError =
      raw.startsWith('ERROR:') ||
      raw.startsWith('SCRIPT ERROR:') ||
      raw.startsWith('USER ERROR:') ||
      /\bParse Error:/i.test(raw) ||
      /\bCompile Error:/i.test(raw)
    const isWarning = raw.startsWith('WARNING:') || raw.startsWith('USER WARNING:')

    if (!isError && !isWarning) continue

    const severity: 'error' | 'warning' = isError ? 'error' : 'warning'
    let message = raw
      .replace(/^(?:SCRIPT ERROR|USER ERROR|ERROR|USER WARNING|WARNING):\s*/i, '')
      .trim()

    let resPath: string | null = null
    let line: number | null = null

    const inlineLoc = raw.match(resLocRe)
    if (inlineLoc) {
      resPath = inlineLoc[1]
      line = Number.parseInt(inlineLoc[2], 10)
    } else if (i + 1 < lines.length) {
      // Godot often prints the location on the immediately following `at: ... (res://foo.gd:42)` line
      const nextLine = lines[i + 1].trim()
      const nextLoc = nextLine.match(resLocRe)
      if (nextLoc) {
        resPath = nextLoc[1]
        line = Number.parseInt(nextLoc[2], 10)
      }
    }

    if (!message) message = raw
    pushUnique({
      severity,
      message,
      resPath,
      relPath: resPath ? resPathToRelPath(resPath) : null,
      line: line !== null && Number.isFinite(line) ? line : null,
      raw
    })

    if (diagnostics.length >= 200) break
  }

  return diagnostics
}

/** Extracts a concise Godot version like `4.7.2` from `4.7.2.stable.official.ed1daf0bf`. */
export function parseGodotShortVersion(versionOutput: string): string | null {
  const firstLine = versionOutput.trim().split(/\r?\n/)[0] ?? ''
  const match = firstLine.match(/^(\d+\.\d+(?:\.\d+)?)/)
  return match ? match[1] : null
}

/** Splits a user CLI argument string into tokens while respecting single/double quotes. */
export function splitCliArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current.length > 0) args.push(current)
  return args
}

/** Quotes a single shell argument safely for POSIX or Windows shells. */
export function quoteShellArg(arg: string, platform = 'linux'): string {
  if (arg.length === 0) return platform === 'win32' ? '""' : "''"
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(arg)) return arg
  if (platform === 'win32') {
    return `"${arg.replace(/"/g, '\\"')}"`
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** Builds a safely quoted shell command string from executable + args. */
export function buildShellCommand(
  executable: string,
  args: readonly string[],
  platform = 'linux'
): string {
  return [executable, ...args].map((part) => quoteShellArg(part, platform)).join(' ')
}
