/**
 * Genspark CLI (`gsk`) runner — uses only the launch protocol confirmed by measurement.
 *
 * Measurement basis (docs/00-genspark-cli-spec-review.md 9.1–9.4):
 *   - The shim (gsk.cmd) yields EINVAL when spawned from Node. Launch `node <dist/index.js>` directly.
 *   - Under the Windows sandbox, `stdio: 'pipe'` yields EPERM. Redirecting stdout/stderr to
 *     temp-file fds works (measured: stdout/stderr were captured correctly and separately).
 *   - stdin is 'ignore'. Confirmation prompts fall back to EOF → refusal (no server call).
 *   - Inject GSK_NO_AUTO_UPDATE=1. Executions that attempt auto-update end with exit code 0xC0000409,
 *     which cannot be used for success determination, so CLI self-update is decoupled from DSH.
 *   - Arguments are passed via `--args-file <JSON file>` (bypassing shell quoting entirely).
 *
 * Success is determined mainly by whether stdout can be interpreted as a JSON envelope, not by the exit code.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isEnvelope, parseEnvelope } from './result.js';

/**
 * Resolve the directory for temporary files **always as an absolute path**.
 *
 * Important: the default value of the `tmpDir` setting is an empty string, and `'' ?? tmpdir()` returns `''`
 * (the nullish coalescing operator treats an empty string as "present"). As a result
 * `join('', 'dsh-genspark-args-')` becomes a relative path; mkdtemp resolves it against the parent process's cwd,
 * while the child process's cwd is the session working directory — this mismatch makes `--args-file` hit ENOENT
 * (a defect that occurred on a real DSH machine). Normalize to an absolute path to remove the cwd dependence.
 */
export function resolveTmpRoot(value, { fsTmpDir = tmpdir() } = {}) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw.length > 0 ? resolve(raw) : fsTmpDir;
}

/** Enumerate realistic candidates for the global installation location of @genspark/cli. */
export function cliEntryCandidates({ env = process.env, execPath = process.execPath } = {}) {
  const tail = ['node_modules', '@genspark', 'cli', 'dist', 'index.js'];
  const list = [];
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0) list.push(value);
  };

  push(env.GSK_CLI_ENTRY);
  push(env.GSK_CLI_PATH);
  if (env.APPDATA) push(join(env.APPDATA, 'npm', ...tail)); // Windows: npm default global location
  if (env.LOCALAPPDATA) push(join(env.LOCALAPPDATA, 'npm', ...tail));
  if (env.npm_config_prefix) push(join(env.npm_config_prefix, ...tail));
  if (env.NVM_BIN) push(join(env.NVM_BIN, '..', 'lib', ...tail));
  const nodeDir = dirname(execPath);
  push(join(nodeDir, ...tail));
  push(join(nodeDir, '..', 'lib', ...tail));
  push(join('/usr/local/lib', ...tail));
  push(join('/usr/lib', ...tail));

  return [...new Set(list)];
}

/** Resolve one existing CLI entry. Returns null if none is found. */
export function resolveCliEntry(options = {}) {
  const { cliEntry, fsExists = existsSync, ...rest } = options;
  const candidates = [];
  if (typeof cliEntry === 'string' && cliEntry.length > 0) candidates.push(cliEntry);
  candidates.push(...cliEntryCandidates(rest));
  for (const candidate of candidates) {
    if (fsExists(candidate)) return candidate;
  }
  return null;
}

export const ENTRY_NOT_FOUND_MESSAGE =
  'The @genspark/cli entry was not found. Run `npm install -g @genspark/cli`, or ' +
  'specify the absolute path to dist/index.js in the plugin setting cliEntry.';

/**
 * Enumerate candidates for a real Node executable in priority order (Electron executables are excluded).
 * Because DSH runs on Electron, using `process.execPath` as is for the child process runtime makes
 * commander see `process.versions.electron` and switch to Electron-style argv interpretation;
 * when `process.defaultApp` is unset (launched with ELECTRON_RUN_AS_NODE), it treats `argv.slice(1)` as
 * user arguments and fails with `error: unknown command '<dist/index.js>'` (measured).
 * Commander-side branching: node_modules/commander/lib/command.js:981-983, 1010-1018.
 */
