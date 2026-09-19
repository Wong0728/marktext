import debounce from 'lodash/debounce'
import { useEditorStore } from './editor'

const BUFFERED_STATE_DEBOUNCE_MS = 1000
// Upper bound on how long continuous edits can defer a snapshot write. Without
// it, non-stop typing keeps resetting the 1s debounce so the snapshot never
// lands and a crash mid-session loses everything typed so far.
const BUFFERED_STATE_MAX_WAIT_MS = 5000
const BUFFERED_STATE_VERSION = 2

interface StoreCache {
  editorStore: ReturnType<typeof useEditorStore> | null
}

const stores: StoreCache = {
  editorStore: null
}

// Crash-recovery snapshot: only unsaved content is worth persisting. A `null`
// snapshot tells the main process to delete the snapshot file — the session
// has nothing to recover.
export const createBufferedState = (): Record<string, unknown> | null => {
  if (!stores.editorStore) {
    stores.editorStore = useEditorStore()
  }

  const editorState = stores.editorStore.CREATE_BUFFERED_STATE()
  if (!editorState) return null

  // Keep only tabs the user could lose: named files with unsaved edits and
  // untitled tabs that actually contain something.
  const unsavedTabs = editorState.tabs.filter(
    (tab) => !tab.isSaved && (tab.pathname || tab.markdown.trim().length > 0)
  )
  if (unsavedTabs.length === 0) return null

  return {
    version: BUFFERED_STATE_VERSION,
    tabs: unsavedTabs
  }
}

export const sendBufferedState = (): Promise<unknown> => {
  // Always invoke: `null` clears the snapshot on the main side.
  return window.electron.ipcRenderer.invoke('update-buffer-state', createBufferedState())
}

export const debouncedSendBufferedState = debounce(
  () => {
    sendBufferedState().catch((err) => {
      console.error('Failed to update buffered state', err)
    })
  },
  BUFFERED_STATE_DEBOUNCE_MS,
  { maxWait: BUFFERED_STATE_MAX_WAIT_MS }
)
