<template>
  <div
    ref="sourceCodeContainer"
    class="source-code"
    @scroll.passive="updateActiveHeadingFromScroll"
  />
</template>

<script setup lang="ts">
import {
  registerSourceView,
  captureSourceHistory,
  restoreSourceHistory
} from '../../services/documentMode'
import { ref, shallowRef, markRaw, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useEditorStore } from '@/store/editor'
import { usePreferencesStore } from '@/store/preferences'
import {
  findMarkdownHeadingLine,
  getMarkdownHeadingLines,
  scrollSourceEditorToLine
} from '@/util/sourceModeToc'
import { storeToRefs } from 'pinia'
import type CodeMirror from 'codemirror'
import codeMirror, { setCursorAtFirstLine, setTextDirection } from '../../codeMirror'
import { wordCount as getWordCount } from '@muyajs/core'
import { adjustCursor, isWindows } from '../../util'
import { getSourceExtraKeys } from '../../codeMirror/keybindings'
import bus from '../../bus'
import { oneDarkThemes, railscastsThemes } from '@/config'

interface MuyaIndexCursorLike {
  anchor: CodeMirror.Position
  focus: CodeMirror.Position
}

// Aliases for the fork's source-mode helpers (format-keybinding parity,
// merge-highlight), now backed by the real CodeMirror types.
type CMInstance = CodeMirror.Editor
type CMCursor = CodeMirror.Position

const props = defineProps<{
  markdown?: string
  muyaIndexCursor?: unknown
  textDirection: string
}>()

const editorStore = useEditorStore()
const preferencesStore = usePreferencesStore()

const sourceCodeContainer = ref<HTMLDivElement | null>(null)

const editor = shallowRef<CodeMirror.Editor | null>(null)
const viewDestroyed = ref(false)
const tabId = ref<string | null>(null)

const {
  theme,
  sourceCode,
  vimMode,
  sourceCodeLineNumbers,
  texMathDollars,
  texMathGfm,
  texMathSingleBackslash,
  texMathDoubleBackslash
} = storeToRefs(preferencesStore)
const { currentFile: currentTab } = storeToRefs(editorStore)

const isValidMuyaIndexCursor = (cursor: unknown): cursor is MuyaIndexCursorLike => {
  const c = cursor as MuyaIndexCursorLike | null | undefined
  return !!(c && c.anchor && c.focus)
}

watch(
  () => props.textDirection,
  (value, oldValue) => {
    if (value !== oldValue && editor.value) {
      setTextDirection(editor.value, value)
    }
  }
)

watch(vimMode, (value, oldValue) => {
  if (value !== oldValue && editor.value) {
    editor.value.setOption('keyMap', value ? 'vim' : 'default')
  }
})

watch(sourceCodeLineNumbers, (value) => {
  editor.value?.setOption('lineNumbers', value)
})

// A fresh instance reads these at mount; the watch is for a preference changed
// while the source view is already open (#5446).
const markdownMathMode = () => ({
  name: 'markdown-math',
  texMathDollars: texMathDollars.value,
  texMathGfm: texMathGfm.value,
  texMathSingleBackslash: texMathSingleBackslash.value,
  texMathDoubleBackslash: texMathDoubleBackslash.value
})

watch([texMathDollars, texMathGfm, texMathSingleBackslash, texMathDoubleBackslash], () => {
  editor.value?.setOption('mode', markdownMathMode())
})

const getMarkdownAndCursor = (cm: CodeMirror.Editor) => {
  let focus = cm.getCursor('head')
  let anchor = cm.getCursor('anchor')

  const markdown: string = cm.getValue()
  const convertToMuyaCursor = (cursor: CodeMirror.Position) => {
    const line = cm.getLine(cursor.line)
    const preLine = cm.getLine(cursor.line - 1)
    const nextLine = cm.getLine(cursor.line + 1)
    return adjustCursor(
      cursor,
      preLine,
      line,
      nextLine,
      (lineNumber) => {
        return cm.getLine(lineNumber)
      },
      cm.lineCount()
    )
  }

  anchor = convertToMuyaCursor(anchor)
  focus = convertToMuyaCursor(focus)

  // Normalize cursor that `anchor` is always before `focus` because
  // this is the expected behavior in Muya.
  if (anchor && focus && anchor.line > focus.line) {
    const tmpCursor = focus
    focus = anchor
    anchor = tmpCursor
  }
  return { cursor: { focus, anchor }, markdown }
}

