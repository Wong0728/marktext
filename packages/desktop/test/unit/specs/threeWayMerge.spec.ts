import { describe, it, expect } from 'vitest'
import { threeWayMerge } from '@/util/threeWayMerge'

/**
 * Diff3 merge used by the external-change pipeline (store/editor.ts): when a
 * watched file changes on disk while the tab is dirty, the disk version is
 * merged against the user's buffer through their common ancestor. These tests
 * pin the two properties the feature relies on: non-overlapping edits merge
 * automatically, and overlapping edits are reported as conflicts instead of
 * being applied.
 */

// The classic diff3 example: base A..E, ours adds X at the top, theirs
// changes C to C'. Both sides touch disjoint regions.
const BASE = ['A', 'B', 'C', 'D', 'E'].join('\n')

describe('threeWayMerge — clean merges', () => {
  it('merges disjoint edits from both sides', () => {
    const ours = ['X', 'A', 'B', 'C', 'D', 'E'].join('\n')
    const theirs = ['A', 'B', "C'", 'D', 'E'].join('\n')

    const result = threeWayMerge(BASE, ours, theirs)

    expect(result.conflicts).toBe(0)
    expect(result.merged).toBe(['X', 'A', 'B', "C'", 'D', 'E'].join('\n'))
    expect(result.theirsChanges).toBe(1)
    // The theirs hunk lands at merged line 3 (0-based), one line long.
    expect(result.theirsRegions).toEqual([{ start: 3, end: 4 }])
  })

  it('merges when ours did not change at all', () => {
    const result = threeWayMerge(BASE, BASE, ['A', 'B', "C'", 'D', 'E'].join('\n'))

    expect(result.conflicts).toBe(0)
    expect(result.merged).toBe(['A', 'B', "C'", 'D', 'E'].join('\n'))
    expect(result.theirsChanges).toBe(1)
  })

  it('is a no-op when only ours changed', () => {
    const ours = ['A', 'B', 'C changed by user', 'D', 'E'].join('\n')
    const result = threeWayMerge(BASE, ours, BASE)

    expect(result.conflicts).toBe(0)
    expect(result.merged).toBe(ours)
    expect(result.theirsChanges).toBe(0)
  })

  it('keeps both sides of insertions at the same base position', () => {
    // Both insert after B: ours adds X, theirs adds Y. The insertions do not
    // overlap (empty base ranges never intersect), so both survive.
    const ours = ['A', 'B', 'X', 'C', 'D', 'E'].join('\n')
    const theirs = ['A', 'B', 'Y', 'C', 'D', 'E'].join('\n')

    const result = threeWayMerge(BASE, ours, theirs)

    expect(result.conflicts).toBe(0)
    expect(result.merged).toBe(['A', 'B', 'X', 'Y', 'C', 'D', 'E'].join('\n'))
  })

  it('applies theirs cleanly when ours is identical to theirs', () => {
    const changed = ['A', 'B', "C'", 'D', 'E'].join('\n')
    const result = threeWayMerge(BASE, changed, changed)

    expect(result.conflicts).toBe(0)
    expect(result.merged).toBe(changed)
  })

  it('round-trips a trailing newline', () => {
    const base = 'A\nB\n'
    const ours = 'A\nB\nC\n' // user appended a paragraph
    const theirs = "A\nB'\n" // external rewrote B

    const result = threeWayMerge(base, ours, theirs)

    expect(result.conflicts).toBe(0)
    expect(result.merged).toBe("A\nB'\nC\n")
  })

  it('merges a burst of theirs hunks around untouched user edits', () => {
    // Simulates an agent rewriting two distant paragraphs while the user
    // edited a third one in the middle.
    const base = ['p1', 'p2', 'p3', 'p4', 'p5'].join('\n')
    const ours = ['p1', 'p2', 'p3 edited by user', 'p4', 'p5'].join('\n')
    const theirs = ['p1 rewritten', 'p2', 'p3', 'p4', 'p5 rewritten'].join('\n')

    const result = threeWayMerge(base, ours, theirs)

    expect(result.conflicts).toBe(0)
    expect(result.merged).toBe(
      ['p1 rewritten', 'p2', 'p3 edited by user', 'p4', 'p5 rewritten'].join('\n')
    )
    expect(result.theirsChanges).toBe(2)
    // Regions are in MERGED-content coordinates (they drive the editor's
    // merge highlight).
    expect(result.theirsRegions).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 5 }
    ])
  })

  it('handles repeated identical lines (Myers pathologies)', () => {
    const base = ['x', 'x', 'x', 'x'].join('\n')
    const ours = ['x', 'x', 'user', 'x', 'x'].join('\n')
    const theirs = ['x', 'x', 'x', 'x', 'x', 'x'].join('\n')

    const result = threeWayMerge(base, ours, theirs)

    expect(result.conflicts).toBe(0)
    // Theirs appended two lines; ours inserted one in the middle.
    expect(result.merged).toBe(['x', 'x', 'user', 'x', 'x', 'x', 'x'].join('\n'))
  })

  it('handles empty strings on either side', () => {
    expect(threeWayMerge('', '', '').merged).toBe('')
    // Fresh external file over a still-empty buffer.
    expect(threeWayMerge('', '', 'hello').merged).toBe('hello')
    expect(threeWayMerge('', 'hello', '').conflicts).toBe(0)
  })
})

