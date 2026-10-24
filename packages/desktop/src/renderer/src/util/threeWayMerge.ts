/**
 * Line-based three-way merge (diff3) for externally rewritten files.
 *
 * Given the common ancestor (`base`), the user's current buffer (`ours`) and
 * the new on-disk content (`theirs` — an AI agent, git checkout, sync client…),
 * this computes a merged document with no editor/DOM dependency so it can be
 * unit-tested in isolation:
 *
 * - Change regions that do not overlap in `base` are merged automatically,
 *   no matter which side made them.
 * - Overlapping regions conflict. Policy is the caller's business (the editor
 *   store keeps `ours` and stashes `theirs` for the user); when
 *   `conflicts > 0` the `merged` output keeps the ours-side content inside
 *   conflict regions and MUST NOT be applied.
 *
 * The merge happens on the markdown text, not the muya block tree — the
 * merged string is handed to the engine as a whole (see `Muya.replaceContent`),
 * which re-parses it and records the change as a single invertible undo
 * boundary.
 */

interface ReplaceHunk {
  /** Half-open range [baseStart, baseEnd) of replaced lines in the base. */
  baseStart: number
  baseEnd: number
  /** Matching half-open range in the changed side's lines. */
  sideStart: number
  sideEnd: number
}

export interface MergeRegionRange {
  /** Half-open line range [start, end) in the MERGED content. */
  start: number
  end: number
}

export interface Diff3MergeResult {
  /** Merged lines; with conflicts, conflict regions hold the ours-side content. */
  merged: string[]
  /** Number of conflicting regions (0 = clean merge, safe to apply). */
  conflicts: number
  /** Number of theirs-side change regions merged in cleanly. */
  theirsChanges: number
  /** Line ranges of the theirs-side changes, in merged-content coordinates. */
  theirsRegions: MergeRegionRange[]
}

export interface ThreeWayMergeResult {
  /** Merged markdown; with conflicts, conflict regions hold the ours-side content. */
  merged: string
  /** Number of conflicting regions (0 = clean merge, safe to apply). */
  conflicts: number
  /** Number of theirs-side change regions merged in cleanly. */
  theirsChanges: number
  /** Line ranges of the theirs-side changes, in merged-content coordinates. */
  theirsRegions: MergeRegionRange[]
}

/**
 * Myers O(ND) diff of two line arrays, grouped into non-adjacent replace
 * hunks. Hunks are ordered by position and separated by at least one
 * unchanged base line.
 */
const diffReplaceHunks = (a: string[], b: string[]): ReplaceHunk[] => {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []

  const max = n + m
  const offset = max
  const size = 2 * max + 1
  // v[k + offset] = furthest x reached on diagonal k (x - y = k).
  const v = new Int32Array(size)
  // trace[d] = v snapshot BEFORE processing step d (i.e. after step d - 1).
  const trace: Int32Array[] = []
  let steps = -1

  for (let d = 0; d <= max && steps < 0; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset] // down-move: insert from the other side
      } else {
        x = v[k - 1 + offset] + 1 // right-move: delete a[x]
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[k + offset] = x
      if (x >= n && y >= m) {
        steps = d
        break
      }
    }
  }

  // Backtrack the shortest edit script; every step contributes one edit move
  // (a single delete and/or insert) preceded by a snake of unchanged lines.
  const edits: ReplaceHunk[] = []
  let x = n
  let y = m
  for (let d = steps; d >= 1; d--) {
    const vPrev = trace[d]
    const k = x - y
    const goDown = k === -d || (k !== d && vPrev[k - 1 + offset] < vPrev[k + 1 + offset])
    const prevK = goDown ? k + 1 : k - 1
    const prevX = vPrev[prevK + offset]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
    }
    if (x !== prevX || y !== prevY) {
      edits.push({ baseStart: prevX, baseEnd: x, sideStart: prevY, sideEnd: y })
    }
    x = prevX
    y = prevY
  }

  edits.reverse()

  // Fuse adjacent edit moves (delete+insert at the same spot) into one
  // replace hunk so diff3 sees a change region, not two touching ones.
  const hunks: ReplaceHunk[] = []
  for (const edit of edits) {
    const last = hunks[hunks.length - 1]
    if (last && edit.baseStart <= last.baseEnd) {
      last.baseEnd = edit.baseEnd
      last.sideEnd = edit.sideEnd
    } else {
      hunks.push({ ...edit })
    }
  }
  return hunks
}

const linesEqual = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

interface MergeRegion {
  baseStart: number
  baseEnd: number
  /** Resolved content when the region is not a conflict. */
  lines?: string[]
  /** Set when the region conflicts; carries both sides' content. */
  conflictOurs?: string[]
  conflictTheirs?: string[]
  /** Which side's change a resolved region came from. */
  from?: 'ours' | 'theirs'
}

