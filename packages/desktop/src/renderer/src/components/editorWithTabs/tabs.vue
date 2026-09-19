<template>
  <div
    class="editor-tabs"
    @dragover="onTabStripDragOver"
    @dragleave="onTabStripDragLeave"
    @drop="onTabStripDrop"
  >
    <div
      ref="tabContainer"
      class="scrollable-tabs"
    >
      <ul
        ref="tabDropContainer"
        class="tabs-container"
      >
        <li
          v-for="file of tabs"
          :key="file.id"
          draggable="true"
          :title="file.pathname"
          :class="{
            active: currentFile?.id === file.id,
            unsaved: !file.isSaved,
            dragging: draggingTabId === file.id,
            'drop-before': isDropBefore(file),
            'drop-after': isDropAfter(file)
          }"
          :data-id="file.id"
          @click.stop="selectFile(file)"
          @click.middle="closeTab(file.id)"
          @contextmenu.prevent="handleContextMenu($event, file)"
          @dragstart="onDragStart($event, file)"
          @dragend="onDragEnd($event)"
        >
          <span>{{ file.filename }}</span>
          <span class="unsaved-dot" />
          <el-icon
            class="close-icon"
            :size="12"
            @click.stop="removeFileInTab(file)"
          >
            <Close />
          </el-icon>
        </li>
      </ul>
    </div>
    <div
      class="new-file"
      @click.stop="newFile()"
    >
      <el-icon :size="16">
        <Plus />
      </el-icon>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useEditorStore } from '@/store/editor'
import { useLayoutStore } from '@/store/layout'
import { storeToRefs } from 'pinia'
import { Plus, Close } from '@element-plus/icons-vue'
import { showContextMenu } from '../../contextMenu/tabs'
import bus from '../../bus'
import type { IFileState, TabDragPayload } from '@shared/types/files'

const editorStore = useEditorStore()
const layoutStore = useLayoutStore()

const { currentFile, tabs } = storeToRefs(editorStore)

// MIME type used to carry the dragged tab between windows. Data for custom
// types is only readable by the window that receives the drop.
const TAB_MIME = 'application/x-marktext-tab'

const tabContainer = ref<HTMLElement | null>(null)
const tabDropContainer = ref<HTMLElement | null>(null)

// State of an active tab drag: the serialized payload, the dragged tab and
// where the insertion marker should be rendered.
let currentDragPayload: TabDragPayload | null = null
const draggingTabId = ref<string | null>(null)
const dropMarker = ref<{ id: string | null; after: boolean } | null>(null)

// Methods incorporated from tabsMixins
const selectFile = (file: IFileState) => {
  if (file.id !== currentFile.value?.id) {
    editorStore.UPDATE_CURRENT_FILE(file)
  }
}

const removeFileInTab = (file: IFileState) => {
  const { isSaved } = file
  if (isSaved) {
    editorStore.FORCE_CLOSE_TAB(file)
  } else {
    editorStore.CLOSE_UNSAVED_TAB(file)
  }
}

// Original methods
const newFile = () => {
  editorStore.NEW_UNTITLED_TAB({})
}

// Keep the active tab visible when the selection changes by something other
// than a direct click on a visible tab (keyboard cycle, switch-by-index, open
// from the sidebar): the strip has `overflow: hidden` and only scrolls on the
// wheel, so an off-screen tab would otherwise stay hidden (#3958).
const scrollActiveTabIntoView = () => {
  const container = tabContainer.value
  if (!container) return
  const activeTab = container.querySelector<HTMLElement>('li.active')
  if (!activeTab) return

  const containerRect = container.getBoundingClientRect()
  const tabRect = activeTab.getBoundingClientRect()
  if (tabRect.left < containerRect.left) {
    container.scrollLeft -= containerRect.left - tabRect.left
  } else if (tabRect.right > containerRect.right) {
    container.scrollLeft += tabRect.right - containerRect.right
  }
}

const handleTabScroll = (event: WheelEvent) => {
  // Use mouse wheel value first but prioritize X value more (e.g. touchpad input).
  let delta = event.deltaY
  if (event.deltaX !== 0) {
    delta = event.deltaX
  }

  const tabsEl = tabContainer.value
  if (!tabsEl) return
  const newLeft = Math.max(0, Math.min(tabsEl.scrollLeft + delta, tabsEl.scrollWidth))
  tabsEl.scrollLeft = newLeft
}

