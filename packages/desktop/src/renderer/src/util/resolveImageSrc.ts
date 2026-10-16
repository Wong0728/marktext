import { pathToFileUrl } from './fileUrl'

// Resolve an <img>'s src for export / static print (GH#678): a relative local
// path is resolved to an absolute `file://` URL against the current document
// directory; URLs, `data:` URIs, and already-absolute / `file://` srcs are left
// untouched. Ported from the legacy muyajs `getImageInfo(src)` so a saved
// styled-HTML / PDF document keeps rendering its images after it is moved out of
// the source folder.
const IMAGE_EXT_REG = /\.(?:jpeg|jpg|png|gif|svg|webp)(?=\?|$)/i

export function resolveLocalImageSrc(src: string, directory = window.DIRNAME): string {
  if (!src) return src
  // Already a URL or data: URI — leave as-is (avoids `file://file://…`).
  if (/^(?:https?:|file:|data:)/i.test(src)) return src
  // Only rewrite recognised local image paths (mirrors muyajs's IMAGE_EXT_REG
  // gate) — leave anything else untouched, e.g. an extensionless absolute
  // server path `/api/image?id=…` must not become `file:///api/image…`.
  if (!IMAGE_EXT_REG.test(src)) return src
  try {
    src = decodeURIComponent(src)
  } catch {
    // A literal percent sign is valid in a local filename.
  }
  // Absolute local image path (POSIX / UNC / Windows drive) → file://.
  if (/^(?:\/|\\\\|[a-zA-Z]:[\\/])/.test(src)) return pathToFileUrl(src)
  // Relative local image path — resolve against the document directory.
  if (directory) return pathToFileUrl(window.path.resolve(directory, src))
  return src
}
