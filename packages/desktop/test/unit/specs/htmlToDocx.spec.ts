import { beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'

// The JS DOCX engine wrapper (src/main/utils/htmlToDocx.ts) has two external
// dependencies we must isolate:
//   1. @turbodocx/html-to-docx — the conversion library (default export fn)
//   2. main_renderer/filesystem — writeFile (disk I/O)
//   3. mathml2omml — MathML→OMML converter (used only when mathBlocks present)
// Mocking all three lets us assert call args without touching disk or running
// the real ~heavy DOCX serializer.

const mockHtmlToDocx = vi.hoisted(() => vi.fn())
const mockWriteFile = vi.hoisted(() => vi.fn())
const mockMml2omml = vi.hoisted(() => vi.fn())
const mockApplyDocxFont = vi.hoisted(() => vi.fn(async(buffer: Buffer) => buffer))

vi.mock('@turbodocx/html-to-docx', () => ({
  default: mockHtmlToDocx
}))

vi.mock('main_renderer/filesystem', () => ({
  writeFile: mockWriteFile
}))

vi.mock('mathml2omml', () => ({
  mml2omml: mockMml2omml
}))

vi.mock('main_renderer/utils/docxReference', () => ({
  applyDocxFontToBuffer: mockApplyDocxFont
}))

const { convertHtmlToDocxFile, jsDocxEngine } = await import('main_renderer/utils/htmlToDocx')

// Build a minimal valid DOCX (ZIP) with the given word/document.xml content,
// so tests can feed a realistic buffer to the mocked HtmlToDocx.
const buildMinimalDocx = async(documentXml: string): Promise<Buffer> => {
  const zip = new JSZip()
  zip.file('word/document.xml', documentXml)
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

const readDocxDocumentXml = async(buffer: Buffer): Promise<string> => {
  const zip = await JSZip.loadAsync(buffer)
  const file = zip.file('word/document.xml')
  if (!file) throw new Error('word/document.xml not found in DOCX')
  return file.async('string')
}

describe('jsDocxEngine', () => {
  beforeEach(() => {
    mockHtmlToDocx.mockReset()
    mockWriteFile.mockReset()
    mockWriteFile.mockResolvedValue(undefined)
    mockMml2omml.mockReset()
    mockApplyDocxFont.mockClear()
  })

  it('exists() always returns true (bundled, no install detection needed)', () => {
    expect(jsDocxEngine.exists()).toBe(true)
  })

  it('convert calls HtmlToDocx with correct options and writes result to disk', async() => {
    const buffer = Buffer.from('fake-docx-content')
    mockHtmlToDocx.mockResolvedValue(buffer)

    await convertHtmlToDocxFile('<p>hello</p>', '/out/export.docx', {
      title: 'My Doc',
      orientation: 'landscape'
    })

    expect(mockHtmlToDocx).toHaveBeenCalledTimes(1)
    const [html, header, options, footer] = mockHtmlToDocx.mock.calls[0] as [
      string, unknown, Record<string, unknown>, unknown
    ]
    expect(html).toBe('<p>hello</p>')
    expect(header).toBeNull()
    expect(options.orientation).toBe('landscape')
    expect(options.title).toBe('My Doc')
    expect(options.creator).toBe('MarkText')
    expect(options.table).toEqual({
      row: { cantSplit: true },
      borderOptions: { size: 1, color: '000000' }
    })
    expect(options.pageNumber).toBe(true)
    expect(footer).toBeNull()

    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    const [path, content, ext, encoding] = mockWriteFile.mock.calls[0] as [
      string, Buffer, string, string
    ]
    expect(path).toBe('/out/export.docx')
    expect(content).toBe(buffer)
    expect(ext).toBe('docx')
    expect(encoding).toBe('binary')
  })

  it('coerces ArrayBuffer return value to Node Buffer before writing', async() => {
    // @turbodocx/html-to-docx may return an ArrayBuffer in Node contexts.
    // The wrapper must convert it to Buffer for writeFile compatibility.
    const arrayBuffer = new ArrayBuffer(8)
    const view = new Uint8Array(arrayBuffer)
    view.set([1, 2, 3, 4, 5, 6, 7, 8])
    mockHtmlToDocx.mockResolvedValue(arrayBuffer)

    await convertHtmlToDocxFile('<p>test</p>', '/out/export.docx')

    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    const content = mockWriteFile.mock.calls[0]![1] as Buffer
    expect(Buffer.isBuffer(content)).toBe(true)
    expect(content.length).toBe(8)
  })

  it('passes through Buffer return value without conversion', async() => {
    const buffer = Buffer.from('already-a-buffer')
    mockHtmlToDocx.mockResolvedValue(buffer)

    await convertHtmlToDocxFile('<p>test</p>', '/out/export.docx')

    const content = mockWriteFile.mock.calls[0]![1] as Buffer
    expect(content).toBe(buffer)
  })

  it('uses default values when options are omitted', async() => {
    mockHtmlToDocx.mockResolvedValue(Buffer.from('x'))

    await convertHtmlToDocxFile('<p>test</p>', '/out/export.docx')

    const options = mockHtmlToDocx.mock.calls[0]![2] as Record<string, unknown>
    expect(options.orientation).toBe('portrait')
    expect(options.title).toBe('')
    expect(options.creator).toBe('MarkText')
  })

  it('exposes convert as jsDocxEngine.convert', async() => {
    mockHtmlToDocx.mockResolvedValue(Buffer.from('x'))

    await jsDocxEngine.convert('<p>via-engine</p>', '/out/via-engine.docx')

    expect(mockHtmlToDocx).toHaveBeenCalledTimes(1)
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    expect(mockWriteFile.mock.calls[0]![0]).toBe('/out/via-engine.docx')
  })

  it('maps docxFont settings to native engine options (font / half-point size)', async() => {
    mockHtmlToDocx.mockResolvedValue(Buffer.from('x'))

    await convertHtmlToDocxFile('<p>test</p>', '/out/export.docx', {
      docxFont: { latin: 'Arial', sizePt: 10.5 }
    })

    const options = mockHtmlToDocx.mock.calls[0]![2] as Record<string, unknown>
    expect(options.font).toBe('Arial')
    expect(options.fontSize).toBe(21)
    expect(mockApplyDocxFont).toHaveBeenCalledWith(expect.anything(), { latin: 'Arial', sizePt: 10.5 })
  })

  it('emits no native font options when docxFont is absent', async() => {
    mockHtmlToDocx.mockResolvedValue(Buffer.from('x'))

    await convertHtmlToDocxFile('<p>test</p>', '/out/export.docx')

    const options = mockHtmlToDocx.mock.calls[0]![2] as Record<string, unknown>
    expect('font' in options).toBe(false)
    expect('fontSize' in options).toBe(false)
  })
})

describe('convertHtmlToDocxFile — OMML math injection', () => {
  beforeEach(() => {
    mockHtmlToDocx.mockReset()
    mockWriteFile.mockReset()
    mockWriteFile.mockResolvedValue(undefined)
    mockMml2omml.mockReset()
  })

  it('injects <m:oMath> where the placeholder run was', async() => {
    const docXml =
      '<w:document><w:body>' +
        '<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r>' +
        '<w:r><w:t xml:space="preserve">MTMATHOMML0000</w:t></w:r>' +
        '<w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p>' +
      '</w:body></w:document>'
    mockHtmlToDocx.mockResolvedValue(await buildMinimalDocx(docXml))
    mockMml2omml.mockReturnValue(
      '<m:oMath xmlns:m="urn:test"><m:r><m:t>2+2=4</m:t></m:r></m:oMath>'
    )

    await convertHtmlToDocxFile('<p>test</p>', '/out/export.docx', {
      mathBlocks: [{ index: 0, mathml: '<math><mn>2</mn></math>', display: false }]
    })

    const writtenBuffer = mockWriteFile.mock.calls[0]![1] as Buffer
    const resultXml = await readDocxDocumentXml(writtenBuffer)
    expect(resultXml).toContain('<m:oMath')
    expect(resultXml).not.toContain('MTMATHOMML0000')
    // Surrounding text survives the run replacement.
    expect(resultXml).toContain('Hello')
    expect(resultXml).toContain('world')
  })

  it('wraps display math in <m:oMathPara>', async() => {
    const docXml =
      '<w:document><w:body>' +
        '<w:p><w:r><w:t xml:space="preserve">MTMATHOMML0000</w:t></w:r></w:p>' +
      '</w:body></w:document>'
    mockHtmlToDocx.mockResolvedValue(await buildMinimalDocx(docXml))
    mockMml2omml.mockReturnValue('<m:oMath xmlns:m="urn:test">inline</m:oMath>')

    await convertHtmlToDocxFile('<p>test</p>', '/out/export.docx', {
      mathBlocks: [{ index: 0, mathml: '<math></math>', display: true }]
    })

    const writtenBuffer = mockWriteFile.mock.calls[0]![1] as Buffer
    const resultXml = await readDocxDocumentXml(writtenBuffer)
    expect(resultXml).toContain('<m:oMathPara>')
    expect(resultXml).toContain('<m:oMath')
  })

  it('degrades gracefully when mml2omml throws (keeps placeholder text)', async() => {
    const docXml =
      '<w:document><w:body>' +
        '<w:p><w:r><w:t xml:space="preserve">MTMATHOMML0000</w:t></w:r></w:p>' +
      '</w:body></w:document>'
    mockHtmlToDocx.mockResolvedValue(await buildMinimalDocx(docXml))
    mockMml2omml.mockImplementation(() => {
      throw new Error('convert failed')
    })

    await convertHtmlToDocxFile('<p>test</p>', '/out/export.docx', {
      mathBlocks: [{ index: 0, mathml: '<math></math>', display: false }]
    })

    const writtenBuffer = mockWriteFile.mock.calls[0]![1] as Buffer
    const resultXml = await readDocxDocumentXml(writtenBuffer)
    // Placeholder remains as styled text — no crash, no OMML.
    expect(resultXml).toContain('MTMATHOMML0000')
    expect(resultXml).not.toContain('<m:oMath')
  })

  it('passes through buffer unchanged when mathBlocks is empty', async() => {
    const buffer = Buffer.from('raw-docx-no-math')
    mockHtmlToDocx.mockResolvedValue(buffer)

    await convertHtmlToDocxFile('<p>test</p>', '/out/export.docx', {
      mathBlocks: []
    })

    expect(mockMml2omml).not.toHaveBeenCalled()
    const writtenBuffer = mockWriteFile.mock.calls[0]![1] as Buffer
    expect(writtenBuffer).toBe(buffer)
  })

  it('passes through buffer unchanged when mathBlocks is undefined', async() => {
    const buffer = Buffer.from('raw-docx')
    mockHtmlToDocx.mockResolvedValue(buffer)

    await convertHtmlToDocxFile('<p>test</p>', '/out/export.docx')

    expect(mockMml2omml).not.toHaveBeenCalled()
    const writtenBuffer = mockWriteFile.mock.calls[0]![1] as Buffer
    expect(writtenBuffer).toBe(buffer)
  })

  it('handles multiple math blocks in sequence', async() => {
    const docXml =
      '<w:document><w:body>' +
        '<w:p><w:r><w:t>MTMATHOMML0000</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>MTMATHOMML0001</w:t></w:r></w:p>' +
      '</w:body></w:document>'
    mockHtmlToDocx.mockResolvedValue(await buildMinimalDocx(docXml))
    mockMml2omml.mockImplementation((mml: string) => `<m:oMath>${mml}</m:oMath>`)

    await convertHtmlToDocxFile('<p>test</p>', '/out/export.docx', {
      mathBlocks: [
        { index: 0, mathml: '<mi>a</mi>', display: false },
        { index: 1, mathml: '<mi>b</mi>', display: false }
      ]
    })

    const writtenBuffer = mockWriteFile.mock.calls[0]![1] as Buffer
    const resultXml = await readDocxDocumentXml(writtenBuffer)
    expect(resultXml).toContain('<m:oMath')
    expect(resultXml).not.toContain('MTMATHOMML0000')
    expect(resultXml).not.toContain('MTMATHOMML0001')
  })
})
