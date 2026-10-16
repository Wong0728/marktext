import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecFileOptions } from 'child_process'
import path from 'path'
import { tmpdir } from 'os'
import type { DocxClipboardPayload } from '@shared/types/ipc'

const { mockExecFile, mockMkdtemp, mockRm, mockExportDocxFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn<(
    file: string, args: string[], options: ExecFileOptions
  ) => Promise<{ stdout: string; stderr: string }>>(),
  mockMkdtemp: vi.fn(),
  mockRm: vi.fn(),
  mockExportDocxFile: vi.fn()
}))

vi.mock('child_process', async() => {
  const { promisify } = await import('util')
  // Preserve execFile's custom promisified { stdout, stderr } contract without spawning.
  const execFile = Object.assign(mockExecFile, { [promisify.custom]: mockExecFile })
  return { execFile, default: { execFile } }
})
vi.mock('fs/promises', () => ({
  mkdtemp: mockMkdtemp,
  rm: mockRm,
  default: { mkdtemp: mockMkdtemp, rm: mockRm }
}))
vi.mock('main_renderer/utils/htmlToDocx', () => ({ exportDocxFile: mockExportDocxFile }))

const { copyDocxToClipboard } = await import('main_renderer/utils/wordClipboard')

const directory = path.join(tmpdir(), 'mock word selection')
const filename = path.join(directory, 'selection.docx')
const payload: DocxClipboardPayload = { content: '<p>Selected text only</p>', docxEngine: 'js' }
const ready = { stdout: 'WORD_PROCESS:24680:638900000000000000\r\nWORD_CLIPBOARD_READY\r\n', stderr: '' }
const timeoutMessage = 'Microsoft Word took too long to prepare the clipboard. Try a smaller selection.'

const failWord = (details: { stdout?: string; stderr?: string; killed?: boolean }) => {
  mockExecFile.mockImplementationOnce(async(_file, args) => {
    throw Object.assign(new Error(`Command failed: powershell.exe ${args.join(' ')}`), details)
  })
}

const expectNoWork = () => {
  expect(mockMkdtemp).not.toHaveBeenCalled()
  expect(mockExportDocxFile).not.toHaveBeenCalled()
  expect(mockExecFile).not.toHaveBeenCalled()
  expect(mockRm).not.toHaveBeenCalled()
}

const expectCleanupAndRetry = async() => {
  expect(mockRm).toHaveBeenCalledExactlyOnceWith(directory, { recursive: true, force: true })
  await expect(copyDocxToClipboard(payload)).resolves.toBeUndefined()
  expect(mockMkdtemp).toHaveBeenCalledTimes(2)
  expect(mockRm).toHaveBeenNthCalledWith(2, directory, { recursive: true, force: true })
}

