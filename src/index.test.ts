import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildMcpArgs,
  createLoaderPlugin,
  finalizeBrowserSession,
  identityForAgent,
  loadObuSkill,
  resolveObuCommand,
  type Config,
} from './index.js'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const baseConfig: Config = {
  command: 'obu',
  baseArgs: ['mcp'],
  toolCallTimeoutMs: 60_000,
  finalizeTimeoutMs: 15_000,
  failOnStartupError: true,
  reconnect: {
    enabled: true,
    initialDelayMs: 500,
    maxDelayMs: 30_000,
    maxAttempts: 10,
  },
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function lifecycleHarness() {
  let commandHandler: ((invocation: any) => Promise<any>) | undefined
  const warnings: string[] = []
  const rootCtx = {
    commands: { register: vi.fn((command: any) => { commandHandler = command.handler }) },
    logger: () => ({ warn: (message: string) => warnings.push(message) }),
    tools: { schemas: () => [] },
  }
  const fiberReady = deferred<void>()
  let cleanup: (() => Promise<void>) | undefined
  let pluginCalls = 0
  let disposeCalls = 0
  const fiber = Object.assign(fiberReady.promise, {
    dispose: vi.fn(async () => { disposeCalls += 1 }),
  })
  const agent = {
    id: 'agent-1',
    inject: vi.fn(),
    ctx: {
      plugin: vi.fn(() => {
        pluginCalls += 1
        return fiber
      }),
      effect: vi.fn((factory: () => () => Promise<void>) => {
        cleanup = factory()
        return async () => undefined
      }),
    },
  }
  const finalize = vi.fn(async () => undefined)
  const plugin = createLoaderPlugin({
    mcpPlugin: {} as any,
    loadSkill: async () => ({
      name: 'open-browser-use',
      description: 'test',
      invocation: { modelInvocable: false, userInvocable: false },
      source: 'runtime',
      provider: 'test',
      content: 'test skill',
    }),
    finalizeBrowserSession: finalize,
  })
  plugin.apply(rootCtx as any, { ...baseConfig, command: 'C:/obu.exe', finalizeTimeoutMs: 50 })
  const invoke = (action: string) => commandHandler!({ rawInput: action, agent })
  return {
    agent,
    cleanup: () => cleanup!(),
    fiberReady,
    finalize,
    invoke,
    pluginCalls: () => pluginCalls,
    disposeCalls: () => disposeCalls,
    warnings,
  }
}

describe('resolveObuCommand', () => {
  it('keeps an explicit command override', () => {
    expect(resolveObuCommand('C:/Tools/open-browser-use.exe', {})).toBe('C:/Tools/open-browser-use.exe')
  })

  it('finds the standard Windows native-host installation', () => {
    const command = resolveObuCommand(
      undefined,
      { LOCALAPPDATA: 'C:/Users/Alice/AppData/Local', APPDATA: 'C:/Users/Alice/AppData/Roaming' },
      path => path === 'C:\\Users\\Alice\\AppData\\Local\\OpenBrowserUse\\native-host\\open-browser-use.exe',
      'win32',
      'x64',
    )
    expect(command).toBe('C:\\Users\\Alice\\AppData\\Local\\OpenBrowserUse\\native-host\\open-browser-use.exe')
  })

  it('falls back to the native binary shipped by the global npm package', () => {
    const command = resolveObuCommand(
      undefined,
      { APPDATA: 'C:/Users/Alice/AppData/Roaming' },
      path => path.endsWith('open-browser-use\\native\\windows-arm64\\open-browser-use.exe'),
      'win32',
      'arm64',
    )
    expect(command).toContain('windows-arm64')
  })

  it('discovers a custom npm prefix', () => {
    const command = resolveObuCommand(
      undefined,
      { npm_config_prefix: 'C:/Tools/npm-global' },
      path => path.includes('C:\\Tools\\npm-global') && path.endsWith('open-browser-use.exe'),
      'win32',
      'x64',
    )
    expect(command).toContain('npm-global')
  })

  it('uses the PATH command on non-Windows hosts', () => {
    expect(resolveObuCommand(undefined, {}, () => false, 'linux', 'x64')).toBe('obu')
  })
})

describe('identityForAgent', () => {
  it('creates stable, valid and isolated MCP identities', () => {
    const first = identityForAgent('session-1234/中文')
    const again = identityForAgent('session-1234/中文')
    const second = identityForAgent('session-5678/中文')

    expect(first).toEqual(again)
    expect(first).not.toEqual(second)
    expect(first.serverName).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
    expect(first.toolPrefix).toBe(`mcp__${first.serverName}__`)
    expect(first.browserSessionId).toMatch(/^dsh-obu-/)
  })
})

describe('buildMcpArgs', () => {
  it('uses automatic target discovery by default', () => {
    expect(buildMcpArgs(baseConfig, 'dsh-obu-test')).toEqual(['mcp', '--session-id', 'dsh-obu-test'])
  })

  it('locks configured browser, profile, and socket directory at startup', () => {
    expect(buildMcpArgs({
      ...baseConfig,
      browser: 'chrome',
      profile: 'Default',
      socketDir: 'C:/Temp/open-browser-use',
    }, 'dsh-obu-test')).toEqual([
      'mcp', '--session-id', 'dsh-obu-test', '--browser', 'chrome', '--profile', 'Default',
      '--socket-dir', 'C:/Temp/open-browser-use',
    ])
  })
})

describe('loadObuSkill', () => {
  it('loads the bundled skill without YAML frontmatter and keeps a resource base', async () => {
    const skill = await loadObuSkill()
    expect(skill.name).toBe('open-browser-use')
    expect(skill.content).toContain('# Open Browser Use')
    expect(skill.content).not.toMatch(/^---/)
    expect(skill.resourceBase).toMatchObject({ kind: 'directory' })
    expect(skill.invocation).toEqual({ modelInvocable: false, userInvocable: false })
  })

  it('supports a development skill override and cleans its temporary directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-obu-loader-'))
    tempDirectories.push(root)
    const path = join(root, 'SKILL.md')
    await writeFile(path, '---\nname: open-browser-use\ndescription: test\n---\n\n# Test Skill\n', 'utf8')
    const skill = await loadObuSkill(path)
    expect(skill.content).toBe('# Test Skill')
    expect(skill.path).toBe(path)
  })
})

