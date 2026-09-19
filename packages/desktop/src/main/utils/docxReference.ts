// DOCX font settings ("default theme") applied to the export pipeline.
//
// pandoc derives every font and size from its --reference-doc, so the user's
// DOCX font settings (latin font / east-asian font / body size) are honoured
// by patching a copy of the packaged reference.docx with JSZip per export —
// no reference document per combination is shipped. The JS engine
// (@turbodocx) receives latin font + body size through its own `font` /
// `fontSize` options and gets the east-asian font through the same XML patch
// applied to its output buffer, which those options cannot express.
//
// All patching is best-effort: any failure logs a warning and falls back to
// the unpatched document, so an export is never blocked by it.

import JSZip from 'jszip'
import path from 'path'
import { readFile } from 'fs/promises'
import log from 'electron-log'
import { getPath } from '.'
import { writeFile } from '../filesystem'

export interface DocxFontSettings {
  /** Western font for Latin text, e.g. "Times New Roman". */
  latin?: string
  /** East-asian font for CJK text, e.g. "宋体". Empty keeps the Word default. */
  eastAsia?: string
  /** Body text size in points; headings scale relative to it. */
  sizePt?: number
}

// Half-point heading offsets above the body size. At the 12pt default this
// yields H1=16pt / H2=14pt / H3=13pt, matching the web-exported document.
const HEADING_OFFSETS_HP: Array<[string, number]> = [
  ['Heading1', 8],
  ['Heading2', 4],
  ['Heading3', 2]
]

const escapeXmlAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const hasSettings = (settings?: DocxFontSettings): settings is DocxFontSettings =>
  !!settings && !!(settings.latin || settings.eastAsia || settings.sizePt)

// Tempered scan up to the end of a font scheme. Uses [\s\S] because the real
// theme XML is pretty-printed across lines (dot does not match newlines).
const SCHEME_BODY = '(?:(?!</a:(?:major|minor)Font>)[\\s\\S])*?'

// theme1.xml: set the latin / east-asian typefaces of both font schemes.
// Word resolves East Asian fonts through the per-script entries first
// (<a:font script="Hans" …>), falling back to <a:ea> — both must be patched.
const patchThemeXml = (xml: string, settings: DocxFontSettings): string => {
  let next = xml
  if (settings.latin) {
    next = next.replace(
      new RegExp(`(<a:(?:major|minor)Font>${SCHEME_BODY}<a:latin typeface=")[^"]*(")`, 'g'),
      (_match, pre: string, post: string) => pre + escapeXmlAttribute(settings.latin!) + post
    )
  }
  if (settings.eastAsia) {
    next = next.replace(
      new RegExp(`(<a:(?:major|minor)Font>${SCHEME_BODY}<a:ea typeface=")[^"]*(")`, 'g'),
      (_match, pre: string, post: string) => pre + escapeXmlAttribute(settings.eastAsia!) + post
    )
    next = next.replace(
      /(<a:font script="Han[st]" typeface=")[^"]*(")/g,
      (_match, pre: string, post: string) => pre + escapeXmlAttribute(settings.eastAsia!) + post
    )
  }
  return next
}

// styles.xml: docDefaults body size (+ east-asian font) and heading sizes
// relative to it.
const patchStylesXml = (xml: string, settings: DocxFontSettings): string => {
  const baseHp = settings.sizePt ? Math.round(settings.sizePt * 2) : null
  let next = xml

  const docDefaults = /<w:docDefaults>[\s\S]*?<\/w:docDefaults>/.exec(next)
  if (docDefaults) {
    let block = docDefaults[0]
    if (settings.eastAsia) {
      const encoded = escapeXmlAttribute(settings.eastAsia)
      // A theme reference (eastAsiaTheme) takes precedence over a literal
      // eastAsia, so it must be replaced rather than joined.
      if (/w:eastAsiaTheme="[^"]*"/.test(block)) {
        block = block.replace(/w:eastAsiaTheme="[^"]*"/, `w:eastAsia="${encoded}"`)
      } else if (/w:eastAsia="[^"]*"/.test(block)) {
        block = block.replace(/w:eastAsia="[^"]*"/, `w:eastAsia="${encoded}"`)
      } else if (/<w:rFonts\b[^>]*\/>/.test(block)) {
        block = block.replace(/(<w:rFonts\b[^>]*?)\s*\/>/, `$1 w:eastAsia="${encoded}"/>`)
      } else if (/<w:rPr>/.test(block)) {
        block = block.replace('<w:rPr>', `<w:rPr><w:rFonts w:eastAsia="${encoded}"/>`)
      }
    }
    if (baseHp !== null) {
      block = block
        .replace(/<w:sz w:val="\d+"/g, `<w:sz w:val="${baseHp}"`)
        .replace(/<w:szCs w:val="\d+"/g, `<w:szCs w:val="${baseHp}"`)
    }
    next = next.replace(docDefaults[0], block)
  }

  if (baseHp !== null) {
    next = next.replace(
      /<w:style [^>]*w:styleId="(Heading\d)"[^>]*>([\s\S]*?)<\/w:style>/g,
      (match, styleId: string, body: string) => {
        const offset = HEADING_OFFSETS_HP.find(([id]) => id === styleId)
        if (!offset) return match
        const size = baseHp + offset[1]
        const patched = body
          .replace(/<w:sz w:val="\d+"/g, `<w:sz w:val="${size}"`)
          .replace(/<w:szCs w:val="\d+"/g, `<w:szCs w:val="${size}"`)
        return match.replace(body, patched)
      }
    )
  }

  return next
}