export function nodeRuntimeCandidates({ env = process.env, platform = process.platform } = {}) {
  const list = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim().length > 0) list.push(value.trim());
  };

  push(env.DSH_NODE_PATH);
  push(env.NODE_BINARY);
  push(env.NODE_EXE);

  const exeName = platform === 'win32' ? 'node.exe' : 'node';
  const pathValue = env.PATH ?? env.Path ?? '';
  for (const dir of String(pathValue).split(platform === 'win32' ? ';' : ':')) {
    if (dir.length > 0) push(join(dir, exeName));
  }

  if (platform === 'win32') {
    push(join(env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', exeName));
    push(join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'nodejs', exeName));
    if (env.LOCALAPPDATA) push(join(env.LOCALAPPDATA, 'Programs', 'nodejs', exeName));
    if (env.ProgramData) push(join(env.ProgramData, 'chocolatey', 'bin', exeName));
    if (env.USERPROFILE) push(join(env.USERPROFILE, 'scoop', 'shims', exeName));
    if (env.APPDATA) {
      push(join(env.APPDATA, 'nvm', exeName));
      push(join(env.APPDATA, 'npm', exeName));
    }
  } else {
    push('/usr/local/bin/node');
    push('/usr/bin/node');
    push('/opt/homebrew/bin/node');
    push('/snap/bin/node');
  }

  return [...new Set(list)];
}

/**
 * Determine the runtime for the child process.
 * @returns {{path: string, source: string, isElectron: boolean, exists: boolean}}
 *   source: `config.nodePath` / `process.execPath` / `auto` / `electron-fallback`
 */
