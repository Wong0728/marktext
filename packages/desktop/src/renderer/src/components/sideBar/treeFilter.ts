// Pure filename-filter helpers for the sidebar file tree (#6). The filter is
// a render-layer view: the project store keeps mutating its tree in place,
// so the visible nodes are derived per render instead of pruning the source
// tree.

import type { TreeFileNode, TreeFolderNode } from './types'

const matches = (name: string, filter: string): boolean => {
  return name.toLowerCase().includes(filter)
}

/** Whether a single file node passes the (already normalized) filter. */
export const fileMatchesFilter = (file: TreeFileNode, normalizedFilter: string): boolean => {
  if (!normalizedFilter) return true
  return matches(file.name, normalizedFilter)
}

/**
 * Whether a folder passes the filter: either its own name matches (its whole
 * subtree is then shown unfiltered) or any descendant file / folder matches.
 */
export const folderMatchesFilter = (folder: TreeFolderNode, normalizedFilter: string): boolean => {
  if (!normalizedFilter) return true
  if (matches(folder.name, normalizedFilter)) return true
  return (
    folder.folders.some(child => folderMatchesFilter(child, normalizedFilter)) ||
    folder.files.some(file => matches(file.name, normalizedFilter))
  )
}

/** Lowercased + trimmed filter, or `''` when the filter is inactive. */
export const normalizeFilter = (filter: string | undefined): string => {
  return (filter ?? '').trim().toLowerCase()
}
