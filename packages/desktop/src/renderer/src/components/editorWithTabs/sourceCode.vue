<template>
  <div
    ref="sourceCodeContainer"
    class="source-code"
  />
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useEditorStore } from '@/store/editor'
import { usePreferencesStore } from '@/store/preferences'
import { findMarkdownHeadingLine, scrollSourceEditorToLine } from '@/util/sourceModeToc'
import { storeToRefs } from 'pinia'
import codeMirror, { setCursorAtFirstLine, setTextDirection } from '../../codeMirror'
import { wordCount as getWordCount } from '@muyajs/core'
import { adjustCursor } from '../../util'
import bus from '../../bus'
import { oneDarkThemes, railscastsThemes } from '@/config'

// CodeMirror 5 ships no first-party types; the wrapper in src/renderer/src/
// codeMirror/index.ts also keeps the surface intentionally loose.
type CMInstance = any
type CMCursor = any

interface MuyaIndexCursorLike {
  anchor: CMCursor
  focus: CMCursor
}

const props = defineProps<{
  markdown?: string
  muyaIndexCursor?: unknown
  textDirection: string
}>()

const editorStore = useEditorStore()
const preferencesStore = usePreferencesStore()

const sourceCodeContainer = ref<HTMLDivElement | null>(null)

const editor = ref<CMInstance>(null)
const viewDestroyed = ref(false)
const tabId = ref<string | null>(null)

const { theme, sourceCode, vimMode } = storeToRefs(preferencesStore)
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