describe('copyDocxToClipboard', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    mockMkdtemp.mockResolvedValue(directory)
    mockRm.mockResolvedValue(undefined)
    mockExportDocxFile.mockResolvedValue(undefined)
    mockExecFile.mockResolvedValue(ready)
  })

  afterEach(() => vi.restoreAllMocks())

  it.each([
    { docxEngine: 'pandoc', pathname: path.join(directory, 'source folder', 'note.md') },
    { docxEngine: 'js', pathname: undefined }
  ] as const)('forwards the selection and $docxEngine options with pathname=$pathname', async(options) => {
    const selection: DocxClipboardPayload = {
      ...payload,
      ...options,
      content: '  <p>选区 <em>only</em></p>\n',
      title: 'Selection title',
      mathBlocks: [{ index: 0, mathml: '<math><mi>x</mi></math>', display: true }],
      docxFont: { latin: 'Arial', eastAsia: '宋体', sizePt: 12 }
    }
    mockExecFile.mockImplementationOnce(async() => {
      expect(mockExportDocxFile).toHaveBeenCalledTimes(1)
      expect(mockRm).not.toHaveBeenCalled()
      return ready
    })

    await expect(copyDocxToClipboard(selection)).resolves.toBeUndefined()

    expect(mockExportDocxFile).toHaveBeenCalledExactlyOnceWith(selection.content, filename, {
      docxEngine: selection.docxEngine,
      resourcePath: selection.pathname ? path.dirname(selection.pathname) : directory,
      title: selection.title,
      mathBlocks: selection.mathBlocks,
      docxFont: selection.docxFont
    })
    expect(mockExecFile).toHaveBeenCalledExactlyOnceWith('powershell.exe',
      expect.arrayContaining(['-STA', '-EncodedCommand']),
      expect.objectContaining({
        windowsHide: true,
        timeout: expect.any(Number),
        env: expect.objectContaining({ MARKTEXT_COPY_DOCX: filename })
      }))
    expect(mockRm).toHaveBeenCalledExactlyOnceWith(directory, { recursive: true, force: true })
  })

  it.each([undefined, null, { content: '' }, { content: ' \n\t ' }, { content: 42 }])(
    'rejects empty or invalid input %j before doing any work', async(input) => {
      await expect(copyDocxToClipboard(input as DocxClipboardPayload))
        .rejects.toThrow('No content to copy to Word.')
      expectNoWork()
    }
  )

  it.each(['linux', 'darwin'] as const)('rejects %s before doing any work', async(platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await expect(copyDocxToClipboard(payload)).rejects.toThrow('requires Windows and Microsoft Word')
    expectNoWork()
  })

  it('requires the success marker even when PowerShell exits successfully, then allows retry', async() => {
    mockExecFile.mockResolvedValueOnce({ stdout: 'WORD_PROCESS:24680:638900000000000000\r\n', stderr: '' })

    await expect(copyDocxToClipboard(payload)).rejects.toThrow('Word did not finish copying the selection.')
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    await expectCleanupAndRetry()
  })

  it('holds the concurrent-copy lock through export and directory cleanup, then releases it', async() => {
    let finishExport!: () => void
    let finishCleanup!: () => void
    mockExportDocxFile.mockReturnValueOnce(new Promise<void>(resolve => { finishExport = resolve }))
    mockRm.mockReturnValueOnce(new Promise<void>(resolve => { finishCleanup = resolve }))
    const firstCopy = copyDocxToClipboard(payload)

    try {
      await expect(copyDocxToClipboard(payload)).rejects.toThrow('already in progress')
      expect(mockMkdtemp).toHaveBeenCalledTimes(1)
      expect(mockExportDocxFile).toHaveBeenCalledTimes(1)
      expect(mockExecFile).not.toHaveBeenCalled()
      expect(mockRm).not.toHaveBeenCalled()

      finishExport()
      await vi.waitFor(() => expect(mockRm).toHaveBeenCalledTimes(1))
      await expect(copyDocxToClipboard(payload)).rejects.toThrow('already in progress')
      expect(mockMkdtemp).toHaveBeenCalledTimes(1)
      expect(mockExecFile).toHaveBeenCalledTimes(1)
    } finally {
      finishExport()
      finishCleanup()
      await firstCopy
    }
    await expectCleanupAndRetry()
  })

  it('cleans the directory after export failure and permits retry without starting Word', async() => {
    const error = new Error('DOCX export failed')
    mockExportDocxFile.mockRejectedValueOnce(error)

    await expect(copyDocxToClipboard(payload)).rejects.toBe(error)
    expect(mockExecFile).not.toHaveBeenCalled()
    await expectCleanupAndRetry()
  })

  it.each([
    [' \r\nWord is not activated.\r\n ', 'Word is not activated.'],
    ['', 'Could not copy with Microsoft Word. Check that Word is installed and activated.']
  ])('shows only a safe Word error for stderr=%j, cleans up and permits retry', async(stderr, message) => {
    failWord({ stderr })

    await expect(copyDocxToClipboard(payload)).rejects.toEqual(new Error(message))
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    await expectCleanupAndRetry()
  })

  it.each([true, false])('cleans only the stdout-identified Word process on failure (killed=%s)', async(killed) => {
    const pid = '24680'
    const ticks = '638900000000000000'
    failWord({
      stdout: `Word starting\r\nWORD_PROCESS:${pid}:${ticks}\r\n`,
      stderr: '  Word copy failed.  ',
      killed
    })

    const error = await copyDocxToClipboard(payload).catch((error: Error) => error)
    expect(error).toEqual(new Error(killed ? timeoutMessage : 'Word copy failed.'))
    expect(mockExecFile).toHaveBeenCalledTimes(2)
    const [, copyArgs] = mockExecFile.mock.calls[0]
    expect(String(error)).not.toContain('EncodedCommand')
    expect(String(error)).not.toContain(copyArgs[copyArgs.indexOf('-EncodedCommand') + 1])
    const [executable, cleanupArgs, cleanupOptions] = mockExecFile.mock.calls[1]
    expect(executable).toBe('powershell.exe')
    expect(cleanupOptions).toMatchObject({ windowsHide: true, timeout: expect.any(Number) })
    // Check the process-identity guards, not the PowerShell script's formatting or full text.
    const cleanup = cleanupArgs.join(' ')
    expect(cleanup).toMatch(new RegExp(`Get-Process\\s+-Id\\s+${pid}\\b`, 'i'))
    expect(cleanup).toMatch(/ProcessName\s+-eq\s+['"]WINWORD['"]/i)
    expect(cleanup).toMatch(new RegExp(`StartTime\\.Ticks\\s+-eq\\s+${ticks}\\b`, 'i'))
    expect(cleanup).toMatch(/\.Kill\s*\(/i)
    await expectCleanupAndRetry()
  })

  it.each([
    undefined,
    'prefix WORD_PROCESS:24680:638900000000000000',
    'WORD_PROCESS:24680;Stop-Process:638900000000000000',
    'WORD_PROCESS:24680:638900000000000000 trailing'
  ])('does not clean processes without a validated stdout marker (%j)', async(stdout) => {
    failWord({ stdout, stderr: 'WORD_PROCESS:99999:638900000000000001', killed: true })

    await expect(copyDocxToClipboard(payload)).rejects.toEqual(new Error(timeoutMessage))
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    await expectCleanupAndRetry()
  })

  it('reports process cleanup failure without leaking either command, and still permits retry', async() => {
    failWord({ stdout: ready.stdout, killed: true })
    failWord({ stderr: 'cleanup failed' })

    await expect(copyDocxToClipboard(payload)).rejects.toEqual(new Error(
      `${timeoutMessage} The temporary Word process could not be closed.`
    ))
    expect(mockExecFile).toHaveBeenCalledTimes(2)
    await expectCleanupAndRetry()
  })

  it('releases the lock even when removing the directory fails', async() => {
    const error = new Error('Temporary directory is busy')
    mockRm.mockRejectedValueOnce(error)

    await expect(copyDocxToClipboard(payload)).rejects.toBe(error)
    await expectCleanupAndRetry()
  })
})
