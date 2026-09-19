import path from 'path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { BrowserWindowConstructorOptions } from 'electron'
import log from 'electron-log'
import windowStateKeeper from 'electron-window-state'
import { isChildOfDirectory, isSamePathSync } from 'common/filesystem/paths'
import BaseWindow, { WindowLifecycle, WindowType } from './base'
import type Accessor from '../app/accessor'
import { ensureWindowPosition, zoomIn, zoomOut } from './utils'
import { TITLE_BAR_HEIGHT, editorWinOptions, isLinux, isOsx } from '../config'
import { showEditorContextMenu } from '../contextMenu/editor'
import { loadMarkdownFile } from '../filesystem/markdown'
import { switchLanguage } from '../spellchecker'
import { t } from '../i18n'
import { isSessionEnding, markSessionEnding } from '../appState'
import type { SnapshotTab } from '../editorBufferStore'

type RawMarkdownDocument = Awaited<ReturnType<typeof loadMarkdownFile>>

// Grace period after `mt::ask-for-close` before the renderer is treated as
// unresponsive. A JS busy-loop (unlike a crash) never fires
// `render-process-gone`, so without this the window could never be closed.
const CLOSE_ACK_TIMEOUT_MS = 2000

// The deferred file/markdown to open before the window finishes loading.
interface PendingFile {
  doc: RawMarkdownDocument
  options: Record<string, unknown>
  selected: boolean
}

interface CandidateScore {
  id: number | null
  score: number
}

class EditorWindow extends BaseWindow {
  // Root directory and file list to open when the window is ready.
  private _directoryToOpen: string | null
  private _filesToOpen: PendingFile[] | null
  private _markdownToOpen: string[] | null
  // Unsaved tab snapshots (e.g. tabs dragged out of another window) to
  // restore once the window is ready.
  private _unsavedTabsToOpen: SnapshotTab[] | null
  // Root directory and file list that are currently opened. These lists are
  // used to find the best window to open new files in.
  private _openedRootDirectory: string | null
  private _openedFiles: string[] | null

  // Stable id used for the crash-recovery snapshot file of this window.
  public snapshotId: string | null

  // Close-handshake bookkeeping (see the `close` handler): whether a close
  // request is currently awaiting the renderer's ack, the fallback timer that
  // fires if it never arrives, and the ipcMain ack listener to detach on close.
  private _isClosing: boolean
  private _closeAckTimer: ReturnType<typeof setTimeout> | null
  private _onCloseAck: ((e: Electron.IpcMainEvent) => void) | null

  /**
   * @param accessor The application accessor for application instances.
   */
  constructor(accessor: Accessor) {
    super(accessor)
    this.type = WindowType.EDITOR

    // Root directory and file list to open when the window is ready.
    this._directoryToOpen = null
    this._filesToOpen = [] // {doc: IMarkdownDocumentRaw, options: any, selected: boolean}
    this._markdownToOpen = [] // List of markdown strings or an empty string will open a new untitled tab
    this._unsavedTabsToOpen = []

    // Root directory and file list that are currently opened. These lists are
    // used to find the best window to open new files in.
    this._openedRootDirectory = ''
    this._openedFiles = []

    this.snapshotId = null

    this._isClosing = false
    this._closeAckTimer = null
    this._onCloseAck = null
  }

