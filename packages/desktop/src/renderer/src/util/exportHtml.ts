// Desktop-side styled-HTML export wrapper for the @muyajs/core engine.
//
// The new engine (`@muyajs/core`) exposes `MarkdownToHtml(md, muya).generate()`
// which produces a full standalone HTML document (markdown rendered, diagrams
// rasterised, github-markdown-css + katex + prism linked, plus the engine
// export stylesheet). It has NO equivalent of the legacy muyajs
// `exportStyledHTML`, which additionally injected a table-of-contents at the
// `[TOC]` marker and wrapped the article in a header/footer page table for PDF
// / print. This helper reproduces that desktop-specific behaviour on top of the
// engine output so the export result stays equivalent to the legacy engine.

import type { Muya } from '@muyajs/core'
import { MarkdownToHtml } from '@muyajs/core'
import { sanitize, EXPORT_DOMPURIFY_CONFIG } from './dompurify'
import { resolveLocalImageSrc } from './resolveImageSrc'
import { resolveLocalLinkHref } from './resolveLinkHref'
import { fileUrlToNativePath } from './fileUrl'
import { cleanKaTeXMathML } from './mathml'

export interface HeaderFooterPart {
  type?: number
  left?: string
  center?: string
  right?: string
}

export interface ExportStyledHtmlOptions {
  title?: string
  printOptimization?: boolean
  extraCss?: string
  /** Pre-rendered TOC HTML (from `getHtmlToc`). Injected at `[TOC]`. */
  toc?: string
  header?: HeaderFooterPart | null
  footer?: HeaderFooterPart | null
  headerFooterStyled?: boolean
  /** Editor text direction ('ltr' | 'rtl' | 'auto'); set on the exported <html>. */
  dir?: string
}

// Ported verbatim from legacy muyajs `headerFooterStyle.css` so the page
// header/footer table lays out the same in the exported document.
const HEADER_FOOTER_CSS = `
:root { --footerHeaderBorderColor: #1c1c1c; }
table.page-container { width: 100%; border-collapse: collapse; }
table.page-container > tbody,
table.page-container > tbody > tr,
table.page-container > tbody > tr > td { display: block; width: 100vw; }
table.page-container > tbody > tr > td { overflow-wrap: anywhere; }
table.page-container > thead,
table.page-container > tfoot { display: table-header-group; }
.page-header .hf-container,
.page-footer-fake .hf-container,
.page-footer .hf-container { display: flex; justify-content: space-between; font-size: 0.75em; font-weight: 400; }
.page-header { display: table-header-group; }
.page-header .hf-container { margin-bottom: 16px; }
.page-header.styled .hf-container { padding-bottom: 1px; border-bottom: 1px solid var(--footerHeaderBorderColor); }
.page-header .hf-container > div { flex: 1; max-height: 100px; overflow: hidden; }
.page-header .header-content-left { text-align: left; margin-right: 4px; }
.page-header .header-content { text-align: center; }
.page-header .header-content-right { text-align: right; margin-left: 4px; }
.page-header.single .header-content-left,
.page-header.single .header-content-right { display: none; }
.page-footer-fake { display: table-footer-group; }
.page-footer-fake .hf-container { margin-top: 16px; visibility: hidden; }
.page-footer { position: fixed; bottom: 0; left: 0; right: 0; }
.page-footer.styled .hf-container { padding-top: 1px; border-top: 1px solid var(--footerHeaderBorderColor); }
.page-footer .hf-container > div { flex: 1; white-space: nowrap; overflow: hidden; }
.page-footer .footer-content-left { text-align: left; margin-right: 14px; }
.page-footer .footer-content { text-align: center; }
.page-footer .footer-content-right { text-align: right; margin-left: 14px; }
.page-footer.single .footer-content-left,
.page-footer.single .footer-content-right { display: none; }
`

const HF_TABLE_START = '<table class="page-container">'
const HF_TABLE_END = '</table>'
const HF_TABLE_FOOTER = `<tfoot class="page-footer-fake"><tr><td>
  <div class="hf-container">&nbsp;</div>
</td></tr></tfoot>`

