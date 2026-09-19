import path from 'path'

// GUI-launched apps on macOS/Linux don't inherit the user's login-shell PATH,
// so Homebrew (/opt/homebrew/bin, /usr/local/bin) and standard bin dirs are
// absent and CLI tools like pandoc can't be found (#2751). These mirror the
// picgo uploader's PATH handling (ipc/uploader.ts).
//
// On Windows the NSIS/MSI installer defaults to C:\Program Files\Pandoc and
// some users only add that directory to their user PATH. Adding it here makes
// pandoc discoverable even when the GUI-launched Electron process inherits a
// stale or truncated PATH.
const EXTRA_PATH_DIRS: Record<string, string[]> = {
  darwin: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/Library/TeX/texbin'],
  linux: ['/usr/local/bin', '/usr/bin', '/bin'],
  win32: [
    'C:\\Program Files\\Pandoc',
    'C:\\Program Files (x86)\\Pandoc'
  ]
}

export const patchEnvPath = (): void => {
  const extras = EXTRA_PATH_DIRS[process.platform]
  if (!extras) return

  const current = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of extras) {
    if (!current.includes(dir)) current.push(dir)
  }
  process.env.PATH = current.join(path.delimiter)
}
