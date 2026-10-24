import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.hoisted(() => {
  const w = globalThis as unknown as {
    window?: {
      path?: { sep: string; dirname: (p: string) => string }
      fileUtils?: { isSamePathSync: (a: string, b: string) => boolean }
      electron?: { ipcRenderer: { send: (...a: unknown[]) => void; on: Mock } }
    }
  }
  w.window ??= {}
  w.window.path ??= { sep: '/', dirname: (p: string) => p }
  w.window.fileUtils ??= { isSamePathSync: (a, b) => a === b }
  w.window.electron ??= { ipcRenderer: { send: () => {}, on: vi.fn() } }
})

vi.mock('@/services/notification', () => ({
  default: { notify: vi.fn(), name: 'notify' }
}))
vi.mock('@/store/bufferedState', () => ({ debouncedSendBufferedState: vi.fn() }))

import bus from '@/bus'
import { useEditorStore } from '@/store/editor'
import type { FileNotification, IFileState } from '@shared/types/files'

/**
 * The external-change banner flow (store/editor.ts): a watched file changed
 * on disk while the tab holds unsaved edits. Nothing is applied silently —
 * the banner offers Load (discard edits), Merge (three-way against the merge
 * base), Close (keep editing, stash the disk version).
 */
describe('useEditorStore external-change banner', () => {
  const makeDirtyTab = (
    store: ReturnType<typeof useEditorStore>,
    overrides: Partial<IFileState> = {}
  ) => {
    const tab = {
      id: 'tab-1',
      filename: 'a.md',
      pathname: '/x/a.md',
      markdown: 'A\nB user edit\nC\nD\nE',
      baseMarkdown: 'A\nB\nC\nD\nE',
      isSaved: false,
      notifications: [],
      history: { stack: [], index: 0 },
      cursor: undefined,
      scrollTop: 0,
      ...overrides
    }
    store.tabs = [tab] as unknown as typeof store.tabs
    store.tabIdToIndex = { 'tab-1': 0 }
    return tab as IFileState
  }

  const fire = (store: ReturnType<typeof useEditorStore>, markdown: string) =>
    store.OFFER_EXTERNAL_CHANGE_RESOLUTION({
      pathname: '/x/a.md',
      data: { markdown, filename: 'a.md' }
    })

  const banner = (store: ReturnType<typeof useEditorStore>): FileNotification =>
    store.tabs[0].notifications[0] as FileNotification

  const clickMerge = (store: ReturnType<typeof useEditorStore>) => {
    const item = banner(store)
    item.secondaryAction?.()
  }

  // Mimic notifications.vue: the banner is consumed (shifted) BEFORE the
  // action runs.
  const clickPrimary = (store: ReturnType<typeof useEditorStore>, status: boolean) => {
    const item = store.tabs[0].notifications.shift() as FileNotification | undefined
    item?.action?.(status)
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ;(window.electron.ipcRenderer.on as Mock).mockReset()
  })

  it('offers the three-way choice without touching content', () => {
    const store = useEditorStore()
    const tab = makeDirtyTab(store)

    fire(store, 'A\nB\nC disk edit\nD\nE')

    // Nothing applied: the buffer and the merge base are untouched.
    expect(tab.markdown).toBe('A\nB user edit\nC\nD\nE')
    expect(tab.baseMarkdown).toBe('A\nB\nC\nD\nE')
    expect(tab.pendingExternalChange?.markdown).toBe('A\nB\nC disk edit\nD\nE')
    expect(tab.isSaved).toBe(false)
    // The banner carries Load (primary), Merge (secondary) and close.
    const item = banner(store)
    expect(item.showConfirm).toBe(true)
    expect(item.primaryLabel).toBeTruthy()
    expect(item.secondaryLabel).toBeTruthy()
    expect(typeof item.secondaryAction).toBe('function')
  })

  it('applies a clean merge only when the user picks Merge', () => {
    const store = useEditorStore()
    const tab = makeDirtyTab(store)
    store.currentFile = tab
    const payloads: Array<Record<string, unknown>> = []
    bus.on('file-changed', (payload: unknown) => {
      payloads.push(payload as Record<string, unknown>)
    })

    fire(store, 'A\nB\nC disk edit\nD\nE')
    clickMerge(store)

    expect(tab.markdown).toBe('A\nB user edit\nC disk edit\nD\nE')
    expect(tab.isSaved).toBe(false)
    // `theirs` is fully incorporated and becomes the next merge base.
    expect(tab.baseMarkdown).toBe('A\nB\nC disk edit\nD\nE')
    expect(tab.pendingExternalChange).toBeUndefined()
    // The applied theirs hunk drives the merge highlight (merged line 2).
    expect(tab.lastMergedRegions).toEqual([{ start: 2, end: 3 }])
    // Active tab: the engine gets the merged content as an external merge.
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({
      id: 'tab-1',
      markdown: 'A\nB user edit\nC disk edit\nD\nE',
      isExternalMerge: true
    })
    // The choice banner is replaced by the merged info banner.
    expect(store.tabs[0].notifications).toHaveLength(1)
    expect(banner(store).showConfirm).toBe(false)
    expect(banner(store).secondaryLabel).toBeTruthy()
  })

  it('never touches the engine for a background tab', () => {
    const store = useEditorStore()
    const tab = makeDirtyTab(store)
    const payloads: unknown[] = []
    bus.on('file-changed', (payload: unknown) => payloads.push(payload))

    fire(store, 'A\nB\nC disk edit\nD\nE')
    clickMerge(store)

    expect(tab.markdown).toBe('A\nB user edit\nC disk edit\nD\nE')
    expect(payloads).toHaveLength(0)
  })

  it('re-offers the choice when the merge conflicts', () => {
    const store = useEditorStore()
    const tab = makeDirtyTab(store)

    // Both sides rewrote B (theirs collides with the user's B edit).
    fire(store, 'A\nB user edit 2\nC\nD\nE')
    clickMerge(store)

    // Nothing applied: the user's buffer and the merge base are intact.
    expect(tab.markdown).toBe('A\nB user edit\nC\nD\nE')
    expect(tab.baseMarkdown).toBe('A\nB\nC\nD\nE')
    expect(tab.pendingExternalChange?.markdown).toBe('A\nB user edit 2\nC\nD\nE')
    // The conflict banner still offers Load and a Merge retry.
    expect(store.tabs[0].notifications).toHaveLength(1)
    expect(banner(store).showConfirm).toBe(true)
    expect(banner(store).primaryLabel).toBeTruthy()
    expect(banner(store).secondaryLabel).toBeTruthy()
  })

  it('applies the merge on retry after the user resolved the overlap', () => {
    const store = useEditorStore()
    const tab = makeDirtyTab(store)

    fire(store, 'A\nB theirs\nC\nD\nE') // conflicts with the user's B edit
    clickMerge(store)
    // Nothing applied while the overlap exists.
    expect(tab.markdown).toBe('A\nB user edit\nC\nD\nE')

    // The user gives up their B wording (back to the base text); the retry
    // merges cleanly and brings in the disk version.
    tab.markdown = 'A\nB\nC\nD\nE'
    clickMerge(store)

    expect(tab.markdown).toBe('A\nB theirs\nC\nD\nE')
    expect(tab.baseMarkdown).toBe('A\nB theirs\nC\nD\nE')
    expect(tab.pendingExternalChange).toBeUndefined()
  })

  it('loads the latest stash when the user picks Load', () => {
    const store = useEditorStore()
    makeDirtyTab(store)
    const loadChangeSpy = vi.spyOn(store, 'loadChange').mockImplementation(() => {})

    fire(store, 'A\nB user edit 2\nC\nD\nE') // stash
    fire(store, 'A\nB user edit 3\nC\nD\nE') // burst replaces the stash
    clickPrimary(store, true)

    expect(loadChangeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/x/a.md',
        data: expect.objectContaining({ markdown: 'A\nB user edit 3\nC\nD\nE' })
      })
    )
  })

  it('keeps only the stash when the user closes the banner', () => {
    const store = useEditorStore()
    const tab = makeDirtyTab(store)

    fire(store, 'A\nB user edit 2\nC\nD\nE')
    clickPrimary(store, false)

    expect(tab.markdown).toBe('A\nB user edit\nC\nD\nE')
    expect(tab.pendingExternalChange?.markdown).toBe('A\nB user edit 2\nC\nD\nE')
    expect(store.tabs[0].notifications).toHaveLength(0)
  })

  it('replaces the stash when a burst of external rewrites arrives', () => {
    const store = useEditorStore()
    const tab = makeDirtyTab(store)

    fire(store, 'A\nB user edit 2\nC\nD\nE') // conflicts
    fire(store, 'A\nB user edit 3\nC\nD\nE') // conflicts again

    expect(tab.pendingExternalChange?.markdown).toBe('A\nB user edit 3\nC\nD\nE')
    expect(tab.markdown).toBe('A\nB user edit\nC\nD\nE')
  })

  it('falls back to the conflict banner when no merge base is known', () => {
    const store = useEditorStore()
    const tab = makeDirtyTab(store, { baseMarkdown: undefined })

    fire(store, 'A\nB\nC disk edit\nD\nE')
    clickMerge(store)

    expect(tab.markdown).toBe('A\nB user edit\nC\nD\nE')
    expect(tab.pendingExternalChange?.markdown).toBe('A\nB\nC disk edit\nD\nE')
    expect(store.tabs[0].notifications).toHaveLength(1)
    expect(banner(store).showConfirm).toBe(true)
  })

  it('only moves the base when the disk adds nothing beyond the buffer', () => {
    const store = useEditorStore()
    const tab = makeDirtyTab(store, {
      markdown: 'A\nB edited\nC\nD\nE',
      baseMarkdown: 'A\nB\nC\nD\nE'
    })
    const payloads: unknown[] = []
    bus.on('file-changed', (payload: unknown) => payloads.push(payload))

    // The disk change equals what the user already did.
    fire(store, 'A\nB edited\nC\nD\nE')
    clickMerge(store)

    expect(tab.baseMarkdown).toBe('A\nB edited\nC\nD\nE')
    expect(tab.markdown).toBe('A\nB edited\nC\nD\nE')
    expect(payloads).toHaveLength(0)
    // Nothing changed, so the choice banner is simply dropped.
    expect(store.tabs[0].notifications).toHaveLength(0)
  })

  it('resolves a stashed conflict when the tab is saved', () => {
    const store = useEditorStore()
    const tab = makeDirtyTab(store)
    tab.notifications.push({
      msg: 'conflict',
      showConfirm: true,
      style: 'warn',
      exclusiveType: 'file_changed',
      action: () => {}
    })
    store.LISTEN_FOR_SET_PATHNAME()
    const onMock = window.electron.ipcRenderer.on as Mock
    const savedHandler = onMock.mock.calls.find((c) => c[0] === 'mt::tab-saved')![1] as (
      e: unknown,
      tabId: string
    ) => void

    fire(store, 'A\nB user edit 2\nC\nD\nE') // stash a conflict
    tab.lastMergedRegions = [{ start: 0, end: 1 }] // an earlier merge's highlight
    savedHandler(null, 'tab-1')

    expect(tab.pendingExternalChange).toBeUndefined()
    expect(tab.baseMarkdown).toBe('A\nB user edit\nC\nD\nE')
    expect(tab.isSaved).toBe(true)
    // Saving resolves the conflict AND retires the merge highlight.
    expect(tab.notifications).toHaveLength(0)
    expect(tab.lastMergedRegions).toBeUndefined()
  })
})