const styledClass = (value: boolean | undefined): string => {
  if (value === undefined) return ''
  return value ? ' styled' : ' simple'
}

// Header/footer left/center/right are user-supplied, so sanitize them here.
// The article body is NOT sanitized again (it was already sanitized by the
// engine during render); re-sanitizing it strips diagram <foreignObject>
// labels and drops mermaid content from the export (#3359).
const hf = (value: string): string => sanitize(value, EXPORT_DOMPURIFY_CONFIG) as string

const createTableHeader = (header: HeaderFooterPart, headerFooterStyled?: boolean): string => {
  const { type, left = '', center = '', right = '' } = header
  const headerClass = `page-header ${(type === 1 ? 'single' : '') + styledClass(headerFooterStyled)}`
    .replace(/\s+/g, ' ')
    .trim()
  return `<thead class="${headerClass}"><tr><th>
  <div class="hf-container">
    <div class="header-content-left">${hf(left)}</div>
    <div class="header-content">${hf(center)}</div>
    <div class="header-content-right">${hf(right)}</div>
  </div>
</th></tr></thead>`
}

const createRealFooter = (footer: HeaderFooterPart, headerFooterStyled?: boolean): string => {
  const { type, left = '', center = '', right = '' } = footer
  const footerClass = `page-footer ${(type === 1 ? 'single' : '') + styledClass(headerFooterStyled)}`
    .replace(/\s+/g, ' ')
    .trim()
  return `<div class="${footerClass}">
  <div class="hf-container">
    <div class="footer-content-left">${hf(left)}</div>
    <div class="footer-content">${hf(center)}</div>
    <div class="footer-content-right">${hf(right)}</div>
  </div>
</div>`
}

const createTableBody = (article: string): string =>
  `<tbody><tr><td>
  <div class="main-container">
    ${article}
  </div>
</td></tr></tbody>`

// Match a standalone `[TOC]` line (mirrors legacy marked TOC block token).
const TOC_REG = /^ {0,3}\[TOC\] *$/im

// Match the `src="…"` of an <img> tag in the (already sanitized, double-quoted)
// engine output, so relative image paths can be rewritten to absolute `file://`
// URLs. A string rewrite avoids re-serializing the whole article DOM (which
// holds rendered KaTeX / diagram SVG).
const IMG_SRC_REG = /(<img\b[^>]*?\ssrc=")([^"]*)(")/gi

/**
 * Rewrite relative / absolute-local `<img src>` to absolute `file://` URLs so a
 * saved styled-HTML document still resolves its images after it is moved out of
 * the source folder (legacy muyajs `correctImageSrc` parity, issue 230). Remote
 * URLs and `data:` URIs are left untouched. Idempotent: a `file://` src is left
 * as-is, so the PDF / print path (which rewrites again via printService) is a
 * no-op the second time.
 */
const rewriteImageSrcs = (html: string): string =>
  html.replace(IMG_SRC_REG, (match, pre: string, src: string, post: string) => {
    const resolved = resolveLocalImageSrc(src)
    return resolved === src ? match : `${pre}${resolved}${post}`
  })

// Match the `href="…"` of an <a> tag in the (already sanitized, double-quoted)
// engine output, so relative local links are rewritten to absolute `file://`
// URLs the same way images are.
const ANCHOR_HREF_REG = /(<a\b[^>]*?\shref=")([^"]*)(")/gi

/**
 * Rewrite relative / absolute-local `<a href>` to absolute `file://` URLs so a
 * link to a local file still resolves after the saved document is moved out of
 * the source folder (#1688). Remote URLs, `mailto:`/`data:` schemes and in-page
 * fragment anchors are left untouched.
 */
const rewriteAnchorHrefs = (html: string): string =>
  html.replace(ANCHOR_HREF_REG, (match, pre: string, href: string, post: string) => {
    const resolved = resolveLocalLinkHref(href)
    return resolved === href ? match : `${pre}${resolved}${post}`
  })

// Mime types of the local image extensions resolveLocalImageSrc accepts.
const EMBED_MIME_TYPES: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp'
}

