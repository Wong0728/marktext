import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { app, BrowserWindow } from 'electron'

// Upper bound for loading + rasterizing one print job. A wedged load (e.g. a
// hanging file:// image) must not leave the export deadlocked forever.
const PRINT_TIMEOUT_MS = 60_000

const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), PRINT_TIMEOUT_MS)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * Renders print-ready HTML in a dedicated hidden BrowserWindow and returns
 * the PDF bytes (#11).
 *
 * The visible editor window's DOM is no longer part of the PDF path: the
 * renderer hands over a fully self-contained document (exportStyledHTML
 * output) and everything — parsing, layout, sandboxed execution — happens in
 * this throwaway window, so a bad document can never disturb the editing
 * session.
 */
export const printToPdfOffscreen = async(
  html: string,
  options: Electron.PrintToPDFOptions
): Promise<Buffer> => {
  const tmpPath = path.join(app.getPath('temp'), `marktext-print-${crypto.randomUUID()}.html`)
  let win: BrowserWindow | null = null
  try {
    await fs.promises.writeFile(tmpPath, html, 'utf8')

    win = new BrowserWindow({
      show: false,
      // Offscreen and paint-only: no menu, no focus steal, closed right after
      // the raster. The document is plain HTML — no preload surface needed.
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false
      }
    })

    await withTimeout(win.loadFile(tmpPath), 'Loading print document')
    return await withTimeout(win.webContents.printToPDF(options), 'printToPDF')
  } finally {
    if (win) {
      win.destroy()
    }
    // Best effort: a lingering temp file in the OS temp dir is harmless.
    fs.promises.unlink(tmpPath).catch(() => {})
  }
}
