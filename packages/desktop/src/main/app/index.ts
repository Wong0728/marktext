import path from 'path'
import fsPromises from 'fs/promises'
import { exec } from 'child_process'
import dayjs from 'dayjs'
import log from 'electron-log'
import { app, BrowserWindow, dialog, nativeTheme, screen, ipcMain } from 'electron'
import type { BrowserWindowConstructorOptions } from 'electron'
import { isChildOfDirectory } from 'common/filesystem/paths'
import type { IUserPreferences } from '@shared/types/preferences'
import type { TabDragPayload, TabTransferData } from '@shared/types/files'
import { isLinux, isOsx, isWindows, TITLE_BAR_HEIGHT } from '../config'
import parseArgs from '../cli/parser'
import { normalizeAndResolvePath } from '../filesystem'
import { normalizeCliMarkdownPath, normalizeMarkdownPath } from '../filesystem/markdown'
import { confirmAndTrashItem } from '../filesystem/trash'
import { registerKeyboardListeners } from '../keyboard'
import { selectTheme } from '../menu/actions/theme'
import { dockMenu } from '../menu/templates'
import registerSpellcheckerListeners from '../spellchecker'
import { watchers } from '../utils/imagePathAutoComplement'
import { onInternalChannel } from '../utils/internalIpc'
import { WindowLifecycle, WindowType } from '../windows/base'
import EditorWindow, { type FileOpenOptions } from '../windows/editor'
import SettingWindow from '../windows/setting'
import { setLanguage, t } from '../i18n'
import { matchSupportedLanguage } from 'common/i18n'
import { getNativeThemeSource, isDarkApplicationTheme } from './nativeTheme'
import type Accessor from './accessor'
import type WindowManager from './windowManager'

interface CliArgs {
  _: string[]
  [flag: string]: unknown
}

interface PathInfo extends FileOpenOptions {
  isDir: boolean
  path: string
}

// Vertical extent of a window's "top strip" (custom title bar + tab bar)
// into which a tab dragged from another window may be dropped to merge.
const TAB_DRAG_TOP_STRIP_HEIGHT = TITLE_BAR_HEIGHT + 28 + 8

// Recognized tab drag sessions that another window already adopted via
// `mt::tab-drag-adopt`; consumed by `mt::tab-drag-finished`.
const adoptedTabDrags = new Set<string>()

const isPointInRect = (
  point: { x: number; y: number },
  rect: { x: number; y: number; width: number; height: number }
): boolean => {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}

class App {
  private _accessor: Accessor
  private _args: CliArgs
  private _openFilesCache: PathInfo[]
  private _openFilesTimer: ReturnType<typeof setTimeout> | null
  private _windowManager: WindowManager
  private _themeListenerRegistered: boolean
  private _preferencesListenerRegistered: boolean

  constructor(accessor: Accessor, args: Partial<CliArgs>) {
    this._accessor = accessor
    this._args = (args as CliArgs) || ({ _: [] } as CliArgs)
    this._openFilesCache = []
    this._openFilesTimer = null
    this._windowManager = this._accessor.windowManager

    this._listenForIpcMain()
    this._themeListenerRegistered = false
    this._preferencesListenerRegistered = false
  }