const closeTab = (tabId: unknown) => {
  const tab = tabs.value.find((f) => f.id === tabId)
  if (tab) {
    editorStore.CLOSE_TAB(tab)
  }
}

const closeOthers = (tabId: unknown) => {
  const tab = tabs.value.find((f) => f.id === tabId)
  if (tab) {
    editorStore.CLOSE_OTHER_TABS(tab)
  }
}

const closeSaved = () => {
  editorStore.CLOSE_SAVED_TABS()
}

const closeAll = () => {
  editorStore.CLOSE_ALL_TABS()
}

const changeMaxWidth = (width: unknown) => {
  layoutStore.CHANGE_SIDE_BAR_WIDTH(width as number)
}

const rename = (tabId: unknown) => {
  const tab = tabs.value.find((f) => f.id === tabId)
  if (tab && tab.pathname) {
    editorStore.RENAME_FILE(tab)
  }
}

const copyPath = (tabId: unknown) => {
  const tab = tabs.value.find((f) => f.id === tabId)
  if (tab && tab.pathname) {
    window.electron.clipboard.writeText(tab.pathname)
  }
}

const showInFolder = (tabId: unknown) => {
  const tab = tabs.value.find((f) => f.id === tabId)
  if (tab && tab.pathname) {
    window.electron.shell.showItemInFolder(tab.pathname)
  }
}

const handleContextMenu = (event: MouseEvent, tab: IFileState) => {
  if (tab.id) {
    showContextMenu(event, tab)
  }
}

// --- tab drag & drop ---------------------------------

const serializeTab = (file: IFileState) => {
  return {
    id: file.id,
    pathname: file.pathname,
    filename: file.filename,
    markdown: file.markdown,
    isSaved: file.isSaved,
    encoding: file.encoding,
    lineEnding: file.lineEnding,
    adjustLineEndingOnSave: file.adjustLineEndingOnSave,
    trimTrailingNewline: file.trimTrailingNewline
  }
}

const buildTabPayload = (file: IFileState): TabDragPayload | null => {
  const windowId = window.marktext?.env?.windowId
  if (windowId == null) return null
  return {
    dragId: crypto.randomUUID(),
    sourceWindowId: windowId,
    tab: serializeTab(file)
  }
}

const isTabDrag = (event: DragEvent): boolean => {
  const { dataTransfer } = event
  return !!dataTransfer && Array.from(dataTransfer.types).includes(TAB_MIME)
}

// Insertion index within the tab list *without* the dragged tab: the number
// of remaining tabs whose center lies left of the pointer.
const computeDropIndex = (clientX: number): number => {
  const container = tabDropContainer.value
  if (!container) return 0
  const lis = Array.from(container.querySelectorAll<HTMLLIElement>('li[data-id]'))
  const isLocalDrag = draggingTabId.value != null
  let index = 0
  for (const li of lis) {
    if (isLocalDrag && li.dataset.id === draggingTabId.value) continue
    const rect = li.getBoundingClientRect()
    if (clientX > rect.left + rect.width / 2) {
      index++
    }
  }
  return index
}

const updateDropMarker = (clientX: number): void => {
  const container = tabDropContainer.value
  if (!container) return
  const lis = Array.from(container.querySelectorAll<HTMLLIElement>('li[data-id]'))
  const isLocalDrag = draggingTabId.value != null

  for (const li of lis) {
    if (isLocalDrag && li.dataset.id === draggingTabId.value) continue
    const rect = li.getBoundingClientRect()
    if (clientX <= rect.left + rect.width / 2) {
      dropMarker.value = { id: li.dataset.id ?? null, after: false }
      return
    }
  }
  const last = lis.length ? lis[lis.length - 1] : null
  dropMarker.value = last ? { id: last.dataset.id ?? null, after: true } : null
}

const isDropBefore = (file: IFileState): boolean => {
  const marker = dropMarker.value
  return !!marker && !marker.after && marker.id === file.id
}

const isDropAfter = (file: IFileState): boolean => {
  const marker = dropMarker.value
  return !!marker && marker.after && marker.id === file.id
}

// Simple edge auto-scroll while a tab is dragged near the strip's borders.
let autoScrollDir = 0
let autoScrollRaf = 0

