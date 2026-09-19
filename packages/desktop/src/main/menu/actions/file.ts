import { rename as fsRename } from 'fs-extra'
import { createReadStream } from 'fs'
import path from 'path'
import type { Readable } from 'stream'
import {
  BrowserWindow,
  app,
  dialog,
  shell,
  ipcMain,
  type IpcMainEvent,
  type MenuItem
} from 'electron'
import log from 'electron-log'
import JSZip from 'jszip'
import { isDirectory, isFile, exists } from 'common/filesystem'
import { MARKDOWN_EXTENSIONS, isDangerousExecutableFile, isMarkdownFile } from 'common/filesystem/paths'
import { checkUpdates, userSetting } from './marktext'
import { showTabBar } from './view'
import { COMMANDS } from '../../commands'
import type { CommandManager } from '../../commands'
import { EXTENSION_HASN, PANDOC_EXTENSIONS, URL_REG } from '../../config'
import { normalizeAndResolvePath, writeFile } from '../../filesystem'
import { writeMarkdownFile } from '../../filesystem/markdown'
import { getPath, getRecommendTitleFromMarkdownString } from '../../utils'
import pandoc from '../../utils/pandoc'
import { centerImageParagraphsFile, jsDocxEngine } from '../../utils/htmlToDocx'
import { printToPdfOffscreen } from '../../utils/offscreenPrint'
import { prepareReferenceDoc, type DocxFontSettings } from '../../utils/docxReference'
import { t } from '../../i18n'
import type { UnsavedFile } from '@shared/types/files'

type Win = BrowserWindow | null | undefined

interface PageOptions {
  pageSize?: string
  pageSizeWidth?: number
  pageSizeHeight?: number
  isLandscape?: boolean
}

// TODO(refactor): "save" and "save as" should be moved to the editor window (editor.js) and
// the renderer should communicate only with the editor window for file relevant stuff.
// E.g. "mt::save-tabs" --> "mt::window-save-tabs$wid:<windowId>"

const getExportExtensionFilter = (type: string): Electron.FileFilter[] | undefined => {
  if (type === 'pdf') {
    return [
      {
        name: 'Portable Document Format',
        extensions: ['pdf']
      }
    ]
  } else if (type === 'styledHtml') {
    return [
      {
        name: 'Hypertext Markup Language',
        extensions: ['html']
      }
    ]
  } else if (type === 'docx') {
    return [
      {
        name: 'Microsoft Word Document',
        extensions: ['docx']
      }
    ]
  }

  // Allow all extensions.
  return undefined
}

const getPdfPageOptions = (options?: PageOptions): Record<string, unknown> => {
  if (!options) {
    return {}
  }

  const { pageSize, pageSizeWidth, pageSizeHeight, isLandscape } = options
  if (pageSize === 'custom' && pageSizeWidth && pageSizeHeight) {
    return {
      // Note: mm to microns
      pageSize: { height: pageSizeHeight * 1000, width: pageSizeWidth * 1000 },
      landscape: !!isLandscape
    }
  } else {
    return { pageSize, landscape: !!isLandscape }
  }
}

interface ExportPayload {
  type: string
  content?: string
  pathname?: string
  title?: string
  pageOptions?: PageOptions
  /** Which DOCX engine to use: 'auto' picks pandoc if installed, else JS. */
  docxEngine?: 'auto' | 'pandoc' | 'js'
  /** User's DOCX font settings (latin / east-asian font, body size). */
  docxFont?: DocxFontSettings
  /** Math blocks extracted by prepareHtmlForJsDocx, for OMML post-injection. */
  mathBlocks?: Array<{ index: number; mathml: string; display: boolean }>
  /** Local image bytes for ZIP export, packed next to the HTML. */
  zipImages?: Array<{ zipName: string; data: Uint8Array }>
}

