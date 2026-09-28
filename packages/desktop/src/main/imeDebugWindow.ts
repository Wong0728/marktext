/**
 * Standalone IME diagnostic window (development only).
 *
 * Enabled with `MARKTEXT_IME_DEBUG=1 pnpm run dev`. It loads the debug page in
 * its own BrowserWindow so the trace runs in the exact Chromium/IME stack the
 * editor uses, without the editor window's layout, tabs or file state getting
 * in the way — and so the reproduction is a clean, repeatable procedure.
 */

import { BrowserWindow } from 'electron'
import log from 'electron-log'

export function openImeDebugWindow(): BrowserWindow | null {
  const baseUrl = process.env['ELECTRON_RENDERER_URL']
  if (!baseUrl) {
    log.error('[ime-debug] ELECTRON_RENDERER_URL is unset — start the app via `pnpm run dev`.')
    return null
  }

  const url = new URL('ime-debug.html', baseUrl)

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'MarkText · IME Debug',
    show: true,
    backgroundColor: '#14161a',
    webPreferences: {
      // Debug-only relaxation. The shipped windows keep `contextIsolation: true`
      // + `sandbox: true`; this page needs `require('fs')` so a capture can be
      // appended to a JSONL file and read after the window closes, which is not
      // worth widening the app's typed IPC contract for a throwaway tool.
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: true,
      webSecurity: false,
      spellcheck: false
    }
  })

  // No preload: the page talks to nothing but `fs`.
  win.loadURL(url.toString()).catch((err: unknown) => {
    log.error('[ime-debug] failed to load', err)
  })

  win.webContents.on('did-finish-load', () => {
    log.info(`[ime-debug] ready at ${url.toString()}`)
  })

  return win
}
