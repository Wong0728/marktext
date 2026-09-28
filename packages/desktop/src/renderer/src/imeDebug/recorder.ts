/**
 * IME trace recorder.
 *
 * Purpose: diagnose input methods that commit text into the DOM but leave the
 * editor's own state (muya's `block.text`) behind. The trace has to answer one
 * question per event — "did the DOM and the state agree, and who wrote what?" —
 * so every record carries three snapshots of the active block:
 *
 *   pre    — synchronously in the capture-phase listener, before any handler runs
 *   post   — microtask after dispatch, i.e. after muya's handlers have run
 *   settle — two frames later, catching IME writes that land asynchronously
 *            (Doubao and other cloud-assisted IMEs post-process *after* the
 *            composition commits, which is the failure mode under investigation)
 *
 * `desync` compares `block.text` against the block's DOM text. When they differ,
 * any later re-render writes the stale state back over the DOM and undoes what
 * the user just deleted — which is exactly the reported symptom.
 */

export type PaneKind = 'muya' | 'plain'
export type RecordKind = 'event' | 'mutation' | 'call' | 'note'

export interface Snapshot {
  blockName: string | null
  blockId: string | null
  stateText: string | null
  domText: string | null
  domHTML: string | null
  isComposed: boolean | null
  cursor: string | null
  selection: string | null
  desync: boolean | null
  // Why the engine's own selection resolver accepted or rejected the live
  // selection. `bail` names the exact early-return in TextSelection.getSelection
  // — the check Editor._dispatchEvents uses to decide whether to disable itself.
  diag: Record<string, unknown> | null
}

export interface CallFrame {
  name: string
  args: string[]
  blockId: string
  isComposedBefore: boolean | null
  isComposedAfter: boolean | null
  defaultPreventedAfter: boolean
  textBefore: string | null
  textAfter: string | null
  error: string | null
}

export interface TraceRecord {
  seq: number
  dt: number
  kind: RecordKind
  pane: PaneKind | 'meta'
  type: string
  detail: Record<string, unknown>
  flags: string[]
  pre: Snapshot | null
  post: Snapshot | null
  settle: Snapshot | null
  calls: CallFrame[]
}

// Records are kept in memory for the on-screen timeline and mirrored to disk by
// the sink. The cap bounds memory for a long typing session; the file keeps
// everything that was captured before the cap kicked in.
const MAX_RECORDS = 20000

export function clip(text: string | null | undefined, limit = 320): string | null {
  if (text == null) { return null }
  return text.length > limit ? `${text.slice(0, limit)}…(+${text.length})` : text
}

/**
 * Make invisible characters visible. Zero-width and no-break characters are
 * exactly what desyncs `textContent` from the state, so they must be readable
 * in the trace instead of looking like "identical" strings.
 */
const INVISIBLE: ReadonlyArray<readonly [RegExp, string]> = [
  [/\u200B/g, '[ZWSP]'],
  [/\u00A0/g, '[NBSP]'],
  [/\uFEFF/g, '[BOM]'],
  [/\u200C/g, '[ZWNJ]'],
  [/\u200D/g, '[ZWJ]'],
  [/\u2060/g, '[WORDJOINER]'],
  [/\u3000/g, '[IDEO-SPACE]'],
  [/\u00AD/g, '[SHY]'],
  [/\t/g, '[TAB]'],
  [/\n/g, '[LF]'],
  [/\r/g, '[CR]']
]

export function visualize(text: string, limit = 240): string {
  let out = text
  for (const [pattern, label] of INVISIBLE) { out = out.replace(pattern, label) }

  // Boundary spaces matter for caret/offset maths but are invisible on screen;
  // interior ones are left alone to keep the trace readable.
  out = out.replace(/^ +/, match => `[SPx${match.length}]`)
  out = out.replace(/ +$/, match => `[SPx${match.length}]`)

  if (out.length > limit) { out = `${out.slice(0, limit)}…(+${out.length - limit})` }

  return out
}

