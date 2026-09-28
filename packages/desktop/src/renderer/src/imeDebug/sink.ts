/**
 * Trace sink: mirrors the in-memory timeline to a JSONL file so a capture
 * survives the window closing and can be analysed afterwards.
 *
 * The debug window is opened with `nodeIntegration: true` (dev-only — every
 * shipped window keeps `contextIsolation` + `sandbox` on), so the page reaches
 * `fs` directly instead of widening the app's typed IPC contract for a
 * throwaway diagnostic. When the page is opened in a plain browser instead,
 * `require` is absent and everything degrades to in-memory + download.
 */

import type { TraceRecord } from './recorder'

export interface TraceSink {
  readonly path: string | null
  reset(): void
  write(records: TraceRecord[]): void
  flush(): Promise<void>
}

/**
 * The page runs with `nodeIntegration: true` in the debug window, so Node's own
 * modules are reached directly instead of through the app's IPC bridge. Only
 * the four calls below are used, so they are declared here rather than pulling
 * `@types/node` semantics into a renderer-side file.
 */
interface NodeRequire {
  (id: string): unknown
}

interface NodeFs {
  writeFileSync(file: string, data: string, encoding: string): void
  promises: { appendFile(file: string, data: string, encoding: string): Promise<void> }
}

interface NodePathModule {
  join(...parts: string[]): string
}

interface NodeOs {
  tmpdir(): string
}

interface NodeElectron {
  app: { getPath(name: string): string }
}

function nodeRequire(): NodeRequire | null {
  const req = (globalThis as { require?: unknown }).require
  return typeof req === 'function' ? (req as NodeRequire) : null
}

function createFileSink(req: NodeRequire): TraceSink | null {
  let fs: NodeFs
  let nodePath: NodePathModule
  try {
    fs = req('fs') as NodeFs
    nodePath = req('path') as NodePathModule
  } catch {
    return null
  }

  let dir: string
  try {
    // userData keeps the trace next to the app's other state; tmpdir is the
    // fallback when the page runs outside a packaged/registered app path.
    dir = (req('electron') as NodeElectron).app.getPath('userData')
  } catch {
    try {
      dir = (req('os') as NodeOs).tmpdir()
    } catch {
      return null
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = `${nodePath.join(dir, 'ime-debug')}-${stamp}.jsonl`

  let pending: string[] = []
  let flushing: Promise<void> = Promise.resolve()

  const enqueue = (records: TraceRecord[]): void => {
    for (const record of records) {
      pending.push(JSON.stringify(record))
    }
  }

  const drain = (): void => {
    if (pending.length === 0) { return }
    const batch = pending
    pending = []
    flushing = flushing
      .then(() => fs.promises.appendFile(file, `${batch.join('\n')}\n`, 'utf8'))
      .catch(() => {
        // A trace that cannot be written must not break the page — the
        // on-screen timeline stays authoritative.
      })
  }

  try {
    fs.writeFileSync(file, '', 'utf8')
  } catch {
    return null
  }

  return {
    path: file,
    reset() {
      pending = []
      try {
        fs.writeFileSync(file, '', 'utf8')
      } catch {
        // ignored — see above
      }
    },
    write(records) {
      enqueue(records)
      drain()
    },
    async flush() {
      drain()
      await flushing
    }
  }
}

export function createTraceSink(): TraceSink {
  const req = nodeRequire()
  if (req) {
    const sink = createFileSink(req)
    if (sink) { return sink }
  }

  return { path: null, reset() {}, write() {}, async flush() {} }
}

export function downloadTrace(records: TraceRecord[], filename: string): void {
  const blob = new Blob([records.map(r => JSON.stringify(r)).join('\n')], { type: 'application/x-ndjson' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function copyTrace(records: TraceRecord[]): Promise<boolean> {
  const text = records.map(r => JSON.stringify(r)).join('\n')
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
