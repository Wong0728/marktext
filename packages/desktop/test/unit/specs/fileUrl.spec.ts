import { describe, expect, it } from 'vitest'

import {
  encodeDirnameForUrl,
  fileUrlToNativePath,
  localPathToFileUrl,
  pathToFileUrl
} from '@/util/fileUrl'

// Windows 专项修复的回归锚点（fork 独有功能清单："pandoc PATH、CJK fileUrl、原子写"）。
//
// * `pathToFileUrl` — 导出 HTML/DOCX 时把绝对路径变成合法的 file:// URL：
//   朴素的 `file://${path}` 会把 Windows 盘符 `C:` 当成 URL authority（host），
//   严格读取方（pandoc 的 DOCX 图片抓取器）会解析成不存在的主机并丢弃所有图片；
//   CJK、空格、`#`、`?` 不编码也会破坏 URL。见 util/fileUrl.ts 头部注释。
// * `fileUrlToNativePath` — pandoc 会把 file: URI 的非 ASCII 部分百分号编码后再
//   当作路径打开，中文文件夹因此全部抓取失败；DOCX 转换因此改回裸路径。
//
// 在此之前这两个函数只有间接覆盖（exportHtml.spec.ts 走导出包装器、
// exportHtmlZip.spec.ts 仅 stub 该模块），没有直接断言。

describe('pathToFileUrl — Windows drive paths keep the drive letter out of the authority', () => {
  it('converts a drive path to file:///C:/… (three slashes)', () => {
    expect(pathToFileUrl('C:\\a\\b.png')).toBe('file:///C:/a/b.png')
  })

  it('percent-encodes CJK folder and file names', () => {
    expect(pathToFileUrl('C:\\文档\\图片.png')).toBe(
      'file:///C:/%E6%96%87%E6%A1%A3/%E5%9B%BE%E7%89%87.png'
    )
  })

  it('encodes spaces but keeps the drive colon literal', () => {
    expect(pathToFileUrl('C:\\a b\\图.png')).toBe('file:///C:/a%20b/%E5%9B%BE.png')
  })

  it('escapes # and ? inside directory names', () => {
    expect(pathToFileUrl('/docs/#tag?q/a.png')).toBe('file:///docs/%23tag%3Fq/a.png')
  })

  it('keeps a POSIX absolute path as file:///path', () => {
    expect(pathToFileUrl('/home/me/笔记.md')).toBe('file:///home/me/%E7%AC%94%E8%AE%B0.md')
  })

  it('maps a UNC share to file://host/… (host is the authority)', () => {
    expect(pathToFileUrl('\\\\server\\共享\\a.png')).toBe(
      'file://server/%E5%85%B1%E4%BA%AB/a.png'
    )
  })

  it('passes an empty string through untouched', () => {
    expect(pathToFileUrl('')).toBe('')
  })
})

describe('fileUrlToNativePath — the pandoc DOCX CJK fix', () => {
  it('decodes a CJK file:// URL back to a plain drive path', () => {
    expect(fileUrlToNativePath('file:///C:/%E6%96%87%E6%A1%A3/%E5%9B%BE%E7%89%87.png')).toBe(
      'C:/文档/图片.png'
    )
  })

  it('decodes a POSIX file:// URL', () => {
    expect(fileUrlToNativePath('file:///home/me/%E7%AC%94%E8%AE%B0.md')).toBe(
      '/home/me/笔记.md'
    )
  })

  it('turns a UNC file:// URL back into backslash form', () => {
    expect(fileUrlToNativePath('file://server/%E5%85%B1%E4%BA%AB/a.png')).toBe(
      '\\\\server\\共享\\a.png'
    )
  })

  it('leaves non-file URLs and bare paths untouched', () => {
    expect(fileUrlToNativePath('https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(fileUrlToNativePath('C:\\文档\\a.png')).toBe('C:\\文档\\a.png')
  })

  it('keeps a literal percent escape that is not valid URI escape (50%.png)', () => {
    expect(fileUrlToNativePath('file:///docs/50%.png')).toBe('/docs/50%.png')
  })

  it('round-trips a CJK drive path through the URL form', () => {
    const original = 'D:\\资料\\论文\\fig 1.png'
    expect(fileUrlToNativePath(pathToFileUrl(original))).toBe('D:/资料/论文/fig 1.png')
  })
})

describe('localPathToFileUrl — renderer-side local image/link URLs', () => {
  it('prefixes a Windows drive path with three slashes', () => {
    expect(localPathToFileUrl('C:\\x\\y.png')).toBe('file:///C:/x/y.png')
  })

  it('maps a UNC share to file://host/share/…', () => {
    expect(localPathToFileUrl('\\\\server\\share\\a.png')).toBe('file://server/share/a.png')
  })

  it('prefixes a plain absolute path with file:///', () => {
    expect(localPathToFileUrl('/docs/a.png')).toBe('file:///docs/a.png')
  })
})

describe('encodeDirnameForUrl — escape only the raw-directory metacharacters', () => {
  it('escapes %, ? and # in the document directory', () => {
    expect(encodeDirnameForUrl('/docs/50%/#a?b')).toBe('/docs/50%25/%23a%3Fb')
  })

  it('leaves a clean directory untouched', () => {
    expect(encodeDirnameForUrl('/docs/文档')).toBe('/docs/文档')
  })
})