  init(): void {
    // Enable these features to use `backdrop-filter` css rules!
    if (isOsx) {
      app.commandLine.appendSwitch('enable-experimental-web-platform-features', 'true')
    }

    app.on('second-instance', (_event, argv, workingDirectory, additionalData) => {
      const { _openFilesCache, _windowManager } = this
      // `argv` lists switches before the other arguments and adds switches of its
      // own, which separates `--user-data-dir <dir>` from its value (#3020), so
      // parse the unchanged copy a second instance sends as additional data.
      // A second instance of a version that doesn't send it falls back to `argv`.
      const sent = additionalData as { argv?: unknown } | null | undefined
      const secondArgv = Array.isArray(sent?.argv) ? (sent.argv as string[]) : argv
      const args = parseArgs(secondArgv.slice(1)) as CliArgs
      const readOnly = args['--read-only'] === true

      const buf: PathInfo[] = []
      for (const pathname of args._) {
        if (pathname.startsWith('--')) {
          continue
        }

        const info = normalizeCliMarkdownPath(path.resolve(workingDirectory, pathname))
        if (info) {
          buf.push({ ...info, ...(readOnly ? { readOnly } : {}) } as PathInfo)
        }
      }

      if (args['--new-window']) {
        this._openPathList(buf, true)
        return
      }

      _openFilesCache.push(...buf)
      if (_openFilesCache.length) {
        this._openFilesToOpen()
      } else {
        const activeWindow = _windowManager.getActiveWindow()
        if (activeWindow) {
          activeWindow.bringToFront()
        }
      }
    })

    app.on('open-file', this.openFile) // macOS only

    app.on('ready', this.ready)

    app.on('window-all-closed', () => {
      for (const watcher of watchers.values()) {
        watcher.close()
      }
      this._windowManager.closeWatcher()
      if (!isOsx) {
        app.quit()
      }
    })

    app.on('activate', () => {
      // macOS only
      // On OS X it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (this._windowManager.windowCount === 0) {
        this.ready()
      }
    })