const prepareTabSwitch = () => {
  if (tabId.value && editor.value) {
    const { cursor, markdown: newMarkdown } = getMarkdownAndCursor(editor.value)
    editorStore.LISTEN_FOR_CONTENT_CHANGE({
      id: tabId.value,
      markdown: newMarkdown,
      muyaIndexCursor: cursor
    })
    captureSourceHistory(
      tabId.value,
      editor.value,
      editorStore.tabs.find((tab) => tab.id === tabId.value)?.markdown
    )
    tabId.value = null
  }
}

interface FileChangePayloadLike {
  reason?: string
  id: string
  markdown?: string
  muyaIndexCursor?: unknown
}

const handleFileChange = (payload: unknown) => {
  const { id, markdown: newMarkdown, muyaIndexCursor, reason } = payload as FileChangePayloadLike
  if (reason === 'source-handoff') return
  if (!editor.value) return

  // On same-tab reload (external file change), preserve scroll across
  // setValue. Snapshot every plausible scroll element (the outer
  // .source-code div, CodeMirror's own scroller, and the nearest scrollable
  // ancestor) and restore each, since which one is actually active depends
  // on CodeMirror's height:auto + outer overflow:auto interplay. Re-apply
  // on nextTick and the next animation frame to outlast layout side-effects
  // from sibling handlers: muya editor.vue also listens for file-changed.
  // A cross-tab switch must instead commit the outgoing tab's state; the
  // fresh markdown from disk would otherwise overwrite uncommitted edits.
  const isSameTabReload = tabId.value && tabId.value === id
  const scrollTargets: Array<{ el: HTMLElement; top: number }> = []
  if (isSameTabReload) {
    const seen = new Set<HTMLElement>()
    const consider = (el: HTMLElement | null | undefined) => {
      if (el && !seen.has(el)) {
        seen.add(el)
        scrollTargets.push({ el, top: el.scrollTop })
      }
    }
    consider(sourceCodeContainer.value)
    consider(editor.value.getScrollerElement?.() as HTMLElement | null | undefined)
    let node: HTMLElement | null = sourceCodeContainer.value?.parentElement ?? null
    while (node && node !== document.body) {
      const overflowY = window.getComputedStyle(node).overflowY
      if (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        node.scrollHeight > node.clientHeight
      ) {
        consider(node)
        break
      }
      node = node.parentElement
    }
  } else {
    prepareTabSwitch()
    tabId.value = id
  }

  if (typeof newMarkdown === 'string' && editor.value.getValue() !== newMarkdown) {
    editor.value.setValue(newMarkdown)
  }
  if (!isSameTabReload) restoreSourceHistory(id, editor.value)

  if (isValidMuyaIndexCursor(muyaIndexCursor)) {
    const { anchor, focus } = muyaIndexCursor

    editor.value.setSelection(anchor, focus, { scroll: true })
  } else if (scrollTargets.length) {
    const restoreScroll = () => {
      for (const { el, top } of scrollTargets) el.scrollTop = top
    }
    restoreScroll()
    nextTick(restoreScroll)
    requestAnimationFrame(restoreScroll)
  } else {
    setCursorAtFirstLine(editor.value)
  }

  // Repaint the merge highlight for the (possibly switched) tab — the store
  // clears it on save / reload / next merge, so stale ranges can't survive.
  removeMergedHighlightClasses()
  applyMergedRegionHighlights()
}

const handleSelectAll = () => {
  if (!sourceCode.value) {
    return
  }

  if (editor.value && editor.value.hasFocus()) {
    editor.value.execCommand('selectAll')
  } else {
    const activeElement = document.activeElement as HTMLElement | null
    const nodeName = activeElement?.nodeName
    if (nodeName === 'INPUT' || nodeName === 'TEXTAREA') {
      const selectable = activeElement as HTMLInputElement | HTMLTextAreaElement | null
      if (selectable && typeof selectable.select === 'function') {
        selectable.select()
      }
    }
  }
}

const handleUndo = () => {
  if (!sourceCode.value) {
    return
  }

  if (editor.value) {
    editor.value.execCommand('undo')
  }
}