const autoScrollStep = (): void => {
  const el = tabContainer.value
  if (el && autoScrollDir !== 0) {
    el.scrollLeft += autoScrollDir
    autoScrollRaf = requestAnimationFrame(autoScrollStep)
  } else {
    autoScrollRaf = 0
  }
}

const updateAutoScroll = (clientX: number): void => {
  const el = tabContainer.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  autoScrollDir = clientX - rect.left < 28 ? -8 : rect.right - clientX < 28 ? 8 : 0
  if (autoScrollDir !== 0 && !autoScrollRaf) {
    autoScrollRaf = requestAnimationFrame(autoScrollStep)
  }
}

const stopAutoScroll = (): void => {
  autoScrollDir = 0
  if (autoScrollRaf) {
    cancelAnimationFrame(autoScrollRaf)
    autoScrollRaf = 0
  }
}

const onDragStart = (event: DragEvent, file: IFileState): void => {
  const payload = buildTabPayload(file)
  if (!event.dataTransfer || !payload) return
  event.dataTransfer.setData(TAB_MIME, JSON.stringify(payload))
  event.dataTransfer.effectAllowed = 'move'
  currentDragPayload = payload
  draggingTabId.value = file.id
}

const onTabStripDragOver = (event: DragEvent): void => {
  if (!isTabDrag(event)) return
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
  updateDropMarker(event.clientX)
  updateAutoScroll(event.clientX)
}

const onTabStripDragLeave = (event: DragEvent): void => {
  if (!isTabDrag(event)) return
  const container = tabDropContainer.value
  if (
    container &&
    event.relatedTarget instanceof Node &&
    container.contains(event.relatedTarget)
  ) {
    return
  }
  dropMarker.value = null
  stopAutoScroll()
}

const onTabStripDrop = (event: DragEvent): void => {
  dropMarker.value = null
  stopAutoScroll()
  const { dataTransfer } = event
  if (!dataTransfer || !isTabDrag(event)) return
  event.preventDefault()

  const raw = dataTransfer.getData(TAB_MIME)
  if (!raw) return
  let payload: TabDragPayload | null = null
  try {
    payload = JSON.parse(raw) as TabDragPayload
  } catch {
    return
  }
  if (!payload || !payload.tab) return

  const toIndex = computeDropIndex(event.clientX)
  if (payload.sourceWindowId === window.marktext?.env?.windowId) {
    // Dropped within this window's tab bar: reorder.
    editorStore.MOVE_TAB_TO_INDEX({ fromId: payload.tab.id, toIndex })
  } else {
    // Dropped from another window: ask main to open the tab here. The source
    // window closes its tab once its dragend reports the tab was adopted.
    window.electron.ipcRenderer.invoke('mt::tab-drag-adopt', payload)
  }
}

const onDragEnd = (event: DragEvent): void => {
  const payload = currentDragPayload
  currentDragPayload = null
  draggingTabId.value = null
  dropMarker.value = null
  stopAutoScroll()

  // `dropEffect === 'none'` means the tab was not dropped on this window's
  // tab bar; let main decide whether the tab merges into another window,
  // detaches into a new window, or the drag is cancelled.
  if (!payload || !event.dataTransfer || event.dataTransfer.dropEffect !== 'none') {
    return
  }

  window.electron.ipcRenderer
    .invoke('mt::tab-drag-finished', payload.dragId, payload)
    .then((result) => {
      if (result && result.adopted) {
        const tab = tabs.value.find((f) => f.id === payload!.tab.id)
        if (tab) {
          editorStore.FORCE_CLOSE_TAB(tab)
        }
      }
    })
}

// Move a tab into its own new window (tab context menu).
const openInNewWindow = (tabId: unknown) => {
  const tab = tabs.value.find((f) => f.id === tabId)
  if (!tab) return
  const windowId = window.marktext?.env?.windowId
  if (windowId == null) return
  const payload: TabDragPayload = {
    dragId: crypto.randomUUID(),
    sourceWindowId: windowId,
    tab: serializeTab(tab)
  }
  window.electron.ipcRenderer.invoke('mt::move-tab-to-new-window', payload).then((ok) => {
    if (ok) {
      const moved = tabs.value.find((f) => f.id === tab.id)
      if (moved) {
        editorStore.FORCE_CLOSE_TAB(moved)
      }
    }
  })
}

watch(
  () => currentFile.value?.id,
  () => {
    nextTick(scrollActiveTabIntoView)
  }
)