    // Prevent to load webview and opening links or new windows via HTML/JS.
    app.on('web-contents-created', (_event, contents) => {
      contents.on('will-attach-webview', (event) => {
        event.preventDefault()
      })
      contents.on('will-navigate', (event) => {
        event.preventDefault()
      })
      contents.setWindowOpenHandler(() => {
        return { action: 'deny' }
      })
    })
  }

  /**
   * Initialize the main process language from preferences, detecting the
   * system language on first start. Must run after the app is ready —
   * `app.getLocale()` returns an empty string before the ready event — and
   * before the first window is created so menus and the renderer start in
   * the right language.
   */
  private _initializeLanguage(): void {
    try {
      let currentLanguage = this._accessor.preferences.getItem<string>('language')

      if (!currentLanguage) {
        const systemLocale = app.getLocale()
        currentLanguage = matchSupportedLanguage(systemLocale) ?? 'en'
        this._accessor.preferences.setItem('language', currentLanguage)
        log.info(
          `Auto-detected and set language to: ${currentLanguage} (system locale: ${systemLocale})`
        )
      }

      setLanguage(currentLanguage)
      log.info(`Main process language initialized to: ${currentLanguage}`)
    } catch (error) {
      log.error('Failed to initialize main process language:', error)
      setLanguage('en')
    }
  }

  async getScreenshotFileName(): Promise<string> {
    const screenshotFolderPath = (await this._accessor.dataCenter.getItem(
      'screenshotFolderPath'
    )) as string
    const fileName = `${dayjs().format('YYYY-MM-DD-HH-mm-ss')}-screenshot.png`
    return path.join(screenshotFolderPath, fileName)
  }

  ready = (): void => {
    const { _args: args, _openFilesCache } = this
    const { preferences } = this._accessor

    this._initializeLanguage()
    const { startUpAction, defaultDirectoryToOpen, theme } = preferences.getAll()
    const followSystemTheme = preferences.getItem<boolean>('followSystemTheme')
    const lastOpenedFolder = preferences.getItem<string>('lastOpenedFolder')
    const lightModeTheme = preferences.getItem<string>('lightModeTheme')
    const darkModeTheme = preferences.getItem<string>('darkModeTheme')

    if (args._.length) {
      const readOnly = args['--read-only'] === true
      for (const pathname of args._) {
        if (pathname.startsWith('--')) {
          continue
        }

        const info = normalizeCliMarkdownPath(pathname)
        if (info) {
          _openFilesCache.push({ ...info, ...(readOnly ? { readOnly } : {}) } as PathInfo)
        }
      }
    }

    // We should NOT open a folder if the user just wants to double click to open a file
    if (_openFilesCache.length === 0) {
      if (startUpAction === 'folder' && defaultDirectoryToOpen) {
        const info = normalizeMarkdownPath(defaultDirectoryToOpen)
        if (info) {
          _openFilesCache.unshift(info as PathInfo)
        }
      } else if (startUpAction === 'openLastFolder' && lastOpenedFolder) {
        const info = normalizeMarkdownPath(lastOpenedFolder)
        if (info) {
          _openFilesCache.unshift(info as PathInfo)
        }
      }
    }

    nativeTheme.themeSource = getNativeThemeSource({ followSystemTheme, theme })

    const isDarkTheme = isDarkApplicationTheme(theme)
    const systemIsDark = nativeTheme.shouldUseDarkColors

    if (followSystemTheme && isDarkTheme !== systemIsDark) {
      const newTheme = systemIsDark ? darkModeTheme : lightModeTheme
      log.info(
        `Following system theme at startup: ${newTheme} (system ${systemIsDark ? 'dark' : 'light'})`
      )
      selectTheme(newTheme)
    }

    if (!this._preferencesListenerRegistered) {
      this._preferencesListenerRegistered = true
      onInternalChannel(
        'broadcast-preferences-changed',
        (change: Partial<IUserPreferences>) => {
          const nextPreferences = {
            ...preferences.getAll(),
            ...change
          }
          nativeTheme.themeSource = getNativeThemeSource(nextPreferences)

        if (change.followSystemTheme === true) {
          const systemIsDark = nativeTheme.shouldUseDarkColors
          const lightModeTheme = preferences.getItem<string>('lightModeTheme')
          const darkModeTheme = preferences.getItem<string>('darkModeTheme')
          const newTheme = systemIsDark ? darkModeTheme : lightModeTheme

          log.info(
            `followSystemTheme enabled, switching to: ${newTheme} (system ${systemIsDark ? 'dark' : 'light'})`
          )
          selectTheme(newTheme)
          preferences.setItem('theme', newTheme)
        }
        if (
          preferences.getItem<boolean>('followSystemTheme') &&
        (change.lightModeTheme || change.darkModeTheme)
          ) {
            const systemIsDark = nativeTheme.shouldUseDarkColors

        // Use newly changed theme preferences before the stored values are refreshed.
          let lightModeTheme = preferences.getItem<string>('lightModeTheme')
          let darkModeTheme = preferences.getItem<string>('darkModeTheme')

          if (change.lightModeTheme !== undefined) {
            lightModeTheme = change.lightModeTheme
          }
          if (change.darkModeTheme !== undefined) {
            darkModeTheme = change.darkModeTheme
          }

            const newTheme = systemIsDark ? darkModeTheme : lightModeTheme

            log.info(`Theme preference changed, applying: ${newTheme}`)
            selectTheme(newTheme)
            preferences.setItem('theme', newTheme)
          }
        })
    }

    if (!this._themeListenerRegistered) {
      nativeTheme.on('updated', () => {
        const followSystemTheme = preferences.getItem<boolean>('followSystemTheme')
        const lightModeTheme = preferences.getItem<string>('lightModeTheme')
        const darkModeTheme = preferences.getItem<string>('darkModeTheme')

        if (followSystemTheme) {
          const systemIsDark = nativeTheme.shouldUseDarkColors
          const newTheme = systemIsDark ? darkModeTheme : lightModeTheme
          const currentTheme = preferences.getItem<string>('theme')

          if (newTheme !== currentTheme) {
            log.info(
              `System theme changed, switching to: ${newTheme} (system ${systemIsDark ? 'dark' : 'light'})`
            )
            selectTheme(newTheme)
            preferences.setItem('theme', newTheme)
          }
        }
      })
      this._themeListenerRegistered = true
    }

    if (isOsx) {
      app.dock?.setMenu(dockMenu)
    } else if (isWindows) {
      app.setJumpList([
        {
          type: 'recent'
        },
        {
          type: 'tasks',
          items: [
            {
              type: 'task',
              title: 'New Window',
              description: 'Opens a new window',
              program: process.execPath,
              args: '--new-window',
              iconPath: process.execPath,
              iconIndex: 0
            }
          ]
        }
      ])
    }

    const createWindow = (): void => {
      if (_openFilesCache.length) {
        this._openFilesToOpen()
      } else {
        this._createEditorWindow()
      }

      // Leftover snapshot files mean the previous session ended abnormally —
      // offer to recover their unsaved content in the first editor window.
      this._offerCrashRecovery()
    }

    if (isLinux) {
      let windowCreated = false

      const createWindowOnce = (): void => {
        if (windowCreated) return
        windowCreated = true
        createWindow()
      }

      // Wait for theme to settle (Linux-specific issue?)
      nativeTheme.once('updated', createWindowOnce)
      // Fallback timeout in case 'updated' never fires (no theme change)
      setTimeout(createWindowOnce, 150)
    } else {
      createWindow()
    }



    //   try {
    //     // write screenshot image into screenshot folder.
    //     await fse.writeFile(screenshotFileName, bufferImage)
    //   } catch (err) {
    //     log.error(err)
    //   }
    // })
  }

  openFile = (event: Electron.Event, pathname: string): void => {
    event.preventDefault()
    const info = normalizeMarkdownPath(pathname)
    if (info) {
      this._openFilesCache.push(info as PathInfo)

      if (app.isReady()) {
        // It might come more files
        if (this._openFilesTimer) {
          clearTimeout(this._openFilesTimer)
        }
        this._openFilesTimer = setTimeout(() => {
          this._openFilesTimer = null
          this._openFilesToOpen()
        }, 100)
      }
    }
  }


  private _createEditorWindow(
    rootDirectory: string | null = null,
    fileList: string[] = [],
    markdownList: string[] = [],
    options: Partial<BrowserWindowConstructorOptions> = {},
    unsavedTabs: TabTransferData[] = [],
    fileOptions: Record<string, FileOpenOptions> = {}
  ): EditorWindow {
    const editor = new EditorWindow(this._accessor)
    if (rootDirectory) {
      this._accessor.preferences.setItems({ lastOpenedFolder: rootDirectory })
    }
    editor.createWindow(rootDirectory, fileList, markdownList, options, unsavedTabs, fileOptions)
    this._windowManager.add(editor)
    if (this._windowManager.windowCount === 1) {
      this._accessor.menu.setActiveWindow(editor.id!)
    }
    return editor
  }

  /**
   * Opens a tab transferred from another window (tab drag & drop or the
   * "open in new window" context-menu action) in the given editor window.
   * Saved files are re-read from disk; unsaved buffers keep their content.
   */
  private _openTransferredTabIn(editor: EditorWindow, tab: TabTransferData): void {
    if (!tab) return
    if (tab.pathname && tab.isSaved) {
      editor.openTab(tab.pathname, {}, true)
    } else if (tab.pathname) {
      editor.restoreUnsavedTabs([tab])
    } else {
      editor.openUntitledTab(true, tab.markdown)
    }
  }

  /**
   * Computes BrowserWindow options that place a new editor window near the
   * given screen point (a tab dragged out of another window), clamped to the
   * nearest display's work area so the window stays fully visible.
   */
  private _windowPositionForDropPoint(
    point: { x: number; y: number }
  ): Partial<BrowserWindowConstructorOptions> {
    const { workArea } = screen.getDisplayNearestPoint(point)
    const x = Math.min(Math.max(point.x - 80, workArea.x), workArea.x + workArea.width - 200)
    const y = Math.min(Math.max(point.y - 10, workArea.y), workArea.y + workArea.height - 100)
    return { x, y }
  }

  /**
   * Offer to recover unsaved content from crash-recovery snapshots left over
   * by an abnormal exit. On a clean exit no snapshot files exist and this is
   * a no-op.
   */
  private _offerCrashRecovery(): void {
    const { editorBufferStore } = this._accessor
    // Snapshot the leftover files up front. Everything below runs before/around
    // an `await`, during which the fresh session's windows write new snapshots
    // (with new UUIDs). Deleting by this captured list — never "all" — avoids
    // wiping those new snapshots and losing content on a subsequent crash.
    const leftoverSnapshots = editorBufferStore.listSnapshotFiles()
    const tabs = editorBufferStore.collectUnsavedTabs()
    if (tabs.length === 0) {
      // Nothing recoverable — also clears legacy session buffers that only
      // contained saved tabs.
      editorBufferStore.deleteSnapshotsByPaths(leftoverSnapshots)
      return
    }

    const editor = this._windowManager
      .getWindowsByType(WindowType.EDITOR)
      .map(({ win }) => win)
      .find((win): win is EditorWindow => win instanceof EditorWindow)
    if (!editor) {
      // No editor window to recover into; keep the snapshots for a later run.
      return
    }

    const askForRecovery = async(): Promise<void> => {
      const win = editor.browserWindow
      if (!win || win.isDestroyed()) {
        return
      }

      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: [t('dialog.recover'), t('dialog.discard')],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        message: t('dialog.unsavedContentFound'),
        detail: t('dialog.unsavedContentFoundDetail', { count: tabs.length })
      })

      if (response === 0) {
        editor.restoreUnsavedTabs(tabs)
      }
      // The decision has been made either way; the restored tabs are written
      // to a fresh snapshot by the renderer as soon as they are re-created.
      // Delete only the captured leftover files so that fresh snapshot (and any
      // other window's) survives.
      editorBufferStore.deleteSnapshotsByPaths(leftoverSnapshots)
    }

    if (editor.lifecycle === WindowLifecycle.READY) {
      askForRecovery()
    } else {
      editor.once('window-ready', () => {
        askForRecovery()
      })
    }
  }

  /**
   * Create a new setting window.
   */
  private _createSettingWindow(category?: string | null): void {
    const setting = new SettingWindow(this._accessor)
    setting.createWindow(category ?? null)
    this._windowManager.add(setting)
    if (this._windowManager.windowCount === 1) {
      this._accessor.menu.setActiveWindow(setting.id!)
    }
  }

  private _openFilesToOpen(): void {
    this._openPathList(this._openFilesCache, false)
  }

  /** When openFilesInSameWindow is true, discard all but the first directory and open its files together. */
  private _openPathList(pathsToOpen: PathInfo[], openFilesInSameWindow: boolean = false): void {
    const { _windowManager } = this
    const openFilesInNewWindow = this._accessor.preferences.getItem<boolean>('openFilesInNewWindow')

    const fileOptions: Record<string, FileOpenOptions> = {}
    const fileSet = new Set<string>()
    const directorySet = new Set<string>()
    for (const { allowMissing, isDir, path: pathname, readOnly } of pathsToOpen) {
      if (isDir) {
        directorySet.add(pathname)
      } else {
        fileSet.add(pathname)
        fileOptions[pathname] = {
          ...fileOptions[pathname],
          ...(allowMissing ? { allowMissing: true } : {}),
          ...(readOnly ? { readOnly: true } : {})
        }
      }
    }

    for (const window of _windowManager.windows.values()) {
      if (window.type === WindowType.EDITOR) {
        const { openedRootDirectory } = window as EditorWindow
        if (openedRootDirectory && directorySet.has(openedRootDirectory)) {
          window.bringToFront()
          directorySet.delete(openedRootDirectory)
        }
      }
    }

    const directoriesToOpen: { rootDirectory: string | null; fileList: string[] }[] = Array.from(
      directorySet
    ).map((dir) => ({
      rootDirectory: dir,
      fileList: []
    }))
    const filesToOpen = Array.from(fileSet)

    if (openFilesInSameWindow) {
      if (directoriesToOpen.length) {
        directoriesToOpen[0].fileList.push(...filesToOpen)
        directoriesToOpen.length = 1
      } else {
        directoriesToOpen.push({ rootDirectory: null, fileList: [...filesToOpen] })
      }
      filesToOpen.length = 0
    }

    if (!openFilesInSameWindow && !openFilesInNewWindow) {
      const isFirstWindow = _windowManager.getActiveEditorId() === null

      for (let i = 0; i < directoriesToOpen.length; ++i) {
        const { fileList, rootDirectory } = directoriesToOpen[i]

        let breakOuterLoop = false
        for (let j = 0; j < filesToOpen.length; ++j) {
          const pathname = filesToOpen[j]
          if (isChildOfDirectory(rootDirectory ?? '', pathname)) {
            if (isFirstWindow) {
              fileList.push(...filesToOpen)
              filesToOpen.length = 0
              breakOuterLoop = true
              break
            }
            fileList.push(pathname)
            filesToOpen.splice(j, 1)
            --j
          }
        }

        if (breakOuterLoop) {
          break
        }
      }

      if (isFirstWindow && directoriesToOpen.length && filesToOpen.length) {
        const { fileList } = directoriesToOpen[0]
        fileList.push(...filesToOpen)
        filesToOpen.length = 0
      } else {
        const windowList = _windowManager.findBestWindowToOpenIn(filesToOpen)
        for (const item of windowList) {
          const { windowId, fileList } = item

          if (fileList.length === 0) {
            continue
          }

          if (windowId !== null) {
            const window = _windowManager.get(windowId) as EditorWindow | undefined
            if (window) {
              window.openTabsFromPaths(fileList, fileOptions)
              window.bringToFront()
              continue
            }
            // else: fallthrough
          }
          this._createEditorWindow(null, fileList, [], {}, [], fileOptions)
        }
      }

      for (const item of directoriesToOpen) {
        const { rootDirectory, fileList } = item
        this._createEditorWindow(rootDirectory, fileList, [], {}, [], fileOptions)
      }
    } else {

      for (const pathname of filesToOpen) {
        this._createEditorWindow(null, [pathname], [], {}, [], fileOptions)
      }

      for (const item of directoriesToOpen) {
        const { rootDirectory, fileList } = item
        this._createEditorWindow(rootDirectory, fileList, [], {}, [], fileOptions)
      }
    }

    pathsToOpen.length = 0
  }

  private _openSettingsWindow(category?: string | null): void {
    const settingWins = this._windowManager.getWindowsByType(WindowType.SETTINGS)
    if (settingWins.length >= 1) {
      const browserSettingWindow = settingWins[0].win.browserWindow!
      browserSettingWindow.webContents.send('settings::change-tab', category)
      if (isLinux) {
        browserSettingWindow.focus()
      } else {
        browserSettingWindow.moveTop()
      }
      return
    }
    this._createSettingWindow(category)
  }

  private _listenForIpcMain(): void {
    registerKeyboardListeners()
    registerSpellcheckerListeners()

    ipcMain.on('mt::get-current-language', (event) => {
      const { language } = this._accessor.preferences.getAll()
      event.reply('mt::current-language', language || 'en')
    })

    ipcMain.on('app-create-editor-window', () => {
      this._createEditorWindow()
    })

    // --- tab drag & drop across windows -------------------------------

    // A renderer window accepted a tab dropped onto its tab bar. Remember
    // the drag session so the source window's `mt::tab-drag-finished` knows
    // the tab moved, and open the tab in the receiving window.
    ipcMain.handle('mt::tab-drag-adopt', (event, payload: TabDragPayload) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || !payload || typeof payload.dragId !== 'string') return false
      const editor = this._windowManager.get(win.id) as EditorWindow | undefined
      if (!editor) return false
      adoptedTabDrags.add(payload.dragId)
      this._openTransferredTabIn(editor, payload.tab)
      return true
    })

    // A tab drag ended without being dropped inside the source window. Main
    // arbitrates based on the cursor position: merge into the window under
    // the cursor (top strip only), create a new window, or cancel.
    ipcMain.handle('mt::tab-drag-finished', (event, dragId: string, payload: TabDragPayload) => {
      if (typeof dragId === 'string' && adoptedTabDrags.delete(dragId)) {
        return { adopted: true }
      }

      const sourceWin = BrowserWindow.fromWebContents(event.sender)
      if (!sourceWin || sourceWin.isDestroyed() || !payload || !payload.tab) {
        return { adopted: false }
      }

      const cursor = screen.getCursorScreenPoint()
      if (isPointInRect(cursor, sourceWin.getBounds())) {
        // Dropped inside the source window (e.g. on the editor area): cancel.
        return { adopted: false }
      }

      // Over another editor window? Only its top strip (title bar + tab bar)
      // accepts a merge — dropping on the document area does nothing.
      for (const { id, win } of this._windowManager.getWindowsByType(WindowType.EDITOR)) {
        if (id === sourceWin.id) continue
        const bounds = win.browserWindow && !win.browserWindow.isDestroyed()
          ? win.browserWindow.getBounds()
          : null
        if (!bounds || !isPointInRect(cursor, bounds)) continue
        if (cursor.y <= bounds.y + TAB_DRAG_TOP_STRIP_HEIGHT) {
          this._openTransferredTabIn(win as EditorWindow, payload.tab)
          return { adopted: true }
        }
        return { adopted: false }
      }

      // Dropped outside every editor window: detach into a new window at the
      // drop position. The source window closes the tab (adopted: true).
      const options = this._windowPositionForDropPoint(cursor)
      const tab = payload.tab
      if (tab.pathname && tab.isSaved) {
        this._createEditorWindow(null, [tab.pathname], [], options)
      } else if (tab.pathname) {
        this._createEditorWindow(null, [], [], options, [tab])
      } else {
        this._createEditorWindow(null, [], [tab.markdown], options)
      }
      return { adopted: true }
    })

    // "Open in new window" tab context-menu action.
    ipcMain.handle('mt::move-tab-to-new-window', (_event, payload: TabDragPayload) => {
      const tab = payload && payload.tab
      if (!tab) return false
      if (tab.pathname && tab.isSaved) {
        this._createEditorWindow(null, [tab.pathname])
      } else if (tab.pathname) {
        this._createEditorWindow(null, [], [], {}, [tab])
      } else {
        this._createEditorWindow(null, [], [tab.markdown])
      }
      return true
    })

    onInternalChannel('screen-capture', async(win: BrowserWindow) => {
      if (isOsx) {
        const screenshotFileName = await this.getScreenshotFileName()
        // Capture straight to a file: Electron 44 removed the synchronous
        // clipboard `readImage` API, and the file form also keeps the
        // user's clipboard intact.
        exec(`screencapture -i "${screenshotFileName}"`, async(err) => {
          if (err) {
            log.error(err)
            return
          }
          // The renderer inserts the capture at the cursor; screencapture
          // writes no file when the user cancels (Esc).
          let savedPath = ''
          try {
            await fsPromises.stat(screenshotFileName)
            savedPath = screenshotFileName
          } catch (statErr) {
            log.error(statErr)
          }
          if (!win.isDestroyed()) {
            win.webContents.send('mt::screenshot-captured', savedPath)
          }
        })
      } else {
        // TODO: Do nothing, maybe we'll add screenCapture later on Linux and Windows.
        // if (this.shortcutCapture) {
        //   this.launchScreenshotWin = win
        //   this.shortcutCapture.shortcutCapture()
        // }
      }
    })

    onInternalChannel('app-create-settings-window', (category?: string) => {
      this._openSettingsWindow(category)
    })

    onInternalChannel(
      'app-open-file-by-id',
      (windowId: number, filePath: string, options: Record<string, unknown> = {}) => {
        const openFilesInNewWindow =
          this._accessor.preferences.getItem<boolean>('openFilesInNewWindow')
        if (openFilesInNewWindow) {
          this._createEditorWindow(null, [filePath], [], {}, [], {
            [filePath]: options as FileOpenOptions
          })
        } else {
          const editor = this._windowManager.get(windowId) as EditorWindow | undefined
          if (editor) {
            editor.openTab(filePath, options, true)
          }
        }
      }
    )
    onInternalChannel('app-open-files-by-id', (windowId: number, fileList: string[]) => {
      const openFilesInNewWindow = this._accessor.preferences.getItem<boolean>('openFilesInNewWindow')
      if (openFilesInNewWindow) {
        this._createEditorWindow(null, fileList)
      } else {
        const editor = this._windowManager.get(windowId) as EditorWindow | undefined
        if (editor) {
          editor.openTabsFromPaths(
            fileList
              .map((p) => normalizeMarkdownPath(p))
              .filter((i): i is PathInfo => i !== null && !i.isDir)
              .map((i) => i.path)
          )
        }
      }
    })

    onInternalChannel('app-open-markdown-by-id', (windowId: number, data: string) => {
      const openFilesInNewWindow = this._accessor.preferences.getItem<boolean>('openFilesInNewWindow')
      if (openFilesInNewWindow) {
        this._createEditorWindow(null, [], [data])
      } else {
        const editor = this._windowManager.get(windowId) as EditorWindow | undefined
        if (editor) {
          editor.openUntitledTab(true, data)
        }
      }
    })

    onInternalChannel(
      'app-open-directory-by-id',
      (windowId: number, pathname: string, openInSameWindow: boolean) => {
        const { openFolderInNewWindow } = this._accessor.preferences.getAll()
        if (openInSameWindow || !openFolderInNewWindow) {
          const editor = this._windowManager.get(windowId) as EditorWindow | undefined
          if (editor) {
            editor.openFolder(pathname)
            return
          }
        }
        this._createEditorWindow(pathname)
      }
    )


    ipcMain.on('mt::app-try-quit', () => {
      app.quit()
    })

    ipcMain.on('mt::open-file-by-window-id', (_e, windowId: number, filePath: string) => {
      const resolvedPath = normalizeAndResolvePath(filePath)
      const openFilesInNewWindow = this._accessor.preferences.getItem<boolean>('openFilesInNewWindow')
      if (openFilesInNewWindow) {
        this._createEditorWindow(null, [resolvedPath])
      } else {
        const editor = this._windowManager.get(windowId) as EditorWindow | undefined
        if (editor) {
          editor.openTab(resolvedPath, {}, true)
        }
      }
    })

    ipcMain.on('mt::select-default-directory-to-open', async(e) => {
      const { preferences } = this._accessor
      const { defaultDirectoryToOpen } = preferences.getAll()
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) return

      const { filePaths } = await dialog.showOpenDialog(win, {
        defaultPath: defaultDirectoryToOpen,
        properties: ['openDirectory', 'createDirectory']
      })
      if (filePaths && filePaths[0]) {
        preferences.setItems({ defaultDirectoryToOpen: filePaths[0] })
      }
    })

    ipcMain.on('mt::open-setting-window', () => {
      this._openSettingsWindow()
    })

    ipcMain.on('mt::make-screenshot', (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      ipcMain.emit('screen-capture', win)
    })

    ipcMain.on('mt::request-keybindings', (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) return
      const { keybindings } = this._accessor
      win.webContents.send('mt::keybindings-response', Object.fromEntries(keybindings.keys))
    })

    ipcMain.on('mt::open-keybindings-config', () => {
      const { keybindings } = this._accessor
      keybindings.openConfigInFileManager()
    })

    ipcMain.handle('mt::keybinding-get-pref-keybindings', () => {
      const { keybindings } = this._accessor
      const defaultKeybindings = keybindings.getDefaultKeybindings()
      const userKeybindings = keybindings.getUserKeybindings()
      return { defaultKeybindings, userKeybindings }
    })

    ipcMain.handle('mt::keybinding-save-user-keybindings', async(_event, userKeybindings) => {
      const { keybindings, menu } = this._accessor
      const editorWindows = this._windowManager
        .getWindowsByType(WindowType.EDITOR)
        .map(({ win }) => win.browserWindow)
        .filter((win): win is BrowserWindow => win != null)
      const saved = await keybindings.setUserKeybindings(userKeybindings, editorWindows)

      menu.updateKeybindings()
      const keybindingMap = Object.fromEntries(keybindings.keys)
      for (const win of editorWindows) {
        win.webContents.send('mt::keybindings-response', keybindingMap)
      }

      return saved
    })

    ipcMain.handle('mt::fs-trash-item', async(event, fullPath: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      // chokidar v5 emits POSIX separators on Windows, so sidebar tree
      // pathnames reach here as `C:/a/b.md`; shell.trashItem rejects those
      // with "Failed to parse path" (electron/electron#28831).
      return confirmAndTrashItem(win, path.normalize(fullPath))
    })
  }
}

export default App