/**
 * Inline every local `<img src="file://…">` as a base64 `data:` URI so the
 * exported HTML is self-contained — it keeps working when moved, shared or
 * opened on another machine with no image folder around. Same images share
 * one lookup; images that cannot be read keep their `file://` src.
 */
export const embedImagesAsDataUris = async(html: string): Promise<string> => {
  const uris = new Map<string, string>()
  const tasks: Promise<void>[] = []
  html.replace(IMG_SRC_REG, (match, _pre: string, src: string) => {
    if (/^file:\/\//i.test(src) && !uris.has(src)) {
      tasks.push((async() => {
        try {
          const nativePath = fileUrlToNativePath(src)
          const ext = (/\.([a-z0-9]+)(?:$|\?)/i.exec(nativePath) || [])[1]?.toLowerCase()
          const mime = ext && EMBED_MIME_TYPES[ext]
          if (!mime) return
          const bytes = await window.fileUtils.readFile(nativePath)
          if (!(bytes instanceof Uint8Array)) return
          uris.set(src, await bytesToDataUri(bytes, mime))
        } catch {
          // Keep the original src for unreadable images.
        }
      })())
    }
    return match
  })
  await Promise.all(tasks)
  if (uris.size === 0) return html
  return html.replace(IMG_SRC_REG, (match, pre: string, src: string, post: string) =>
    uris.has(src) ? `${pre}${uris.get(src)}${post}` : match
  )
}

export interface ZipImage {
  /** Path of the image inside the zip archive, e.g. `images/photo.jpg`. */
  zipName: string
  /** Raw file bytes, read through fileUtils. */
  data: Uint8Array
}

/**
 * Rewrite every local `<img src="file://…">` to a relative `images/<name>`
 * path and return the referenced files' bytes so the main process can pack
 * them next to the HTML into a zip archive. Identical sources share one
 * archive entry; basename collisions get a numeric suffix. Remote (http/https)
 * and `data:` sources are left untouched, images that cannot be read keep
 * their `file://` src.
 */
export const collectLocalImagesForZip = async(
  html: string
): Promise<{ html: string; images: ZipImage[] }> => {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const images: ZipImage[] = []
  const zipNames = new Map<string, string | null>()
  const usedNames = new Set<string>()

  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || ''
    if (!/^file:\/\//i.test(src)) continue
    if (!zipNames.has(src)) {
      try {
        const nativePath = fileUrlToNativePath(src)
        const bytes = await window.fileUtils.readFile(nativePath)
        if (!(bytes instanceof Uint8Array)) throw new Error('readFile returned no bytes')
        const basename = nativePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'image'
        const dot = basename.lastIndexOf('.')
        const stem = dot > 0 ? basename.slice(0, dot) : basename
        const ext = dot > 0 ? basename.slice(dot) : ''
        let zipName = basename
        let counter = 1
        while (usedNames.has(zipName.toLowerCase())) {
          zipName = `${stem}-${counter++}${ext}`
        }
        usedNames.add(zipName.toLowerCase())
        zipNames.set(src, zipName)
        images.push({ zipName, data: bytes })
      } catch {
        zipNames.set(src, null)
      }
    }
    const zipName = zipNames.get(src)
    if (zipName) img.setAttribute('src', `images/${zipName}`)
  }

  return {
    html: '<!DOCTYPE html>\n' + doc.documentElement.outerHTML,
    images
  }
}

/**
 * Build a styled, standalone HTML document equivalent to legacy muyajs
 * `exportStyledHTML`. Renders markdown through the new engine, injects the TOC
 * at the `[TOC]` marker, and — when a header/footer is supplied — wraps the
 * article in the page-container table for paged PDF / print export.
 */