onMounted(() => {
  bus.on('TABS::close-this', closeTab)
  bus.on('TABS::close-others', closeOthers)
  bus.on('TABS::close-saved', closeSaved)
  bus.on('TABS::close-all', closeAll)
  bus.on('TABS::rename', rename)
  bus.on('TABS::copy-path', copyPath)
  bus.on('TABS::show-in-folder', showInFolder)
  bus.on('TABS::open-in-new-window', openInNewWindow)
  bus.on('EDITOR_TABS::change-max-width', changeMaxWidth)

  const tabsEl = tabContainer.value
  if (!tabsEl) return

  // Allow to scroll through the tabs by mouse wheel or touchpad.
  tabsEl.addEventListener('wheel', handleTabScroll)
})

onBeforeUnmount(() => {
  const tabsEl = tabContainer.value
  if (tabsEl) {
    tabsEl.removeEventListener('wheel', handleTabScroll)
  }

  stopAutoScroll()

  // Remove event listeners
  bus.off('TABS::close-this', closeTab)
  bus.off('TABS::close-others', closeOthers)
  bus.off('TABS::close-saved', closeSaved)
  bus.off('TABS::close-all', closeAll)
  bus.off('TABS::rename', rename)
  bus.off('TABS::copy-path', copyPath)
  bus.off('TABS::show-in-folder', showInFolder)
  bus.off('TABS::open-in-new-window', openInNewWindow)
  bus.off('EDITOR_TABS::change-max-width', changeMaxWidth)
})
</script>

<style scoped>
.close-icon {
  cursor: pointer;
  transition: opacity 0.15s ease-in-out;
}

.close-icon:hover {
  color: var(--focusColor);
}

.editor-tabs {
  position: relative;
  display: flex;
  flex-direction: row;
  height: 28px;
  user-select: none;
  box-shadow: 0px 0px 9px 2px rgba(0, 0, 0, 0.1);
  overflow: hidden;
  &:hover > .new-file {
    opacity: 1 !important;
  }
}
.scrollable-tabs {
  flex: 0 1 auto;
  height: 28px;
  overflow: hidden;
}
.tabs-container {
  min-width: min-content;
  list-style: none;
  margin: 0;
  padding: 0;
  height: 28px;
  position: relative;
  display: flex;
  flex-direction: row;
  overflow-y: hidden;
  z-index: 2;
  &::-webkit-scrollbar:horizontal {
    display: none;
  }
  & > li {
    transition: all 0.15s ease-in-out;
    position: relative;
    padding: 0 8px;
    color: var(--editorColor50);
    font-size: 12px;
    line-height: 28px;
    height: 28px;
    max-width: 280px;
    display: flex;
    align-items: center;
    &.dragging {
      opacity: 0.4;
    }
    &.drop-before {
      box-shadow: inset 2px 0 0 var(--themeColor);
    }
    &.drop-after {
      box-shadow: inset -2px 0 0 var(--themeColor);
    }
    & > .close-icon {
      opacity: 0;
    }
    &:focus {
      outline: none;
    }
    &:hover {
      background: var(--floatBgColor) !important;
    }
    &:hover > .close-icon {
      opacity: 1;
    }
    &:hover > .unsaved-dot {
      display: none;
    }
    & > span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-right: 3px;
    }
    & > .unsaved-dot {
      display: none;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--themeColor);
      flex-shrink: 0;
    }
  }
  & > li.unsaved:not(.active) {
    & > .close-icon {
      opacity: 0;
    }
    & > .unsaved-dot {
      display: block;
    }
    &:hover > .close-icon {
      opacity: 1;
    }
    &:hover > .unsaved-dot {
      display: none;
    }
  }
  & > li.active {
    background: var(--itemBgColor);
    z-index: 3;
    &:after {
      content: '';
      position: absolute;
      left: 0;
      bottom: 0;
      right: 0;
      height: 2px;
      background: var(--themeColor);
    }
    & > .close-icon {
      opacity: 1;
    }
    & > .unsaved-dot {
      display: none;
    }
  }
}
.editor-tabs > .new-file {
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  border-right: none;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: space-around;
  cursor: pointer;
  color: var(--editorColor50);
  opacity: 0;
  &.always-visible {
    opacity: 1;
  }
}

.editor-tabs > .new-file:hover {
  transition: all 0.15s ease-in-out;
  & > svg {
    fill: var(--focusColor);
  }
}
</style>