describe('per-Agent lifecycle', () => {
  it('serializes concurrent starts and creates only one fiber', async () => {
    const harness = lifecycleHarness()
    const first = harness.invoke('on')
    const second = harness.invoke('on')
    await vi.waitFor(() => expect(harness.pluginCalls()).toBe(1))
    harness.fiberReady.resolve()

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ kind: 'success' }),
      expect.objectContaining({ kind: 'success' }),
    ])
    expect(harness.pluginCalls()).toBe(1)
    expect(harness.agent.inject).toHaveBeenCalledTimes(1)
  })

  it('cancels a starting Agent and shares teardown without leaking the fiber', async () => {
    const harness = lifecycleHarness()
    const starting = harness.invoke('on')
    await vi.waitFor(() => expect(harness.pluginCalls()).toBe(1))

    const stopped = harness.invoke('off')
    const disposed = harness.cleanup()
    harness.fiberReady.resolve()

    await expect(stopped).resolves.toMatchObject({ kind: 'success' })
    await expect(disposed).resolves.toBeUndefined()
    await expect(starting).resolves.toMatchObject({ kind: 'error' })
    expect(harness.disposeCalls()).toBe(1)
    expect(harness.finalize).not.toHaveBeenCalled()
    expect(harness.agent.inject).not.toHaveBeenCalled()
    await expect(harness.invoke('status')).resolves.toMatchObject({ text: expect.stringContaining('disabled') })
  })

  it('disposes the fiber even when finalize fails', async () => {
    const harness = lifecycleHarness()
    harness.finalize.mockRejectedValueOnce(new Error('finalize failed'))
    const starting = harness.invoke('on')
    await vi.waitFor(() => expect(harness.pluginCalls()).toBe(1))
    harness.fiberReady.resolve()
    await starting

    await expect(harness.invoke('off')).resolves.toMatchObject({ kind: 'success' })
    expect(harness.finalize).toHaveBeenCalledTimes(1)
    expect(harness.disposeCalls()).toBe(1)
    expect(harness.warnings).toEqual([expect.stringContaining('finalize failed')])
  })
})

describe('finalizeBrowserSession', () => {
  it('uses the DSH subprocess seam with an explicit minimal environment', async () => {
    const spawn = vi.fn(() => ({
      pid: 1,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: { stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: vi.fn(),
      waitForExit: vi.fn(async () => true),
    }))

    await finalizeBrowserSession({ subprocess: { spawn } } as any, 'C:/obu.exe', baseConfig, 'session-1')

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      argv: ['C:/obu.exe', 'finalize-tabs', '--session-id', 'session-1', '--keep', '[]'],
      env: {},
      graceMs: 2_000,
    }))
  })

  it('times out and invokes process-tree termination fallback', async () => {
    const done = deferred<{ exitCode: number | null, signal: NodeJS.Signals | null }>()
    const terminate = vi.fn(() => done.resolve({ exitCode: null, signal: 'SIGTERM' }))
    const waitForExit = vi.fn(async () => true)
    const spawn = vi.fn(() => {
      return {
        pid: 1,
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        collected: { stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
        done: done.promise,
        terminate,
        waitForExit,
      }
    })

    await expect(finalizeBrowserSession(
      { subprocess: { spawn } } as any,
      'C:/obu.exe',
      { ...baseConfig, finalizeTimeoutMs: 5 },
      'session-1',
    )).rejects.toThrow('timed out')
    expect(terminate).toHaveBeenCalled()
    expect(waitForExit).toHaveBeenCalled()
  })
})