export function resolveNodeRuntime({
  config = {},
  env = process.env,
  fsExists = existsSync,
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  const explicit = String(config.nodePath ?? '').trim();
  if (explicit.length > 0) {
    return { path: explicit, source: 'config.nodePath', isElectron: false, exists: fsExists(explicit) };
  }

  // If running on a real Node, that is enough (the Electron detection is a commander concern).
  if (!process.versions?.electron) {
    return { path: execPath, source: 'process.execPath', isElectron: false, exists: true };
  }

  for (const candidate of nodeRuntimeCandidates({ env, platform })) {
    if (fsExists(candidate)) {
      return { path: candidate, source: 'auto', isElectron: false, exists: true };
    }
  }

  // Last resort. Even when launched with ELECTRON_RUN_AS_NODE=1, commander's
  // Electron detection remains, so some commands such as `me` fail (warned in status).
  return { path: execPath, source: 'electron-fallback', isElectron: true, exists: true };
}

/**
 * Summary of an execution result.
 * @typedef {object} GskRunResult
 * @property {number|null} code      Exit code (may be unreliable; see ok below)
 * @property {boolean} ok            Whether stdout could be read as an envelope with status:"ok"
 * @property {object|undefined} envelope Parsed envelope
 * @property {unknown} data          envelope.data
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 * @property {boolean} aborted
 * @property {string[]} args         The argv actually passed
 */

/**
 * Create a runner. `getConfig()` is called every time (to follow hot changes to settings).
 */
export function createRunner({ getConfig, env = process.env } = {}) {
  /**
   * Run gsk once.
   * @param {string[]} argv            Arguments to pass to the CLI (from the tool name onward)
   * @param {object} [options]
   * @param {string} [options.cwd]     Working directory (for resolving relative local file paths)
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.timeoutMs]
   * @param {string} [options.tmpRoot]
   * @param {Record<string, string>} [options.extraEnv]
   * @returns {Promise<GskRunResult>}
   */
  async function run(argv, options = {}) {
    const config = (typeof getConfig === 'function' ? getConfig() : getConfig) ?? {};
    const entry = resolveCliEntry({
      cliEntry: config.cliEntry,
      env,
      execPath: process.execPath,
    });
    if (entry === null) {
      const error = new Error(ENTRY_NOT_FOUND_MESSAGE);
      error.code = 'GSK_ENTRY_NOT_FOUND';
      throw error;
    }

    const timeoutMs = Number(options.timeoutMs ?? config.timeoutMs ?? 600000);
    const tmpRoot = resolveTmpRoot(options.tmpRoot ?? config.tmpDir);
    const signal = options.signal;
    const args = [entry, ...argv];
    // Execution runtime. Because DSH runs on Electron, `process.execPath` is the Electron binary
    // ("DeepSeek Harness.exe"), and launching it as is triggers commander's Electron detection and
    // yields `error: unknown command '<...>/dist/index.js'` (measured). Find and use a real Node.
    const runtime = options.runtimePath
      ? { path: options.runtimePath, source: 'options.runtimePath', isElectron: false, exists: true }
      : resolveNodeRuntime({ config, env });
    // When using an Electron executable as the runtime, always add
    // RUN_AS_NODE so the GUI does not start (commander's Electron detection remains, so some commands may fail).
    const useElectronShim = runtime.isElectron || runtime.path === process.execPath;

    if (signal?.aborted) {
      return {
        code: null, ok: false, envelope: undefined, data: undefined,
        stdout: '', stderr: '', timedOut: false, aborted: true, args,
      };
    }

    const workDir = await mkdtemp(join(tmpRoot, 'dsh-genspark-'));
    const outPath = join(workDir, 'stdout.json');
    const errPath = join(workDir, 'stderr.log');
    const outHandle = await open(outPath, 'w');
    const errHandle = await open(errPath, 'w');

    let child;
    let timedOut = false;
    let aborted = false;
    let timer = null;

    const killChild = () => {
      try {
        child?.kill();
      } catch {
        /* Ignore if it has already exited */
      }
    };
    const onAbort = () => {
      aborted = true;
      killChild();
    };

    try {
      child = spawn(runtime.path, args, {
        cwd: options.cwd && options.cwd.length > 0 ? options.cwd : process.cwd(),
        // Pipes are not usable (EPERM). Close stdin and send stdout/stderr to fds.
        stdio: ['ignore', outHandle.fd, errHandle.fd],
        windowsHide: true,
        env: {
          ...env,
          GSK_NO_AUTO_UPDATE: '1', // Stop self-update (avoids exit-code pollution and delays)
          ...(useElectronShim ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          ...(options.extraEnv ?? {}),
        },
      });
    } catch (error) {
      await outHandle.close().catch(() => {});
      await errHandle.close().catch(() => {});
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killChild();
      }, timeoutMs);
      timer.unref?.();
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    const settled = await new Promise((resolve) => {
      child.on('error', (error) => resolve({ spawnError: error }));
      child.on('close', (code, closeSignal) => resolve({ code, closeSignal }));
    });

    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);

    await outHandle.close().catch(() => {});
    await errHandle.close().catch(() => {});

    const [stdout, stderr] = await Promise.all([
      readFile(outPath, 'utf8').catch(() => ''),
      readFile(errPath, 'utf8').catch(() => ''),
    ]);
    await rm(workDir, { recursive: true, force: true }).catch(() => {});

    if (settled.spawnError) throw settled.spawnError;

    const { value } = parseEnvelope(stdout);
    const envelope = isEnvelope(value) ? value : undefined;
    return {
      code: typeof settled.code === 'number' ? settled.code : null,
      ok: envelope?.status === 'ok',
      envelope,
      /** Parse result including JSON that is not an envelope (such as the {tools:[...]} from `gsk ls`) */
      value,
      data: envelope?.data ?? value,
      stdout,
      stderr,
      timedOut,
      aborted,
      args,
      runtime,
    };
  }

  /**
   * Run one tool. Arguments are written to a temp file and passed via `--args-file`, so they are
   * unaffected by shell quoting, `$` expansion, or quote breakage.
   *
   * Note: `--args-file` is an option that exists only on "tools that have parameters". Passing it
   * when there are no arguments fails with `error: unknown option '--args-file'` (measured: `me`). Do not pass it when empty.
   */
  async function runTool(toolName, toolArgs, options = {}) {
    const config = (typeof getConfig === 'function' ? getConfig() : getConfig) ?? {};
    // Grouped commands (e.g. social_twitter → `gsk social twitter`) are passed by the caller
    // as a segment array. If unspecified, run the tool name as a one-word command as before.
    const head = Array.isArray(options.toolCommand) && options.toolCommand.length > 0 ? options.toolCommand : [toolName];
    const hasArgs = toolArgs !== null && typeof toolArgs === 'object' && Object.keys(toolArgs).length > 0;
    if (!hasArgs) {
      const argv = [...(options.globalArgs ?? []), ...head, ...(options.toolArgs ?? [])];
      return await run(argv, options);
    }
    const tmpRoot = resolveTmpRoot(options.tmpRoot ?? config.tmpDir);
    const workDir = await mkdtemp(join(tmpRoot, 'dsh-genspark-args-'));
    try {
      const argsPath = await writeArgsFile(workDir, toolArgs);
      const argv = [...(options.globalArgs ?? []), ...head, '--args-file', argsPath, ...(options.toolArgs ?? [])];
      return await run(argv, options);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    run,
    runTool,
    resolveEntry: () => resolveCliEntry({ cliEntry: getConfig?.()?.cliEntry, env }),
    resolveRuntime: () => resolveNodeRuntime({ config: getConfig?.() ?? {}, env }),
  };
}

/**
 * Write the arguments object to a temp file and return the path for `--args-file`.
 * The return value is always an absolute path (so it does not depend on the child process's cwd).
 */
export async function writeArgsFile(dir, args) {
  const path = resolve(join(dir, 'args.json'));
  await writeFile(path, JSON.stringify(args ?? {}), 'utf8');
  return path;
}