export const exportStyledHTML = async(
  muya: Muya,
  markdown: string,
  options: ExportStyledHtmlOptions = {}
): Promise<string> => {
  const { title = '', toc = '', header, footer, headerFooterStyled, dir } = options
  let { extraCss = '' } = options

  // The header/footer page table needs its own stylesheet — fold it into
  // extraCss (which `generate` injects into <head>) up front so we only render
  // the document once.
  const appendHeaderFooter = !!header || !!footer
  if (appendHeaderFooter) {
    extraCss = extraCss ? HEADER_FOOTER_CSS + extraCss : HEADER_FOOTER_CSS
  }

  // Render the engine's full HTML document. We re-extract its <article> body so
  // we can inject the TOC / header-footer, then re-emit the document shell.
  const fullDoc = await new MarkdownToHtml(markdown, muya).generate({
    title,
    extraCSS: extraCss,
    dir
  })

  const articleMatch = /<article class="markdown-body">([\s\S]*)<\/article>/.exec(fullDoc)
  let article = articleMatch ? articleMatch[1] : fullDoc

  // Resolve relative image paths to absolute file:// URLs so the saved document
  // still shows its images when opened from a different folder (issue 230).
  article = rewriteImageSrcs(article)
  // Same for relative local links so they still resolve after the document is
  // moved out of the source folder (#1688).
  article = rewriteAnchorHrefs(article)

  // Inject the TOC at the `[TOC]` marker (legacy behaviour: only appears when
  // the document explicitly contains `[TOC]`). The marker is rendered as a
  // paragraph by marked, so replace the rendered `<p>[TOC]</p>` first, falling
  // back to a raw `[TOC]` if present.
  if (toc) {
    if (/<p>\s*\[TOC\]\s*<\/p>/i.test(article)) {
      article = article.replace(/<p>\s*\[TOC\]\s*<\/p>/i, toc)
    } else if (TOC_REG.test(article)) {
      article = article.replace(TOC_REG, toc)
    }
  }

  let bodyHtml: string
  if (!appendHeaderFooter) {
    bodyHtml = `<article class="markdown-body">${article}</article>`
  } else {
    let output = HF_TABLE_START
    if (header) output += createTableHeader(header, headerFooterStyled)
    if (footer) {
      output += HF_TABLE_FOOTER
      output = createRealFooter(footer, headerFooterStyled) + output
    }
    output += createTableBody(`<article class="markdown-body">${article}</article>`)
    output += HF_TABLE_END
    bodyHtml = output
  }

  // Re-emit the engine document shell with the (possibly augmented) body.
  return fullDoc.replace(/<body>[\s\S]*<\/body>/, () => `<body>\n  ${bodyHtml}\n</body>`)
}

// Image pre-optimisation for DOCX export. pandoc embeds SVGs verbatim (only
// recent Word builds render them) and carries phone-sized JPEGs through at
// full resolution, so every local rasterisable image is re-encoded through a
// canvas before conversion: SVG → PNG at 2× (matching how the reference DOCX
// export rasterises vector figures), oversized JPEG → downscaled re-encode.
// Images are fetched via fileUtils and loaded from `data:` URIs — a `file://`
// image drawn into a canvas would taint it and make toDataURL throw.
const SVG_RASTER_SCALE = 2
const JPEG_MAX_DIM = 1800
const JPEG_QUALITY = 0.82

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('image load failed'))
    image.src = src
  })

// `btoa` rejects the output of TextDecoder('latin1') (which is really
// windows-1252: bytes 0x80–0x9F decode beyond U+00FF), so binary payloads are
// base64-ed by the platform instead.
const bytesToDataUri = (bytes: Uint8Array, mime: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('readAsDataURL failed'))
    reader.readAsDataURL(new Blob([bytes as BlobPart], { type: mime }))
  })

const drawToCanvas = async(src: string, w: number, h: number): Promise<HTMLCanvasElement> => {
  const image = await loadImage(src)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(image, 0, 0, w, h)
  return canvas
}

// SVG files declare size via width/height attributes or, failing those, the
// viewBox aspect; Chromium reports 300×150 for a sizeless SVG, which would
// rasterise tiny.
const svgIntrinsicSize = (svgText: string): { width: number; height: number } => {
  const tag = (/<svg[^>]*>/i.exec(svgText) || [''])[0]
  const wAttr = /\swidth\s*=\s*"([\d.]+)/i.exec(tag)
  const hAttr = /\sheight\s*=\s*"([\d.]+)/i.exec(tag)
  let width = wAttr ? parseFloat(wAttr[1]) : 0
  let height = hAttr ? parseFloat(hAttr[1]) : 0
  if ((!width || !height) && /\sviewBox\s*=\s*"([^"]+)"/i.test(tag)) {
    const [, , vbW, vbH] = (/\sviewBox\s*=\s*"([^"]+)"/i.exec(tag) as RegExpExecArray)[1]
      .split(/[\s,]+/).map(Number)
    if (!width) width = vbW
    if (!height) height = vbH
  }
  return { width: width || 800, height: height || 600 }
}