  /**
   * Creates a new editor window.
   */
  createWindow(
    rootDirectory: string | null = null,
    fileList: string[] = [],
    markdownList: string[] = [],
    options: Partial<BrowserWindowConstructorOptions> = {},
    unsavedTabs: SnapshotTab[] = []
  ): BrowserWindow {
    const { menu: appMenu, env, preferences, editorBufferStore } = this._accessor
    const addBlankTab =
      !rootDirectory && fileList.length === 0 && markdownList.length === 0 && unsavedTabs.length === 0
    this._unsavedTabsToOpen = unsavedTabs.slice()

    const mainWindowState = windowStateKeeper({
      defaultWidth: 1200,
      defaultHeight: 800
    })

    const { x, y, width, height } = ensureWindowPosition(mainWindowState)
    const winOptions: BrowserWindowConstructorOptions = Object.assign(
      { x, y, width, height },
      editorWinOptions,
      options
    )
    if (isLinux) {
      winOptions.icon = path.join(process.cwd(), 'static', 'logo-96px.png')
    }

    const {
      titleBarStyle,
      theme,
      sideBarVisibility,
      restoreLayoutState,
      tabBarVisibility,
      sourceCodeModeEnabled,
      spellcheckerEnabled,
      spellcheckerLanguage
    } = preferences.getAll()
    const resolvedSideBarVisibility = restoreLayoutState ? !!sideBarVisibility : false

    // Enable native or custom/frameless window and titlebar
    if (!isOsx) {
      winOptions.titleBarStyle = 'default'
      if (titleBarStyle === 'native') {
        winOptions.frame = true
      }
    }

    winOptions.backgroundColor = this._getPreferredBackgroundColor(theme)
    if (env.disableSpellcheck) {
      // winOptions.webPreferences is set by editorWinOptions spread above
      ;(winOptions.webPreferences as { spellcheck: boolean }).spellcheck = false
    }

    let win: BrowserWindow | null = (this.browserWindow = new BrowserWindow(winOptions))

    // Give every editor window a stable id for its crash-recovery snapshot.
    // We cant use win.id as it might collide with same IDs from closed windows
    this.snapshotId = editorBufferStore.getUnUsedBufferUUID()
    ;(win as unknown as { restoreBufferId: string }).restoreBufferId = this.snapshotId

    this.id = win.id

    if (spellcheckerEnabled && !isOsx) {
      try {
        switchLanguage(win, spellcheckerLanguage as string)
      } catch (error) {
        log.error('Unable to set spell checker language on startup:', error)
      }
    }

    // Create a menu for the current window
    appMenu.addEditorMenu(win, { sourceCodeModeEnabled: sourceCodeModeEnabled as boolean })

    win.webContents.on('context-menu', (event, params) => {
      showEditorContextMenu(win!, event, params, preferences.getItem('spellcheckerEnabled'))
    })

    win.webContents.once('did-finish-load', () => {
      this.lifecycle = WindowLifecycle.READY
      this.emit('window-ready')

      // Restore and focus window
      this.bringToFront()

      const lineEnding = preferences.getPreferredEol()
      appMenu.updateLineEndingMenu(this.id!, lineEnding)

      win!.webContents.send('mt::bootstrap-editor', {
        addBlankTab,
        markdownList: this._markdownToOpen,
        lineEnding,
        sideBarVisibility: resolvedSideBarVisibility,
        tabBarVisibility,
        sourceCodeModeEnabled
      })

      this._doOpenFilesToOpen()
      this._markdownToOpen!.length = 0
      if (this._unsavedTabsToOpen && this._unsavedTabsToOpen.length > 0) {
        const unsavedTabs = this._unsavedTabsToOpen
        this._unsavedTabsToOpen = []
        this.restoreUnsavedTabs(unsavedTabs)
      }

      // Listen on default system mouse zoom event (e.g. Ctrl+MouseWheel on Linux/Windows).
      win!.webContents.on('zoom-changed', (_event, zoomDirection) => {
        if (zoomDirection === 'in') {
          zoomIn(win!)
        } else if (zoomDirection === 'out') {
          zoomOut(win!)
        }
      })
    })

    win.webContents.once('did-fail-load', (_event, errorCode, errorDescription, url) => {
      log.error(
        `The window failed to load or was cancelled: ${errorCode}; ${errorDescription}; @ ${url}`
      )
    })

    win.webContents.once('render-process-gone', async(_event, { reason }) => {
      if (reason === 'clean-exit') {
        return
      }

      const msg = `The renderer process has crashed unexpected or is killed (${reason}).`
      log.error(msg)

      if (reason === 'abnormal-exit') {
        return
      }

      const { response } = await dialog.showMessageBox(win!, {
        type: 'warning',
        buttons: ['Close', 'Reload', 'Keep It Open'],
        message: 'MarkText has crashed',
        detail: msg
      })

      if (win === null) return

      switch (response) {
        case 0:
          return this.destroy()
        case 1:
          return this.reload()
      }
    })

    win.on('focus', () => {
      this.emit('window-focus')
      win!.webContents.send('mt::window-active-status', { status: true })
    })

    // Lost focus
    win.on('blur', () => {
      this.emit('window-blur')
      win!.webContents.send('mt::window-active-status', { status: false })
    })
    ;(['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const).forEach(
      (channel) => {
        // Electron's BrowserWindow.on() is heavily overloaded — the union of
        // event names can't be satisfied by a single overload, so we widen.
        ;(win! as { on(event: string, listener: () => void): void }).on(channel, () => {
          win!.webContents.send(`mt::window-${channel}`)
        })
      }
    )

    // Windows OS shutdown / logout: flag the session end early (on the query,
    // which precedes the forced close) so the `close` handler below stops
    // blocking the shutdown with the confirm handshake. No-op on other OSes.
    win.on('query-session-end', markSessionEnding)
    win.on('session-end', markSessionEnding)

    // Renderer's synchronous reply to `mt::ask-for-close`. Receiving it proves
    // the renderer is alive and now owns the close decision, so we cancel the
    // unresponsive fallback and allow subsequent close requests.
    this._onCloseAck = (e) => {
      if (!win || win.isDestroyed() || e.sender !== win.webContents) return
      this._clearCloseFallback()
    }
    ipcMain.on('mt::close-request-ack', this._onCloseAck)

    // Before closed. We cancel the action and ask the editor further instructions.
    win.on('close', (event) => {
      // OS-initiated shutdown/logout won't wait for our confirm handshake, and
      // blocking it stalls the shutdown. Let the window close normally; the
      // crash-recovery snapshot preserves anything unsaved for the next launch.
      if (isSessionEnding()) {
        return
      }

      event.preventDefault()

      // Collapse a repeated close while the previous request is still awaiting
      // the renderer ack, so we don't send a second ask or stack a fallback.
      if (this._isClosing) {
        return
      }

      this.emit('window-close')

      // Still loading: the renderer hasn't registered its close listener and
      // holds no user edits yet, so `mt::ask-for-close` would be lost. Close
      // directly instead of waiting for a reply that never comes.
      if (this.lifecycle !== WindowLifecycle.READY) {
        ipcMain.emit('window-close-by-id', this.id)
        return
      }

      this._isClosing = true
      win!.webContents.send('mt::ask-for-close')

      // A renderer stuck in a JS busy-loop never acks and never crashes, so the
      // window would be impossible to close. After a grace period, ask the user
      // directly whether to force-close it.
      this._closeAckTimer = setTimeout(() => {
        this._closeAckTimer = null
        if (!win || win.isDestroyed()) return
        dialog
          .showMessageBox(win, {
            type: 'warning',
            buttons: [t('dialog.close'), t('dialog.keepOpen')],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
            message: t('dialog.windowNotResponding'),
            detail: t('dialog.windowNotRespondingDetail')
          })
          .then(({ response }) => {
            this._isClosing = false
            if (response === 0) {
              ipcMain.emit('window-close-by-id', this.id)
            }
          })
      }, CLOSE_ACK_TIMEOUT_MS)
    })

    // The window is now destroyed.
    win.on('closed', () => {
      this.lifecycle = WindowLifecycle.QUITTED
      this._clearCloseFallback()
      if (this._onCloseAck) {
        ipcMain.removeListener('mt::close-request-ack', this._onCloseAck)
        this._onCloseAck = null
      }
      this.emit('window-closed')

      // Free window reference
      win = null
    })

    this.lifecycle = WindowLifecycle.LOADING
    win.loadURL(this._buildUrlString(this.id, env, preferences))
    win.setSheetOffset(TITLE_BAR_HEIGHT)

    mainWindowState.manage(win)

    // Disable application menu shortcuts because we want to handle key bindings ourself.
    win.webContents.setIgnoreMenuShortcuts(true)

    // Delay load files and directories after the current control flow.
    setTimeout(() => {
      if (rootDirectory) {
        this.openFolder(rootDirectory)
      }
      if (fileList.length) {
        this.openTabsFromPaths(fileList)
      }
    }, 0)

    return win
  }

  /**
   * Open a new tab from a markdown file.
   */
  openTab(filePath: string, options: Record<string, unknown> = {}, selected: boolean = true): void {
    // TODO: Don't allow new files if quitting.
    if (this.lifecycle === WindowLifecycle.QUITTED) return
    this.openTabs([{ filePath, options, selected }])
  }

  /**
   * Open new tabs from the given file paths.
   */
  openTabsFromPaths(filePaths: string[]): void {
    if (!filePaths || filePaths.length === 0) return

    const fileList = filePaths.map((p) => ({ filePath: p, options: {}, selected: false }))
    fileList[0].selected = true
    this.openTabs(fileList)
  }

  /**
   * Open new tabs from markdown files with options for editor window.
   */
  openTabs(
    fileList: { filePath: string; selected: boolean; options: Record<string, unknown> }[]
  ): void {
    // TODO: Don't allow new files if quitting.
    if (this.lifecycle === WindowLifecycle.QUITTED) return

    const { browserWindow } = this
    const { preferences } = this._accessor
    const eol = preferences.getPreferredEol()
    const { autoGuessEncoding, trimTrailingNewline, autoNormalizeLineEndings } =
      preferences.getAll()

    for (const { filePath, options, selected } of fileList) {
      if (this._openedFiles!.includes(filePath)) {
        // File is already opened - avoid opening it again so we dont have duplicate watchers
        browserWindow!.webContents.send('mt::switch-tab-by-file_path', filePath)
        continue
      }
      loadMarkdownFile(
        filePath,
        eol,
        autoGuessEncoding,
        trimTrailingNewline,
        autoNormalizeLineEndings
      )
        .then((rawDocument) => {
          if (this.lifecycle === WindowLifecycle.READY) {
            this._doOpenTab(rawDocument, options, selected)
          } else {
            this._filesToOpen!.push({ doc: rawDocument, options, selected })
          }
        })
        .catch((err: Error) => {
          const { message, stack } = err
          log.error(`[ERROR] Cannot open file or directory: ${message}\n\n${stack}`)
          browserWindow!.webContents.send('mt::show-notification', {
            title: 'Cannot open tab',
            type: 'error',
            message: err.message
          })
        })
    }
  }

  /**
   * Open a new untitled tab optional with a markdown string.
   */
  openUntitledTab(selected: boolean = true, markdown: string = ''): void {
    // TODO: Don't allow new files if quitting.
    if (this.lifecycle === WindowLifecycle.QUITTED) return

    if (this.lifecycle === WindowLifecycle.READY) {
      const { browserWindow } = this
      browserWindow!.webContents.send('mt::new-untitled-tab', selected, markdown)
    } else {
      this._markdownToOpen!.push(markdown)
    }
  }

  /**
   * Open a (new) directory and replaces the old one.
   */
  openFolder(pathname: string): void {
    // TODO: Don't allow new files if quitting.
    if (
      !pathname ||
      this.lifecycle === WindowLifecycle.QUITTED ||
      isSamePathSync(pathname, this._openedRootDirectory ?? '')
    ) {
      return
    }

    if (this.lifecycle === WindowLifecycle.READY) {
      const { browserWindow } = this
      const { menu: appMenu, preferences } = this._accessor

      if (this._openedRootDirectory) {
        ipcMain.emit('watcher-unwatch-directory', browserWindow, this._openedRootDirectory)
      }

      preferences.setItems({ lastOpenedFolder: pathname })
      appMenu.addRecentlyUsedDocument(pathname)
      this._openedRootDirectory = pathname
      ipcMain.emit('watcher-watch-directory', browserWindow, pathname)
      browserWindow!.webContents.send('mt::open-directory', pathname)
    } else {
      this._directoryToOpen = pathname
    }
  }

  /**
   * Add a new path to the file list and watch the given path.
   */
  addToOpenedFiles(filePath: string): void {
    const { _openedFiles, browserWindow } = this
    _openedFiles!.push(filePath)
    ipcMain.emit('watcher-watch-file', browserWindow, filePath)
  }

  /**
   * Change a path in the opened file list and update the watcher.
   */
  changeOpenedFilePath(pathname: string, oldPathname: string): void {
    const { _openedFiles, browserWindow } = this
    const index = _openedFiles!.findIndex((p) => p === oldPathname)
    if (index === -1) {
      // The old path was not found but add the new one.
      _openedFiles!.push(pathname)
    } else {
      _openedFiles![index] = pathname
    }
    ipcMain.emit('watcher-unwatch-file', browserWindow, oldPathname)
    ipcMain.emit('watcher-watch-file', browserWindow, pathname)
  }

  /**
   * Remove a path from the opened file list and stop watching the path.
   */
  removeFromOpenedFiles(pathname: string): void {
    const { _openedFiles, browserWindow } = this
    const index = _openedFiles!.findIndex((p) => p === pathname)
    if (index !== -1) {
      _openedFiles!.splice(index, 1)
    }
    ipcMain.emit('watcher-unwatch-file', browserWindow, pathname)
  }

  /**
   * Returns a score list for a given file list.
   */
  getCandidateScores(fileList: string[]): CandidateScore[] {
    const { _openedFiles, _openedRootDirectory, id } = this
    const buf: CandidateScore[] = []
    for (const pathname of fileList) {
      let score = 0
      if (_openedFiles!.some((p) => p === pathname)) {
        score = -1
      } else {
        if (isChildOfDirectory(_openedRootDirectory ?? '', pathname)) {
          score += 5
        }
        for (const item of _openedFiles!) {
          if (isChildOfDirectory(path.dirname(item), pathname)) {
            score += 1
          }
        }
      }
      buf.push({ id, score })
    }
    return buf
  }

  override reload(): void {
    const { id, browserWindow } = this

    // Close watchers
    ipcMain.emit('watcher-unwatch-all-by-id', id)

    // Reset saved state
    this._directoryToOpen = ''
    this._filesToOpen = []
    this._markdownToOpen = []
    this._unsavedTabsToOpen = []
    this._openedRootDirectory = ''
    this._openedFiles = []

    browserWindow!.webContents.once('did-finish-load', () => {
      this.lifecycle = WindowLifecycle.READY
      const { preferences } = this._accessor
      const { sideBarVisibility, restoreLayoutState, tabBarVisibility, sourceCodeModeEnabled } =
        preferences.getAll()
      const resolvedSideBarVisibility = restoreLayoutState ? !!sideBarVisibility : false
      const lineEnding = preferences.getPreferredEol()
      browserWindow!.webContents.send('mt::bootstrap-editor', {
        addBlankTab: true,
        markdownList: [],
        lineEnding,
        sideBarVisibility: resolvedSideBarVisibility,
        tabBarVisibility,
        sourceCodeModeEnabled
      })
    })

    browserWindow!.webContents.once('did-fail-load', (_event, errorCode, errorDescription, url) => {
      log.error(
        `The window failed to load or was cancelled: ${errorCode}; ${errorDescription}; @ ${url}`
      )
    })

    browserWindow!.webContents.once('render-process-gone', async(_event, { reason }) => {
      if (reason === 'clean-exit' || reason === 'abnormal-exit') return
      const msg = `The renderer process has crashed unexpected or is killed (${reason}).`
      log.error(msg)
      const { response } = await dialog.showMessageBox(browserWindow!, {
        type: 'warning',
        buttons: ['Close', 'Reload', 'Keep It Open'],
        message: 'MarkText has crashed',
        detail: msg
      })
      if (browserWindow === null || browserWindow.isDestroyed()) return
      switch (response) {
        case 0:
          return this.destroy()
        case 1:
          return this.reload()
      }
    })

    this.lifecycle = WindowLifecycle.LOADING
    super.reload()
  }

  override destroy(): void {
    this._clearCloseFallback()
    if (this._onCloseAck) {
      ipcMain.removeListener('mt::close-request-ack', this._onCloseAck)
      this._onCloseAck = null
    }

    super.destroy()

    // Watchers are freed from WindowManager.

    this._directoryToOpen = null
    this._filesToOpen = null
    this._markdownToOpen = null
    this._unsavedTabsToOpen = null
    this._openedRootDirectory = null
    this._openedFiles = null
  }

  /**
   * Cancel the pending close handshake: stop the unresponsive fallback timer
   * and allow future close requests.
   */
  private _clearCloseFallback(): void {
    this._isClosing = false
    if (this._closeAckTimer) {
      clearTimeout(this._closeAckTimer)
      this._closeAckTimer = null
    }
  }

  get openedRootDirectory(): string | null {
    return this._openedRootDirectory
  }

  /**
   * Inject crash-recovered unsaved tabs into this window (recovery accepted
   * by the user at startup). Tabs keep their unsaved content; named files are
   * registered in the opened-file list so watchers and menus stay consistent.
   */
  restoreUnsavedTabs(tabs: SnapshotTab[]): void {
    if (this.lifecycle === WindowLifecycle.QUITTED || tabs.length === 0) {
      return
    }

    const doRestore = (): void => {
      const { menu: appMenu } = this._accessor
      for (const tab of tabs) {
        if (tab.pathname && !this._openedFiles!.includes(tab.pathname)) {
          this.addToOpenedFiles(tab.pathname)
          appMenu.addRecentlyUsedDocument(tab.pathname)
        }
      }
      this.browserWindow!.webContents.send('mt::restore-unsaved-tabs', tabs)
    }

    if (this.lifecycle === WindowLifecycle.READY) {
      doRestore()
    } else {
      this.once('window-ready', doRestore)
    }
  }

  // --- private ---------------------------------

  /**
   * Open a new new tab from the markdown document.
   */
  private _doOpenTab(
    rawDocument: RawMarkdownDocument,
    options: Record<string, unknown>,
    selected: boolean
  ): void {
    const { _accessor, _openedFiles, browserWindow } = this
    const { menu: appMenu } = _accessor
    const { pathname } = rawDocument

    // Listen for file changed.
    ipcMain.emit('watcher-watch-file', browserWindow, pathname)

    appMenu.addRecentlyUsedDocument(pathname)
    _openedFiles!.push(pathname)
    browserWindow!.webContents.send('mt::open-new-tab', rawDocument, options, selected)
  }

  private _doOpenFilesToOpen(): void {
    if (this.lifecycle !== WindowLifecycle.READY) {
      throw new Error('Invalid state.')
    }

    if (this._directoryToOpen) {
      this.openFolder(this._directoryToOpen)
    }
    this._directoryToOpen = null

    for (const { doc, options, selected } of this._filesToOpen!) {
      this._doOpenTab(doc, options, selected)
    }
    this._filesToOpen!.length = 0
  }
}

export default EditorWindow