/**
 * Walk both hunk lists (each sorted by base position) and produce merge
 * regions: ours-only, theirs-only, or conflicting regions covering every
 * hunk that starts inside them.
 */
const buildRegions = (base: string[], ours: string[], theirs: string[]): MergeRegion[] => {
  const ourHunks = diffReplaceHunks(base, ours)
  const theirHunks = diffReplaceHunks(base, theirs)
  const regions: MergeRegion[] = []

  let iO = 0
  let iT = 0
  while (iO < ourHunks.length || iT < theirHunks.length) {
    const ho = ourHunks[iO]
    const ht = theirHunks[iT]

    // Strict half-open intersection: touching ranges merge independently,
    // and empty (pure-insert) ranges never intersect anything.
    if (ho && ht && ho.baseStart < ht.baseEnd && ht.baseStart < ho.baseEnd) {
      // Grow the conflict region until no further hunk starts inside it.
      const start = Math.min(ho.baseStart, ht.baseStart)
      let end = Math.max(ho.baseEnd, ht.baseEnd)
      let lastOur = ho
      let lastTheir = ht
      iO++
      iT++
      for (;;) {
        const no = ourHunks[iO]
        const nt = theirHunks[iT]
        if (no && no.baseStart < end) {
          end = Math.max(end, no.baseEnd)
          lastOur = no
          iO++
        } else if (nt && nt.baseStart < end) {
          end = Math.max(end, nt.baseEnd)
          lastTheir = nt
          iT++
        } else {
          break
        }
      }
      // Map the base range onto each side through its first/last hunk.
      const oursSlice = ours.slice(start + ho.sideStart - ho.baseStart, end + lastOur.sideEnd - lastOur.baseEnd)
      const theirsSlice = theirs.slice(
        start + ht.sideStart - ht.baseStart,
        end + lastTheir.sideEnd - lastTheir.baseEnd
      )
      if (linesEqual(oursSlice, theirsSlice)) {
        // Both sides made the identical change — not a real conflict.
        regions.push({ baseStart: start, baseEnd: end, lines: oursSlice, from: 'ours' })
      } else {
        regions.push({ baseStart: start, baseEnd: end, conflictOurs: oursSlice, conflictTheirs: theirsSlice })
      }
    } else if (ho && (!ht || ho.baseStart <= ht.baseStart)) {
      regions.push({
        baseStart: ho.baseStart,
        baseEnd: ho.baseEnd,
        lines: ours.slice(ho.sideStart, ho.sideEnd),
        from: 'ours'
      })
      iO++
    } else if (ht) {
      regions.push({
        baseStart: ht.baseStart,
        baseEnd: ht.baseEnd,
        lines: theirs.slice(ht.sideStart, ht.sideEnd),
        from: 'theirs'
      })
      iT++
    }
  }

  return regions
}

/**
 * Three-way merge of line arrays. Stable base lines and non-overlapping
 * change regions are emitted in order; overlapping regions conflict unless
 * both sides made the identical change.
 */
export const diff3MergeLines = (base: string[], ours: string[], theirs: string[]): Diff3MergeResult => {
  const regions = buildRegions(base, ours, theirs)

  const merged: string[] = []
  const theirsRegions: MergeRegionRange[] = []
  let cursor = 0
  let conflicts = 0
  let theirsChanges = 0
  for (const region of regions) {
    for (let i = cursor; i < region.baseStart; i++) {
      merged.push(base[i])
    }
    if (region.conflictOurs) {
      conflicts++
      merged.push(...region.conflictOurs)
    } else if (region.lines) {
      if (region.from === 'theirs') {
        theirsChanges++
        theirsRegions.push({ start: merged.length, end: merged.length + region.lines.length })
      }
      merged.push(...region.lines)
    }
    cursor = region.baseEnd
  }
  for (let i = cursor; i < base.length; i++) {
    merged.push(base[i])
  }

  return { merged, conflicts, theirsChanges, theirsRegions }
}

/**
 * Three-way merge of markdown strings (split on `\n`; a trailing newline is
 * the final empty line and round-trips through `join`).
 */
export const threeWayMerge = (base: string, ours: string, theirs: string): ThreeWayMergeResult => {
  const result = diff3MergeLines(base.split('\n'), ours.split('\n'), theirs.split('\n'))
  return {
    merged: result.merged.join('\n'),
    conflicts: result.conflicts,
    theirsChanges: result.theirsChanges,
    theirsRegions: result.theirsRegions
  }
}