const patchDocxZip = async (zip: JSZip, settings: DocxFontSettings): Promise<void> => {
  const theme = zip.file('word/theme/theme1.xml')
  if (theme) {
    zip.file('word/theme/theme1.xml', patchThemeXml(await theme.async('string'), settings))
  }
  const styles = zip.file('word/styles.xml')
  if (styles) {
    zip.file('word/styles.xml', patchStylesXml(await styles.async('string'), settings))
  }
}

const settingsHash = (settings: DocxFontSettings): string => {
  const text = JSON.stringify(settings)
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

/**
 * Patch the JS engine's DOCX buffer with the font settings. The latin font
 * and body size are passed to @turbodocx natively; this covers the
 * east-asian font and keeps heading sizes consistent. Returns the original
 * buffer on any failure.
 */
export const applyDocxFontToBuffer = async(
  buffer: Buffer,
  settings?: DocxFontSettings
): Promise<Buffer> => {
  if (!hasSettings(settings)) return buffer
  try {
    const zip = await JSZip.loadAsync(buffer)
    await patchDocxZip(zip, settings)
    return zip.generateAsync({ type: 'nodebuffer' })
  } catch (err) {
    log.warn('Failed to apply DOCX font settings to export buffer:', (err as Error)?.message ?? err)
    return buffer
  }
}

/**
 * Resolve the pandoc --reference-doc for the given font settings: the
 * packaged reference.docx when no settings are active, otherwise a patched
 * copy in the temp directory. Never throws — falls back to the packaged
 * document when patching fails.
 */
export const prepareReferenceDoc = async(
  settings?: DocxFontSettings
): Promise<string> => {
  const packagedDoc = path.join(global.__static, 'reference.docx')
  if (!hasSettings(settings)) return packagedDoc

  try {
    const data = await readFile(packagedDoc)
    const zip = await JSZip.loadAsync(data)
    await patchDocxZip(zip, settings)
    const patched = await zip.generateAsync({ type: 'nodebuffer' })
    const target = path.join(getPath('temp'), `marktext-reference-${settingsHash(settings)}.docx`)
    await writeFile(target, patched, 'docx', 'binary')
    return target
  } catch (err) {
    log.warn('Failed to patch DOCX reference document:', (err as Error)?.message ?? err)
    return packagedDoc
  }
}
