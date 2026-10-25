// Core file/tab/document shapes shared between main and renderer.
//
// Concrete fields are populated as call-sites convert to TS in subsequent
// commits. Until then, these are intentionally open structures — better an
// imperfect surface than a placeholder that's wrong.

export type LineEnding = 'lf' | 'crlf'

export interface SerializedStat {
  size: number
  birthtimeMs: number
  mtimeMs: number
  ctimeMs: number
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink?: boolean
}

export interface MarkdownDocument {
  isPendingCreation?: boolean
  markdown: string
  filename: string
  pathname: string | null
  encoding?: string
  lineEnding?: LineEnding
  adjustLineEndingOnSave?: boolean
  trimTrailingNewline?: number
  isMixedLineEndings?: boolean
}

export interface FileHistory {
  stack: HistoryStackEntry[]
  index: number
  // Tracked by Muya to know which history frame represents the last edit
  // and the initial document. -1 when undefined.
  lastEditIndex?: number
  lastInitIndex?: number
}

export interface HistoryStackEntry {
  id: number | string
  [key: string]: unknown
}

export interface FileEncoding {
  encoding: string
  isBom: boolean
}

export interface FileWordCount {
  paragraph: number
  word: number
  character: number
  all: number
}

export interface FileSearchMatches {
  index: number
  matches: unknown[]
  value: string
}

/** Canonical per-tab state shared by renderer stores, buffered persistence and IPC. */
export interface IFileState {
  readOnly: boolean
  // Transient navigation state; deliberately excluded from buffered tab state.
  isPreview: boolean
  modeChanging?: boolean
  diskMissing?: boolean
  diskConflict?: boolean
  // A named CLI buffer can be unmodified while its target does not exist yet.
  isPendingCreation?: boolean
  id: string
  filename: string
  // Empty for untitled buffers; always a string at runtime.
  pathname: string
  markdown: string
  isSaved: boolean
  encoding: FileEncoding
  lineEnding: LineEnding | string
  adjustLineEndingOnSave: boolean
  trimTrailingNewline: number
  history: FileHistory
  cursor: unknown
  wordCount: FileWordCount
  searchMatches: FileSearchMatches
  scrollTop: number
  // View state for this open tab; deliberately excluded from buffered persistence.
  tocCollapsedKeys?: string[]
  muyaIndexCursor: unknown
  notifications: FileNotification[]
  lastSavedHistoryId?: number
  // Snapshot of the markdown as last written to / read from disk. Used only by
  // source-code mode (which has no undo-history id) to detect when an edit was
  // undone back to the saved text. `undefined` means the on-disk baseline is
  // unknown (e.g. a crash-recovered unsaved tab).
  savedMarkdown?: string
  // Three-way merge base: the disk content as of the last point the editor
  // fully incorporated it (load, save, clean external reload, successful
  // merge). Unlike `savedMarkdown` this also moves when an external change is
  // merged into a dirty tab — it is the common ancestor for the NEXT merge,
  // not the last saved text. `undefined` = unknown; merging then degrades to
  // the conservative keep-mine path.
  baseMarkdown?: string
  // External change that conflicted with unsaved edits and was set aside
  // (theirs is NOT on disk in merged form). Replaced by each newer watcher
  // event until the user resolves it; cleared on save (the user's version
  // won) or when a later change merges cleanly.
  pendingExternalChange?: { markdown: string; mtimeMs?: number }
  // Line ranges (half-open, in the CURRENT merged content) of the external
  // changes applied by the last merge — drives the merge highlight in the
  // WYSIWYG block flash and the source-code mode line background. Cleared on
  // save, on a full reload, and when the user edits the highlighted text.
  lastMergedRegions?: Array<{ start: number; end: number }>
  // Muya block tree; only populated for the actively edited tab.
  blocks?: unknown
  isMixedLineEndings?: boolean
}

export interface FileNotification {
  msg: string
  showConfirm: boolean
  style: string
  exclusiveType: string
  action: (status?: unknown) => void
  // Custom label for the OK button (falls back to `common.ok`).
  primaryLabel?: string
  // Optional extra labeled button next to the OK/close controls (e.g. the
  // external-change banner's "Merge" / "view changes"). Clicking it consumes
  // the banner and runs `secondaryAction` instead of `action`.
  secondaryLabel?: string
  secondaryAction?: () => void
}

export type ITab = IFileState

export interface FileChangeDetail {
  pathname: string
  type?: string
  [key: string]: unknown
}

export interface TabOptions {
  readOnly?: boolean
  selected?: boolean
  /** Link fragment to reveal once the tab is active, e.g. `setup` from `other.md#setup`. */
  anchor?: string
  [key: string]: unknown
}

export interface SidebarOpenOptions extends TabOptions {
  preview?: boolean
  requestId?: number
}

export interface SaveOptions {
  isPendingCreation?: boolean
  // Encoding is the `FileEncoding` object at runtime (`{ encoding, isBom }`).
  // String form is accepted for legacy callers that haven't been updated.
  encoding?: FileEncoding | string
  lineEnding?: LineEnding | string
  adjustLineEndingOnSave?: boolean
  trimTrailingNewline?: number
}

/** Unsaved tab payload for close-window and save-tabs confirmation requests. */
export interface UnsavedFile {
  readOnly?: boolean
  id: string
  filename: string
  pathname?: string
  markdown: string
  options: SaveOptions
  defaultPath?: string
}

/**
 * Serializable subset of a tab transferred between windows by tab drag &
 * drop or the "open in new window" tab context-menu action. Consumed on the
 * main side to decide how to open the tab in the target window (from disk,
 * from an unsaved snapshot, or as a new untitled buffer).
 */
export type TabTransferData = {
  /** Renderer-local tab id of the source window. */
  id: string
  pathname: string
  filename: string
  markdown: string
  isSaved: boolean
  encoding?: { encoding: string; isBom: boolean }
  lineEnding?: LineEnding | string
  adjustLineEndingOnSave?: boolean
  trimTrailingNewline?: number
}

export interface TabDragPayload {
  /** Unique id for one HTML5 drag session (generated at dragstart). */
  dragId: string
  /** BrowserWindow id of the window the drag started in. */
  sourceWindowId: number
  tab: TabTransferData
}

export interface BootstrapEditorConfig {
  isNewWindow?: boolean
  addBlankTab?: boolean
  /** Seed Markdown for new untitled tabs, including stdin launches. */
  markdownList: string[]
  lineEnding: LineEnding
  sideBarVisibility: boolean
  tabBarVisibility: boolean
  sourceCodeModeEnabled: boolean
  preferences?: unknown
  userKeybindings?: unknown
  recentlyUsedFiles?: string[]
  windowId?: number
  [key: string]: unknown
}

export interface PageOptions {
  pageSize?: string
  pageSizeWidth?: number
  pageSizeHeight?: number
  isLandscape?: boolean
  printBackground?: boolean
  [key: string]: unknown
}

export type ExportType = 'pdf' | 'html' | 'styledHtml' | 'png' | 'jpeg'

export interface PandocExportPayload {
  githubAlerts?: boolean
  /** One of `PANDOC_EXPORT_FORMATS[].id`. */
  target: string
  markdown: string
  /** Names the output when the tab has no path yet. */
  title: string
  /** Folder pandoc resolves the document's relative links against. */
  pathname: string
  /** Reader preferences only the renderer knows; see `getPandocReader`. */
  superSubScript: boolean
  footnote: boolean
  texMathDollars: boolean
  texMathGfm: boolean
  texMathSingleBackslash: boolean
  texMathDoubleBackslash: boolean
}
