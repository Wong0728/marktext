import { execFile } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'
import type { DocxClipboardPayload } from '@shared/types/ipc'
import { exportDocxFile } from './htmlToDocx'

const run = promisify(execFile)

const COPY_WITH_WORD = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WordClipboard {
    [DllImport("ole32.dll")] public static extern int OleInitialize(IntPtr reserved);
    [DllImport("ole32.dll")] public static extern void OleUninitialize();
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
}
'@
[Runtime.InteropServices.Marshal]::ThrowExceptionForHR([WordClipboard]::OleInitialize([IntPtr]::Zero))
$sequence = [WordClipboard]::GetClipboardSequenceNumber()
$existingProcesses = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$word = $null
$documents = $null
$document = $null
$range = $null
$window = $null
$ownsWord = $false
$failure = $null
$noSave = 0
try {
    # Word is a SingleUse COM server: activation creates a separate application.
    $word = New-Object -ComObject Word.Application
    $ownsWord = $true
    $documents = $word.Documents
    $document = $documents.Add()
    $window = $document.ActiveWindow
    $wordProcessId = [uint32]0
    [void][WordClipboard]::GetWindowThreadProcessId([IntPtr]$window.Hwnd, [ref]$wordProcessId)
    if ($wordProcessId -eq 0 -or $existingProcesses -contains $wordProcessId) {
        $ownsWord = $false
        throw 'Could not create an isolated Microsoft Word instance.'
    }
    $started = (Get-Process -Id $wordProcessId).StartTime.Ticks
    Write-Output "WORD_PROCESS:$($wordProcessId):$started"
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3
    $document.Close([ref]$noSave)
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($window)
    $window = $null
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($document)
    $document = $null
    $filename = $env:MARKTEXT_COPY_DOCX
    $confirm = $false
    $readOnly = $true
    $recent = $false
    $document = $documents.Open([ref]$filename, [ref]$confirm, [ref]$readOnly, [ref]$recent)
    $range = $document.Content
    if ([WordClipboard]::GetClipboardSequenceNumber() -ne $sequence) {
        throw 'The clipboard changed while Word was preparing the selection. Copy again.'
    }
    $range.Copy()
    $source = [Windows.Forms.Clipboard]::GetDataObject()
    $snapshot = New-Object Windows.Forms.DataObject
    foreach ($format in @('Rich Text Format', 'HTML Format', 'UnicodeText')) {
        $value = $source.GetData($format, $false)
        if ($null -eq $value) { throw "Word did not provide $format clipboard data." }
        $snapshot.SetData($format, $false, $value)
    }
    [Windows.Forms.Clipboard]::SetDataObject($snapshot, $true)
} catch {
    $failure = $_.Exception.Message
} finally {
    try { if ($document) { $document.Close([ref]$noSave) } } catch { if (!$failure) { $failure = $_.Exception.Message } }
    try { if ($ownsWord) { $word.Quit([ref]$noSave) } } catch { if (!$failure) { $failure = $_.Exception.Message } }
    foreach ($item in @($range, $window, $document, $documents, $word)) {
        if ($null -ne $item) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($item) }
    }
    [WordClipboard]::OleUninitialize()
}
if ($failure) { [Console]::Error.WriteLine($failure); exit 1 }
Write-Output 'WORD_CLIPBOARD_READY'
`

let copying = false

export const copyDocxToClipboard = async(payload: DocxClipboardPayload): Promise<void> => {
  if (process.platform !== 'win32') throw new Error('Word clipboard conversion requires Windows and Microsoft Word.')
  if (!payload || typeof payload.content !== 'string' || !payload.content.trim()) {
    throw new Error('No content to copy to Word.')
  }
  if (copying) throw new Error('A Word copy is already in progress.')
  copying = true
  let directory: string | undefined
  try {
    directory = await mkdtemp(path.join(tmpdir(), 'marktext-word-copy-'))
    const filename = path.join(directory, 'selection.docx')
    await exportDocxFile(payload.content, filename, {
      docxEngine: payload.docxEngine,
      resourcePath: payload.pathname ? path.dirname(payload.pathname) : directory,
      title: payload.title,
      mathBlocks: payload.mathBlocks,
      docxFont: payload.docxFont
    })
    const { stdout } = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand',
      Buffer.from(COPY_WITH_WORD, 'utf16le').toString('base64')
    ], {
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, MARKTEXT_COPY_DOCX: filename }
    }).catch(async(error: Error & { stdout?: string; stderr?: string; killed?: boolean }) => {
      const ownedProcess = error.stdout?.match(/^WORD_PROCESS:(\d+):(\d+)\r?$/m)
      let cleanupFailed = false
      if (ownedProcess) {
        const [, pid, started] = ownedProcess
        try {
          await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `$ErrorActionPreference = 'Stop'; $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
            `if ($p -and $p.ProcessName -eq 'WINWORD' -and $p.StartTime.Ticks -eq ${started}) { $p.Kill(); [void]$p.WaitForExit(10000) }; exit 0`
          ], { windowsHide: true, timeout: 15000 })
        } catch {
          cleanupFailed = true
        }
      }
      const message = error.killed
        ? 'Microsoft Word took too long to prepare the clipboard. Try a smaller selection.'
        : error.stderr?.trim() || 'Could not copy with Microsoft Word. Check that Word is installed and activated.'
      throw new Error(message + (cleanupFailed ? ' The temporary Word process could not be closed.' : ''))
    })
    if (!stdout.includes('WORD_CLIPBOARD_READY')) throw new Error('Word did not finish copying the selection.')
  } finally {
    try {
      if (directory) await rm(directory, { recursive: true, force: true })
    } finally {
      copying = false
    }
  }
}