/**
 * Resolve the user's engine preference to a concrete engine. 'auto' prefers
 * pandoc (so LaTeX formulas become native OMML equations) and falls back to
 * the bundled JS engine when pandoc is not installed — this keeps DOCX export
 * working out-of-the-box for users who have not installed pandoc.
 */
const resolveDocxEngine = (preferred?: 'auto' | 'pandoc' | 'js'): 'pandoc' | 'js' => {
  if (preferred === 'pandoc') return 'pandoc'
  if (preferred === 'js') return 'js'
  return pandoc.exists() ? 'pandoc' : 'js'
}

// Handle the export response from renderer process.
const handleResponseForExport = async(e: IpcMainEvent, payload: ExportPayload): Promise<void> => {
  const { type, content, pathname, title, pageOptions } = payload
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) {
    return
  }
  const isZipExport = type === 'styledHtml' && !!payload.zipImages
  const extension = isZipExport ? '.zip' : (EXTENSION_HASN as Record<string, string>)[type]
  const dirname = pathname ? path.dirname(pathname) : getPath('documents')
  let nakedFilename = pathname ? path.basename(pathname, '.md') : title
  if (!nakedFilename) {
    nakedFilename = 'Untitled'
  }

  const defaultPath = path.join(dirname, `${nakedFilename}${extension}`)
  const { filePath, canceled } = await dialog.showSaveDialog(win, {
    defaultPath,
    filters: isZipExport
      ? [{ name: 'Zip Archive', extensions: ['zip'] }]
      : getExportExtensionFilter(type)
  })

  if (filePath && !canceled) {
    try {
      if (type === 'pdf') {
        // The renderer hands over a fully print-ready document; it is
        // rasterized in a dedicated hidden window (#11) so the visible
        // editor window's DOM is never part of the PDF path.
        if (!content) {
          throw new Error('No HTML content found for PDF export.')
        }
        // Build a clickable bookmark/outline tree from the document's h1-h6
        // headings so exported PDFs have a navigation pane (#2989). The outline
        // is derived from the tagged-PDF structure tree, so generateTaggedPDF is
        // required — generateDocumentOutline alone produces no outline.
        const options: Electron.PrintToPDFOptions = {
          printBackground: true,
          generateTaggedPDF: true,
          generateDocumentOutline: true
        }
        Object.assign(options, getPdfPageOptions(pageOptions))
        const data = await printToPdfOffscreen(content, options)
        await writeFile(filePath, data, extension!, 'binary')
      } else if (type === 'docx') {
        // Export to DOCX. The renderer sends styled HTML produced by
        // exportStyledHTML (with engine-specific preprocessing already applied:
        // pandoc gets MathML-only HTML, the JS engine gets visual-span HTML).
        // Dispatch to the user's chosen engine; 'auto' prefers pandoc (for
        // native OMML equations) and falls back to the JS engine when pandoc
        // is not installed.
        if (!content) {
          throw new Error('No HTML content found for DOCX export.')
        }
        const engine = resolveDocxEngine(payload.docxEngine)
        if (engine === 'pandoc') {
          if (!pandoc.exists()) {
            noticeDocxPandocNotFound(win)
            return
          }
          // `--resource-path` tells pandoc where to look for local images when
          // the input comes from stdin. Fall back to the documents directory
          // when the file has not been saved yet.
          const resourcePath = pathname ? path.dirname(pathname) : getPath('documents')
          // A custom reference document gives tables visible borders and adds a
          // subtle background to inline / block code (VerbatimChar). Pandoc's
          // default reference.docx has no table borders and no code shading.
          // The user's DOCX font settings are baked into a patched copy of it.
          const referenceDoc = await prepareReferenceDoc(payload.docxFont)
          const pandocArgs = ['--wrap=none', `--resource-path=${resourcePath}`]
          if (isFile(referenceDoc)) {
            pandocArgs.push(`--reference-doc=${referenceDoc}`)
          }
          const converter = pandoc('html', 'docx', ...pandocArgs)
          await converter.toFile(content, filePath)
          // pandoc leaves image paragraphs left-aligned; center them in place.
          await centerImageParagraphsFile(filePath)
        } else {
          // JS engine: no external binary, better tables / task lists. Math
          // formulas are post-processed into native OMML via mathml2omml.
          await jsDocxEngine.convert(content, filePath, {
            resourcePath: pathname ? path.dirname(pathname) : getPath('documents'),
            title: title || '',
            mathBlocks: payload.mathBlocks,
            docxFont: payload.docxFont
          })
        }
      } else {
        if (!content) {
          throw new Error('No HTML content found.')
        }
        if (isZipExport) {
          // Portable archive: the HTML (with images rewritten to relative
          // `images/…` paths by the renderer) plus the referenced local files.
          // Empty image lists still produce a valid zip with just the HTML.
          const archive = new JSZip()
          archive.file(`${nakedFilename}.html`, content)
          if (payload.zipImages!.length > 0) {
            const imageDir = archive.folder('images')!
            for (const image of payload.zipImages!) {
              imageDir.file(image.zipName, Buffer.from(image.data))
            }
          }
          const data = await archive.generateAsync({
            type: 'nodebuffer',
            compression: 'DEFLATE'
          })
          await writeFile(filePath, data, '.zip', 'binary')
        } else {
          await writeFile(filePath, content, extension!, 'utf8')
        }
      }
      win.webContents.send('mt::export-success', { type, filePath })
    } catch (err) {
      log.error('Error while exporting:', err)
      const ERROR_MSG =
        (err instanceof Error && err.message) || `Error happened when export ${filePath}`
      win.webContents.send('mt::show-notification', {
        title: 'Export failure',
        type: 'error',
        message: ERROR_MSG
      })
    }
  } else {
    // User canceled save dialog. PDF no longer touches the editor window's
    // DOM (#11), so nothing to clean up here.
  }
}

