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
    [DllImport("user32.dll", SetLastError=true)] public static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetClipboardData(uint uFormat);
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint RegisterClipboardFormat(string lpszFormat);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GlobalSize(IntPtr hMem);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GlobalLock(IntPtr hMem);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GlobalUnlock(IntPtr hMem);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GlobalFree(IntPtr hMem);
    public static byte[] GetRawClipboardData(uint format) {
        IntPtr h = GetClipboardData(format);
        if (h == IntPtr.Zero) return null;
        IntPtr p = GlobalLock(h);
        if (p == IntPtr.Zero) return null;
        try {
            uint size = GlobalSize(h);
            byte[] data = new byte[size];
            Marshal.Copy(p, data, 0, (int)size);
            return data;
        } finally { GlobalUnlock(h); }
    }
    public static bool SetRawClipboardData(uint format, byte[] data) {
        IntPtr h = GlobalAlloc(0x0002, (UIntPtr)data.Length);
        if (h == IntPtr.Zero) return false;
        IntPtr p = GlobalLock(h);
        if (p == IntPtr.Zero) { GlobalFree(h); return false; }
        try { Marshal.Copy(data, 0, p, data.Length); }
        finally { GlobalUnlock(h); }
        if (SetClipboardData(format, h) == IntPtr.Zero) { GlobalFree(h); return false; }
        return true;
    }
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
    # WinForms maps 'HTML Format' and 'Rich Text Format' through the system ANSI code
    # page; on a CJK system that corrupts Word's UTF-8 CF_HTML (a trailing CJK byte
    # pairs with the following '<' and both are lost, and the header offsets then point
    # past the shrunk buffer so Word refuses the paste). Carry those two formats as raw
    # bytes instead. UnicodeText is a native UTF-16 WinForms format and stays on the
    # DataObject snapshot.
    $source = [Windows.Forms.Clipboard]::GetDataObject()
    $htmlFormat = [WordClipboard]::RegisterClipboardFormat('HTML Format')
    $rtfFormat = [WordClipboard]::RegisterClipboardFormat('Rich Text Format')
    $rawHtml = $null
    $rawRtf = $null
    if (-not [WordClipboard]::OpenClipboard([IntPtr]::Zero)) { throw 'Could not open the clipboard.' }
    try {
        $rawHtml = [WordClipboard]::GetRawClipboardData($htmlFormat)
        $rawRtf = [WordClipboard]::GetRawClipboardData($rtfFormat)
    } finally { [void][WordClipboard]::CloseClipboard() }
    if ($null -eq $rawHtml) { throw 'Word did not provide HTML Format clipboard data.' }
    if ($null -eq $rawRtf) { throw 'Word did not provide Rich Text Format clipboard data.' }
    $unicodeText = $source.GetData('UnicodeText', $false)
    if ($null -eq $unicodeText) { throw 'Word did not provide UnicodeText clipboard data.' }
    $snapshot = New-Object Windows.Forms.DataObject
    $snapshot.SetData('UnicodeText', $false, $unicodeText)
    [Windows.Forms.Clipboard]::SetDataObject($snapshot, $true)
    if (-not [WordClipboard]::OpenClipboard([IntPtr]::Zero)) { throw 'Could not open the clipboard for writing.' }
    $rawWritten = $false
    try {
        $rawWritten = [WordClipboard]::SetRawClipboardData($htmlFormat, $rawHtml)
        if ($rawWritten) { $rawWritten = [WordClipboard]::SetRawClipboardData($rtfFormat, $rawRtf) }
    } finally { [void][WordClipboard]::CloseClipboard() }
    if (-not $rawWritten) { throw 'Could not write the Word clipboard formats.' }
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
