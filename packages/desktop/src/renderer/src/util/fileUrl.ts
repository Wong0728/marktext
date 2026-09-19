// Convert an absolute filesystem path to a `file://` URL for export.
//
// Naive `` `file://${path}` `` interpolation is malformed: a Windows drive path
// becomes `file://C:/x`, where `C:` parses as the *authority* (host) rather than
// part of the path. Chromium tolerates it, but strict readers — pandoc's DOCX
// image fetcher in particular — resolve it to a nonexistent host and drop every
// image. The correct forms are:
//
//   C:\a\b.png      → file:///C:/a/b.png
//   /a/b.png        → file:///a/b.png
//   \\server\a\b.png → file://server/a/b.png   (host is the authority)

// Percent-encode each path segment. CJK, spaces, `#` and `?` all break a URL
// when left raw; the drive-letter colon is kept literal (Node's pathToFileURL
// and every browser do the same).
const encodeSegments = (posixPath: string): string =>
  posixPath.split('/').map(encodeURIComponent).join('/')

export const pathToFileUrl = (fsPath: string): string => {
  if (!fsPath) return fsPath
  const posix = fsPath.replace(/\\/g, '/')

  // UNC: strip the leading `//` so the server becomes the URL authority.
  if (/^\/\/[^/]/.test(posix)) return `file://${encodeSegments(posix.slice(2))}`

  const drive = /^([a-zA-Z]):(?=$|\/)/.exec(posix)
  if (drive) return `file:///${drive[1]}:${encodeSegments(posix.slice(drive[0].length))}`

  return `file://${encodeSegments(posix.startsWith('/') ? posix : `/${posix}`)}`
}

const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment)
  } catch {
    // A literal `%` that is not a valid escape (e.g. `50%.png`) — keep as-is.
    return segment
  }
}

/**
 * Inverse of `pathToFileUrl`: turn a `file://` URL back into a plain
 * filesystem path.
 *
 * Needed for the pandoc DOCX path. pandoc percent-encodes the non-ASCII parts
 * of a `file:` URI and then opens the *encoded* string as a path, so any URL
 * with CJK (or other non-ASCII) in it fails to fetch — while a bare path is
 * read verbatim and works. Word documents with Chinese folder names are the
 * common case, so DOCX conversion gets paths, not URLs.
 */
export const fileUrlToNativePath = (url: string): string => {
  if (!/^file:\/\//i.test(url)) return url
  let rest = url.replace(/^file:\/\//i, '')

  // `file://host/…` (UNC) vs `file:///C:/…` / `file:///posix` (empty authority).
  let isUnc = false
  if (rest && rest[0] !== '/') {
    isUnc = true
  } else {
    rest = rest.slice(1)
  }

  const posix = isUnc ? `//${rest}` : (/^[a-zA-Z]:(\/|$)/.test(rest) ? rest : `/${rest}`)
  const decoded = posix.split('/').map(decodeSegment).join('/')
  return isUnc ? decoded.replace(/\//g, '\\') : decoded
}