const handleResponseForPrint = async(e: IpcMainEvent): Promise<void> => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) {
    return
  }
  win.webContents.print({ printBackground: true }, () => {
    removePrintServiceFromWindow(win)
  })
}

const handleResponseForSave = async(
  e: IpcMainEvent,
  id: string,
  filename: string,
  pathname: string | undefined,
  markdown: string,
  options: UnsavedFile['options'],
  defaultPath?: string
): Promise<string | void> => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) {
    return Promise.resolve()
  }
  let recommendFilename = getRecommendTitleFromMarkdownString(markdown)
  if (!recommendFilename) {
    recommendFilename = filename || 'Untitled'
  }

  // If the file doesn't exist on disk add it to the recently used documents later
  // and execute file from filesystem watcher for a short time. The file may exists
  // on disk nevertheless but is already tracked by MarkText.
  const alreadyExistOnDisk = !!pathname

  let filePath = pathname

  if (!filePath) {
    const { filePath: dialogPath, canceled } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(defaultPath || getPath('documents'), `${recommendFilename}.md`)
    })

    if (dialogPath && !canceled) {
      filePath = dialogPath
    }
  }

  // Save dialog canceled by user - no error.
  if (!filePath) {
    return Promise.resolve()
  }

  filePath = path.resolve(filePath)
  const extension = path.extname(filePath) || '.md'
  filePath = !filePath.endsWith(extension) ? (filePath += extension) : filePath
  // The original JS passed `win` here; writeMarkdownFile only takes 3 args
  // (the 4th was silently ignored). Drop it explicitly under strict mode.
  // The IPC `SaveOptions` has every field optional, but writeMarkdownFile
  // requires the strict `MarkdownDocumentOptions` shape — the renderer always
  // populates every field for the unsaved-file dialog payload, so the cast
  // is safe at this seam.
  return writeMarkdownFile(filePath, markdown, options as Parameters<typeof writeMarkdownFile>[2])
    .then(() => {
      if (win.isDestroyed()) return id
      if (!alreadyExistOnDisk) {
        ipcMain.emit('window-add-file-path', win.id, filePath)
        ipcMain.emit('menu-add-recently-used', filePath)

        const newFilename = path.basename(filePath!)
        win.webContents.send('mt::set-pathname', { id, pathname: filePath, filename: newFilename })
      } else {
        ipcMain.emit('window-file-saved', win.id, filePath)
        win.webContents.send('mt::tab-saved', id)
      }
      return id
    })
    .catch((err: unknown) => {
      log.error('Error while saving:', err)
      if (win.isDestroyed()) return
      const msg = err instanceof Error ? err.message : String(err)
      win.webContents.send('mt::tab-save-failure', id, msg)
    })
}

