import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { delimiter, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '@deepseek-ai/dsh-commands';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import { renderSkillContent } from '@deepseek-ai/dsh-skill';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import z from '@deepseek-ai/schemastery';
export const name = 'obu-loader';
export const inject = ['commands', 'skills', 'tools'];
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_RECONNECT = Object.freeze({
    enabled: true,
    initialDelayMs: 500,
    maxDelayMs: 30_000,
    maxAttempts: 10,
});
export const Config = z.object({
    command: z.string().min(1),
    baseArgs: z.array(String).default(['mcp']),
    browser: z.string(),
    profile: z.string(),
    socketDir: z.string(),
    toolCallTimeoutMs: z.number().min(1).default(DEFAULT_TOOL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(true),
    reconnect: z.object({
        enabled: z.boolean().default(DEFAULT_RECONNECT.enabled),
        initialDelayMs: z.number().min(1).default(DEFAULT_RECONNECT.initialDelayMs),
        maxDelayMs: z.number().min(1).default(DEFAULT_RECONNECT.maxDelayMs),
        maxAttempts: z.number().step(1).min(1).default(DEFAULT_RECONNECT.maxAttempts),
    }).default(DEFAULT_RECONNECT),
    skillPath: z.string(),
});
const runtimeSkillProvider = 'dsh-obu-loader';
const bundledSkillPath = resolve(dirname(fileURLToPath(import.meta.url)), '../skills/open-browser-use/SKILL.md');
/**
 * Resolve the OBU executable without embedding a user-specific path.
 *
 * Windows npm shims are .cmd files, while the MCP stdio transport launches
 * with shell:false. Prefer the stable native-host executable installed by
 * `open-browser-use setup`, then the platform binary shipped by a global npm
 * installation. Non-Windows hosts can use the normal PATH command.
 */
export function resolveObuCommand(configured, env = process.env, fileExists = existsSync, runtimePlatform = platform(), runtimeArch = arch()) {
    if (configured?.trim())
        return configured.trim();
    if (runtimePlatform !== 'win32')
        return 'obu';
    const candidates = [];
    if (env.LOCALAPPDATA) {
        candidates.push(join(env.LOCALAPPDATA, 'OpenBrowserUse', 'native-host', 'open-browser-use.exe'));
    }
    const binaryArch = runtimeArch === 'arm64' ? 'windows-arm64' : 'windows-amd64';
    const prefixes = [
        env.npm_config_prefix,
        env.NPM_CONFIG_PREFIX,
        env.APPDATA ? join(env.APPDATA, 'npm') : undefined,
    ].filter((value) => Boolean(value));
    for (const prefix of new Set(prefixes)) {
        candidates.push(join(prefix, 'node_modules', 'open-browser-use', 'native', binaryArch, 'open-browser-use.exe'));
    }
    for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
        for (const executable of ['obu.exe', 'open-browser-use.exe']) {
            candidates.push(join(directory, executable));
        }
    }
    const found = candidates.find((candidate) => extname(candidate).toLowerCase() === '.exe' && fileExists(candidate));
    if (found)
        return found;
    throw new Error([
        'Open Browser Use executable not found.',
        'Install it with `npm install -g open-browser-use`, then run `open-browser-use setup`.',
        'Alternatively set `config.command` to the absolute path of open-browser-use.exe.',
    ].join(' '));
}
function shortHash(value, length = 8) {
    return createHash('sha256').update(value).digest('hex').slice(0, length);
}
function safeId(value, maxLength) {
    const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    return (normalized || 'session').slice(0, maxLength);
}
export function identityForAgent(agentId) {
    const hash = shortHash(agentId);
    const sessionPart = safeId(agentId, 48);
    const namespacePart = safeId(agentId, 16);
    const browserSessionId = `dsh-obu-${sessionPart}-${hash}`;
    const serverName = `obu_${namespacePart}_${hash}`.slice(0, 32);
    return {
        browserSessionId,
        serverName,
        toolPrefix: `mcp__${serverName}__`,
    };
}
export function buildMcpArgs(config, browserSessionId) {
    const args = [...config.baseArgs, '--session-id', browserSessionId];
    if (config.browser)
        args.push('--browser', config.browser);
    if (config.profile)
        args.push('--profile', config.profile);
    if (config.socketDir)
        args.push('--socket-dir', config.socketDir);
    return args;
}
function stripFrontmatter(markdown) {
    if (!markdown.startsWith('---'))
        return markdown.trim();
    const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(markdown);
    return (match ? markdown.slice(match[0].length) : markdown).trim();
}
export async function loadObuSkill(skillPath = bundledSkillPath) {
    const absolutePath = resolve(skillPath);
    const content = stripFrontmatter(await readFile(absolutePath, 'utf8'));
    return {
        name: 'open-browser-use',
        description: 'Operate the user’s real Chrome through the on-demand Open Browser Use MCP tools. Use only after /obu activates the current DSH session.',
        whenToUse: 'Use for real Chrome tabs, authenticated browser sessions, navigation, CDP, downloads, file choosers, or session cleanup after /obu has been enabled.',
        invocation: {
            modelInvocable: false,
            userInvocable: false,
        },
        source: 'runtime',
        provider: runtimeSkillProvider,
        resourceBase: {
            kind: 'directory',
            path: dirname(absolutePath),
        },
        path: absolutePath,
        content,
    };
}
function renderActivationInstructions(skill, state) {
    const integration = [
        '# DSH Open Browser Use activation',
        '',
        `Open Browser Use is active for this DSH session. Its MCP tool prefix is \`${state.toolPrefix}\`.`,
        `The browser session id is \`${state.browserSessionId}\`; the MCP server already applies it, so do not invent another session id.`,
        'Use the dynamically available tools whose names start with that prefix.',
        'Before opening a tab, call the prefixed `user_tabs` tool and reuse a clearly matching tab when possible.',
        'Finish browser work with the prefixed `finalize_tabs` tool exactly once, preserving only genuine deliverable or handoff tabs.',
        '',
    ].join('\n');
    return `${integration}${renderSkillContent({
        name: skill.name,
        provider: skill.provider ?? runtimeSkillProvider,
        resourceBase: skill.resourceBase,
        content: skill.content,
    })}`;
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
function visibleToolCount(ctx, agent, prefix) {
    return ctx.tools.schemas(scopeOf(agent.ctx)).filter((schema) => schema.name.startsWith(prefix)).length;
}
function selectorSummary(config) {
    const selectors = [];
    if (config.browser)
        selectors.push(`browser=${config.browser}`);
    if (config.profile)
        selectors.push(`profile=${config.profile}`);
    if (config.socketDir)
        selectors.push(`socketDir=${config.socketDir}`);
    return selectors.length ? selectors.join(', ') : 'OBU automatic target discovery';
}
async function finalizeBrowserSession(command, config, browserSessionId) {
    const args = ['finalize-tabs', '--session-id', browserSessionId];
    if (config.browser)
        args.push('--browser', config.browser);
    if (config.profile)
        args.push('--profile', config.profile);
    if (config.socketDir)
        args.push('--socket-dir', config.socketDir);
    args.push('--keep', '[]');
    await new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, {
            cwd: undefined,
            env: process.env,
            shell: false,
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
        });
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk) => {
            if (stderr.length < 4096)
                stderr += chunk;
        });
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0)
                resolvePromise();
            else
                reject(new Error(`OBU finalize-tabs exited with code ${code ?? 'unknown'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
        });
    });
}
export function createLoaderPlugin(dependencies = {
    mcpPlugin: McpClient,
    loadSkill: loadObuSkill,
}) {
    return {
        name,
        inject,
        Config: Config,
        apply(ctx, config) {
            const states = new WeakMap();
            const logger = ctx.logger(name);
            const stop = async (agent) => {
                const state = states.get(agent);
                if (!state)
                    return false;
                const wasActive = state.phase === 'active';
                state.phase = 'stopping';
                try {
                    if (wasActive) {
                        await finalizeBrowserSession(state.command, config, state.browserSessionId).catch((error) => {
                            logger.warn(`failed to finalize OBU browser session ${state.browserSessionId}: ${errorText(error)}`);
                        });
                    }
                    if (state.fiber)
                        await state.fiber.dispose();
                    else if (state.operation)
                        await state.operation.catch(() => undefined);
                }
                finally {
                    if (state.disposeAgentCleanup)
                        await Promise.resolve(state.disposeAgentCleanup()).catch(() => undefined);
                    states.delete(agent);
                }
                return true;
            };
            const start = async (agent) => {
                const existing = states.get(agent);
                if (existing) {
                    if (existing.operation)
                        await existing.operation;
                    if (existing.phase === 'active')
                        return existing;
                    if (existing.error)
                        throw existing.error;
                }
                const identity = identityForAgent(String(agent.id));
                const command = resolveObuCommand(config.command);
                const state = {
                    agent,
                    command,
                    ...identity,
                    phase: 'starting',
                };
                states.set(agent, state);
                state.disposeAgentCleanup = agent.ctx.effect(() => async () => {
                    if (state.phase !== 'active')
                        return;
                    await finalizeBrowserSession(state.command, config, state.browserSessionId).catch((error) => {
                        logger.warn(`failed to finalize disposed OBU browser session ${state.browserSessionId}: ${errorText(error)}`);
                    });
                    states.delete(agent);
                }, 'obu-loader.agent-cleanup');
                state.operation = (async () => {
                    let fiber;
                    try {
                        const skill = await dependencies.loadSkill(config.skillPath);
                        fiber = agent.ctx.plugin({
                            name: `obu-session-${state.serverName}`,
                            inject: ['skills', 'tools'],
                            async apply(sessionCtx) {
                                sessionCtx.skills.register(skill);
                                await sessionCtx.plugin(dependencies.mcpPlugin, {
                                    transport: 'stdio',
                                    serverName: state.serverName,
                                    command: state.command,
                                    args: buildMcpArgs(config, state.browserSessionId),
                                    env: {},
                                    cwd: '',
                                    toolCallTimeoutMs: config.toolCallTimeoutMs,
                                    failOnStartupError: config.failOnStartupError,
                                    reconnect: config.reconnect,
                                });
                            },
                        });
                        state.fiber = fiber;
                        await fiber;
                        state.phase = 'active';
                        agent.inject(createUserMessage({
                            content: [{ type: 'text', text: renderActivationInstructions(skill, state) }],
                            source: {
                                kind: 'skill-invocation',
                                name: 'open-browser-use',
                                form: 'instructions',
                            },
                        }));
                    }
                    catch (error) {
                        state.phase = 'failed';
                        state.error = error instanceof Error ? error : new Error(String(error));
                        if (fiber)
                            await fiber.dispose().catch(() => undefined);
                        if (state.disposeAgentCleanup)
                            await Promise.resolve(state.disposeAgentCleanup()).catch(() => undefined);
                        states.delete(agent);
                        throw state.error;
                    }
                    finally {
                        state.operation = undefined;
                    }
                })();
                await state.operation;
                return state;
            };
            ctx.commands.register({
                name: 'obu',
                description: 'enable, inspect, or disable Open Browser Use for this session',
                input: { hint: '[on|off|status]' },
                async handler(invocation) {
                    const action = invocation.rawInput.trim().toLowerCase() || 'on';
                    if (!['on', 'off', 'status'].includes(action)) {
                        return { kind: 'error', text: 'Usage: /obu [on|off|status]' };
                    }
                    if (action === 'off') {
                        const stopped = await stop(invocation.agent);
                        return {
                            kind: 'success',
                            text: stopped ? 'Open Browser Use disabled for this session.' : 'Open Browser Use is already disabled for this session.',
                        };
                    }
                    if (action === 'status') {
                        const state = states.get(invocation.agent);
                        if (!state)
                            return { kind: 'success', text: 'Open Browser Use is disabled for this session.' };
                        const count = state.phase === 'active' ? visibleToolCount(ctx, invocation.agent, state.toolPrefix) : 0;
                        return {
                            kind: state.phase === 'failed' ? 'error' : 'success',
                            text: [
                                `Open Browser Use: ${state.phase}`,
                                `Browser session: ${state.browserSessionId}`,
                                `Tool prefix: ${state.toolPrefix}`,
                                `Visible tools: ${count}`,
                                `Target: ${selectorSummary(config)}`,
                                ...(state.error ? [`Error: ${state.error.message}`] : []),
                            ].join('\n'),
                        };
                    }
                    try {
                        const state = await start(invocation.agent);
                        const count = visibleToolCount(ctx, invocation.agent, state.toolPrefix);
                        return {
                            kind: 'success',
                            text: [
                                'Open Browser Use enabled for this session.',
                                `Loaded ${count} MCP tools under ${state.toolPrefix}*.`,
                                'The Open Browser Use skill has been queued for the next model step.',
                                `Target: ${selectorSummary(config)}.`,
                                'Use /obu status to inspect or /obu off to unload it.',
                            ].join('\n'),
                        };
                    }
                    catch (error) {
                        logger.warn(`failed to activate OBU for agent ${invocation.agent.id}: ${errorText(error)}`);
                        return {
                            kind: 'error',
                            text: `Open Browser Use activation failed: ${errorText(error)}`,
                        };
                    }
                },
            });
        },
    };
}
const plugin = createLoaderPlugin();
export function apply(ctx, config) {
    plugin.apply(ctx, config);
}
//# sourceMappingURL=index.js.map