const rasterizeLocalImages = async(doc: Document): Promise<void> => {
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || ''
    if (!/^file:\/\//i.test(src)) continue
    const ext = (/\.(svg|jpe?g|png|gif|webp)(?:$|\?)/i.exec(fileUrlToNativePath(src)) || [])[1]?.toLowerCase()
    if (!ext) continue
    try {
      const bytes = await window.fileUtils.readFile(fileUrlToNativePath(src))
      if (!(bytes instanceof Uint8Array)) continue
      if (ext === 'svg') {
        const svgText = new TextDecoder('utf-8').decode(bytes)
        const { width, height } = svgIntrinsicSize(svgText)
        const canvas = await drawToCanvas(
          'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText),
          Math.round(width * SVG_RASTER_SCALE),
          Math.round(height * SVG_RASTER_SCALE)
        )
        img.setAttribute('src', canvas.toDataURL('image/png'))
      } else if (ext === 'jpg' || ext === 'jpeg') {
        const uri = await bytesToDataUri(bytes, 'image/jpeg')
        const image = await loadImage(uri)
        const longest = Math.max(image.naturalWidth, image.naturalHeight)
        if (longest > JPEG_MAX_DIM) {
          const scale = JPEG_MAX_DIM / longest
          const canvas = await drawToCanvas(
            uri,
            Math.round(image.naturalWidth * scale),
            Math.round(image.naturalHeight * scale)
          )
          const out = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
          // Keep the original when the re-encode is not actually smaller.
          if (out.length * 0.75 < bytes.length) img.setAttribute('src', out)
        }
      }
    } catch {
      // Leave the original `file://` src; the converter fetches it as-is.
    }
  }
}

/**
 * Prepare exported HTML for pandoc DOCX conversion.
 *
 * KaTeX renders each formula into two parallel representations:
 *   <span class="katex">
 *     <span class="katex-mathml"><math>…</math></span>   ← semantic MathML
 *     <span class="katex-html" aria-hidden="true">…</span> ← visual spans
 *   </span>
 *
 * Pandoc's HTML reader can turn <math> into native math (→ OMML in DOCX),
 * but it also reads the .katex-html visual spans as regular text, producing
 * garbled duplicate output. This function strips the visual layer and leaves
 * clean <math> elements so pandoc produces proper Word equations.
 *
 * Block math (`$$…$$`) is wrapped by KaTeX in `.katex-display`; we replace
 * that wrapper with a <div> so the result stays block-level.
 */
