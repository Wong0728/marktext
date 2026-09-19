// Pure-JS DOCX engine wrapper around @turbodocx/html-to-docx.
//
// Coexists with the pandoc-based path (../menu/actions/file.ts). The main
// process dispatches to either this module or pandoc based on the user's
// `docxEngine` choice ('auto' | 'pandoc' | 'js'). Unlike pandoc, this engine
// requires no external binary and renders HTML tables / task lists / nested
// lists with higher fidelity.
//
// LaTeX math is handled via post-processing: the renderer extracts KaTeX's
// MathML into `mathBlocks` (see prepareHtmlForJsDocx in exportHtml.ts) and
// leaves a unique placeholder where each formula was. After @turbodocx
// generates the DOCX buffer, injectOmmlMath unzips it, converts each MathML
// to OMML via mathml2omml, and swaps the placeholder runs for native Word
// equations — so the JS engine now produces real <m:oMath> formulas.

import HtmlToDocx from '@turbodocx/html-to-docx'
import JSZip from 'jszip'
import { readFile as fsReadFile } from 'fs/promises'
import { writeFile } from '../filesystem'
import { applyDocxFontToBuffer } from './docxReference'
import type { DocxFontSettings } from './docxReference'

export interface MathBlock {
  index: number
  mathml: string
  display: boolean
}

export interface JsDocxOptions {
  /** Document directory, used to resolve local image relative paths. */
  resourcePath?: string
  orientation?: 'portrait' | 'landscape'
  title?: string
  creator?: string
  /** Math blocks extracted by prepareHtmlForJsDocx, for OMML post-injection. */
  mathBlocks?: MathBlock[]
  /** User's DOCX font settings (latin / east-asian font, body size). */
  docxFont?: DocxFontSettings
}

/**
 * Convert HTML to DOCX using the pure-JS engine and write the result to
 * `outputPath`. Mirrors the pandoc `converter.toFile(content, filePath)`
 * contract so the main process can treat both engines uniformly.
 */
export const convertHtmlToDocxFile = async(
  html: string,
  outputPath: string,
  options: JsDocxOptions = {}
): Promise<void> => {
  const buffer = await HtmlToDocx(
    html,
    null,
    {
      orientation: options.orientation === 'landscape' ? 'landscape' : 'portrait',
      title: options.title || '',
      creator: options.creator || 'MarkText',
      // Give tables visible borders — pandoc gets this from static/reference.docx;
      // the JS engine has no reference-doc concept, so configure it here.
      table: {
        row: { cantSplit: true },
        borderOptions: { size: 1, color: '000000' }
      },
      pageNumber: true,
      // Latin font and body size (half-points) are native engine options.
      ...(options.docxFont?.latin ? { font: options.docxFont.latin } : {}),
      ...(options.docxFont?.sizePt ? { fontSize: options.docxFont.sizePt * 2 } : {})
    },
    null
  )

  // In Node.js the engine returns an ArrayBuffer (or Buffer). writeFile
  // accepts string | Buffer, so coerce ArrayBuffer → Buffer for durability.
  const nodeBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer)

  // Post-process: inject native OMML equations where placeholders landed,
  // then center image-only paragraphs, then apply the user's font settings
  // (east-asian font + heading sizes, which the engine options cannot express).
  const mathBlocks = options.mathBlocks
  const mathBuffer = mathBlocks && mathBlocks.length > 0
    ? await injectOmmlMath(nodeBuffer, mathBlocks)
    : nodeBuffer
  const centeredBuffer = await centerImageParagraphs(mathBuffer)
  const finalBuffer = await applyDocxFontToBuffer(centeredBuffer, options.docxFont)

  await writeFile(outputPath, finalBuffer, 'docx', 'binary')
}

/**
 * Unzip the generated DOCX, replace each placeholder text run with native
 * OMML math (converted from KaTeX's MathML via mathml2omml), and re-zip.
 *
 * Conversion failures degrade gracefully — the placeholder stays as plain
 * text so the document is still valid; the formula just won't be a native
 * equation.
 */
