import { fileURLToPath } from 'url'
import { ipcMain, shell, clipboard, ClipboardItem } from 'electron'
import log from 'electron-log'
import { isDangerousExecutableFile } from 'common/filesystem/paths'

// Protocols the renderer is allowed to hand to the OS via `openExternal`.
// Everything else (notably `file:`, and custom schemes) is refused here so a
// compromised renderer can't bypass the link-click validation in
// `mt::format-link-click` to launch local files or arbitrary handlers.
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

const isAllowedExternalUrl = (url: unknown): url is string => {
  if (typeof url !== 'string' || !url) return false
  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}

export const registerShellHandlers = (): void => {
  ipcMain.handle('mt::shell::open-external', async(_e, url: string) => {
    if (!isAllowedExternalUrl(url)) {
      log.warn('shell.openExternal blocked for disallowed URL:', url)
      return false
    }
    try {
      await shell.openExternal(url)
      return true
    } catch (err) {
      log.error('shell.openExternal failed:', err)
      return false
    }
  })
  ipcMain.on('mt::shell::open-external', (_e, url: string) => {
    if (!isAllowedExternalUrl(url)) {
      log.warn('shell.openExternal blocked for disallowed URL:', url)
      return
    }
    shell.openExternal(url).catch((err) => log.error('shell.openExternal failed:', err))
  })
  ipcMain.on('mt::shell::show-item', (_e, fullPath: string) => {
    try {
      shell.showItemInFolder(fullPath)
    } catch (err) {
      log.error('shell.showItemInFolder failed:', err)
    }
  })
  ipcMain.handle('mt::shell::open-path', async(_e, fullPath: string) => {
    // Defense in depth: never let a renderer open an executable/script through
    // the shell without going through the confirmed link-click path.
    if (typeof fullPath !== 'string' || !fullPath) {
      return 'Invalid path'
    }
    if (isDangerousExecutableFile(fullPath)) {
      log.warn('shell.openPath blocked for executable path:', fullPath)
      return 'Refused to open an executable file'
    }
    try {
      return await shell.openPath(fullPath)
    } catch (err) {
      log.error('shell.openPath failed:', err)
      return String(err instanceof Error ? err.message : err)
    }
  })

  ipcMain.on('mt::clipboard::write-text', (_e, text: string) => {
    try {
      clipboard.writeText(text)
    } catch (err) {
      log.error('clipboard.writeText failed:', err)
    }
  })
  // "Copy as Rich Text" payload: markdown source + rendered HTML + RTF with
  // OMML equation groups. `clipboard.write` replaces the whole clipboard, so
  // the three slots land atomically from one IPC message.
  ipcMain.on(
    'mt::clipboard::write-rich',
    (_e, payload: { text: string; html: string; rtf: string }) => {
      try {
        const data: Record<string, string> = {
          'text/plain': payload.text,
          'text/html': payload.html
        }
        if (payload.rtf) {
          // Chromium maps `application/rtf` to the native CF_RTF format on
          // Windows; desktop Word converts RTF OMML groups into equations.
          data['application/rtf'] = payload.rtf
        }
        void clipboard.write([new ClipboardItem(data)])
      } catch (err) {
        log.error('clipboard.write(rich) failed:', err)
      }
    }
  )
  ipcMain.handle('mt::clipboard::read-text', async() => {
    try {
      // Electron 44 made the main-process clipboard async (W3C-style).
      return await clipboard.readText()
    } catch {
      return ''
    }
  })

  // Electron 44 removed the synchronous format-string clipboard reads
  // (`clipboard.read('FileNameW')` / `'NSFilenamesPboardType'`); the async
  // W3C-style API exposes copied files (when the platform does at all) as a
  // `text/uri-list` entry. Best-effort: resolve the first file:// URI, or
  // return '' when none is available.
  ipcMain.handle('mt::clipboard::guess-file-path', async() => {
    try {
      const items = await clipboard.read()
      for (const item of items) {
        if (!item.types.includes('text/uri-list')) continue
        const blob = (await item.getType('text/uri-list')) as Blob
        const text = await blob.text()
        const fileUri = text
          .split(/\r?\n/)
          .map(line => line.trim())
          .find(line => line.startsWith('file://'))
        if (fileUri) {
          return fileURLToPath(fileUri)
        }
      }
      return ''
    } catch (err) {
      log.error('clipboard.guess-file-path failed:', err)
      return ''
    }
  })
}