export function describeNode(node: Node | null | undefined): string {
  if (!node) { return 'null' }
  if (node.nodeType === Node.TEXT_NODE) { return `#text(${visualize(node.nodeValue ?? '', 48)})` }

  const el = node as Element
  const raw = typeof el.className === 'string' ? el.className.trim() : ''
  const cls = raw ? `.${raw.split(/\s+/).join('.')}` : ''
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}`
}

export function selectionSummary(): string {
  const sel = window.getSelection()
  if (!sel || !sel.anchorNode) { return 'none' }
  return `${describeNode(sel.anchorNode)}@${sel.anchorOffset}→${describeNode(sel.focusNode)}@${sel.focusOffset}`
}

const BLOCK_DOM_PROPERTY = '__MUYA_BLOCK__'

/** Mirrors `findContentDOM` in the engine's selection/dom.ts. */
function findContentDOM(node: Node | null | undefined): HTMLElement | null {
  let current: Node | null = node ?? null
  while (current) {
    if (current instanceof HTMLElement && current.tagName === 'SPAN' && current.classList.contains('mu-content')) { return current }
    current = current.parentNode
  }
  return null
}

/** Node chain up to the editor root — an IME that relocates the caret out of
 *  `mu-content` is only recognisable from the chain it moved to. */
function describeAncestors(node: Node | null | undefined): string {
  const parts: string[] = []
  let current: Node | null = node ?? null
  let depth = 0
  while (current && depth < 8) {
    parts.push(describeNode(current))
    current = current.parentNode
    depth += 1
  }
  return parts.join(' < ')
}

/**
 * Reproduces every early return in `TextSelection.getSelection()`. The engine
 * drops ALL input handling when that call returns null —
 * `Editor._dispatchEvents` sets `activeContentBlock = null` and returns — so
 * naming the failing check is what turns "typing works but delete doesn't" into
 * a specific defect.
 */
export function selectionDiagnostics(): Record<string, unknown> {
  const sel = window.getSelection()
  if (!sel) { return { bail: 'no-selection-object' } }

  const { anchorNode, focusNode, anchorOffset, focusOffset } = sel
  if (!anchorNode || !focusNode) {
    return { bail: 'null-anchor-or-focus', anchorNode: describeNode(anchorNode), focusNode: describeNode(focusNode) }
  }

  const anchorDom = findContentDOM(anchorNode)
  const focusDom = findContentDOM(focusNode)
  if (!anchorDom || !focusDom) {
    return {
      bail: 'no-mu-content-ancestor',
      anchorNode: describeNode(anchorNode),
      focusNode: describeNode(focusNode),
      anchorChain: describeAncestors(anchorNode)
    }
  }

  const backlink = (dom: HTMLElement): { outMostBlock?: unknown, blockName?: string } | undefined =>
    (dom as unknown as Record<string, unknown>)[BLOCK_DOM_PROPERTY] as { outMostBlock?: unknown, blockName?: string } | undefined

  const anchorBlock = backlink(anchorDom)
  const focusBlock = backlink(focusDom)
  if (!anchorBlock || !focusBlock) {
    return {
      bail: 'no-block-backlink',
      anchorHasBlock: Boolean(anchorBlock),
      focusHasBlock: Boolean(focusBlock),
      anchorDom: describeNode(anchorDom)
    }
  }

  if (!anchorBlock.outMostBlock || !focusBlock.outMostBlock) { return { bail: 'no-outmost-block', anchorBlockName: anchorBlock.blockName ?? null } }

  return {
    bail: null,
    sameBlock: anchorBlock === focusBlock,
    anchorOffset,
    focusOffset,
    blockName: anchorBlock.blockName ?? null
  }
}

function describeEvent(ev: Event): Record<string, unknown> {
  const detail: Record<string, unknown> = { target: describeNode(ev.target as Node) }

  if (ev instanceof KeyboardEvent) {
    detail.key = ev.key
    detail.code = ev.code
    detail.keyCode = ev.keyCode
    detail.isComposing = ev.isComposing
    detail.modifiers = `${ev.ctrlKey ? 'ctrl+' : ''}${ev.altKey ? 'alt+' : ''}${ev.shiftKey ? 'shift+' : ''}${ev.metaKey ? 'meta+' : ''}` || '-'
    detail.repeat = ev.repeat
  }

  if (ev instanceof CompositionEvent) { detail.data = ev.data }

  if (ev instanceof InputEvent) {
    detail.inputType = ev.inputType
    detail.data = ev.data
    detail.isComposing = ev.isComposing
    if (ev.dataTransfer) { detail.dataTransferTypes = Array.from(ev.dataTransfer.types).join(',') }
  }

  detail.defaultPrevented = ev.defaultPrevented
  return detail
}

/** Snapshot of a bare contenteditable — the baseline pane, no engine involved. */
export function plainSnapshot(root: HTMLElement): Snapshot {
  return {
    blockName: 'contenteditable',
    blockId: null,
    stateText: null,
    domText: visualize(root.textContent ?? ''),
    domHTML: clip(root.innerHTML),
    isComposed: null,
    cursor: null,
    selection: selectionSummary(),
    desync: null,
    diag: null
  }
}

/**
 * Structural view of the pieces of the engine the trace reads. muya ships no
 * built typings and the desktop's `@muyajs/core` shim is deliberately
 * permissive, so the boundary is described here rather than reached for with
 * `any`.
 */
interface MuyaBlockLike {
  blockName?: string
  text?: string
  isComposed?: boolean
  domNode?: HTMLElement
  getCursor?: () => { start?: { offset?: number }, end?: { offset?: number } } | null
  [key: string]: unknown
}

interface MuyaLike {
  editor?: {
    activeContentBlock?: MuyaBlockLike | null
    selection?: { getSelection?: () => unknown }
  }
  domNode?: HTMLElement
  // The desktop's `@muyajs/core` shim exposes the instance as an index
  // signature; matching it here keeps the engine handle assignable without a
  // cast at the call site.
  [key: string]: unknown
}

/**
 * Audit every `mu-content` span the moment the backlink goes missing. A span
 * whose `outerHTML` differs from the active block's own `domNode` is a clone
 * produced by the browser's editing code, which is the one case the engine
 * cannot map back to a block.
 */
function backlinkAudit(container: HTMLElement | undefined, block: MuyaBlockLike | null): Record<string, unknown> | null {
  if (!container) {
    return null
  }

  const spans = Array.from(container.querySelectorAll<HTMLElement>('span.mu-content'))
  const linked = spans.filter(s => (s as unknown as Record<string, unknown>)[BLOCK_DOM_PROPERTY] != null)
  const unlinked = spans.filter(s => (s as unknown as Record<string, unknown>)[BLOCK_DOM_PROPERTY] == null)
  const activeDom = block?.domNode

  return {
    totalSpans: spans.length,
    linked: linked.length,
    unlinked: unlinked.length,
    unlinkedHTML: unlinked.slice(0, 3).map(s => clip(s.outerHTML, 140)),
    activeDomIsLinked: activeDom
      ? (activeDom as unknown as Record<string, unknown>)[BLOCK_DOM_PROPERTY] != null
      : null,
    activeDomInContainer: activeDom ? container.contains(activeDom) : null,
    caretSpanIsActiveDom: unlinked.length > 0 && activeDom
      ? unlinked.some(s => s === activeDom || s.contains(activeDom) || activeDom.contains(s))
      : null
  }
}

type BlockMethod = (...args: unknown[]) => unknown

// A single recorder serves the page; prototype wrappers are built once and
// outlive any one PaneProbe, so they reach it through a module-level handle
// rather than a closure.
let activeRecorder: TraceRecorder | null = null
const WRAPPED = new WeakSet<BlockMethod>()
const BLOCK_IDS = new WeakMap<object, string>()
let blockSeq = 0

/**
 * Stable per-instance id. The composition and the key that follows it may land
 * on different block objects, and the id is what makes that visible.
 */
function blockId(block: object): string {
  let id = BLOCK_IDS.get(block)
  if (id == null) {
    id = `b${++blockSeq}`
    BLOCK_IDS.set(block, id)
  }
  return id
}

/**
 * Snapshot of the live muya block. `stateText` is the engine's authoritative
 * value; `domText` is what the user currently sees.
 */
export function muyaSnapshot(muya: MuyaLike): Snapshot {
  const block = muya?.editor?.activeContentBlock

  // The engine's own verdict matters as much as our reimplementation of it:
  // `activeContentBlock === null` while the live selection looks fine is the
  // signature of a rejected selection.
  let engineSelection: string
  try {
    engineSelection = muya?.editor?.selection?.getSelection?.() == null ? 'null' : 'resolved'
  } catch {
    engineSelection = 'threw'
  }

  const diag: Record<string, unknown> = { ...selectionDiagnostics(), engineSelection }

  if (diag.bail === 'no-block-backlink') { diag.audit = backlinkAudit(muya?.domNode, block ?? null) }

  if (!block) {
    return {
      blockName: null,
      blockId: null,
      stateText: null,
      domText: null,
      domHTML: null,
      isComposed: null,
      cursor: null,
      selection: selectionSummary(),
      desync: null,
      diag
    }
  }

  const domNode = block.domNode
  const rawDom = domNode ? domNode.textContent ?? '' : null
  const stateText = typeof block.text === 'string' ? block.text : null

  // muya renders a block as `<span class="mu-syntax-text">${text}</span>`, and a
  // few block types pad themselves with ZWSP placeholders, so those are stripped
  // before declaring the two representations out of sync.
  const normalizedDom = rawDom == null ? null : rawDom.replace(/\u200B/g, '')

  let cursor: string | null = null
  try {
    const c = block.getCursor?.()
    cursor = c?.start ? `${c.start.offset ?? '?'}-${c.end?.offset ?? '?'}` : null
  } catch {
    cursor = 'err'
  }

  return {
    blockName: typeof block.blockName === 'string' ? block.blockName : null,
    blockId: blockId(block),
    stateText: stateText == null ? null : visualize(stateText),
    domText: rawDom == null ? null : visualize(rawDom),
    domHTML: domNode ? clip(domNode.innerHTML) : null,
    isComposed: Boolean(block.isComposed),
    cursor,
    selection: selectionSummary(),
    desync: normalizedDom != null && stateText != null ? normalizedDom !== stateText : null,
    diag
  }
}

export class TraceRecorder {
  readonly records: TraceRecord[] = []

  private seq = 0
  private readonly t0 = performance.now()
  private readonly listeners = new Set<() => void>()
  private enabled = true

  // Set for the duration of one task's event dispatch, cleared on a macrotask.
  // MutationObserver callbacks are microtasks and therefore always drain before
  // that timeout, so a mutation seen while this is true belongs to the event
  // currently being dispatched; anything else arrived with no DOM event at all.
  private dispatchActive = false
  private dispatchClearScheduled = false
  private dispatchRecord: TraceRecord | null = null

  now(): number {
    return performance.now() - this.t0
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify(): void {
    for (const fn of this.listeners) { fn() }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.notify()
  }

  isEnabled(): boolean {
    return this.enabled
  }

  clear(): void {
    this.records.length = 0
    this.seq = 0
    this.notify()
  }

  create(
    kind: RecordKind,
    pane: PaneKind | 'meta',
    type: string,
    detail: Record<string, unknown> = {}
  ): TraceRecord | null {
    if (!this.enabled) { return null }

    const record: TraceRecord = {
      seq: ++this.seq,
      dt: this.now(),
      kind,
      pane,
      type,
      detail,
      flags: [],
      pre: null,
      post: null,
      settle: null,
      calls: []
    }
    this.records.push(record)
    if (this.records.length > MAX_RECORDS) { this.records.splice(0, this.records.length - MAX_RECORDS) }

    this.notify()
    return record
  }

  markDispatchStart(record: TraceRecord): void {
    this.dispatchActive = true
    this.dispatchRecord = record
    if (this.dispatchClearScheduled) { return }
    this.dispatchClearScheduled = true
    setTimeout(() => {
      this.dispatchActive = false
      this.dispatchClearScheduled = false
      this.dispatchRecord = null
    }, 0)
  }

  isDispatchActive(): boolean {
    return this.dispatchActive
  }

  /**
   * muya handlers run synchronously inside the dispatch window, so their call
   * frames attach to the event that triggered them. A call made outside any
   * dispatch (programmatic `setContent`, a rAF-driven re-render) becomes its own
   * record so nothing is silently dropped.
   */
  beginCall(
    name: string,
    args: unknown[],
    block: { id: string, text: string | null, isComposed: boolean | null },
    event: Event | null
  ): CallFrame {
    const frame: CallFrame = {
      name,
      args: args.map(a => clip(typeof a === 'string' ? a : describeNode(a as Node), 120) ?? ''),
      blockId: block.id,
      isComposedBefore: block.isComposed,
      isComposedAfter: null,
      defaultPreventedAfter: false,
      textBefore: block.text,
      textAfter: null,
      error: null
    }
    if (event) { frame.defaultPreventedAfter = event.defaultPrevented }

    const owner = this.dispatchRecord
    if (owner) {
      owner.calls.push(frame)
      return frame
    }
    const orphan = this.create('call', 'muya', `${name}()`, { origin: 'no-event' })
    orphan?.calls.push(frame)
    return frame
  }
}

const HOOKED_METHODS = [
  'inputHandler',
  'composeHandler',
  'keydownHandler',
  'keyupHandler',
  'backspaceHandler',
  'deleteHandler',
  'enterHandler',
  'update',
  'setCursor'
] as const

/**
 * Wires one pane (a raw contenteditable, or the live muya container) into the
 * recorder. DOM listeners run in the capture phase so the `pre` snapshot is
 * taken before muya's own handlers; muya's methods are wrapped on the *active
 * block instance* rather than on a prototype, because `Content`, `Format`,
 * `tableCell` and `codeBlockContent` each override them independently.
 */
export class PaneProbe {
  private readonly recorder: TraceRecorder
  private readonly pane: PaneKind
  private readonly snapshot: () => Snapshot | null
  private readonly getActiveBlock?: () => MuyaBlockLike | null | undefined
  private readonly cleanup: Array<() => void> = []
  private lastSelection = ''

  constructor(
    recorder: TraceRecorder,
    pane: PaneKind,
    snapshot: () => Snapshot | null,
    getActiveBlock?: () => MuyaBlockLike | null | undefined
  ) {
    this.recorder = recorder
    this.pane = pane
    this.snapshot = snapshot
    this.getActiveBlock = getActiveBlock
    activeRecorder = recorder
  }

  attach(root: HTMLElement): void {
    const types = ['keydown', 'keyup', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend']

    for (const type of types) {
      const listener = (ev: Event): void => this.onDomEvent(ev)
      root.addEventListener(type, listener, true)
      this.cleanup.push(() => root.removeEventListener(type, listener, true))
    }

    const observer = new MutationObserver(mutations => this.onMutations(root, mutations))
    observer.observe(root, { childList: true, characterData: true, subtree: true, characterDataOldValue: true })
    this.cleanup.push(() => observer.disconnect())

    const onSelectionChange = (): void => {
      this.instrument()
      const summary = selectionSummary()
      if (summary === this.lastSelection) {
        return
      }
      this.lastSelection = summary
      this.recorder.create('note', this.pane, 'selectionchange', { selection: summary })
    }
    document.addEventListener('selectionchange', onSelectionChange)
    this.cleanup.push(() => document.removeEventListener('selectionchange', onSelectionChange))
  }

  /**
   * Wrap both the block's prototypes AND its own instance properties.
   *
   * Prototypes are required because muya swaps the active block object between
   * events and `Content` / `Format` / `tableCell` / `codeBlockContent` each
   * override the handlers independently. Instance properties are equally
   * required: `Content.keydownHandler` is declared as a class field
   * (`keydownHandler = (event) => …`), so it lives on the object, not on any
   * prototype, and a prototype-only walk never sees it — which is why the
   * Enter keydown went unrecorded.
   */
  instrument(): void {
    const block = this.getActiveBlock?.()
    if (!block) {
      return
    }

    const own = block as unknown as Record<string, unknown>
    for (const name of HOOKED_METHODS) {
      const original = own[name] as BlockMethod | undefined
      if (typeof original !== 'function' || WRAPPED.has(original)) {
        continue
      }
      WRAPPED.add(original)
      own[name] = this.wrapHandler(name, original)
    }

    let proto: unknown = Object.getPrototypeOf(block)
    let depth = 0
    while (proto && proto !== Object.prototype && depth < 5) {
      for (const name of HOOKED_METHODS) {
        const original = (proto as Record<string, unknown>)[name] as BlockMethod | undefined
        if (typeof original !== 'function' || WRAPPED.has(original)) {
          continue
        }
        WRAPPED.add(original)
        ;(proto as Record<string, unknown>)[name] = this.wrapHandler(name, original)
      }
      proto = Object.getPrototypeOf(proto)
      depth += 1
    }
  }

  private wrapHandler(name: string, original: BlockMethod): BlockMethod {
    return function(this: MuyaBlockLike, ...args: unknown[]): unknown {
      const event = args.find(a => a instanceof Event) ?? null
      const frame = (activeRecorder as TraceRecorder).beginCall(
        name,
        args,
        {
          id: blockId(this),
          text: typeof this.text === 'string' ? this.text : null,
          isComposed: typeof this.isComposed === 'boolean' ? this.isComposed : null
        },
        event
      )
      try {
        const result = original.apply(this, args)
        frame.textAfter = typeof this.text === 'string' ? this.text : null
        frame.isComposedAfter = typeof this.isComposed === 'boolean' ? this.isComposed : null
        if (event) { frame.defaultPreventedAfter = event.defaultPrevented }
        return result
      } catch (err) {
        frame.error = err instanceof Error ? err.message : String(err)
        throw err
      }
    }
  }

  destroy(): void {
    for (const fn of this.cleanup) {
      fn()
    }
    this.cleanup.length = 0
  }

  private onDomEvent(ev: Event): void {
    const record = this.recorder.create('event', this.pane, ev.type, describeEvent(ev))
    if (!record) {
      return
    }

    this.recorder.markDispatchStart(record)
    record.pre = this.snapshot()

    // Microtask checkpoint: every listener for this event has run, so this is
    // the state after muya handled it.
    queueMicrotask(() => {
      record.post = this.snapshot()
    })

    // Two frames later — catches IME post-processing that lands after commit.
    // rAF is throttled or stops entirely in an occluded window, so a timeout
    // races it to guarantee the settle snapshot is always filled in.
    let done = false
    const settle = (): void => {
      if (done) { return }
      done = true
      record.settle = this.snapshot()
      if (record.pre?.desync) { record.flags.push('DESYNC@pre') }
      if (record.post?.desync) { record.flags.push('DESYNC@post') }
      if (record.settle?.desync) { record.flags.push('DESYNC@settle') }
      if (record.post?.isComposed) { record.flags.push('ISCOMPOSED') }

      // `activeContentBlock === null` is the engine's self-disable switch: no
      // muya handler ran for this event at all.
      const post = record.post
      if (this.pane === 'muya' && post?.blockName == null) {
        const bail = post?.diag?.bail ?? 'no-post-snapshot'
        record.flags.push(`ENGINE-DISABLED(${String(bail)})`)
      }
    }
    requestAnimationFrame(() => requestAnimationFrame(settle))
    setTimeout(settle, 80)
  }

  private onMutations(root: HTMLElement, mutations: MutationRecord[]): void {
    if (mutations.length === 0) { return }

    const fromEvent = this.recorder.isDispatchActive()
    const summary = mutations.slice(0, 12).map((m) => {
      const base: Record<string, unknown> = {
        target: describeNode(m.target),
        mutationType: m.type,
        added: m.addedNodes.length,
        removed: m.removedNodes.length,
        oldValue: m.oldValue ?? null,
        newValue: m.type === 'characterData' ? m.target.nodeValue : null,
        addedHTML: m.addedNodes.length > 0 ? clip(Array.from(m.addedNodes).map(n => (n as Element).outerHTML ?? n.nodeValue ?? '').join(''), 160) : null,
        removedHTML: m.removedNodes.length > 0 ? clip(Array.from(m.removedNodes).map(n => (n as Element).outerHTML ?? n.nodeValue ?? '').join(''), 160) : null
      }
      return base
    })

    const record = this.recorder.create('mutation', this.pane, `${mutations.length} mutation(s)`, {
      fromEvent,
      // No DOM event in this task ⇒ the write came from outside the normal
      // input pipeline (an IME's own DOM manipulation, typically).
      attribution: fromEvent ? 'during-dispatch' : 'UNSOLICITED',
      mutations: summary,
      domTextAfter: visualize(root.textContent ?? '')
    })
    if (record && !fromEvent) { record.flags.push('UNSOLICITED') }
    if (record && this.snapshot()?.desync) { record.flags.push('DESYNC') }
  }
}
