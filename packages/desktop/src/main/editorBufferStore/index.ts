import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import writeFileAtomic from 'write-file-atomic'
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import log from 'electron-log'
import { TypedEmitter } from '@shared/types/typedEmitter'

interface EditorBufferStorePaths {
  editorBufferStorePath: string
}

export interface SnapshotTab {
  pathname?: string
  filename?: string
  markdown?: string
  isSaved?: boolean
  [key: string]: unknown
}

interface SnapshotContent {
  tabs: SnapshotTab[]
  [key: string]: unknown
}

// No instance-level events emitted; kept as TypedEmitter for parity with the
// other main classes.
type EditorBufferStoreEvents = Record<string, unknown[]>

/**
 * Crash-recovery snapshot store.
 *
 * Each editor window continuously writes its *unsaved* tabs to
 * `<id>_editor_buffer_store.json` (or deletes the file when everything is
 * saved). On a clean window close the snapshot is deleted unconditionally —
 * the user has explicitly decided to save or discard. Any snapshot file found
 * at startup therefore means the previous session ended abnormally, and the
 * user is offered recovery of its unsaved tabs.
 */
class EditorBufferStore extends TypedEmitter<EditorBufferStoreEvents> {
  editorBufferStorePath: string

  constructor(paths: EditorBufferStorePaths) {
    super()

    const { editorBufferStorePath } = paths
    this.editorBufferStorePath = editorBufferStorePath

    this.init()
  }

  init(): void {
    if (!fs.existsSync(this.editorBufferStorePath)) {
      fs.mkdirSync(this.editorBufferStorePath, { recursive: true })
    }
    this._listenForIpcMain()
  }

  /**
   * Collect the unsaved tabs of all leftover snapshot files. Legacy session
   * buffers (which also contained saved tabs) are filtered down to unsaved
   * content only.
   */
  collectUnsavedTabs(): SnapshotTab[] {
    const tabs: SnapshotTab[] = []
    for (const filePath of this._listSnapshotFiles()) {
      try {
        const snapshot = this._readSnapshotFile(filePath)
        for (const tab of snapshot.tabs) {
          const markdown = typeof tab.markdown === 'string' ? tab.markdown : ''
          const isRecoverable = !tab.isSaved && (tab.pathname || markdown.trim().length > 0)
          if (isRecoverable) {
            tabs.push(tab)
          }
        }
      } catch (e) {
        log.error(`Failed to read snapshot file "${filePath}":`, e)
      }
    }
    return tabs
  }

  /**
   * Delete the snapshot of a single window (clean close).
   */
  deleteSnapshot(id: string | undefined): void {
    if (!id) {
      return
    }
    const filePath = this._snapshotFilePath(id)
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    } catch (e) {
      log.error(`Failed to delete snapshot file "${filePath}":`, e)
    }
  }

  /**
   * Delete all snapshot files (after the recovery decision at startup).
   */
  deleteAllSnapshots(): void {
    for (const filePath of this._listSnapshotFiles()) {
      try {
        fs.unlinkSync(filePath)
      } catch (e) {
        log.error(`Failed to delete snapshot file "${filePath}":`, e)
      }
    }
  }

  /**
   * The absolute paths of all snapshot files currently on disk. Callers can
   * capture this set before an `await` and later delete only those files, so a
   * snapshot written by a new window during the wait is not clobbered.
   */
  listSnapshotFiles(): string[] {
    return this._listSnapshotFiles()
  }

  /**
   * Delete a specific set of snapshot files (by absolute path). Used by the
   * startup recovery flow to remove only the pre-existing leftover snapshots
   * and never the fresh ones the current session is already writing.
   */
  deleteSnapshotsByPaths(filePaths: string[]): void {
    for (const filePath of filePaths) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath)
        }
      } catch (e) {
        log.error(`Failed to delete snapshot file "${filePath}":`, e)
      }
    }
  }

  updateBufferState(e: IpcMainInvokeEvent, newState: unknown): boolean {
    const win = BrowserWindow.fromWebContents(e.sender)
    const restoreBufferId = (win as unknown as { restoreBufferId?: string })?.restoreBufferId

    if (!restoreBufferId) {
      log.warn('No restoreBufferId found for window, skipping buffer state update')
      return false
    }

    const filePath = this._snapshotFilePath(restoreBufferId)

    // `null` means there is nothing unsaved to protect — drop the snapshot.
    if (newState == null) {
      this.deleteSnapshot(restoreBufferId)
      return true
    }

    this.writeBufferStoreFile(filePath, newState)
    return true
  }

  writeBufferStoreFile(filePath: string, newState: unknown): void {
    // Durable atomic write: write-file-atomic writes to a temp file, fsyncs it,
    // then renames it over the target, so a power loss can't leave this
    // crash-recovery snapshot truncated or zero-filled (#3786).
    writeFileAtomic.sync(filePath, JSON.stringify(newState), 'utf8')
  }

  getUnUsedBufferUUID(): string {
    let uuid: string
    do {
      uuid = randomUUID()
    } while (fs.existsSync(this._snapshotFilePath(uuid)))

    return uuid
  }

  // --- private --------------------------------

  private _snapshotFilePath(id: string): string {
    return path.join(this.editorBufferStorePath, `${id}_editor_buffer_store.json`)
  }

  private _listSnapshotFiles(): string[] {
    const results: string[] = []
    if (!fs.existsSync(this.editorBufferStorePath)) {
      return results
    }

    const entries = fs.readdirSync(this.editorBufferStorePath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('_editor_buffer_store.json')) {
        results.push(path.join(this.editorBufferStorePath, entry.name))
      }
    }
    return results
  }

  private _readSnapshotFile(filePath: string): SnapshotContent {
    const content = fs.readFileSync(filePath, 'utf8')
    if (!content.trim()) {
      throw new Error('Snapshot file is empty.')
    }

    const snapshot = JSON.parse(content) as SnapshotContent
    if (!snapshot || !Array.isArray(snapshot.tabs)) {
      throw new Error('Invalid editor snapshot state.')
    }

    return snapshot
  }

  private _listenForIpcMain(): void {
    ipcMain.handle('update-buffer-state', (e, newState) => {
      return this.updateBufferState(e, newState)
    })
  }
}

export default EditorBufferStore
