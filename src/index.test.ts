import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildMcpArgs, identityForAgent, loadObuSkill, resolveObuCommand, type Config } from './index.js'

const baseConfig: Config = {
  command: 'obu',
  baseArgs: ['mcp'],
  toolCallTimeoutMs: 60_000,
  failOnStartupError: true,
  reconnect: {
    enabled: true,
    initialDelayMs: 500,
    maxDelayMs: 30_000,
    maxAttempts: 10,
  },
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
    expect(buildMcpArgs(baseConfig, 'dsh-obu-test')).toEqual([
      'mcp',
      '--session-id',
      'dsh-obu-test',
    ])
  })

  it('locks configured browser, profile, and socket directory at startup', () => {
    expect(buildMcpArgs({
      ...baseConfig,
      browser: 'chrome',
      profile: 'Default',
      socketDir: 'C:/Temp/open-browser-use',
    }, 'dsh-obu-test')).toEqual([
      'mcp',
      '--session-id',
      'dsh-obu-test',
      '--browser',
      'chrome',
      '--profile',
      'Default',
      '--socket-dir',
      'C:/Temp/open-browser-use',
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

  it('supports a development skill override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-obu-loader-'))
    const path = join(root, 'SKILL.md')
    await writeFile(path, '---\nname: open-browser-use\ndescription: test\n---\n\n# Test Skill\n', 'utf8')
    const skill = await loadObuSkill(path)
    expect(skill.content).toBe('# Test Skill')
    expect(skill.path).toBe(path)
  })
})
