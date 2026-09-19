import { beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { mkdtemp, writeFile as fsWriteFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

// The DOCX font-settings patcher (src/main/utils/docxReference.ts) touches the
// filesystem and electron paths:
//   1. electron-log — logging only
//   2. electron (via main_renderer/utils getPath) — temp directory
//   3. main_renderer/filesystem — writeFile (disk I/O)
// The reference.docx itself is a real fixture written to the OS temp dir, so
// the actual JSZip patch pipeline is exercised end-to-end.

const mockLogWarn = vi.hoisted(() => vi.fn())
const mockGetPath = vi.hoisted(() => vi.fn(() => '/tmp/mock-temp'))
const mockWriteFile = vi.hoisted(() => vi.fn())

vi.mock('electron-log', () => ({ default: { warn: mockLogWarn } }))
vi.mock('electron', () => ({ app: { getPath: mockGetPath } }))
vi.mock('main_renderer/filesystem', () => ({ writeFile: mockWriteFile }))

const { prepareReferenceDoc, applyDocxFontToBuffer } = await import('main_renderer/utils/docxReference')

// Multi-line on purpose: the real theme XML is pretty-printed, and the patch
// regexes must match across newlines.
const THEME_XML = `<?xml version="1.0" encoding="UTF-8"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">
  <a:themeElements>
    <a:fontScheme name="Office">
      <a:majorFont>
        <a:latin typeface="Times New Roman"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
        <a:font script="Jpan" typeface="游ゴシック Light"/>
        <a:font script="Hans" typeface="等线 Light"/>
        <a:font script="Hant" typeface="新細明體"/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="Times New Roman"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
        <a:font script="Hans" typeface="等线"/>
      </a:minorFont>
    </a:fontScheme>
  </a:themeElements>
</a:theme>`

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/>
        <w:sz w:val="24"/><w:szCs w:val="24"/>
        <w:lang w:val="en-US" w:eastAsia="zh-CN"/>
      </w:rPr>
    </w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
</w:styles>`

const buildReferenceDocx = async(): Promise<Buffer> => {
  const zip = new JSZip()
  zip.file('word/theme/theme1.xml', THEME_XML)
  zip.file('word/styles.xml', STYLES_XML)
  return zip.generateAsync({ type: 'nodebuffer' })
}

let staticDir: string

beforeEach(async() => {
  mockWriteFile.mockReset()
  mockWriteFile.mockResolvedValue(undefined)
  mockLogWarn.mockReset()
  staticDir = await mkdtemp(path.join(tmpdir(), 'marktext-ref-test-'))
  ;(globalThis as Record<string, unknown>).__static = staticDir
  return async() => {
    await rm(staticDir, { recursive: true, force: true })
  }
})

const readZipText = async(buffer: Buffer, entry: string): Promise<string> => {
  const zip = await JSZip.loadAsync(buffer)
  const file = zip.file(entry)
  if (!file) throw new Error(`${entry} not found`)
  return file.async('string')
}

describe('prepareReferenceDoc', () => {
  it('returns the packaged reference.docx untouched when no settings are given', async() => {
    const result = await prepareReferenceDoc()
    expect(result).toBe(path.join(staticDir, 'reference.docx'))
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('returns the packaged reference.docx when settings are all empty', async() => {
    const result = await prepareReferenceDoc({})
    expect(result).toBe(path.join(staticDir, 'reference.docx'))
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('writes a patched copy to temp with fonts and scaled sizes applied', async() => {
    await fsWriteFile(path.join(staticDir, 'reference.docx'), await buildReferenceDocx())

    const result = await prepareReferenceDoc({ latin: 'Arial', eastAsia: '宋体', sizePt: 10.5 })

    expect(result.startsWith(path.join('/tmp/mock-temp', 'marktext-reference-'))).toBe(true)
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    const [target, data] = mockWriteFile.mock.calls[0] as [string, Buffer]
    expect(target).toBe(result)

    const theme = await readZipText(data, 'word/theme/theme1.xml')
    expect(theme).toContain('<a:latin typeface="Arial"/>')
    expect(theme).toContain('<a:ea typeface="宋体"/>')
    // per-script CJK entries win over <a:ea> in Word's resolution
    expect(theme).toContain('<a:font script="Hans" typeface="宋体"/>')
    expect(theme).toContain('<a:font script="Hant" typeface="宋体"/>')

    const styles = await readZipText(data, 'word/styles.xml')
    // body size 10.5pt → 21 half-points in docDefaults, plus the east-asian
    // font replacing the theme reference (a literal loses to eastAsiaTheme)
    expect(styles).toContain('<w:sz w:val="21"/>')
    expect(styles).toContain('w:eastAsia="宋体"')
    expect(styles).not.toContain('w:eastAsiaTheme=')
    // headings scale relative to the body: +8/+4/+2 half-points
    expect(styles).toContain('<w:sz w:val="29"/>')
    expect(styles).toContain('<w:sz w:val="25"/>')
    expect(styles).toContain('<w:sz w:val="23"/>')
  })

  it('falls back to the packaged document when the reference file is corrupt', async() => {
    await fsWriteFile(path.join(staticDir, 'reference.docx'), Buffer.from('not a zip'))

    const result = await prepareReferenceDoc({ sizePt: 12 })

    expect(result).toBe(path.join(staticDir, 'reference.docx'))
    expect(mockLogWarn).toHaveBeenCalledTimes(1)
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('falls back to the packaged document when the reference file is missing', async() => {
    const result = await prepareReferenceDoc({ sizePt: 12 })

    expect(result).toBe(path.join(staticDir, 'reference.docx'))
    expect(mockLogWarn).toHaveBeenCalledTimes(1)
  })
})

describe('applyDocxFontToBuffer', () => {
  it('returns the same buffer when no settings are given', async() => {
    const buffer = await buildReferenceDocx()
    const result = await applyDocxFontToBuffer(buffer)
    expect(result).toBe(buffer)
  })

  it('patches theme fonts and style sizes in the buffer', async() => {
    const buffer = await buildReferenceDocx()

    const result = await applyDocxFontToBuffer(buffer, { eastAsia: '微软雅黑', sizePt: 12 })

    expect(result).not.toBe(buffer)
    const theme = await readZipText(result, 'word/theme/theme1.xml')
    expect(theme).toContain('<a:ea typeface="微软雅黑"/>')
    expect(theme).toContain('<a:font script="Hans" typeface="微软雅黑"/>')
    const styles = await readZipText(result, 'word/styles.xml')
    // body stays 12pt (24 half-points) but gains the east-asian font
    expect(styles).toContain('<w:sz w:val="24"/>')
    expect(styles).toContain('w:eastAsia="微软雅黑"')
    // 12pt body → headings 32/28/26 unchanged (relative offsets)
    expect(styles).toContain('<w:sz w:val="32"/>')
  })

  it('returns the original buffer unchanged when the buffer is not a zip', async() => {
    const buffer = Buffer.from('garbage')
    const result = await applyDocxFontToBuffer(buffer, { latin: 'Arial' })
    expect(result).toBe(buffer)
    expect(mockLogWarn).toHaveBeenCalledTimes(1)
  })

  it('escapes XML-special characters in font names', async() => {
    const buffer = await buildReferenceDocx()

    const result = await applyDocxFontToBuffer(buffer, { eastAsia: 'a<b>&"c' })

    const theme = await readZipText(result, 'word/theme/theme1.xml')
    expect(theme).toContain('typeface="a&lt;b&gt;&amp;&quot;c"')
  })
})