const showUnsavedFilesMessage = async(
  win: BrowserWindow,
  files: UnsavedFile[]
): Promise<{ needSave: boolean } | null> => {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: [t('dialog.save'), t('dialog.dontSave'), t('dialog.cancel')],
    defaultId: 0,
    message: t('dialog.saveChanges', {
      count: files.length,
      type: files.length === 1 ? t('dialog.file') : t('dialog.files'),
      files: files.map((f) => f.filename).join('\n')
    }),
    detail: t('dialog.changesWillBeLost'),
    cancelId: 2,
    noLink: true
  })

  switch (response) {
    case 0:
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({ needSave: true })
        })
      })
    case 1:
      return { needSave: false }
    default:
      return null
  }
}

const noticePandocNotFound = (win: BrowserWindow): void => {
  win.webContents.send('mt::pandoc-not-exists', {
    title: t('dialog.importWarning'),
    type: 'warning',
    message: t('dialog.installPandoc'),
    time: 10000
  })
}

// DOCX-export-only pandoc-missing notice. Points the user at the JS engine
// fallback so they are not blocked when pandoc is not installed.
const noticeDocxPandocNotFound = (win: BrowserWindow): void => {
  win.webContents.send('mt::pandoc-not-exists', {
    title: t('dialog.importWarning'),
    type: 'warning',
    message: t('dialog.installPandocOrSwitchEngine'),
    time: 10000
  })
}

// Map common file extensions to pandoc reader names. Most match one-to-one,
// but LaTeX and reStructuredText have several conventional extensions.
const getPandocInputFormat = (ext: string): string => {
  switch (ext) {
    case 'tex':
    case 'ltx':
      return 'latex'
    case 'rest':
      return 'rst'
    case 'wiki':
      return 'mediawiki'
    default:
      return ext
  }
}

const streamToString = (stream: Readable | null): Promise<string> =>
  new Promise((resolve, reject) => {
    if (!stream) {
      resolve('')
      return
    }
    let data = ''
    stream.on('data', (chunk: Buffer | string) => {
      data += chunk.toString()
    })
    stream.on('end', () => resolve(data))
    stream.on('error', reject)
  })

const openPandocFile = async(windowId: number, pathname: string): Promise<void> => {
  try {
    const ext = path.extname(pathname).toLowerCase().slice(1)
    const format = getPandocInputFormat(ext)
    const converter = pandoc(format, 'markdown')
    const data = await streamToString(converter.stream(createReadStream(pathname)))
    ipcMain.emit('app-open-markdown-by-id', windowId, data)
  } catch (err) {
    log.error('Error while converting file:', err)
  }
}

const removePrintServiceFromWindow = (win: BrowserWindow): void => {
  // remove print service content and restore GUI
  win.webContents.send('mt::print-service-clearup')
}

// --- events -----------------------------------

ipcMain.on('mt::save-tabs', (e, unsavedFiles: UnsavedFile[]) => {
  Promise.all(
    unsavedFiles.map((file) =>
      handleResponseForSave(
        e,
        file.id,
        file.filename,
        file.pathname,
        file.markdown,
        file.options,
        file.defaultPath
      )
    )
  ).catch(log.error)
})

