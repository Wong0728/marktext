/**
 * Standalone IME diagnostic window.
 *
 * Run `MARKTEXT_IME_DEBUG=1 pnpm run dev` (see src/main/imeDebugWindow.ts) or
 * just open `/ime-debug.html` from the dev server in any Chromium browser.
 *
 * Two panes sit side by side on purpose: the left one is a bare
 * `contenteditable` showing what the input method does to the DOM on its own,
 * the right one is the real muya engine going through the exact input path the
 * editor uses. Typing the same sentence into both separates "the IME does
 * something unusual" from "muya mishandles a normal IME sequence".
 */

import '@muyajs/core/assets/styles/index.css'
import { Muya, zhCN } from '@muyajs/core'
import type { Snapshot, TraceRecord } from './recorder'
import { PaneProbe, TraceRecorder, muyaSnapshot, plainSnapshot } from './recorder'
import { copyTrace, createTraceSink, downloadTrace } from './sink'

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector)
  if (!node) { throw new Error(`missing element: ${selector}`) }
  return node
}

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"]/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[char])
}

// The seed paragraph gives Backspace/Delete something to remove, which is the
// operation that reportedly fails.
const muya = new Muya(el<HTMLElement>('#muya'), {
  markdown: 'IME debug line one.\n\nIME debug line two.',
  tabSize: 4,
  spellcheckEnabled: false,
  hideQuickInsertHint: true
})
muya.locale(zhCN)
muya.init()

const recorder = new TraceRecorder()
const sink = createTraceSink()

const plainEl = el<HTMLElement>('#plain')
const muyaPane = new PaneProbe(
  recorder,
  'muya',
  () => muyaSnapshot(muya),
  () => muya.editor?.activeContentBlock
)
const plainPane = new PaneProbe(recorder, 'plain', () => plainSnapshot(plainEl))

plainPane.attach(plainEl)
muyaPane.attach(muya.domNode as HTMLElement)
muyaPane.instrument()

// -----------------------------------------------
// Timeline rendering

const logBody = el<HTMLElement>('#log-body')
const countEl = el<HTMLElement>('#count')
const sinkEl = el<HTMLElement>('#sink')
const hintEl = el<HTMLElement>('#hint')
const diagEl = el<HTMLElement>('#diag')

// Vite's full-reload does not always land in this window, so a stale module can
// silently produce a trace that looks fine but is missing the `bail` field.
// Probe the live snapshot instead of trusting the module that happens to be
// loaded.
const diagLive = muyaSnapshot(muya).diag != null
diagEl.textContent = diagLive ? '诊断: 开' : '诊断: 关（页面未更新，请 Ctrl+R）'
diagEl.classList.toggle('stale', !diagLive)

const MAX_ROWS = 400
const expanded = new Set<number>()
const filters = { muya: true, plain: true, mutation: true, onlyFlag: false }

sinkEl.textContent = sink.path ?? '（浏览器模式：未落盘，请用「导出 JSONL」）'

let lastWrittenSeq = 0
let dirty = true
recorder.onChange(() => {
  dirty = true
})

function passes(record: TraceRecord): boolean {
  if (record.pane === 'plain' && !filters.plain) { return false }
  if (record.pane === 'muya' && !filters.muya) { return false }
  if (filters.onlyFlag) { return record.flags.length > 0 }
  if (record.kind === 'mutation' && !filters.mutation) { return false }
  return true
}

function detailText(record: TraceRecord): string {
  const d = record.detail
  const parts: string[] = []

  if (record.kind === 'event') {
    if ('inputType' in d) { parts.push(`inputType=${d.inputType}`) }
    if ('key' in d) { parts.push(`key=${JSON.stringify(d.key)}`, `code=${d.code}`, `keyCode=${d.keyCode}`) }
    if ('data' in d) { parts.push(`data=${JSON.stringify(d.data)}`) }
    if ('isComposing' in d) { parts.push(`isComposing=${d.isComposing}`) }
    if ('modifiers' in d && d.modifiers !== '-') { parts.push(`mods=${d.modifiers}`) }
    if ('repeat' in d && d.repeat) { parts.push('repeat') }
    if ('defaultPrevented' in d) { parts.push(`defaultPrevented=${d.defaultPrevented}`) }
    if ('target' in d) { parts.push(`target=${d.target}`) }
  } else if (record.kind === 'mutation') {
    parts.push(String(d.attribution ?? ''))
    for (const m of (d.mutations as Record<string, unknown>[]) ?? []) {
      const bits = [`${m.mutationType}@${m.target}`, `+${m.added}/-${m.removed}`]
      if (m.addedHTML) { bits.push(`«${m.addedHTML}»`) }
      if (m.removedHTML) { bits.push(`-«${m.removedHTML}»`) }
      if (m.newValue != null) { bits.push(`new=${JSON.stringify(m.newValue)}`) }
      if (m.oldValue != null && m.mutationType === 'characterData') { bits.push(`old=${JSON.stringify(m.oldValue)}`) }
      parts.push(bits.join(' '))
    }
  } else if ('selection' in d) {
    parts.push(String(d.selection))
  } else {
    parts.push(JSON.stringify(d))
  }

  return parts.join('   ')
}