const handleRedo = () => {
  if (!sourceCode.value) {
    return
  }

  if (editor.value) {
    editor.value.execCommand('redo')
  }
}

interface ImageActionPayload {
  id: string
  result: string
  alt: string
}

const handleImageAction = (payload: unknown) => {
  const cm = editor.value
  if (!cm) return

  const { id, result, alt } = payload as ImageActionPayload
  const value: string = cm.getValue()
  const focus = cm.getCursor('focus')
  const anchor = cm.getCursor('anchor')
  const lines: string[] = value.split('\n')
  const index = lines.findIndex((line: string) => line.indexOf(id) > 0)

  if (index > -1) {
    const oldLine = lines[index]
    lines[index] = oldLine.replace(new RegExp(`!\\[${id}\\]\\(.*\\)`), `![${alt}](${result})`)
    const newValue = lines.join('\n')
    cm.setValue(newValue)
    const match = /(!\[.*\]\(.*\))/.exec(oldLine)
    if (!match) {
      return
    }
    const range = {
      start: match.index,
      end: match.index + match[1].length
    }
    const delta = alt.length + result.length + 5 - match[1].length

    const adjustPointer = (pointer: CodeMirror.Position) => {
      if (!pointer) {
        return
      }
      if (pointer.line !== index) {
        return
      }
      if (pointer.ch <= range.start) {
        // do nothing.
      } else if (pointer.ch > range.start && pointer.ch < range.end) {
        pointer.ch = range.start + alt.length + result.length + 5
      } else {
        pointer.ch += delta
      }
    }

    adjustPointer(focus)
    adjustPointer(anchor)
    if (focus && anchor) {
      cm.setSelection(anchor, focus, { scroll: true })
    } else {
      setCursorAtFirstLine(cm)
    }
  }
}

// `cursorActivity` fires per drag step, so key the dedup on the ranges rather
// than on `getSelection()`, which copies the whole selection.
let lastSelectionKey = ''

const selectionKey = (cm: CodeMirror.Editor): string =>
  cm
    .listSelections()
    .map(({ anchor, head }) => `${anchor.line}:${anchor.ch}-${head.line}:${head.ch}`)
    .join(',')

const updateSelectionWordCount = (cm: CodeMirror.Editor) => {
  const key = selectionKey(cm)
  if (key === lastSelectionKey && editorStore.selectionWordCount != null) return
  lastSelectionKey = key

  const selectedText = cm.getSelection()
  const hasSelection = selectedText.trim().length > 0
  if (!hasSelection && editorStore.selectionWordCount == null) return

  editorStore.SET_SELECTION_WORD_COUNT(hasSelection ? getWordCount(selectedText) : null)
}

const saveContent = (cm: CodeMirror.Editor) => {
  const { cursor, markdown: newMarkdown } = getMarkdownAndCursor(cm)
  const wordCount = getWordCount(newMarkdown)
  if (!viewDestroyed.value) {
    if (tabId.value) {
      editorStore.LISTEN_FOR_CONTENT_CHANGE({
        id: tabId.value,
        markdown: newMarkdown,
        wordCount,
        muyaIndexCursor: cursor
      })
    } else {
      // This may occur during tab switching but should not occur otherwise.
      console.warn('LISTEN_FOR_CONTENT_CHANGE: Cannot commit changes because not tab id was set!')
    }
  }
}

// --- external merge highlight -------------------------------------------
// The store keeps `lastMergedRegions` (line ranges of the changes the last
// external three-way merge applied, in current-content coordinates — see
// EXTERNAL_CHANGE_MERGE). Source-code mode paints them as line backgrounds
// so the merge banner's "view changes" entry has something to show. They
// clear on the first user edit here, on save, and on the next merge.

let mergedHighlightHandles: unknown[] = []

const removeMergedHighlightClasses = () => {
  const cm = editor.value
  if (!cm) return
  for (const handle of mergedHighlightHandles) {
    cm.removeLineClass(handle, 'background', 'mu-merged-line')
  }
  mergedHighlightHandles = []
}

const clearMergedRegions = () => {
  removeMergedHighlightClasses()
  const tab = currentTab.value
  if (tab?.lastMergedRegions) {
    tab.lastMergedRegions = undefined
  }
}

