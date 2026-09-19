import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { launchWithMarkdown, setSourceMarkdown, waitForEditor } from './helpers'

const FIXTURE = `10. 多行对齐公式

$$
\\begin{aligned}
(a+b)^2 &= a^2 + 2ab + b^2 \\\\
(a-b)^2 &= a^2 - 2ab + b^2 \\\\
(a+b)(a-b) &= a^2 - b^2
\\end{aligned}
$$

化学方程式（如果支持 mhchem）：

$$
\\ce{2H2 + O2 -> 2H2O}
$$

分式嵌套：

$$
\\frac{1}{1 + \\frac{1}{1 + \\frac{1}{x}}}
$$
`

test.describe('Rendered math formulas', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async() => {
    const launched = await launchWithMarkdown('')
    app = launched.app
    page = launched.page
    await waitForEditor(page)
    await setSourceMarkdown(page, app, FIXTURE)
    await page.waitForTimeout(1000)
  })

  test.afterAll(async() => {
    if (app) await app.close()
  })

  test('renders math formulas without errors', async() => {
    const info = await page.evaluate(() => {
      return {
        mathPreviewCount: document.querySelectorAll('.mu-math-preview').length,
        mathRenderCount: document.querySelectorAll('.mu-math-render').length,
        katexDisplayCount: document.querySelectorAll('.katex-display').length,
        mathErrorCount: document.querySelectorAll('.mu-math-error').length,
        katexErrorCount: document.querySelectorAll('.katex-error').length,
      }
    })
    console.log('DOM info:', info)
    await page.screenshot({ path: 'test-results/math-formulas.png', fullPage: true })
    expect(info.mathErrorCount).toBe(0)
    expect(info.katexErrorCount).toBe(0)
    expect(info.katexDisplayCount).toBeGreaterThanOrEqual(3)
  })
})