function snapLine(label: string, snap: Snapshot | null, withHtml: boolean): string {
  if (!snap) { return '' }

  const diag = snap.diag
    ? `⛔bail=${String(snap.diag.bail ?? 'none')}  engineSel=${String(snap.diag.engineSelection ?? '—')}` +
      (snap.diag.anchorChain ? `  chain=${String(snap.diag.anchorChain)}` : '') +
      (snap.diag.anchorDom ? `  dom=${String(snap.diag.anchorDom)}` : '') +
      (snap.diag.audit ? `  audit=${esc(JSON.stringify(snap.diag.audit))}` : '')
    : ''

  let out = `<div class="snap">${label} <b>state=${esc(snap.stateText ?? '—')}</b> dom=${esc(snap.domText ?? '—')}  isComposed=${snap.isComposed ?? '—'}  cursor=${snap.cursor ?? '—'}  block=${esc(snap.blockName ?? '—')}${snap.blockId ? `/${esc(snap.blockId)}` : ''}${snap.desync ? '  ⚠DESYNC' : ''}</div>`
  if (diag) { out += `<div class="snap">${' '.repeat(6)}${esc(diag)}</div>` }
  if (withHtml && snap.domHTML) { out += `<div class="snap">${' '.repeat(6)}html=${esc(snap.domHTML)}</div>` }
  return out
}

function renderRow(record: TraceRecord): string {
  const isOpen = expanded.has(record.seq) || record.flags.length > 0
  const flags = record.flags.length ? ` <span class="flagtxt">⚠ ${esc(record.flags.join(' '))}</span>` : ''
  const calls = record.calls
    .map(call => `<div class="call">↳ ${esc(call.name)}(${esc(call.args.join(', '))})  blk=${esc(call.blockId)}  isComposed=${call.isComposedBefore}→${call.isComposedAfter}  preventDefault=${call.defaultPreventedAfter}  text ${esc(call.textBefore)} → ${esc(call.textAfter)}${call.error ? `  ERROR ${esc(call.error)}` : ''}</div>`)
    .join('')

  const body = isOpen
    ? snapLine('pre   ', record.pre, expanded.has(record.seq)) +
        snapLine('post  ', record.post, expanded.has(record.seq)) +
        snapLine('settle', record.settle, expanded.has(record.seq)) +
        calls
    : ''

  return `<div class="row${record.flags.length ? ' flag' : ''}" data-seq="${record.seq}">` +
    `<div class="hd"><span class="seq">#${record.seq}</span>` +
    `<span class="dt">+${Math.round(record.dt)}ms</span>` +
    `<span class="kind ${record.kind}">${record.kind}</span>` +
    `<span class="pane-tag">[${record.pane}]</span>` +
    `<span>${esc(record.type)}</span>` +
    `<span class="detail">${esc(detailText(record))}</span>${flags}</div>` +
    `<div class="body${isOpen ? '' : ' hidden'}">${body}</div>` +
    '</div>'
}

function paint(): void {
  const visible = recorder.records.filter(passes).slice(-MAX_ROWS)
  const atBottom = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 120

  logBody.innerHTML = visible.map(renderRow).join('')
  countEl.textContent = `${recorder.records.length} 条（显示 ${visible.length}）`

  if (atBottom) { logBody.scrollTop = logBody.scrollHeight }
}

function tick(): void {
  if (dirty) {
    dirty = false
    paint()
  }
  requestAnimationFrame(tick)
}

// -----------------------------------------------
// Log persistence

// A record is only flushed once its `settle` snapshot exists, otherwise the file
// would contain the pre-snapshot version of every event and lose the very
// post-IME-processing state the investigation is about.
setInterval(() => {
  const fresh = recorder.records.filter(r =>
    r.seq > lastWrittenSeq && (r.settle !== null || recorder.now() - r.dt > 1000))
  if (fresh.length === 0) { return }
  lastWrittenSeq = fresh[fresh.length - 1].seq
  sink.write(fresh)
}, 250)

// -----------------------------------------------
// Controls

el<HTMLButtonElement>('#toggle').addEventListener('click', (ev) => {
  const button = ev.currentTarget as HTMLButtonElement
  const next = !recorder.isEnabled()
  recorder.setEnabled(next)
  button.classList.toggle('rec-on', next)
  button.textContent = next ? '● 录制中' : '❚❚ 已暂停'
})

el<HTMLButtonElement>('#clear').addEventListener('click', () => {
  recorder.clear()
  expanded.clear()
  lastWrittenSeq = 0
  sink.reset()
  hint('已清空')
})

el<HTMLButtonElement>('#export').addEventListener('click', () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  downloadTrace(recorder.records, `ime-debug-${stamp}.jsonl`)
  hint(`已导出 ${recorder.records.length} 条`)
})

el<HTMLButtonElement>('#copy').addEventListener('click', async() => {
  const ok = await copyTrace(recorder.records)
  hint(ok ? `已复制 ${recorder.records.length} 条` : '复制失败，请用导出')
})

for (const [id, key] of [['#f-muya', 'muya'], ['#f-plain', 'plain'], ['#f-mutation', 'mutation'], ['#f-flag', 'onlyFlag']] as const) {
  el<HTMLInputElement>(id).addEventListener('change', (ev) => {
    filters[key] = (ev.currentTarget as HTMLInputElement).checked
    dirty = true
  })
}

logBody.addEventListener('click', (ev) => {
  const head = (ev.target as HTMLElement).closest<HTMLElement>('.hd')
  if (!head) { return }
  const seq = Number(head.parentElement?.dataset.seq)
  if (!expanded.has(seq)) { expanded.add(seq) } else { expanded.delete(seq) }
  dirty = true
})

let hintTimer = 0
function hint(text: string): void {
  hintEl.textContent = text
  clearTimeout(hintTimer)
  hintTimer = window.setTimeout(() => {
    hintEl.textContent = ''
  }, 4000)
}

// -----------------------------------------------

paint()
requestAnimationFrame(tick)
hint('在右侧 muya 面板里用豆包输入法打字，然后按退格/删除')
