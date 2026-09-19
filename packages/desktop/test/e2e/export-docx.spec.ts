import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  launchWithMarkdown,
  waitForMenuReady,
  sendIpcToRenderer
} from './helpers'

const DOCX_DOC =
  '# DOCX Export Test\n\n' +
  'Inline code: `printf()` and `var x = 1`.\n\n' +
  '```python\n' +
  'def hello():\n' +
  '    print("world")\n' +
  '```\n\n' +
  '| Name | Age |\n' +
  '|------|-----|\n' +
  '| Alice | 25 |\n' +
  '| Bob | 30 |\n\n' +
  'Math: $E = mc^2$ and $$x = {-b \\pm \\sqrt{b^2-4ac} \\over 2a}$$\n'

const DOCX_NO_MATH =
  '# No Math Test\n\n' +
  'Inline code: `printf()` and `var x = 1`.\n\n' +
  '```python\n' +
  'def hello():\n' +
  '    print("world")\n' +
  '```\n\n' +
  '| Name | Age |\n' +
  '|------|-----|\n' +
  '| Alice | 25 |\n' +
  '| Bob | 30 |\n'

// Complex markdown exercising nested tables, task lists, nested lists, and
// math — the content pandoc struggles with and the JS engine handles better.
const DOCX_COMPLEX =
  '# Complex Export Test\n\n' +
  '## Table with colspan\n\n' +
  '| Category | Item | Price |\n' +
  '|----------|------|-------|\n' +
  '| Fruit    | Apple | 1.00 |\n' +
  '| Fruit    | Banana | 0.50 |\n' +
  '| Vegetable | Carrot | 0.80 |\n\n' +
  '## Task list\n\n' +
  '- [x] Done task\n' +
  '- [ ] Pending task\n' +
  '- [ ] Another pending\n\n' +
  '## Nested list\n\n' +
  '1. First\n' +
  '   - Nested a\n' +
  '   - Nested b\n' +
  '2. Second\n\n' +
  '## Math\n\n' +
  'Inline: $E = mc^2$ and block:\n\n' +
  '$$\\int_0^1 x^2 dx = \\frac{1}{3}$$\n\n' +
  '## Code\n\n' +
  '```javascript\n' +
  'const fn = (x) => x * 2;\n' +
  '```\n'

const stubSaveDialog = async(app: ElectronApplication, targetPath: string): Promise<void> => {
  await app.evaluate(async({ dialog }, savePath) => {
    const g = global as unknown as {
      __mt_orig_showSaveDialog__?: typeof dialog.showSaveDialog
    }
    if (!g.__mt_orig_showSaveDialog__) {
      g.__mt_orig_showSaveDialog__ = dialog.showSaveDialog.bind(dialog)
    }
    ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async() => ({
      canceled: false,
      filePath: savePath
    })
  }, targetPath)
}

const restoreSaveDialog = async(app: ElectronApplication): Promise<void> => {
  await app.evaluate(({ dialog }) => {
    const g = global as unknown as {
      __mt_orig_showSaveDialog__?: typeof dialog.showSaveDialog
    }
    if (g.__mt_orig_showSaveDialog__) {
      ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog =
        g.__mt_orig_showSaveDialog__
    }
  })
}

const triggerDocxExportViaDialog = async(app: ElectronApplication, page: Page): Promise<void> => {
  await sendIpcToRenderer(app, 'mt::show-export-dialog', 'docx')
  const confirm = page.locator('.print-settings-dialog .button-primary')
  await confirm.waitFor({ state: 'visible', timeout: 10000 })
  await confirm.click()
}

// Select a DOCX engine in the export settings dialog before clicking confirm.
// The engine selector lives on the "info" tab (default active tab) inside
// .docx-engine-select. Element Plus renders el-select options in a teleported
// dropdown — click the trigger, then click the matching option item.
const selectDocxEngine = async(page: Page, engine: 'auto' | 'pandoc' | 'js'): Promise<void> => {
  const selectTrigger = page.locator('.docx-engine-select .el-select').first()
  await selectTrigger.waitFor({ state: 'visible', timeout: 5000 })
  await selectTrigger.click()

  // The dropdown is teleported to body; wait for option items to appear.
  // Match by the option value via a data attribute is not available, so we
  // match by partial text. The labels are locale-dependent but the English
  // defaults are used in the e2e environment.
  const labelFragment = engine === 'js' ? 'Built-in JS'
    : engine === 'pandoc' ? 'Pandoc'
      : 'Auto'
  const option = page.locator('.el-select-dropdown__item').filter({ hasText: labelFragment }).first()
  await option.waitFor({ state: 'visible', timeout: 5000 })
  await option.click()
}

// Trigger DOCX export with a specific engine selected in the dialog.
const triggerDocxExportWithEngine = async(
  app: ElectronApplication,
  page: Page,
  engine: 'auto' | 'pandoc' | 'js'
): Promise<void> => {
  await sendIpcToRenderer(app, 'mt::show-export-dialog', 'docx')
  const confirm = page.locator('.print-settings-dialog .button-primary')
  await confirm.waitFor({ state: 'visible', timeout: 10000 })
  await selectDocxEngine(page, engine)
  await confirm.click()
}

const pollForDocxFile = async(filePath: string, timeoutMs = 20000): Promise<Buffer> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath)
      if (data.length > 0) return data
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`DOCX file was not written within ${timeoutMs}ms: ${filePath}`)
}

const extractDocx = (docxPath: string, extractDir: string): string => {
  const zipPath = `${docxPath}.zip`
  fs.copyFileSync(docxPath, zipPath)
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true })
  }
  childProcess.execSync(`powershell -ExecutionPolicy Bypass -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}'"`)
  return path.join(extractDir, 'word', 'document.xml')
}