ipcMain.on('mt::save-and-close-tabs', async(e, unsavedFiles: UnsavedFile[]) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) {
    return
  }
  const userResult = await showUnsavedFilesMessage(win, unsavedFiles)
  if (!userResult) {
    return
  }

  const { needSave } = userResult
  if (needSave) {
    Promise.all(
      unsavedFiles.map((file) =>
        handleResponseForSave(
          e,
          file.id,
          file.filename,
          file.pathname,
          file.markdown,
          file.options,
          file.defaultPath
        )
      )
    )
      .then((arr) => {
        const tabIds = arr.filter((id): id is string => id != null)
        win.webContents.send('mt::force-close-tabs-by-id', tabIds)
      })
      .catch((err: unknown) => {
        log.error('Error while save all:', err)
      })
  } else {
    const tabIds = unsavedFiles.map((f) => f.id)
    win.webContents.send('mt::force-close-tabs-by-id', tabIds)
  }
})

ipcMain.on(
  'mt::response-file-save-as',
  async(
    e: IpcMainEvent,
    id: string,
    filename: string,
    pathname: string | undefined,
    markdown: string,
    options: UnsavedFile['options'],
    defaultPath?: string
  ) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) {
      return
    }
    let recommendFilename = getRecommendTitleFromMarkdownString(markdown)
    if (!recommendFilename) {
      recommendFilename = filename || 'Untitled'
    }

    // If the file doesn't exist on disk add it to the recently used documents later
    // and execute file from filesystem watcher for a short time. The file may exists
    // on disk nevertheless but is already tracked by MarkText.
    const alreadyExistOnDisk = !!pathname

    let { filePath, canceled } = await dialog.showSaveDialog(win, {
      defaultPath:
        pathname || path.join(defaultPath || getPath('documents'), `${recommendFilename}.md`)
    })

    if (filePath && !canceled) {
      filePath = path.resolve(filePath)
      writeMarkdownFile(filePath, markdown, options as Parameters<typeof writeMarkdownFile>[2])
        .then(() => {
          if (!alreadyExistOnDisk) {
            ipcMain.emit('window-add-file-path', win.id, filePath)
            ipcMain.emit('menu-add-recently-used', filePath)

            const newFilename = path.basename(filePath!)
            win.webContents.send('mt::set-pathname', {
              id,
              pathname: filePath,
              filename: newFilename
            })
          } else if (pathname !== filePath) {
            // Update window file list and watcher.
            ipcMain.emit('window-change-file-path', win.id, filePath, pathname)

            const newFilename = path.basename(filePath!)
            win.webContents.send('mt::set-pathname', {
              id,
              pathname: filePath,
              filename: newFilename
            })
          } else {
            ipcMain.emit('window-file-saved', win.id, filePath)
            win.webContents.send('mt::tab-saved', id)
          }
        })
        .catch((err: unknown) => {
          log.error('Error while save as:', err)
          const msg = err instanceof Error ? err.message : String(err)
          win.webContents.send('mt::tab-save-failure', id, msg)
        })
    }
  }
)

// Window ids whose unsaved-changes confirm dialog is currently open. Guards
// against stacking dialogs when a close is requested repeatedly (M6).
const windowsAwaitingCloseConfirm = new Set<number>()

ipcMain.on('mt::close-window-confirm', async(e, unsavedFiles: UnsavedFile[]) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) {
    return
  }

  // Collapse repeated close requests: while this window's confirm dialog is
  // open, ignore further requests so a second X-click (or a quit) can't stack
  // another dialog or overturn the user's first choice.
  if (windowsAwaitingCloseConfirm.has(win.id)) {
    return
  }
  windowsAwaitingCloseConfirm.add(win.id)

  try {
    const userResult = await showUnsavedFilesMessage(win, unsavedFiles)
    if (!userResult) {
      return
    }

    const { needSave } = userResult
    if (!needSave) {
      ipcMain.emit('window-close-by-id', win.id)
      return
    }

    const results = await Promise.all(
      unsavedFiles.map((file) =>
        handleResponseForSave(
          e,
          file.id,
          file.filename,
          file.pathname,
          file.markdown,
          file.options,
          file.defaultPath
        )
      )
    )

    // handleResponseForSave resolves the tab id only when the file was actually
    // written; a canceled Save As dialog (or a save failure) resolves to
    // undefined. Close the window only when every unsaved file was saved —
    // otherwise the user would silently lose the content they declined to save.
    const savedCount = results.filter((id): id is string => id != null).length
    if (win.isDestroyed()) {
      return
    }
    if (savedCount === unsavedFiles.length) {
      ipcMain.emit('window-close-by-id', win.id)
    }
  } catch (err: unknown) {
    log.error('Error while saving before quit:', err)
  } finally {
    windowsAwaitingCloseConfirm.delete(win.id)
  }
})

