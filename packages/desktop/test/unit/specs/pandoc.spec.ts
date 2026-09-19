import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pandoc binary output (e.g. docx) cannot be written to stdout unless forced
// with `-o -`. `toFile` must pass the output file explicitly so pandoc writes
// directly to disk.

const spawnMocks: {
  stdout: { on: ReturnType<typeof vi.fn>; pipe: ReturnType<typeof vi.fn> }
  stderr: { on: ReturnType<typeof vi.fn> }
  stdin: { on: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
  on: ReturnType<typeof vi.fn>
}[] = []

const mockSpawn = vi.hoisted(() =>
  vi.fn((command: string, args: string[]) => {
    const mock = {
      stdout: {
        on: vi.fn(),
        pipe: vi.fn()
      },
      stderr: {
        on: vi.fn()
      },
      stdin: {
        on: vi.fn(),
        end: vi.fn()
      },
      on: vi.fn()
    }
    spawnMocks.push(mock)

    // Simulate successful exit on the next tick.
    setTimeout(() => {
      const closeHandler = mock.on.mock.calls.find((call: unknown[]) => call[0] === 'close')?.[1]
      if (closeHandler) closeHandler(0)
    }, 0)

    return mock
  })
)

vi.mock('child_process', () => ({
  default: { spawn: mockSpawn }
}))

vi.mock('command-exists', () => ({ default: { sync: vi.fn(() => false) } }))
vi.mock('common/filesystem', () => ({ isFile2: vi.fn(() => true) }))

const { default: pandoc } = await import('main_renderer/utils/pandoc')

describe('pandoc', () => {
  beforeEach(() => {
    spawnMocks.length = 0
    mockSpawn.mockClear()
    process.env.MARKTEXT_PANDOC = '/fake/pandoc'
  })

  it('passes -o <outputPath> when writing binary output via toFile', async() => {
    const converter = pandoc('html', 'docx', '--wrap=none', '--resource-path=/tmp')
    await converter.toFile('<p>hello</p>', '/out/export.docx')

    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]]
    expect(args).toEqual([
      '-f', 'html',
      '-t', 'docx',
      '--wrap=none',
      '--resource-path=/tmp',
      '-o', '/out/export.docx'
    ])
  })

  it('pipes the input to stdin when using toFile', async() => {
    const converter = pandoc('html', 'docx')
    const input = '<h1>title</h1>'
    await converter.toFile(input, '/out/export.docx')

    const mock = spawnMocks[0]
    expect(mock.stdin.end).toHaveBeenCalledWith(input)
  })
})