describe('threeWayMerge — conflicts', () => {
  it('reports a conflict when both sides rewrite the same line', () => {
    const ours = ['A', 'B', 'C by user', 'D', 'E'].join('\n')
    const theirs = ['A', 'B', "C' by disk", 'D', 'E'].join('\n')

    const result = threeWayMerge(BASE, ours, theirs)

    expect(result.conflicts).toBe(1)
    // With conflicts the merged output is not applicable: ours is kept in the
    // conflict region (the store stashes theirs instead of applying).
    expect(result.merged).toBe(ours)
  })

  it('reports one conflict spanning adjacent same-region edits', () => {
    const base = ['1', '2', '3', '4', '5', '6', '7'].join('\n')
    const ours = ['1', '2a', '3a', '4', '5', '6', '7'].join('\n')
    const theirs = ['1', '2b', '3b', '4', '5', '6', '7'].join('\n')

    const result = threeWayMerge(base, ours, theirs)

    expect(result.conflicts).toBe(1)
    expect(result.merged).toBe(ours)
  })

  it('does not flag touching-but-disjoint edits as conflicts', () => {
    // Ours rewrites line 2; theirs rewrites line 3. Ranges [1,2) and [2,3)
    // touch but do not intersect.
    const base = ['1', '2', '3', '4'].join('\n')
    const ours = ['1', '2 by user', '3', '4'].join('\n')
    const theirs = ['1', '2', '3 by disk', '4'].join('\n')

    const result = threeWayMerge(base, ours, theirs)

    expect(result.conflicts).toBe(0)
    expect(result.merged).toBe(['1', '2 by user', '3 by disk', '4'].join('\n'))
  })

  it('reports a conflict when theirs deletes a region ours edited', () => {
    const base = ['1', '2', '3', '4'].join('\n')
    const ours = ['1', '2 edited', '3', '4'].join('\n')
    const theirs = ['1', '4'].join('\n') // external deleted 2..3

    const result = threeWayMerge(base, ours, theirs)

    expect(result.conflicts).toBe(1)
  })

  it('does not conflict when both sides made the identical change', () => {
    const ours = ['A', 'B', 'C shared', 'D', 'E'].join('\n')
    const result = threeWayMerge(BASE, ours, ours)

    expect(result.conflicts).toBe(0)
    expect(result.merged).toBe(ours)
  })

  it('reports a conflict when theirs rewrites a region ours rewrote differently', () => {
    // AI rewrote a paragraph it had already rewritten once while the user
    // never touched it — but ours contains the first rewrite merged in from
    // an earlier round against a DIFFERENT base, so from this base both
    // sides changed the region.
    const base = ['para'].join('\n')
    const ours = ['para v1'].join('\n')
    const theirs = ['para v2'].join('\n')

    const result = threeWayMerge(base, ours, theirs)

    expect(result.conflicts).toBe(1)
  })
})