const readDocxStylesXml = (docxPath: string): string => {
  const extractDir = `${docxPath}.styles`
  const zipPath = `${docxPath}.zip`
  fs.copyFileSync(docxPath, zipPath)
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true })
  }
  childProcess.execSync(`powershell -ExecutionPolicy Bypass -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}'"`)
  const stylesXml = fs.readFileSync(path.join(extractDir, 'word', 'styles.xml'), 'utf-8')
  fs.rmSync(extractDir, { recursive: true, force: true })
  return stylesXml
}

test.describe('DOCX export content (item docx)', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async() => {
    const launched = await launchWithMarkdown(DOCX_DOC)
    app = launched.app
    page = launched.page
    await waitForMenuReady(app)
  })

  test.afterAll(async() => {
    if (app) {
      await restoreSaveDialog(app)
      await app.close()
    }
  })

  test('writes a DOCX containing table, inline code, and math', async() => {
    const out = path.join(__dirname, `marktext-e2e-docx-${Date.now()}.docx`)
    const extractDir = `${out}.extracted`
    if (fs.existsSync(out)) fs.rmSync(out, { force: true })
    await stubSaveDialog(app, out)

    await triggerDocxExportViaDialog(app, page)

    await pollForDocxFile(out)
    const documentXml = extractDocx(out, extractDir)
    const xml = fs.readFileSync(documentXml, 'utf-8')

    // Dump XML to a fixed file for manual inspection.
    const dumpPath = path.join(__dirname, 'last-docx-document.xml')
    fs.writeFileSync(dumpPath, xml, 'utf-8')
    console.log('DOCX document.xml written to:', dumpPath)
    console.log('XML snippet (first 4000 chars):', xml.slice(0, 4000))

    // Table structure
    expect(xml).toContain('<w:tbl>')
    expect(xml).toContain('<w:tblGrid>')
    expect(xml).toContain('Name')
    expect(xml).toContain('Alice')

    // Inline / block code styling
    expect(xml).toContain('<w:rStyle w:val="VerbatimChar" />')
    expect(xml).toContain('<w:pStyle w:val="SourceCode" />')

    // Syntax highlighting token styles (reference.docx must define these)
    expect(xml).toContain('<w:rStyle w:val="KeywordTok" />')
    expect(xml).toContain('<w:rStyle w:val="StringTok" />')
    const stylesXml = readDocxStylesXml(out)
    expect(stylesXml).toContain('styleId="KeywordTok"')
    expect(stylesXml).toContain('styleId="StringTok"')
    expect(stylesXml).toContain('styleId="SourceCode"')
    expect(stylesXml).toContain('<w:tblBorders>')

    // Math (OMML)
    expect(xml).toContain('<m:oMath>')

    fs.rmSync(out, { force: true })
    fs.rmSync(extractDir, { recursive: true, force: true })
  })
})

test.describe('DOCX export without math (item docx-nomath)', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async() => {
    const launched = await launchWithMarkdown(DOCX_NO_MATH)
    app = launched.app
    page = launched.page
    await waitForMenuReady(app)
  })

  test.afterAll(async() => {
    if (app) {
      await restoreSaveDialog(app)
      await app.close()
    }
  })

  test('writes a DOCX containing table and inline code even without math', async() => {
    const out = path.join(__dirname, `marktext-e2e-docx-nomath-${Date.now()}.docx`)
    const extractDir = `${out}.extracted`
    if (fs.existsSync(out)) fs.rmSync(out, { force: true })
    await stubSaveDialog(app, out)

    await triggerDocxExportViaDialog(app, page)

    await pollForDocxFile(out)
    const documentXml = extractDocx(out, extractDir)
    const xml = fs.readFileSync(documentXml, 'utf-8')

    expect(xml).toContain('<w:tbl>')
    expect(xml).toContain('<w:rStyle w:val="VerbatimChar" />')
    expect(xml).toContain('<w:pStyle w:val="SourceCode" />')

    fs.rmSync(out, { force: true })
    fs.rmSync(extractDir, { recursive: true, force: true })
  })
})

test.describe('DOCX export via JS engine (item docx-js)', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async() => {
    const launched = await launchWithMarkdown(DOCX_COMPLEX)
    app = launched.app
    page = launched.page
    await waitForMenuReady(app)
  })

  test.afterAll(async() => {
    if (app) {
      await restoreSaveDialog(app)
      await app.close()
    }
  })

  test('JS engine produces DOCX with tables and OMML math', async() => {
    const out = path.join(__dirname, `marktext-e2e-docx-js-${Date.now()}.docx`)
    const extractDir = `${out}.extracted`
    if (fs.existsSync(out)) fs.rmSync(out, { force: true })
    await stubSaveDialog(app, out)

    await triggerDocxExportWithEngine(app, page, 'js')

    const data = await pollForDocxFile(out, 30000)
    expect(data.length).toBeGreaterThan(0)

    const documentXml = extractDocx(out, extractDir)
    const xml = fs.readFileSync(documentXml, 'utf-8')

    // The JS engine renders tables natively (better than pandoc).
    expect(xml).toContain('<w:tbl>')

    // The JS engine now produces native OMML equations via mathml2omml
    // post-injection — formulas are no longer styled-text approximations.
    expect(xml).toContain('<m:oMath')

    // Smoke: the complex markdown (task lists, nested lists, code, math) did
    // not crash the engine — the document was written and has content.
    expect(xml.length).toBeGreaterThan(500)

    fs.rmSync(out, { force: true })
    fs.rmSync(extractDir, { recursive: true, force: true })
  })
})
