'use strict';
import { Strings } from '../system';
import { SpawnOptions } from 'child_process';
import { findGitPath, IGit } from './gitLocator';
import { Logger } from '../logger';
import { spawnPromise } from 'spawn-rx';
import * as fs from 'fs';
import * as path from 'path';
import * as tmp from 'tmp';
import * as iconv from 'iconv-lite';

export { IGit };
export * from './models/models';
export * from './parsers/blameParser';
export * from './parsers/branchParser';
export * from './parsers/diffParser';
export * from './parsers/logParser';
export * from './parsers/remoteParser';
export * from './parsers/stashParser';
export * from './parsers/statusParser';
export * from './remotes/provider';

let git: IGit;

const defaultBlameParams = [`blame`, `--root`, `--incremental`];
const defaultLogParams = [`log`, `--name-status`, `--full-history`, `-M`, `--format=%H -%nauthor %an%nauthor-date %at%nparents %P%nsummary %B%nfilename ?`];
const defaultStashParams = [`stash`, `list`, `--name-status`, `--full-history`, `-M`, `--format=%H -%nauthor-date %at%nreflog-selector %gd%nsummary %B%nfilename ?`];

let defaultEncoding = 'utf8';
export function setDefaultEncoding(encoding: string) {
    defaultEncoding = iconv.encodingExists(encoding) ? encoding : 'utf8';
}

const GitWarnings = [
    /Not a git repository/,
    /is outside repository/,
    /no such path/,
    /does not have any commits/,
    /Path \'.*?\' does not exist in/,
    /Path \'.*?\' exists on disk, but not in/,
    /no upstream configured for branch/
];

interface GitCommandOptions {
    cwd: string;
    env?: any;
    encoding?: string;
    overrideErrorHandling?: boolean;
}

async function gitCommand(options: GitCommandOptions, ...args: any[]): Promise<string> {
    if (options.overrideErrorHandling) return gitCommandCore(options, ...args);

    try {
        return await gitCommandCore(options, ...args);
    }
    catch (ex) {
        return gitCommandDefaultErrorHandler(ex, options, ...args);
    }
}

async function gitCommandCore(options: GitCommandOptions, ...args: any[]): Promise<string> {
    // Fixes https://github.com/eamodio/vscode-gitlens/issues/73 & https://github.com/eamodio/vscode-gitlens/issues/161
    // See https://stackoverflow.com/questions/4144417/how-to-handle-asian-characters-in-file-names-in-git-on-os-x
    args.splice(0, 0, '-c', 'core.quotepath=false', '-c', 'color.ui=false');

    Logger.log('git', ...args, `  cwd='${options.cwd}'`);

    const opts = { encoding: 'utf8', ...options };
    const s = await spawnPromise(git.path, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        encoding: (opts.encoding === 'utf8') ? 'utf8' : 'binary'
    } as SpawnOptions);

    if (opts.encoding === 'utf8' || opts.encoding === 'binary') return s;

    return iconv.decode(Buffer.from(s, 'binary'), opts.encoding);
}

function gitCommandDefaultErrorHandler(ex: Error, options: GitCommandOptions, ...args: any[]): string {
    const msg = ex && ex.toString();
    if (msg) {
        for (const warning of GitWarnings) {
            if (warning.test(msg)) {
                Logger.warn('git', ...args, `  cwd='${options.cwd}'`, msg && `\n  ${msg.replace(/\r?\n|\r/g, ' ')}`);
                return '';
            }
        }
    }

    Logger.error(ex, 'git', ...args, `  cwd='${options.cwd}'`, msg && `\n  ${msg.replace(/\r?\n|\r/g, ' ')}`);
    throw ex;
}

export class Git {

    static shaRegex = /^[0-9a-f]{40}(\^[0-9]*?)??( -)?$/;
    static uncommittedRegex = /^[0]{40}(\^[0-9]*?)??$/;

    static gitInfo(): IGit {
        return git;
    }

