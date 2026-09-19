import { describe, it, expect, vi } from 'vitest'

// Same preload-bridge stubbing as exportHtml.spec.ts — the export wrapper
// reaches `window.path` / `window.DIRNAME` via the preload surface.
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

import { exportStyledHTML } from '@/util/exportHtml'

const NO_MUYA = null as unknown as Parameters<typeof exportStyledHTML>[0]

// A combined regression document (#13: 中文 + 复杂公式 + 表格 + Mermaid).
// The golden snapshot freezes the exact rendered export so any engine change
// that would silently break CJK text, math, tables or diagrams shows up as a
// reviewable diff instead of a broken export.
const COMBINED_DOC = `# 项目说明

## 数学公式

行内公式：质能方程 $E = mc^2$ 与欧拉公式 $e^{i\\pi} + 1 = 0$。

块级公式：

$$
\\begin{aligned}
(a+b)^2 &= a^2 + 2ab + b^2 \\\\
(a-b)^2 &= a^2 - 2ab + b^2
\\end{aligned}
$$

$$
f(x) = \\begin{cases} x^2 & \\text{若 } x \\geq 0 \\\\ -x & \\text{若 } x < 0 \\end{cases}
$$

## 数据表格

| 试剂 | 浓度 | 备注 |
|:-----|-----:|:-----|
| 硫酸 | 0.1 mol/L | 危险品 |
| 盐酸 | 0.5 mol/L | 常温保存 |

## 流程图

\`\`\`mermaid
graph TD;
    A-->B;
    A-->C;
    B-->D;
    C-->D;
\`\`\`

> 引用块中的**中文强调**文本。
`

describe('exportStyledHTML — combined CJK + math + table + mermaid regression', () => {
  it('renders the combined document into a stable golden file', async() => {
    const out = await exportStyledHTML(NO_MUYA, COMBINED_DOC, {})
    await expect(out).toMatchFileSnapshot(
      './__snapshots__/combined-cjk-math-table-mermaid.golden.html'
    )
  })

  it('keeps CJK text, semantic table and diagram containers intact', async() => {
    const out = await exportStyledHTML(NO_MUYA, COMBINED_DOC, {})

    // CJK text survives rendering (no mojibake / dropped paragraphs).
    expect(out).toContain('质能方程')
    expect(out).toContain('欧拉公式')
    expect(out).toContain('中文强调')

    // Inline + block math produce MathML (the export pipeline renders math
    // through KaTeX with its MathML sibling preserved).
    expect(out).toContain('<math')

    // GFM table renders as a real table with alignment classes.
    expect(out).toContain('<table>')

    // Mermaid block is preserved for the viewer to hydrate.
    expect(out).toContain('mermaid')
  })
})