const applyMergedRegionHighlights = () => {
  const cm = editor.value
  const regions = currentTab.value?.lastMergedRegions
  if (!cm || !regions || regions.length === 0) return
  const lineCount = cm.lineCount()
  for (const region of regions) {
    const start = Math.max(0, Math.min(region.start, lineCount - 1))
    const end = Math.min(region.end, lineCount)
    for (let line = start; line < end; line++) {
      const handle = cm.getLineHandle(line)
      if (handle) {
        cm.addLineClass(handle, 'background', 'mu-merged-line')
        mergedHighlightHandles.push(handle)
      }
    }
  }
}

let headingMarkdown = ''
let headingLines: number[] = []

const setActiveHeadingAtLine = (line: number): void => {
  if (!editor.value) return
  const markdown = editor.value.getValue()
  if (markdown !== headingMarkdown) {
    headingMarkdown = markdown
    headingLines = getMarkdownHeadingLines(markdown)
  }
  let slug: string | null = null
  for (let index = 0; index < editorStore.listToc.length; index++) {
    const headingLine = headingLines[index] ?? -1
    if (headingLine < 0 || headingLine > line) break
    slug = editorStore.listToc[index].slug ?? null
  }
  editorStore.SET_ACTIVE_HEADING(slug)
}

const updateActiveHeadingFromScroll = (): void => {
  const container = sourceCodeContainer.value
  if (!container || !editor.value) return
  const top = container.getBoundingClientRect().top + 80
  const line = editor.value.lineAtHeight(top, 'window')
  setActiveHeadingAtLine(line)
}

const listenChange = (cm: CodeMirror.Editor) => {
  cm.on('cursorActivity', (instance: CodeMirror.Editor) => {
    saveContent(instance)
    updateSelectionWordCount(instance)
    setActiveHeadingAtLine(instance.getCursor().line)
  })
}

// #3580: in Source Code mode the WYSIWYG container is hidden, so the
// `scroll-to-header` bus event (emitted when a TOC entry is clicked) must scroll
// CodeMirror instead. Resolve the TOC entry to its heading line in the source.
const handleScrollToHeader = (slug: unknown) => {
  if (!editor.value) return
  const index = editorStore.listToc.findIndex((item) => item.slug === slug)
  if (index < 0) return
  const line = findMarkdownHeadingLine(editor.value.getValue(), index)
  if (line < 0) return
  // `.source-code` is the scroll container (CodeMirror renders full-height with
  // viewportMargin: Infinity, so its own scroller never scrolls).
  scrollSourceEditorToLine(editor.value, line, sourceCodeContainer.value)
}

// --- inline format keybinding parity (#2) ------------------------------
// The WYSIWYG format accelerators (Ctrl+B / Ctrl+I / …) reach
// `handleInlineFormat` in editor.vue, which previously dropped them in
// source-code mode. editor.vue re-emits them as `cm-format`; here they wrap
// the selection (multi-cursor aware) with the matching markdown markers —
// the same shortcuts produce the same markdown in both modes.

interface CmRange {
  anchor: CMCursor
  head: CMCursor
}

const wrapSelection = (
  cm: CMInstance,
  before: string,
  after: string,
  cursorInside: boolean = false
): void => {
  const ranges = cm.listSelections() as CmRange[]
  if (!ranges.length) return

  const replacements: Array<{ from: CMCursor; to: CMCursor; text: string }> = []
  const nextSelections: CmRange[] = []
  for (const { anchor, head } of ranges) {
    // `cmpPos` is a CodeMirror static (CodeMirror.cmpPos), not an Editor method.
    const forward = codeMirror.cmpPos(anchor, head) <= 0
    const from = forward ? anchor : head
    const to = forward ? head : anchor
    const text = cm.getRange(from, to)
    const startIndex = cm.indexFromPos(from)
    replacements.push({ from, to, text })
    if (cursorInside) {
      // `[text]()` / `![text]()`: park the caret between the parentheses.
      const pos = cm.posFromIndex(startIndex + before.length + text.length + 1)
      nextSelections.push({ anchor: pos, head: pos })
    } else {
      const anchorIdx = startIndex + before.length
      nextSelections.push({
        anchor: cm.posFromIndex(anchorIdx),
        head: cm.posFromIndex(anchorIdx + text.length)
      })
    }
  }

  // Apply from the last range backwards so earlier character indexes stay valid.
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { from, to, text } = replacements[i]
    cm.replaceRange(before + text + after, from, to)
  }
  cm.setSelections(nextSelections)
}

