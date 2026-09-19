import { describe, it, expect, vi } from 'vitest'

// collectLocalImagesForZip reads image bytes through window.fileUtils and
// derives archive names from the native path (via fileUrlToNativePath). Stub
// the bridge surfaces before the hoisted imports run, mirroring the sibling
// exportHtml specs.
vi.hoisted(() => {
  const w = globalThis as unknown as {
    window?: {
      path?: { sep: string; join?: (...parts: string[]) => string }
      fileUtils?: unknown
    }
  }
  w.window ??= {}
  w.window.path ??= {
    sep: '/',
    join: (...parts: string[]) => parts.join('/')
  }
})

import { collectLocalImagesForZip } from '@/util/exportHtml'

const fileBytes = new Map<string, Uint8Array>([
  ['/docs/images/photo.jpg', new Uint8Array([1, 2, 3])],
  ['/docs/images/fig.svg', new Uint8Array([4, 5])],
  ['/elsewhere/photo.jpg', new Uint8Array([9, 9, 9, 9])]
])

vi.stubGlobal('window', {
  ...globalThis.window,
  path: {
    sep: '/',
    join: (...parts: string[]) => parts.join('/')
  },
  fileUtils: {
    readFile: async(path: string) => {
      const bytes = fileBytes.get(path)
      if (!bytes) throw new Error('not found')
      return bytes
    }
  }
})

const doc = (body: string): string =>
  '<!DOCTYPE html>\n<html><head></head><body>' + body + '</body></html>'

describe('collectLocalImagesForZip — ZIP export image collection', () => {
  it('rewrites file:// image srcs to relative images/ paths and returns their bytes', async() => {
    const result = await collectLocalImagesForZip(
      doc('<img src="file:///docs/images/photo.jpg"><img src="file:///docs/images/fig.svg">')
    )

    expect(result.images.map((i) => i.zipName).sort()).toEqual(['fig.svg', 'photo.jpg'])
    expect(result.html).toContain('src="images/photo.jpg"')
    expect(result.html).toContain('src="images/fig.svg"')
    expect(result.html).not.toContain('file://')
    const svg = result.images.find((i) => i.zipName === 'fig.svg')!
    expect(Array.from(svg.data)).toEqual([4, 5])
  })

  it('shares one archive entry between identical sources', async() => {
    const result = await collectLocalImagesForZip(
      doc('<img src="file:///docs/images/photo.jpg"><img src="file:///docs/images/photo.jpg">')
    )

    expect(result.images).toHaveLength(1)
    expect((result.html.match(/images\/photo\.jpg/g) || []).length).toBe(2)
  })

  it('suffixes colliding basenames from different folders', async() => {
    const result = await collectLocalImagesForZip(
      doc('<img src="file:///docs/images/photo.jpg"><img src="file:///elsewhere/photo.jpg">')
    )

    expect(result.images.map((i) => i.zipName).sort()).toEqual(['photo-1.jpg', 'photo.jpg'])
    expect(result.html).toContain('src="images/photo.jpg"')
    expect(result.html).toContain('src="images/photo-1.jpg"')
    const bumped = result.images.find((i) => i.zipName === 'photo-1.jpg')!
    expect(Array.from(bumped.data)).toEqual([9, 9, 9, 9])
  })

  it('leaves remote and data: sources untouched', async() => {
    const result = await collectLocalImagesForZip(
      doc('<img src="https://cdn.example.com/pic.png"><img src="data:image/png;base64,AAAA">')
    )

    expect(result.images).toHaveLength(0)
    expect(result.html).toContain('src="https://cdn.example.com/pic.png"')
    expect(result.html).toContain('src="data:image/png;base64,AAAA"')
  })

  it('keeps the file:// src of unreadable images and omits them from the archive', async() => {
    const result = await collectLocalImagesForZip(
      doc('<img src="file:///docs/images/missing.jpg"><img src="file:///docs/images/photo.jpg">')
    )

    expect(result.images).toHaveLength(1)
    expect(result.html).toContain('src="file:///docs/images/missing.jpg"')
    expect(result.html).toContain('src="images/photo.jpg"')
  })

  it('emits a document starting with <!DOCTYPE html>', async() => {
    const result = await collectLocalImagesForZip(doc('<p>x</p>'))
    expect(result.html.startsWith('<!DOCTYPE html>')).toBe(true)
  })
})