const getMarkdownAndCursor = (cm: CMInstance) => {
  let focus = cm.getCursor('head')
  let anchor = cm.getCursor('anchor')

  const markdown: string = cm.getValue()
  const convertToMuyaCursor = (cursor: CMCursor) => {
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

  anchor = convertToMuyaCursor(anchor) // Selection start as Muya cursor
  focus = convertToMuyaCursor(focus) // Selection end as Muya cursor

  // Normalize cursor that `anchor` is always before `focus` because
  // this is the expected behavior in Muya.
  if (anchor && focus && anchor.line > focus.line) {
    const tmpCursor = focus
    focus = anchor
    anchor = tmpCursor
  }
  return { cursor: { focus, anchor }, markdown }
}

/**
 * This is to write the OLD content of the editor before switching to another tab
 * @param id
 */
const prepareTabSwitch = () => {
  if (tabId.value) {
    const { cursor, markdown: newMarkdown } = getMarkdownAndCursor(editor.value)
    editorStore.LISTEN_FOR_CONTENT_CHANGE({
      id: tabId.value,
      markdown: newMarkdown,
      muyaIndexCursor: cursor
    })
    tabId.value = null
  }
}

interface FileChangePayloadLike {
  id: string
  markdown?: string
  muyaIndexCursor?: unknown
}

const handleFileChange = (payload: unknown) => {
  const { id, markdown: newMarkdown, muyaIndexCursor } = payload as FileChangePayloadLike
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

  if (typeof newMarkdown === 'string') {
    editor.value.setValue(newMarkdown)
  }

  // t('editor.sourceCode.cursorNullComment')
  if (isValidMuyaIndexCursor(muyaIndexCursor)) {
    const { anchor, focus } = muyaIndexCursor

    editor.value.setSelection(anchor, focus, { scroll: true }) // Scroll the focus into view.
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
}

const handleInvalidateImageCache = () => {
  if (editor.value) {
    editor.value.invalidateImageCache()
  }
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
  const { id, result, alt } = payload as ImageActionPayload
  const value: string = editor.value.getValue()
  const focus = editor.value.getCursor('focus')
  const anchor = editor.value.getCursor('anchor')
  const lines: string[] = value.split('\n')
  const index = lines.findIndex((line: string) => line.indexOf(id) > 0)

  if (index > -1) {
    const oldLine = lines[index]
    lines[index] = oldLine.replace(new RegExp(`!\\[${id}\\]\\(.*\\)`), `![${alt}](${result})`)
    const newValue = lines.join('\n')
    editor.value.setValue(newValue)
    const match = /(!\[.*\]\(.*\))/.exec(oldLine)
    if (!match) {
      // t('editor.sourceCode.imageStructureDeletedComment')
      return
    }
    const range = {
      start: match.index,
      end: match.index + match[1].length
    }
    const delta = alt.length + result.length + 5 - match[1].length

    const adjustPointer = (pointer: CMCursor) => {
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
      editor.value.setSelection(anchor, focus, { scroll: true })
    } else {
      setCursorAtFirstLine(editor.value)
    }
  }
}

const saveContent = (cm: CMInstance) => {
  const { cursor, markdown: newMarkdown } = getMarkdownAndCursor(cm)
  // Attention: the cursor may be `{focus: null, anchor: null}` when press `backspace`
  const wordCount = getWordCount(newMarkdown)
  // See "beforeDestroy" note
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

const listenChange = () => {
  editor.value.on('cursorActivity', (cm: CMInstance) => {
    saveContent(cm)
  })
}

// #3580: in Source Code mode the WYSIWYG container is hidden, so the
// `scroll-to-header` bus event (emitted when a TOC entry is clicked) must scroll
// CodeMirror instead. Resolve the TOC entry to its heading line in the source.
const handleScrollToHeader = (slug: unknown) => {
  if (!editor.value) return
  const index = editorStore.listToc.findIndex(item => item.slug === slug)
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
    const forward = cm.cmpPos(anchor, head) <= 0
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
    const forward = cm.cmpPos(anchor, head) <= 0
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
  // reset currentTab scrollTop position because the codeMirror scroll position is completely different from the muya scroll position
  // reset blocks as well because the blocks are only valid in muya
  // reset cursor because this is a direct "key-cursor", not a muyaIndexCursor, which is {focus: number, anchor: number}
  currentTab.value.scrollTop = 0
  currentTab.value.blocks = undefined
  currentTab.value.cursor = undefined

  const { markdown, muyaIndexCursor, textDirection } = props
  const container = sourceCodeContainer.value
  const codeMirrorConfig: Record<string, unknown> = {
    value: markdown,
    lineNumbers: true,
    // Vim keybindings for source-code mode (preference `vimMode`); the CM5
    // vim addon is imported in the codeMirror wrapper.
    keyMap: vimMode.value ? 'vim' : 'default',
    autofocus: true,
    lineWrapping: true,
    styleActiveLine: true,
    direction: textDirection,
    viewportMargin: Infinity,
    lineNumberFormatter (line: number) {
      if (line % 10 === 0 || line === 1) {
        return line
      } else {
        return ''
      }
    }
  }

  if (railscastsThemes.includes(theme.value)) {
    codeMirrorConfig.theme = 'railscasts'
  } else if (oneDarkThemes.includes(theme.value)) {
    codeMirrorConfig.theme = 'one-dark'
  }

  bus.on('file-loaded', handleFileChange)
  bus.on('invalidate-image-cache', handleInvalidateImageCache)
  bus.on('file-changed', handleFileChange)
  bus.on('selectAll', handleSelectAll)
  bus.on('undo', handleUndo)
  bus.on('redo', handleRedo)
  bus.on('image-action', handleImageAction)
  bus.on('scroll-to-header', handleScrollToHeader)
  bus.on('cm-format', handleCmFormat)

  // For some reason, code mirror does not seem to play well with Vue's refs if we reference editor.value directly.
  // See https://github.com/codemirror/codemirror5/issues/6886 - hence, we need to use a local variable first.
  const codeMirrorInstance = codeMirror(container, codeMirrorConfig)

  // `markdown-math` wraps the standard Markdown mode and delegates `$...$` and
  // `$$...$$` spans to stex so subscript underscores in math do not flip the
  // outer mode into emphasis. See src/renderer/src/codeMirror/markdownMathMode.js.
  codeMirrorInstance.setOption('mode', 'markdown-math')

  codeMirrorInstance.on('contextmenu', (_cm: CMInstance, event: Event) => {
    event.preventDefault()
    event.stopPropagation()
  })

  if (isValidMuyaIndexCursor(muyaIndexCursor)) {
    const { anchor, focus } = muyaIndexCursor
    codeMirrorInstance.setSelection(anchor, focus, { scroll: true })
  } else {
    setCursorAtFirstLine(codeMirrorInstance)
  }

  editor.value = codeMirrorInstance
  tabId.value = id

  listenChange()
})

onBeforeUnmount(() => {
  viewDestroyed.value = true

  bus.off('file-loaded', handleFileChange)
  bus.off('invalidate-image-cache', handleInvalidateImageCache)
  bus.off('file-changed', handleFileChange)
  bus.off('selectAll', handleSelectAll)
  bus.off('undo', handleUndo)
  bus.off('redo', handleRedo)
  bus.off('image-action', handleImageAction)
  bus.off('scroll-to-header', handleScrollToHeader)
  bus.off('cm-format', handleCmFormat)

  const { cursor, markdown: newMarkdown } = getMarkdownAndCursor(editor.value)
  bus.emit('file-changed', {
    id: tabId.value,
    markdown: newMarkdown,
    muyaIndexCursor: cursor,
    renderCursor: true
  })

  if (editor.value) {
    editor.value.toTextArea()
    editor.value = null
  }
})
</script>

<style>
.source-code {
  height: calc(100vh - var(--titleBarHeight));
  box-sizing: border-box;
  overflow: auto;
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
</style>