const FORMAT_MARKERS: Record<string, [string, string]> = {
  strong: ['**', '**'],
  em: ['*', '*'],
  del: ['~~', '~~'],
  mark: ['==', '=='],
  inline_code: ['`', '`'],
  inline_math: ['$', '$'],
  u: ['<u>', '</u>'],
  sup: ['<sup>', '</sup>'],
  sub: ['<sub>', '</sub>']
}

// Multi-character pairs must precede their prefixes (`**` before `*`).
const STRIP_PAIRS: Array<[string, string]> = [
  ['**', '**'],
  ['~~', '~~'],
  ['==', '=='],
  ['<u>', '</u>'],
  ['<sup>', '</sup>'],
  ['<sub>', '</sub>'],
  ['*', '*'],
  ['`', '`'],
  ['$', '$']
]

const stripFormatting = (cm: CMInstance): void => {
  const ranges = cm.listSelections() as CmRange[]
  const replacements: Array<{ from: CMCursor; to: CMCursor; text: string }> = []
  const nextSelections: CmRange[] = []
  for (const { anchor, head } of ranges) {
    // `cmpPos` is a CodeMirror static (CodeMirror.cmpPos), not an Editor method.
    const forward = codeMirror.cmpPos(anchor, head) <= 0
    const from = forward ? anchor : head
    const to = forward ? head : anchor
    const original = cm.getRange(from, to)
    let stripped = original
    for (const [open, close] of STRIP_PAIRS) {
      if (stripped.length >= open.length + close.length && stripped.startsWith(open) && stripped.endsWith(close)) {
        stripped = stripped.slice(open.length, stripped.length - close.length)
        break
      }
    }
    const startIndex = cm.indexFromPos(from)
    replacements.push({ from, to, text: stripped })
    nextSelections.push({
      anchor: cm.posFromIndex(startIndex),
      head: cm.posFromIndex(startIndex + stripped.length)
    })
  }

  for (let i = replacements.length - 1; i >= 0; i--) {
    const { from, to, text } = replacements[i]
    cm.replaceRange(text, from, to)
  }
  cm.setSelections(nextSelections)
}

const handleCmFormat = (type: unknown) => {
  const cm = editor.value
  if (!cm) return
  const key = String(type ?? '')
  if (key === 'clear') {
    stripFormatting(cm)
    return
  }
  if (key === 'link' || key === 'image') {
    wrapSelection(cm, key === 'image' ? '![' : '[', ']()', true)
    return
  }
  const markers = FORMAT_MARKERS[key]
  if (markers) {
    wrapSelection(cm, markers[0], markers[1])
  }
}

