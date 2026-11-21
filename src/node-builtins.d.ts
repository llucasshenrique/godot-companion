// Minimal ambient declarations for Node.js built-ins used by the trusted worker.
// Keeps `tsc -p .` strict with zero npm dependencies.

declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined
  }
  interface Process {
    readonly platform: string
    readonly env: ProcessEnv
  }
}

declare const process: NodeJS.Process

declare module 'node:fs/promises' {
  export interface Dirent {
    readonly name: string
    isDirectory(): boolean
    isFile(): boolean
    isSymbolicLink(): boolean
  }
  export interface FileHandle {
    read(
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null
    ): Promise<{ bytesRead: number }>
    close(): Promise<void>
  }
  export function access(path: string, mode?: number): Promise<void>
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
  export function open(path: string, flags: string): Promise<FileHandle>
  export function readdir(
    path: string,
    options: { withFileTypes: true }
  ): Promise<Dirent[]>
  export function readdir(path: string): Promise<string[]>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; mtimeMs: number; size: number }>
  export function writeFile(path: string, data: string, encoding?: 'utf8'): Promise<void>
  export function mkdtemp(prefix: string): Promise<string>
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
}

declare module 'node:fs' {
  export const constants: {
    readonly F_OK: number
    readonly R_OK: number
    readonly X_OK: number
  }
}

declare module 'node:path' {
  export const sep: string
  export function basename(p: string, suffix?: string): string
  export function dirname(p: string): string
  export function extname(p: string): string
  export function isAbsolute(p: string): boolean
  export function join(...paths: string[]): string
  export function normalize(p: string): string
  export function relative(from: string, to: string): string
  export function resolve(...paths: string[]): string
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}

declare module 'node:child_process' {
  export interface ExecFileOptions {
    cwd?: string
    timeout?: number
    maxBuffer?: number
    windowsHide?: boolean
    env?: NodeJS.ProcessEnv
  }
  export interface ExecFileException extends Error {
    code?: number | string | null
    killed?: boolean
    signal?: string | null
  }
  export function execFile(
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (error: ExecFileException | null, stdout: string, stderr: string) => void
  ): void
  export interface SpawnOptions {
    cwd?: string
    detached?: boolean
    stdio?: 'ignore' | 'pipe'
    windowsHide?: boolean
    env?: NodeJS.ProcessEnv
  }
  export interface ChildProcess {
    readonly pid?: number
    unref(): void
    on(event: string, listener: (...args: unknown[]) => void): this
  }
  export function spawn(
    command: string,
    args: readonly string[],
    options?: SpawnOptions
  ): ChildProcess
}

declare module 'node:net' {
  export interface Socket {
    setTimeout(timeout: number): this
    on(event: string, listener: (...args: unknown[]) => void): this
    destroy(): this
  }
  export function createConnection(options: { host: string; port: number }): Socket
}