ipcMain.on('mt::response-file-save', handleResponseForSave as Parameters<typeof ipcMain.on>[1])

ipcMain.on('mt::response-export', handleResponseForExport as Parameters<typeof ipcMain.on>[1])

ipcMain.on('mt::response-print', handleResponseForPrint as Parameters<typeof ipcMain.on>[1])

ipcMain.on('mt::window::drop', async(e, fileList: string[]) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) {
    return
  }
  for (const file of fileList) {
    if (isMarkdownFile(file)) {
      openFileOrFolder(win, file)
      continue
    }

    // Try to import the file
    if (PANDOC_EXTENSIONS.some((ext: string) => file.endsWith(ext))) {
      const existsPandoc = pandoc.exists()
      if (!existsPandoc) {
        noticePandocNotFound(win)
      } else {
        openPandocFile(win.id, file)
      }
      break
    }
  }
})

interface RenamePayload {
  id: string
  pathname: string
  newPathname: string
}

ipcMain.on('mt::rename', async(e, { id, pathname, newPathname }: RenamePayload) => {
  if (pathname === newPathname) return
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) {
    return
  }

  const doRename = (): void => {
    fsRename(pathname, newPathname, (err: NodeJS.ErrnoException | null) => {
      if (err) {
        log.error(`mt::rename: Cannot rename "${pathname}" to "${newPathname}".\n${err.stack}`)
        return
      }

      ipcMain.emit('window-change-file-path', win.id, newPathname, pathname)
      e.sender.send('mt::set-pathname', {
        id,
        pathname: newPathname,
        filename: path.basename(newPathname)
      })
    })
  }

  if (!(await exists(newPathname))) {
    doRename()
  } else {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [t('dialog.replace'), t('dialog.cancel')],
      defaultId: 1,
      message: t('dialog.fileExists', { filename: path.basename(newPathname) }),
      cancelId: 1,
      noLink: true
    })

    if (response === 0) {
      doRename()
    }
  }
})

ipcMain.on(
  'mt::response-file-move-to',
  async(e, { id, pathname }: { id: string; pathname: string }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) {
      return
    }
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      buttonLabel: 'Move to',
      nameFieldLabel: 'Filename:',
      defaultPath: pathname
    })

    if (filePath && !canceled) {
      fsRename(pathname, filePath, (err: NodeJS.ErrnoException | null) => {
        if (err) {
          log.error(`mt::rename: Cannot rename "${pathname}" to "${filePath}".\n${err.stack}`)
          return
        }

        ipcMain.emit('window-change-file-path', win.id, filePath, pathname)
        e.sender.send('mt::set-pathname', {
          id,
          pathname: filePath,
          filename: path.basename(filePath)
        })
      })
    }
  }
)

ipcMain.on('mt::ask-for-open-project-in-sidebar', async(e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) {
    return
  }
  const { filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory']
  })

  if (filePaths && filePaths[0]) {
    const resolvedPath = normalizeAndResolvePath(filePaths[0])
    ipcMain.emit('app-open-directory-by-id', win.id, resolvedPath, true)
  }
})

interface FormatLinkPayload {
  data: { href?: string; text?: string }
  dirname?: string
}