    static async getGitPath(gitPath?: string): Promise<IGit> {
        git = await findGitPath(gitPath);
        Logger.log(`Git found: ${git.version} @ ${git.path === 'git' ? 'PATH' : git.path}`);
        return git;
    }

    static async getRepoPath(cwd: string | undefined) {
        if (cwd === undefined) return '';

        const data = await gitCommand({ cwd }, 'rev-parse', '--show-toplevel');
        if (!data) return '';

        return data.replace(/\r?\n|\r/g, '').replace(/\\/g, '/');
    }

    static async getVersionedFile(repoPath: string | undefined, fileName: string, branchOrSha: string) {
        const data = await Git.show(repoPath, fileName, branchOrSha, 'binary');
        if (data === undefined) return undefined;

        const suffix = Strings.truncate(Strings.sanitizeForFS(Git.isSha(branchOrSha) ? Git.shortenSha(branchOrSha) : branchOrSha), 50, '');
        const ext = path.extname(fileName);
        return new Promise<string>((resolve, reject) => {
            tmp.file({ prefix: `${path.basename(fileName, ext)}-${suffix}__`, postfix: ext },
                (err, destination, fd, cleanupCallback) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    Logger.log(`getVersionedFile('${repoPath}', '${fileName}', ${branchOrSha}); destination=${destination}`);
                    fs.appendFile(destination, data, { encoding: 'binary' }, err => {
                        if (err) {
                            reject(err);
                            return;
                        }

                        resolve(destination);
                    });
                });
        });
    }

    static isSha(sha: string) {
        return Git.shaRegex.test(sha);
    }

    static isUncommitted(sha: string) {
        return Git.uncommittedRegex.test(sha);
    }

    static normalizePath(fileName: string, repoPath?: string) {
        return fileName && fileName.replace(/\\/g, '/');
    }

    static shortenSha(sha: string) {
        const index = sha.indexOf('^');
        // This is lame, but assume there is only 1 character after the ^
        if (index > 6) return `${sha.substring(0, 6)}${sha.substring(index)}`;
        return sha.substring(0, 8);
    }

    static splitPath(fileName: string, repoPath: string | undefined, extract: boolean = true): [string, string] {
        if (repoPath) {
            fileName = this.normalizePath(fileName);
            repoPath = this.normalizePath(repoPath);

            const normalizedRepoPath = (repoPath.endsWith('/') ? repoPath : `${repoPath}/`).toLowerCase();
            if (fileName.toLowerCase().startsWith(normalizedRepoPath)) {
                fileName = fileName.substring(normalizedRepoPath.length);
            }
        }
        else {
            repoPath = this.normalizePath(extract ? path.dirname(fileName) : repoPath!);
            fileName = this.normalizePath(extract ? path.basename(fileName) : fileName);
        }

        return [ fileName, repoPath ];
    }

    static validateVersion(major: number, minor: number): boolean {
        const [gitMajor, gitMinor] = git.version.split('.');
        return (parseInt(gitMajor, 10) >= major && parseInt(gitMinor, 10) >= minor);
    }

    // Git commands

    static blame(repoPath: string | undefined, fileName: string, sha?: string, options: { ignoreWhitespace?: boolean, startLine?: number, endLine?: number } = {}) {
        const [file, root] = Git.splitPath(fileName, repoPath);

        const params = [...defaultBlameParams];

        if (options.ignoreWhitespace) {
            params.push('-w');
        }
        if (options.startLine != null && options.endLine != null) {
            params.push(`-L ${options.startLine},${options.endLine}`);
        }
        if (sha) {
            params.push(sha);
        }

        return gitCommand({ cwd: root }, ...params, `--`, file);
    }

    static branch(repoPath: string, options: { all: boolean } = { all: false }) {
        const params = [`branch`, `-vv`];
        if (options.all) {
            params.push(`-a`);
        }

        return gitCommand({ cwd: repoPath }, ...params);
    }

    static async branch_current(repoPath: string) {
        const params = [`rev-parse`, `--abbrev-ref`, `--symbolic-full-name`, `@`, `@{u}`];

        const opts = { cwd: repoPath, overrideErrorHandling: true };
        try {
            return await gitCommand(opts, ...params);
        }
        catch (ex) {
            if (/no upstream configured for branch/.test(ex && ex.toString())) {
                return ex.message.split('\n')[0];
            }

            return gitCommandDefaultErrorHandler(ex, opts, ...params);
        }
    }

    static checkout(repoPath: string, fileName: string, sha: string) {
        const [file, root] = Git.splitPath(fileName, repoPath);

        return gitCommand({ cwd: root }, `checkout`, sha, `--`, file);
    }

    static async config_get(key: string, repoPath?: string) {
        try {
            return await gitCommand({ cwd: repoPath || '', overrideErrorHandling: true }, `config`, `--get`, key);
        }
        catch {
            return '';
        }
    }

    static diff(repoPath: string, fileName: string, sha1?: string, sha2?: string, encoding?: string) {
        const params = [`diff`, `--diff-filter=M`, `-M`, `--no-ext-diff`];
        if (sha1) {
            params.push(sha1);
        }
        if (sha2) {
            params.push(sha2);
        }

        return gitCommand({ cwd: repoPath, encoding: encoding || defaultEncoding }, ...params, '--', fileName);
    }

    static diff_nameStatus(repoPath: string, sha1?: string, sha2?: string) {
        const params = [`diff`, `--name-status`, `-M`, `--no-ext-diff`];
        if (sha1) {
            params.push(sha1);
        }
        if (sha2) {
            params.push(sha2);
        }

        return gitCommand({ cwd: repoPath }, ...params);
    }

    static diff_shortstat(repoPath: string, sha?: string) {
        const params = [`diff`, `--shortstat`, `--no-ext-diff`];
        if (sha) {
            params.push(sha);
        }
        return gitCommand({ cwd: repoPath }, ...params);
    }

    static difftool_dirDiff(repoPath: string, sha1: string, sha2?: string) {
        const params = [`difftool`, `--dir-diff`, sha1];
        if (sha2) {
            params.push(sha2);
        }

        return gitCommand({ cwd: repoPath }, ...params);
    }

    static difftool_fileDiff(repoPath: string, fileName: string, staged: boolean) {
        const params = [`difftool`, `--no-prompt`];
        if (staged) {
            params.push('--staged');
        }
        params.push('--');
        params.push(fileName);

        return gitCommand({ cwd: repoPath }, ...params);
    }

    static log(repoPath: string, sha?: string, maxCount?: number, reverse: boolean = false) {
        const params = [...defaultLogParams, `-m`];
        if (maxCount && !reverse) {
            params.push(`-n${maxCount}`);
        }
        if (sha) {
            if (reverse) {
                params.push(`--reverse`);
                params.push(`--ancestry-path`);
                params.push(`${sha}..HEAD`);
            }
            else {
                params.push(sha);
            }
        }
        return gitCommand({ cwd: repoPath }, ...params);
    }

    static log_file(repoPath: string, fileName: string, sha?: string, options: { maxCount?: number, reverse?: boolean, startLine?: number, endLine?: number, skipMerges?: boolean } = { reverse: false, skipMerges: false }) {
        const [file, root] = Git.splitPath(fileName, repoPath);

        const params = [...defaultLogParams, `--follow`];
        if (options.maxCount && !options.reverse) {
            params.push(`-n${options.maxCount}`);
        }

        // If we are looking for a specific sha don't exclude merge commits
        if (options.skipMerges || !sha || options.maxCount! > 2) {
            params.push(`--no-merges`);
        }
        else {
            params.push(`-m`);
        }

        if (sha) {
            if (options.reverse) {
                params.push(`--reverse`);
                params.push(`--ancestry-path`);
                params.push(`${sha}..HEAD`);
            }
            else {
                params.push(sha);
            }
        }

        if (options.startLine != null && options.endLine != null) {
            params.push(`-L ${options.startLine},${options.endLine}:${file}`);
        }

        params.push(`--`);
        params.push(file);

        return gitCommand({ cwd: root }, ...params);
    }

    static log_search(repoPath: string, search: string[] = [], maxCount?: number) {
        const params = [...defaultLogParams, `-m`, `-i`];
        if (maxCount) {
            params.push(`-n${maxCount}`);
        }

        return gitCommand({ cwd: repoPath }, ...params, ...search);
    }

    static log_shortstat(repoPath: string, sha?: string) {
        const params = [`log`, `--shortstat`, `--oneline`];
        if (sha) {
            params.push(sha);
        }
        return gitCommand({ cwd: repoPath }, ...params);
    }

    static async ls_files(repoPath: string, fileName: string): Promise<string> {
        try {
            return await gitCommand({ cwd: repoPath, overrideErrorHandling: true }, 'ls-files', fileName);
        }
        catch {
            return '';
        }
    }

    static remote(repoPath: string): Promise<string> {
        return gitCommand({ cwd: repoPath }, 'remote', '-v');
    }

    static remote_url(repoPath: string, remote: string): Promise<string> {
        return gitCommand({ cwd: repoPath }, 'remote', 'get-url', remote);
    }

    static async show(repoPath: string | undefined, fileName: string, branchOrSha: string, encoding?: string) {
        const [file, root] = Git.splitPath(fileName, repoPath);
        if (Git.isUncommitted(branchOrSha)) throw new Error(`sha=${branchOrSha} is uncommitted`);

        const opts = { cwd: root, encoding: encoding || defaultEncoding, overrideErrorHandling: true };
        const args = `${branchOrSha}:./${file}`;
        try {
            return await gitCommand(opts, 'show', args);
        }
        catch (ex) {
            const msg = ex && ex.toString();
            if (/Path \'.*?\' does not exist in/.test(msg) || /Path \'.*?\' exists on disk, but not in /.test(msg)) {
                return undefined;
            }

            return gitCommandDefaultErrorHandler(ex, opts, args);
        }
    }

    static stash_apply(repoPath: string, stashName: string, deleteAfter: boolean) {
        if (!stashName) return undefined;
        return gitCommand({ cwd: repoPath }, 'stash', deleteAfter ? 'pop' : 'apply', stashName);
    }

    static stash_delete(repoPath: string, stashName: string) {
        if (!stashName) return undefined;
        return gitCommand({ cwd: repoPath }, 'stash', 'drop', stashName);
    }

    static stash_list(repoPath: string) {
        return gitCommand({ cwd: repoPath }, ...defaultStashParams);
    }

    static stash_push(repoPath: string, pathspecs: string[], message?: string) {
        const params = [`stash`, `push`, `-u`];
        if (message) {
            params.push(`-m`);
            params.push(message);
        }
        params.splice(params.length, 0, `--`, ...pathspecs);
        return gitCommand({ cwd: repoPath }, ...params);
    }

    static stash_save(repoPath: string, message?: string) {
        const params = [`stash`, `save`, `-u`];
        if (message) {
            params.push(message);
        }
        return gitCommand({ cwd: repoPath }, ...params);
    }

    static status(repoPath: string, porcelainVersion: number = 1): Promise<string> {
        const porcelain = porcelainVersion >= 2 ? `--porcelain=v${porcelainVersion}` : '--porcelain';
        return gitCommand({ cwd: repoPath, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, 'status', porcelain, '--branch', '-u');
    }

    static status_file(repoPath: string, fileName: string, porcelainVersion: number = 1): Promise<string> {
        const [file, root] = Git.splitPath(fileName, repoPath);

        const porcelain = porcelainVersion >= 2 ? `--porcelain=v${porcelainVersion}` : '--porcelain';
        return gitCommand({ cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, 'status', porcelain, file);
    }
}