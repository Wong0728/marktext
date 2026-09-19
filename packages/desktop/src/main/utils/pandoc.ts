// Copy from https://github.com/utatti/simple-pandoc/blob/master/index.js
import { spawn } from 'child_process'
import type { Readable } from 'stream'
import commandExists from 'command-exists'
import { isFile2 } from 'common/filesystem'

const pandocCommand = 'pandoc'

// Default install locations for the official pandoc Windows installer. Used as
// a fallback when command-exists / PATH lookup fails in a GUI-launched process.
const WINDOWS_PANDOC_PATHS = [
  'C:\\Program Files\\Pandoc\\pandoc.exe',
  'C:\\Program Files (x86)\\Pandoc\\pandoc.exe'
]

const findPandoc = (): string | null => {
  if (envPathExists()) {
    return process.env.MARKTEXT_PANDOC as string
  }

  if (commandExists.sync(pandocCommand)) {
    return pandocCommand
  }

  if (process.platform === 'win32') {
    for (const candidate of WINDOWS_PANDOC_PATHS) {
      if (isFile2(candidate)) {
        return candidate
      }
    }
  }

  return null
}

const getCommand = (): string => {
  return findPandoc() ?? pandocCommand
}

interface PandocConverter {
  (): Promise<string>
  stream: (srcStream: NodeJS.ReadableStream) => Readable | null
  toFile: (input: string, outputPath: string) => Promise<void>
}

interface PandocFn {
  (from: string, to: string, ...args: string[]): PandocConverter
  exists: () => boolean
}

const pandoc = ((from: string, to: string, ...args: string[]): PandocConverter => {
  const command = getCommand()
  const option = ['-f', from, '-t', to].concat(args)

  const converter = ((): Promise<string> =>
    new Promise((resolve, reject) => {
      const proc = spawn(command, option)
      let data = ''
      let stderrData = ''
      let exited = false
      proc.stdout.on('data', (chunk: Buffer | string) => {
        data += chunk.toString()
      })
      proc.stderr.on('data', (chunk: Buffer | string) => {
        stderrData += chunk.toString()
      })
      const fail = (err: Error): void => {
        if (exited) return
        exited = true
        proc.kill()
        if (stderrData) {
          err.message += `\n${stderrData.trim()}`
        }
        reject(err)
      }
      proc.on('error', fail)
      proc.on('close', (code: number) => {
        if (exited) return
        exited = true
        if (code !== 0) {
          reject(new Error(`pandoc exited with code ${code}${stderrData ? ': ' + stderrData.trim() : ''}`))
        } else {
          resolve(data)
        }
      })
      proc.stdin.on('error', fail)
      proc.stdin.end()
    })) as PandocConverter

  converter.stream = (srcStream: NodeJS.ReadableStream): Readable | null => {
    const proc = spawn(command, option)
    proc.on('error', (err) => {
      proc.stdout.destroy(err)
    })
    proc.stderr.on('data', (chunk: Buffer | string) => {
      // eslint-disable-next-line no-console
      console.warn('[pandoc]', chunk.toString().trim())
    })
    srcStream.on('error', (err) => {
      proc.kill()
      proc.stdout.destroy(err)
    })
    proc.stdin.on('error', () => {
      proc.kill()
    })
    srcStream.pipe(proc.stdin)
    return proc.stdout
  }

  // Convert `input` (markdown/HTML/etc.) and write the (possibly binary)
  // result directly to `outputPath`. Used for DOCX/EPUB/PDF output where the
  // result is not valid UTF-8 text and cannot be collected as a string.
  //
  // Pandoc refuses to write binary formats (e.g. docx) to stdout unless forced
  // with `-o -`, so we pass the output file explicitly. This also avoids an
  // extra pipe through the Node process.
  converter.toFile = (input: string, outputPath: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const proc = spawn(command, option.concat('-o', outputPath), { stdio: ['pipe', 'pipe', 'pipe'] })
      let stderrData = ''
      let exited = false
      proc.stderr.on('data', (chunk: Buffer | string) => {
        stderrData += chunk.toString()
      })
      const finish = (err?: Error): void => {
        if (exited) return
        exited = true
        if (err) {
          proc.kill()
          reject(err)
        } else if (stderrData) {
          // Non-fatal: pandoc prints warnings to stderr even on success.
          // eslint-disable-next-line no-console
          console.warn('[pandoc]', stderrData.trim())
          resolve()
        } else {
          resolve()
        }
      }
      proc.on('error', finish)
      proc.on('close', (code: number) => {
        if (code !== 0) {
          finish(new Error(`pandoc exited with code ${code}: ${stderrData.trim()}`))
        } else {
          finish()
        }
      })
      proc.stdin.on('error', finish)
      proc.stdin.end(input)
    })

  return converter
}) as PandocFn

pandoc.exists = (): boolean => {
  return findPandoc() !== null
}

const envPathExists = (): boolean => {
  return !!process.env.MARKTEXT_PANDOC && isFile2(process.env.MARKTEXT_PANDOC)
}

export default pandoc