const injectOmmlMath = async(
  docxBuffer: Buffer,
  mathBlocks: MathBlock[]
): Promise<Buffer> => {
  // mathml2omml is ESM-only; lazy-load so the module parses even if the
  // dependency is missing at import time, and only when math is present.
  const { mml2omml } = await import('mathml2omml')

  const zip = await JSZip.loadAsync(docxBuffer)
  const documentFile = zip.file('word/document.xml')
  if (!documentFile) return docxBuffer

  let xml = await documentFile.async('string')

  for (const block of mathBlocks) {
    const placeholder = `MTMATHOMML${String(block.index).padStart(4, '0')}`
    // Match the <w:r> run containing the placeholder text. turbodocx renders
    // the placeholder span as a single <w:r><w:t>…</w:t></w:r>; the
    // non-greedy `(?!<\/w:r>)` guards also cover leading <w:rPr> properties.
    const runRegex = new RegExp(
      `<w:r\\b[^>]*>(?:(?!<\\/w:r>).)*?<w:t[^>]*>[^<]*${placeholder}[^<]*<\\/w:t>(?:(?!<\\/w:r>).)*?<\\/w:r>`,
      'g'
    )
    xml = xml.replace(runRegex, (match) => {
      try {
        const omml = mml2omml(block.mathml)
        return block.display
          ? `<m:oMathPara>${omml}</m:oMathPara>`
          : omml
      } catch {
        // Conversion failed — leave the placeholder as styled text.
        return match
      }
    })
  }

  zip.file('word/document.xml', xml)
  return zip.generateAsync({ type: 'nodebuffer' })
}

export const jsDocxEngine = {
  convert: convertHtmlToDocxFile,
  // The JS engine is bundled with MarkText, so it is always available —
  // no install-time detection needed (unlike pandoc).
  exists: (): boolean => true
}

/**
 * Center every image-only paragraph of a DOCX.
 *
 * Neither engine emits paragraph alignment by itself (pandoc ignores a
 * `text-align: center` from the HTML side), so images land left-aligned. The
 * reference DOCX export centers image paragraphs; rewrite `word/document.xml`
 * accordingly: a paragraph that contains a drawing and no visible text gets
 * `<w:jc w:val="center"/>` in its `<w:pPr>`.
 */
export const centerImageParagraphs = async(docxBuffer: Buffer): Promise<Buffer> => {
  // A DOCX is a zip, but be forgiving about malformed converter output —
  // centre-less alignment is better than failing the whole export.
  let zip
  try {
    zip = await JSZip.loadAsync(docxBuffer)
  } catch {
    return docxBuffer
  }
  const documentFile = zip.file('word/document.xml')
  if (!documentFile) return docxBuffer

  const xml = await documentFile.async('string')
  const next = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (para) => {
    if (!para.includes('<w:drawing')) return para
    const text = Array.from(para.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g), m => m[1]).join('')
    if (text.trim()) return para
    if (/<w:jc\s+w:val="center"/.test(para)) return para
    // jc belongs at the end of pPr (before any rPr / after spacing).
    if (para.includes('</w:pPr>')) {
      return para.replace('</w:pPr>', '<w:jc w:val="center"/></w:pPr>')
    }
    // Paragraph without pPr — insert one right after the opening tag.
    return para.replace(/^(<w:p(?:\s[^>]*)?>)/, '$1<w:pPr><w:jc w:val="center"/></w:pPr>')
  })
  if (next === xml) return docxBuffer

  zip.file('word/document.xml', next)
  return zip.generateAsync({ type: 'nodebuffer' })
}

/**
 * Center the image-only paragraphs of a DOCX already written to disk.
 * Used by the pandoc path, whose converter writes the file itself.
 */
export const centerImageParagraphsFile = async(docxPath: string): Promise<void> => {
  const data = await fsReadFile(docxPath)
  const centered = await centerImageParagraphs(Buffer.isBuffer(data) ? data : Buffer.from(data))
  if (centered !== data) {
    await writeFile(docxPath, centered, 'docx', 'binary')
  }
}

export default jsDocxEngine