ipcMain.on('mt::format-link-click', async(e, { data, dirname }: FormatLinkPayload) => {
  if (!data || (!data.href && !data.text)) {
    return
  }
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) {
    return
  }

  const rawUrl = data.href || data.text!
  const urlCandidate = rawUrl.replace(/^<(.+)>$/, '$1') // Replace any <> CommonMark #489
  if (urlCandidate === rawUrl) {
    // No <> found, no spaces should be allowed
    if (/\s/.test(rawUrl)) {
      win.webContents.send('mt::show-notification', {
        title: 'Links cannot contain spaces',
        type: 'error',
        message:
          'Either URI encode: <code>My%20Link.md</code> <br> or wrap it in brackets: <br> <code><./My Link.md></code>. <br> See CommonMark #488 for details.'
      })
      return
    }
  }

  if (URL_REG.test(urlCandidate)) {
    shell.openExternal(urlCandidate).catch((err: Error) => log.error('Failed to open URL:', err))
    return
  } else if (/^[a-z0-9]+:\/\//i.test(urlCandidate)) {
    // Prevent other URLs.
    return
  }

  let pathname = urlCandidate
  if (dirname && !path.isAbsolute(urlCandidate)) {
    pathname = path.join(dirname, urlCandidate)
  }

  if (pathname) {
    // decodeURIComponent() CommonMark #503, allow percent encoded path names to open files. https://github.com/marktext/marktext/issues/57
    try {
      pathname = path.normalize(decodeURIComponent(pathname))
    } catch {
      // Malformed percent sequence (e.g. "%", "%E0%A4%A") — use raw path.
      pathname = path.normalize(pathname)
    }
    if (isMarkdownFile(pathname)) {
      const innerWin = BrowserWindow.fromWebContents(e.sender)
      if (innerWin) {
        openFileOrFolder(innerWin, pathname)
      }
    } else {
      // A link in an untrusted document could point at a co-located script or
      // executable; opening it via the OS shell would run code silently (#3575).
      if (isDangerousExecutableFile(pathname)) {
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: [t('dialog.cancel'), t('dialog.openAnyway')],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: t('dialog.unsafeFileTitle'),
          message: t('dialog.unsafeFileMessage'),
          detail: t('dialog.unsafeFileDetail', { name: path.basename(pathname) })
        })
        if (response !== 1) {
          return
        }
      }
      shell.openPath(pathname)
    }
  }
})

// --- commands -------------------------------------

ipcMain.on('mt::cmd-open-file', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  openFile(win)
})

ipcMain.on('mt::cmd-new-editor-window', () => {
  newEditorWindow()
})

ipcMain.on('mt::cmd-open-folder', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  openFolder(win)
})

ipcMain.on('mt::cmd-close-window', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (win) {
    win.close()
  }
})

ipcMain.on('mt::cmd-import-file', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (win) {
    importFile(win)
  }
})

// --- menu -------------------------------------

export const exportFile = (win: Win, type: string): void => {
  if (win && win.webContents) {
    win.webContents.send('mt::show-export-dialog', type)
  }
}

export const importFile = async(win: BrowserWindow | null): Promise<void> => {
  if (!win) {
    return
  }
  const existsPandoc = pandoc.exists()

  if (!existsPandoc) {
    noticePandocNotFound(win)
    return
  }

  const { filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      {
        name: 'All Files',
        extensions: [...PANDOC_EXTENSIONS]
      }
    ]
  })

  if (filePaths && filePaths[0]) {
    openPandocFile(win.id, filePaths[0])
  }
}

export const printDocument = (win: Win): void => {
  if (win) {
    win.webContents.send('mt::show-export-dialog', 'print')
  }
}

export const openFile = async(win: BrowserWindow | null): Promise<void> => {
  if (!win) {
    return
  }
  const { filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Markdown document',
        extensions: [...MARKDOWN_EXTENSIONS]
      }
    ]
  })

  if (Array.isArray(filePaths) && filePaths.length > 0) {
    ipcMain.emit('app-open-files-by-id', win.id, filePaths)
  }
}