onMounted(() => {
  if (!currentTab.value) return
  const { id } = currentTab.value
  // Reset WYSIWYG scroll, block and cursor state; source mode uses different coordinates.
  currentTab.value.scrollTop = 0
  currentTab.value.blocks = undefined
  currentTab.value.cursor = undefined

  const { markdown, muyaIndexCursor, textDirection } = props
  const container = sourceCodeContainer.value
  const codeMirrorConfig: Record<string, unknown> = {
    value: markdown,
    lineNumbers: sourceCodeLineNumbers.value,
    // Vim keybindings for source-code mode (preference `vimMode`); the CM5
    // vim addon is imported in the codeMirror wrapper.
    keyMap: vimMode.value ? 'vim' : 'default',
    autofocus: true,
    lineWrapping: true,
    styleActiveLine: true,
    extraKeys: getSourceExtraKeys(isWindows),
    direction: textDirection,
    viewportMargin: Infinity
  }

  if (railscastsThemes.includes(theme.value)) {
    codeMirrorConfig.theme = 'railscasts'
  } else if (oneDarkThemes.includes(theme.value)) {
    codeMirrorConfig.theme = 'one-dark'
  }

  bus.on('file-loaded', handleFileChange)
  bus.on('file-changed', handleFileChange)
  bus.on('selectAll', handleSelectAll)
  bus.on('undo', handleUndo)
  bus.on('redo', handleRedo)
  bus.on('image-action', handleImageAction)
  bus.on('scroll-to-header', handleScrollToHeader)
  bus.on('cm-format', handleCmFormat)

  // CodeMirror's line tree relies on object identity and must not be proxied by Vue.
  const codeMirrorInstance = markRaw(codeMirror(container, codeMirrorConfig))

  codeMirrorInstance.setOption('mode', markdownMathMode())

  codeMirrorInstance.on('contextmenu', (_cm: CodeMirror.Editor, event: Event) => {
    event.preventDefault()
    event.stopPropagation()
  })

  if (isValidMuyaIndexCursor(muyaIndexCursor)) {
    const { anchor, focus } = muyaIndexCursor
    codeMirrorInstance.setSelection(anchor, focus, { scroll: true })
  } else {
    setCursorAtFirstLine(codeMirrorInstance)
  }

  restoreSourceHistory(id, codeMirrorInstance)
  editor.value = codeMirrorInstance
  tabId.value = id
  updateSelectionWordCount(codeMirrorInstance)

  listenChange(codeMirrorInstance)
  registerSourceView(async () => {
    preferencesStore.SET_MODE({ type: 'sourceCode', checked: false })
    preferencesStore.DISPATCH_EDITOR_VIEW_STATE({ sourceCode: false })
    await nextTick()
  })

  // Paint the last merge's changed lines (if any) and drop the highlight on
  // the first user-origin edit (CM's `setValue` on external reloads is not a
  // user edit).
  applyMergedRegionHighlights()
  codeMirrorInstance.on('change', (_cm: CMInstance, change: { origin?: string }) => {
    if (change?.origin && change.origin !== 'setValue') {
      clearMergedRegions()
    }
  })
})

onBeforeUnmount(() => {
  registerSourceView(null)
  if (editor.value) {
    saveContent(editor.value)
    captureSourceHistory(
      tabId.value,
      editor.value,
      editorStore.tabs.find((tab) => tab.id === tabId.value)?.markdown
    )
  }
  viewDestroyed.value = true

  bus.off('file-loaded', handleFileChange)
  bus.off('file-changed', handleFileChange)
  bus.off('selectAll', handleSelectAll)
  bus.off('undo', handleUndo)
  bus.off('redo', handleRedo)
  bus.off('image-action', handleImageAction)
  editorStore.SET_SELECTION_WORD_COUNT(null)
  lastSelectionKey = ''
  bus.off('scroll-to-header', handleScrollToHeader)
  bus.off('cm-format', handleCmFormat)

  if (editor.value) {
    const { cursor, markdown: newMarkdown } = getMarkdownAndCursor(editor.value)
    bus.emit('file-changed', {
      reason: 'source-handoff',
      id: tabId.value,
      markdown: newMarkdown,
      muyaIndexCursor: cursor,
      renderCursor: true
    })

    // The instance was created on a container div, not a textarea, so it has no
    // `toTextArea` (that exists only on `CodeMirror.fromTextArea` results). The
    // official way to delete such an editor is removing its wrapper node.
    editor.value.getWrapperElement().remove()
    editor.value = null
  }
})
</script>

<style>
.source-code {
  height: 100%;
  box-sizing: border-box;
  overflow: auto;
}

/* Line background for the ranges the last external three-way merge applied
   (see `applyMergedRegionHighlights`). Fixed soft blue, light and dark. */
.source-code .CodeMirror-linebackground.mu-merged-line {
  background-color: rgba(59, 130, 246, 0.14);
}

.source-code .CodeMirror {
  height: auto;
  margin: 50px auto;
  max-width: var(--editorAreaWidth);
  background: transparent;
}
.source-code .CodeMirror-gutters {
  border-right: none;
  background-color: transparent;
}
.source-code .CodeMirror-activeline-background,
.source-code .CodeMirror-activeline-gutter {
  background: var(--floatHoverColor);
}
/* Fade the delimiters against the formula. Dimming the inherited colour rather
   than naming one is what carries across every theme; 0.65 is the lowest value
   still clearing 3:1 in all of them, with one-dark at 3.67 setting the floor. */
.source-code .CodeMirror .cm-formatting-math {
  opacity: 0.65;
}
</style>
