// The panel <-> worker contract, declared once so src/panel.tsx and src/worker.ts stay typed end to end.
import type {
  GodotActionResult,
  GodotHeadlessCheckResult,
  GodotLogsResult,
  GodotSnapshot,
  GodotStatusBanner
} from './types'

export {}

declare module 'orca' {
  interface PluginRequests {
    /** Reads the current workspace, Godot project metadata, binary status, and active session. */
    'godot.snapshot': { input: { forceRefresh?: boolean }; output: GodotSnapshot }
    /** Switches which project.godot is active in a multi-project workspace. */
    'godot.selectProject': { input: { projectRelPath: string }; output: GodotSnapshot }
    /** Runs the main scene or a specific res:// scene in an Orca terminal. */
    'godot.run': { input: { sceneResPath?: string; headless?: boolean }; output: GodotActionResult }
    /** Opens the project or a specific scene in the Godot Editor. */
    'godot.openEditor': { input: { sceneResPath?: string }; output: GodotActionResult }
    /** Stops the currently tracked Godot terminal session. */
    'godot.stopRun': { output: GodotActionResult }
    /** Focuses the currently tracked Godot terminal pane in Orca. */
    'godot.focusTerminal': { output: GodotActionResult }
    /** Reads recent output lines and parsed diagnostics from the active Godot terminal. */
    'godot.readLogs': { input: { maxLines?: number }; output: GodotLogsResult }
    /** Runs Godot in headless mode (--headless --quit) and returns structured diagnostics. */
    'godot.checkHeadless': { output: GodotHeadlessCheckResult }
    /** Starts a Godot export build for a preset from export_presets.cfg. */
    'godot.exportPreset': {
      input: { presetName: string; mode: 'debug' | 'release' }
      output: GodotActionResult
    }
    /** Opens a workspace-relative file inside an Orca editor tab. */
    'godot.openFile': { input: { relPath: string }; output: GodotActionResult }
    /** Pins or unpins a scene for quick access in the Overview and Scenes tabs. */
    'godot.togglePinScene': { input: { resPath: string }; output: { pinnedScenes: string[] } }
    /** Runs detected Godot test suite (GUT or gdUnit4) in an Orca terminal. */
    'godot.runTests': { output: GodotActionResult }
  }

  interface PluginPanelEvents {
    /** Pushed whenever the workspace changes or a worker command updates project state. */
    'godot.updated': GodotSnapshot
    /** Pushed for transient command / check / run status feedback. */
    'godot.status': GodotStatusBanner
  }
}
