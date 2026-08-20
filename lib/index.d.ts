import type { Context, Plugin } from '@deepseek-ai/cordis';
import '@deepseek-ai/dsh-commands';
import { type SkillRegistration } from '@deepseek-ai/dsh-skill';
import z from '@deepseek-ai/schemastery';
export declare const name = "obu-loader";
export declare const inject: string[];
export interface Config {
    command?: string;
    baseArgs: string[];
    browser?: string;
    profile?: string;
    socketDir?: string;
    toolCallTimeoutMs: number;
    failOnStartupError: boolean;
    reconnect: {
        enabled: boolean;
        initialDelayMs: number;
        maxDelayMs: number;
        maxAttempts: number;
    };
    skillPath?: string;
}
export declare const Config: z<Schemastery.ObjectS<{
    command: z<string, string>;
    baseArgs: z<string[], string[]>;
    browser: z<string, string>;
    profile: z<string, string>;
    socketDir: z<string, string>;
    toolCallTimeoutMs: z<number, number>;
    failOnStartupError: z<boolean, boolean>;
    reconnect: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        initialDelayMs: z<number, number>;
        maxDelayMs: z<number, number>;
        maxAttempts: z<number, number>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        initialDelayMs: z<number, number>;
        maxDelayMs: z<number, number>;
        maxAttempts: z<number, number>;
    }>>;
    skillPath: z<string, string>;
}>, Schemastery.ObjectT<{
    command: z<string, string>;
    baseArgs: z<string[], string[]>;
    browser: z<string, string>;
    profile: z<string, string>;
    socketDir: z<string, string>;
    toolCallTimeoutMs: z<number, number>;
    failOnStartupError: z<boolean, boolean>;
    reconnect: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        initialDelayMs: z<number, number>;
        maxDelayMs: z<number, number>;
        maxAttempts: z<number, number>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        initialDelayMs: z<number, number>;
        maxDelayMs: z<number, number>;
        maxAttempts: z<number, number>;
    }>>;
    skillPath: z<string, string>;
}>>;
interface LoaderDependencies {
    readonly mcpPlugin: Plugin;
    readonly loadSkill: (skillPath?: string) => Promise<SkillRegistration>;
}
/**
 * Resolve the OBU executable without embedding a user-specific path.
 *
 * Windows npm shims are .cmd files, while the MCP stdio transport launches
 * with shell:false. Prefer the stable native-host executable installed by
 * `open-browser-use setup`, then the platform binary shipped by a global npm
 * installation. Non-Windows hosts can use the normal PATH command.
 */
export declare function resolveObuCommand(configured?: string, env?: NodeJS.ProcessEnv, fileExists?: (path: string) => boolean, runtimePlatform?: NodeJS.Platform, runtimeArch?: NodeJS.Architecture): string;
export declare function identityForAgent(agentId: string): {
    browserSessionId: string;
    serverName: string;
    toolPrefix: string;
};
export declare function buildMcpArgs(config: Config, browserSessionId: string): string[];
export declare function loadObuSkill(skillPath?: string): Promise<SkillRegistration>;
export declare function createLoaderPlugin(dependencies?: LoaderDependencies): Plugin.Object<Config>;
export declare function apply(ctx: Context, config: Config): void;
export {};