export const prepareHtmlForDocx = async(html: string): Promise<string> => {
  const doc = new DOMParser().parseFromString(html, 'text/html')

  // Re-encode local images (SVG → PNG, oversized JPEG → downscaled JPEG) so
  // the converter receives portable, Word-friendly data URIs.
  await rasterizeLocalImages(doc)

  // pandoc reads a bare filesystem path verbatim but percent-encodes the
  // non-ASCII parts of a `file:` URI and never decodes them back, so a document
  // living under a CJK folder loses every image. Undo the URL form for the
  // converter (the saved HTML / PDF keeps the proper `file://` URLs). Images
  // that were rasterised above are `data:` URIs now and are not touched here.
  for (const img of doc.querySelectorAll('img[src^="file://"]')) {
    img.setAttribute('src', fileUrlToNativePath(img.getAttribute('src') || ''))
  }

  // Muya leaves zero-width spaces behind as placeholder text nodes; pandoc
  // would carry them into word runs, and their presence would also hide the
  // fact that a paragraph contains nothing but one formula below.
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue && node.nodeValue.includes('\u200b')) {
      node.nodeValue = node.nodeValue.replace(/\u200b/g, '')
    }
  }

  // A paragraph / table cell whose only content is a single inline formula is
  // a display equation in disguise — promote it so the converter centres it
  // (the reference output wraps these in oMathPara).
  for (const katex of Array.from(doc.querySelectorAll('.katex'))) {
    if (katex.closest('.katex-display')) continue
    const parent = katex.parentElement
    if (!parent || !/^(?:P|TD|TH)$/.test(parent.tagName)) continue
    const alone = Array.from(parent.childNodes).every((n) =>
      n === katex || (n.nodeType === Node.TEXT_NODE && !(n.nodeValue || '').trim())
    )
    if (!alone) continue
    const display = doc.createElement('div')
    display.className = 'katex-display'
    if (parent.tagName === 'P') {
      parent.replaceWith(display)
    } else {
      parent.replaceChildren(display)
    }
    display.appendChild(katex)
  }

  // Block math: replace .katex-display (which wraps .katex) with a <div>
  // containing just the cleaned <math> element.
  for (const wrapper of doc.querySelectorAll('.katex-display')) {
    const math = wrapper.querySelector('.katex-mathml > math')
    if (!math) continue
    cleanKaTeXMathML(math)
    math.setAttribute('display', 'block')
    const div = doc.createElement('div')
    div.appendChild(math)
    wrapper.replaceWith(div)
  }

  // Inline math: replace .katex with just the cleaned <math> element.
  for (const katex of doc.querySelectorAll('.katex')) {
    const math = katex.querySelector('.katex-mathml > math')
    if (!math) continue
    cleanKaTeXMathML(math)
    katex.replaceWith(math)
  }

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML
}

export interface MathBlock {
  index: number
  mathml: string    // <math>…</math> outerHTML, fed to mathml2omml in the main process
  display: boolean   // true = block ($$…$$), false = inline ($…$)
}

/**
 * Prepare exported HTML for the pure-JS DOCX engine (@turbodocx/html-to-docx).
 *
 * The JS engine walks the HTML DOM and emits docx XmlComponents for each
 * element — it does NOT understand <math> MathML the way pandoc does, so
 * formulas would otherwise render as garbled MathML text + duplicate visual
 * spans. Instead of discarding the MathML, we extract it into `mathBlocks`
 * and replace each `.katex` with a unique placeholder span. After the JS
 * engine produces the DOCX buffer, the main process converts each MathML to
 * OMML (via mathml2omml) and injects it where the placeholder text landed.
 *
 * Returns the cleaned HTML plus the extracted math blocks so the caller can
 * forward them through IPC for post-processing.
 */
export const prepareHtmlForJsDocx = (html: string): {
  html: string
  mathBlocks: MathBlock[]
} => {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const mathBlocks: MathBlock[] = []
  let index = 0

  // Walk every KaTeX render root. Extract the cleaned MathML semantic layer
  // for post-processing, then replace the whole .katex with a placeholder span
  // whose text content is a unique sentinel the JS engine renders as a
  // plain text run — the post-processor finds and swaps it for OMML.
  for (const katex of doc.querySelectorAll('.katex')) {
    const math = katex.querySelector('.katex-mathml > math')
    if (!math) continue
    cleanKaTeXMathML(math)
    const display = !!katex.closest('.katex-display')
    mathBlocks.push({ index, mathml: math.outerHTML, display })
    const placeholder = doc.createElement('span')
    placeholder.textContent = `MTMATHOMML${String(index).padStart(4, '0')}`
    katex.replaceWith(placeholder)
    index++
  }

  // Block math: .katex-display now only wraps the placeholder span. Replace it
  // with a plain <div> so the placeholder stays block-level (and thus in its
  // own paragraph in the generated DOCX).
  for (const wrapper of doc.querySelectorAll('.katex-display')) {
    const div = doc.createElement('div')
    while (wrapper.firstChild) div.appendChild(wrapper.firstChild)
    wrapper.replaceWith(div)
  }

  return {
    html: '<!DOCTYPE html>\n' + doc.documentElement.outerHTML,
    mathBlocks
  }
}
