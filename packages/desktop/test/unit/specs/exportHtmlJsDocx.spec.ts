import { describe, it, expect, vi } from 'vitest'

// exportHtml.ts transitively imports resolveImageSrc / resolveLinkHref which
// read window.path / window.DIRNAME at call-time — not at module load. But
// dompurify.ts touches window at import. Stub the same surfaces the sibling
// exportHtml.spec.ts stubs so the module loads cleanly under jsdom.
vi.hoisted(() => {
  const w = globalThis as unknown as {
    window?: {
      path?: {
        sep: string
        join?: (...parts: string[]) => string
        resolve?: (...parts: string[]) => string
      }
      fileUtils?: unknown
      marktext?: unknown
      DIRNAME?: string
    }
  }
  w.window ??= {}
  w.window.path ??= {
    sep: '/',
    join: (...parts: string[]) => parts.join('/'),
    resolve: (...parts: string[]) =>
      parts.join('/').replace(/\/\.\//g, '/').replace(/\/{2,}/g, '/')
  }
  w.window.DIRNAME = '/docs'
})

import { prepareHtmlForJsDocx, prepareHtmlForDocx } from '@/util/exportHtml'

// KaTeX renders every formula as a dual-output structure:
//   .katex
//     .katex-mathml  → <math> MathML semantic layer (pandoc reads this → OMML)
//     .katex-html    → visual spans (JS engine reads this as styled text)
// The two preprocessing functions choose which layer to keep per engine.

const inlineMathHtml = (formula: string, visualHtml: string): string =>
  '<span class="katex">' +
    '<span class="katex-mathml">' +
      '<math xmlns="http://www.w3.org/1998/Math/MathML">' +
        '<semantics>' +
          `<mrow>${formula}</mrow>` +
          `<annotation encoding="application/x-tex">${formula}</annotation>` +
        '</semantics>' +
      '</math>' +
    '</span>' +
    '<span class="katex-html" aria-hidden="true">' +
      `<span class="base">${visualHtml}</span>` +
    '</span>' +
  '</span>'

const blockMathHtml = (formula: string, visualHtml: string): string =>
  '<div class="katex-display">' + inlineMathHtml(formula, visualHtml) + '</div>'

const fullDocument = (bodyContent: string): string =>
  '<!DOCTYPE html>\n<html><head></head><body>' + bodyContent + '</body></html>'

describe('prepareHtmlForJsDocx — JS engine preprocessing', () => {
  it('replaces .katex with a placeholder span (removes both MathML and visual layers)', () => {
    const html = fullDocument(inlineMathHtml('<mi>E</mi>', 'E'))
    const result = prepareHtmlForJsDocx(html)

    const doc = new DOMParser().parseFromString(result.html, 'text/html')
    expect(doc.querySelectorAll('.katex')).toHaveLength(0)
    expect(doc.querySelectorAll('.katex-mathml')).toHaveLength(0)
    expect(doc.querySelectorAll('.katex-html')).toHaveLength(0)
    expect(doc.querySelectorAll('math')).toHaveLength(0)
    expect(result.html).toContain('MTMATHOMML0000')
  })

  it('replaces block-level .katex-display with a plain <div> containing the placeholder', () => {
    const html = fullDocument(blockMathHtml('<mi>x</mi>', 'x'))
    const result = prepareHtmlForJsDocx(html)

    const doc = new DOMParser().parseFromString(result.html, 'text/html')
    expect(doc.querySelectorAll('.katex-display')).toHaveLength(0)
    const divs = doc.querySelectorAll('body > div')
    expect(divs.length).toBeGreaterThanOrEqual(1)
    expect(divs[0].textContent).toContain('MTMATHOMML')
  })

  it('preserves non-math HTML (paragraphs, tables, code) unchanged', () => {
    const body =
      '<p>Hello world</p>' +
      '<table><tr><td>A</td><td>B</td></tr></table>' +
      '<pre><code>const x = 1</code></pre>' +
      inlineMathHtml('<mi>E</mi>', 'E')
    const html = fullDocument(body)
    const result = prepareHtmlForJsDocx(html)

    const doc = new DOMParser().parseFromString(result.html, 'text/html')
    expect(doc.querySelector('p')!.textContent).toBe('Hello world')
    expect(doc.querySelectorAll('table tr td')).toHaveLength(2)
    expect(doc.querySelector('pre code')!.textContent).toBe('const x = 1')
    expect(doc.querySelectorAll('.katex')).toHaveLength(0)
    expect(result.html).toContain('MTMATHOMML')
  })

  it('outputs a document starting with <!DOCTYPE html>', () => {
    const result = prepareHtmlForJsDocx(fullDocument('<p>x</p>'))
    expect(result.html.startsWith('<!DOCTYPE html>')).toBe(true)
  })

  it('extracts mathBlocks with correct count (one per .katex)', () => {
    const body =
      inlineMathHtml('<mi>E</mi>', 'E') +
      blockMathHtml('<mi>x</mi>', 'x') +
      inlineMathHtml('<mi>m</mi>', 'm')
    const html = fullDocument(body)
    const result = prepareHtmlForJsDocx(html)

    expect(result.mathBlocks).toHaveLength(3)
  })

  it('stores MathML in each mathBlock', () => {
    const html = fullDocument(inlineMathHtml('<mi>E</mi>', 'E'))
    const result = prepareHtmlForJsDocx(html)

    expect(result.mathBlocks).toHaveLength(1)
    expect(result.mathBlocks[0].mathml).toContain('<math')
    expect(result.mathBlocks[0].mathml).toContain('<mi>E</mi>')
  })

  it('marks block math as display=true and inline math as display=false', () => {
    const body =
      inlineMathHtml('<mi>E</mi>', 'E') +
      blockMathHtml('<mi>x</mi>', 'x')
    const html = fullDocument(body)
    const result = prepareHtmlForJsDocx(html)

    expect(result.mathBlocks).toHaveLength(2)
    expect(result.mathBlocks[0].display).toBe(false)
    expect(result.mathBlocks[1].display).toBe(true)
  })

  it('assigns sequential indices starting from 0', () => {
    const body =
      inlineMathHtml('<mi>a</mi>', 'a') +
      inlineMathHtml('<mi>b</mi>', 'b') +
      inlineMathHtml('<mi>c</mi>', 'c')
    const html = fullDocument(body)
    const result = prepareHtmlForJsDocx(html)

    expect(result.mathBlocks.map((b) => b.index)).toEqual([0, 1, 2])
  })

  it('emits zero-padded placeholder text matching the index', () => {
    const body =
      inlineMathHtml('<mi>a</mi>', 'a') +
      inlineMathHtml('<mi>b</mi>', 'b')
    const html = fullDocument(body)
    const result = prepareHtmlForJsDocx(html)

    expect(result.html).toContain('MTMATHOMML0000')
    expect(result.html).toContain('MTMATHOMML0001')
  })

  it('returns empty mathBlocks when there is no math', () => {
    const html = fullDocument('<p>no math here</p>')
    const result = prepareHtmlForJsDocx(html)

    expect(result.mathBlocks).toHaveLength(0)
    expect(result.html).not.toContain('MTMATHOMML')
  })
})

describe('prepareHtmlForDocx — pandoc preprocessing', () => {
  it('replaces block-level .katex-display with a <div> containing <math>', async() => {
    const html = fullDocument(blockMathHtml('<mi>x</mi>', 'x'))
    const result = await prepareHtmlForDocx(html)

    const doc = new DOMParser().parseFromString(result, 'text/html')
    expect(doc.querySelectorAll('.katex-display')).toHaveLength(0)
    // The <math> element should survive inside the replacement div.
    const mathElements = doc.querySelectorAll('math')
    expect(mathElements).toHaveLength(1)
    // The .katex-html visual layer should be removed (pandoc reads MathML only).
    expect(doc.querySelectorAll('.katex-html')).toHaveLength(0)
  })

  it('replaces inline .katex with a bare <math> element', async() => {
    const html = fullDocument(inlineMathHtml('<mi>E</mi>', 'E'))
    const result = await prepareHtmlForDocx(html)

    const doc = new DOMParser().parseFromString(result, 'text/html')
    // No .katex wrapper remains.
    expect(doc.querySelectorAll('.katex')).toHaveLength(0)
    expect(doc.querySelectorAll('.katex-mathml')).toHaveLength(0)
    expect(doc.querySelectorAll('.katex-html')).toHaveLength(0)
    // The <math> element is extracted and inlined.
    const mathElements = doc.querySelectorAll('math')
    expect(mathElements).toHaveLength(1)
  })

  it('handles both inline and block math in the same document', async() => {
    const body =
      '<p>Inline: ' + inlineMathHtml('<mi>E</mi>', 'E') + '</p>' +
      '<div>Block:</div>' +
      blockMathHtml('<mi>x</mi>', 'x')
    const html = fullDocument(body)
    const result = await prepareHtmlForDocx(html)

    const doc = new DOMParser().parseFromString(result, 'text/html')
    const mathElements = doc.querySelectorAll('math')
    expect(mathElements).toHaveLength(2)
    expect(doc.querySelectorAll('.katex')).toHaveLength(0)
    expect(doc.querySelectorAll('.katex-mathml')).toHaveLength(0)
    expect(doc.querySelectorAll('.katex-html')).toHaveLength(0)
  })

  it('outputs a document starting with <!DOCTYPE html>', async() => {
    const result = await prepareHtmlForDocx(fullDocument('<p>x</p>'))
    expect(result.startsWith('<!DOCTYPE html>')).toBe(true)
  })

  it('preserves non-math HTML unchanged', async() => {
    const body =
      '<p>Text</p>' +
      '<ul><li>item</li></ul>' +
      inlineMathHtml('<mi>E</mi>', 'E')
    const html = fullDocument(body)
    const result = await prepareHtmlForDocx(html)

    const doc = new DOMParser().parseFromString(result, 'text/html')
    expect(doc.querySelector('p')!.textContent).toBe('Text')
    expect(doc.querySelectorAll('ul li')).toHaveLength(1)
    expect(doc.querySelectorAll('math')).toHaveLength(1)
  })
})

describe('prepareHtmlForDocx — standalone formula promotion & zero-width spaces', () => {
  it('promotes a paragraph containing only an inline formula to a display block', async() => {
    const html = fullDocument('<p>' + inlineMathHtml('<mi>E</mi>', 'E') + '</p>')
    const result = await prepareHtmlForDocx(html)

    const doc = new DOMParser().parseFromString(result, 'text/html')
    expect(doc.querySelectorAll('.katex')).toHaveLength(0)
    const math = doc.querySelector('math')!
    expect(math.getAttribute('display')).toBe('block')
    expect(doc.querySelector('p')).toBeNull()
  })

  it('promotes a table cell containing only an inline formula', async() => {
    const html = fullDocument('<table><tr><td>' + inlineMathHtml('<mi>x</mi>', 'x') + '</td></tr></table>')
    const result = await prepareHtmlForDocx(html)

    const doc = new DOMParser().parseFromString(result, 'text/html')
    const math = doc.querySelector('math')!
    expect(math.getAttribute('display')).toBe('block')
    expect(doc.querySelector('td')).not.toBeNull()
  })

  it('does not promote a paragraph where the formula has neighbouring text', async() => {
    const html = fullDocument('<p>value ' + inlineMathHtml('<mi>x</mi>', 'x') + ' end</p>')
    const result = await prepareHtmlForDocx(html)

    const doc = new DOMParser().parseFromString(result, 'text/html')
    expect(doc.querySelector('math')!.getAttribute('display')).toBeNull()
    expect(doc.querySelector('p')).not.toBeNull()
  })

  it('strips zero-width spaces from text content', async() => {
    const result = await prepareHtmlForDocx(fullDocument('<p>visibl\u200be text</p>'))
    expect(result).not.toContain('\u200b')
  })
})