export const openFolder = async(win: BrowserWindow | null): Promise<void> => {
  if (!win) {
    return
  }
  const { filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory']
  })

  if (filePaths && filePaths[0]) {
    openFileOrFolder(win, filePaths[0])
  }
}

export const openFileOrFolder = (win: BrowserWindow, pathname: string): void => {
  const resolvedPath = normalizeAndResolvePath(pathname)
  if (isFile(resolvedPath)) {
    ipcMain.emit('app-open-file-by-id', win.id, resolvedPath)
  } else if (isDirectory(resolvedPath)) {
    ipcMain.emit('app-open-directory-by-id', win.id, resolvedPath)
  } else {
    console.error(`[ERROR] Cannot open unknown file: "${resolvedPath}"`)
  }
}

export const newBlankTab = (win: Win): void => {
  if (win && win.webContents) {
    win.webContents.send('mt::new-untitled-tab')
    showTabBar(win)
  }
}

export const newEditorWindow = (): void => {
  ipcMain.emit('app-create-editor-window')
}

export const closeTab = (win: Win): void => {
  if (win && win.webContents) {
    win.webContents.send('mt::editor-close-tab')
  }
}

export const closeWindow = (win: Win): void => {
  if (win) {
    win.close()
  }
}

export const save = (win: Win): void => {
  if (win && win.webContents) {
    win.webContents.send('mt::editor-ask-file-save')
  }
}

export const saveAs = (win: Win): void => {
  if (win && win.webContents) {
    win.webContents.send('mt::editor-ask-file-save-as')
  }
}

export const exportPDF = (win: Win): void => {
  if (win && win.webContents) {
    exportFile(win, 'pdf')
  }
}

export const autoSave = (menuItem: MenuItem, _browserWindow: BrowserWindow | undefined): void => {
  const { checked } = menuItem
  ipcMain.emit('set-user-preference', { autoSave: checked })
}

export const moveTo = (win: Win): void => {
  if (win && win.webContents) {
    win.webContents.send('mt::editor-move-file')
  }
}

export const rename = (win: Win): void => {
  if (win && win.webContents) {
    win.webContents.send('mt::editor-rename-file')
  }
}

export const clearRecentlyUsed = (): void => {
  ipcMain.emit('menu-clear-recently-used')
}

// --- Commands -------------------------------------------------------------

export const loadFileCommands = (commandManager: CommandManager): void => {
  commandManager.add(COMMANDS.FILE_CHECK_UPDATE, checkUpdates)
  commandManager.add(COMMANDS.FILE_CLOSE_TAB, closeTab)
  commandManager.add(COMMANDS.FILE_CLOSE_WINDOW, closeWindow)
  commandManager.add(COMMANDS.FILE_EXPORT_FILE, exportFile)
  commandManager.add(COMMANDS.FILE_IMPORT_FILE, importFile)
  commandManager.add(COMMANDS.FILE_MOVE_FILE, moveTo)
  commandManager.add(COMMANDS.FILE_NEW_FILE, newEditorWindow)
  commandManager.add(COMMANDS.FILE_NEW_TAB, newBlankTab)
  commandManager.add(COMMANDS.FILE_OPEN_FILE, openFile)
  commandManager.add(COMMANDS.FILE_OPEN_FOLDER, openFolder)
  commandManager.add(COMMANDS.FILE_PREFERENCES, userSetting)
  commandManager.add(COMMANDS.FILE_PRINT, printDocument)
  commandManager.add(COMMANDS.FILE_QUIT, app.quit)
  commandManager.add(COMMANDS.FILE_RENAME_FILE, rename)
  commandManager.add(COMMANDS.FILE_SAVE, save)
  commandManager.add(COMMANDS.FILE_SAVE_AS, saveAs)
  commandManager.add(COMMANDS.FILE_EXPORT_FILE_PDF, exportPDF)
}
