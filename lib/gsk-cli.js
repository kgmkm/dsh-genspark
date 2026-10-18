/**
 * Genspark CLI (`gsk`) ランナー — 実測で確定した起動プロトコルだけを使う。
 *
 * 実測根拠（docs/00-genspark-cli-spec-review.md 9.1〜9.4）:
 *   - shim（gsk.cmd）は Node から spawn すると EINVAL。`node <dist/index.js>` を直接起動する。
 *   - Windows サンドボックス下では `stdio: 'pipe'` が EPERM。stdout/stderr を一時ファイルの
 *     fd へリダイレクトすれば通る（実測で stdout/stderr を正しく分離取得できた）。
 *   - stdin は 'ignore'。確認プロンプトは EOF → 拒否（サーバ呼び出しなし）に倒れる。
 *   - GSK_NO_AUTO_UPDATE=1 を注入。自動更新を試みる実行は終了コードが 0xC0000409 になり
 *     成功判定に使えないため、CLI の自己更新は DSH 側から切り離す。
 *   - 引数は `--args-file <JSONファイル>` で渡す（シェル引用を一切経由しない）。
 *
 * 成功判定は終了コードではなく「stdout が JSON エンベロープとして解釈できるか」を主とする。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isEnvelope, parseEnvelope } from './result.js';

/**
 * 一時ファイルを置くディレクトリを**必ず絶対パス**で解決する。
 *
 * 重要: 設定 `tmpDir` の既定値は空文字で、`'' ?? tmpdir()` は `''` を返してしまう
 * （null 合体演算子は空文字を「値あり」と見なす）。その結果 `join('', 'dsh-genspark-args-')`
 * が相対パスになり、mkdtemp は親プロセスの cwd 基準、子プロセスの cwd は
 * セッションの作業ディレクトリ、という不一致で `--args-file` が ENOENT になる
 * （DSH 実機で発生した不具合）。絶対パスに正規化して cwd 依存を断つ。
 */
export function resolveTmpRoot(value, { fsTmpDir = tmpdir() } = {}) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw.length > 0 ? resolve(raw) : fsTmpDir;
}

/** @genspark/cli のグローバル導入先として現実的な候補を列挙する。 */
export function cliEntryCandidates({ env = process.env, execPath = process.execPath } = {}) {
  const tail = ['node_modules', '@genspark', 'cli', 'dist', 'index.js'];
  const list = [];
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0) list.push(value);
  };

  push(env.GSK_CLI_ENTRY);
  push(env.GSK_CLI_PATH);
  if (env.APPDATA) push(join(env.APPDATA, 'npm', ...tail)); // Windows: npm 既定のグローバル
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

/** 実在する CLI エントリを 1 つ解決する。見つからなければ null。 */
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
  '@genspark/cli のエントリが見つかりません。`npm install -g @genspark/cli` を実行するか、' +
  'プラグイン設定 cliEntry に dist/index.js の絶対パスを指定してください。';

/**
 * 実 Node 実行ファイルの候補を優先順に列挙する（Electron 実行ファイルは含めない）。
 * DSH は Electron 上で動くため `process.execPath` をそのまま子プロセスのランタイムに使うと、
 * commander が `process.versions.electron` を見て Electron 用の argv 解釈に切り替わり、
 * `process.defaultApp` が未設定（ELECTRON_RUN_AS_NODE 起動時）だと `argv.slice(1)` を
 * ユーザー引数とみなして `error: unknown command '<dist/index.js>'` で落ちる（実測）。
 * commander 側の分岐: node_modules/commander/lib/command.js:981-983, 1010-1018。
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
 * 子プロセスのランタイムを決める。
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

  // 実 Node 上で動いているならそれで十分（Electron 判定は commander の都合）。
  if (!process.versions?.electron) {
    return { path: execPath, source: 'process.execPath', isElectron: false, exists: true };
  }

  for (const candidate of nodeRuntimeCandidates({ env, platform })) {
    if (fsExists(candidate)) {
      return { path: candidate, source: 'auto', isElectron: false, exists: true };
    }
  }

  // 最後の手段。ELECTRON_RUN_AS_NODE=1 を付けて起動しても commander の
  // Electron 判定は残るため、`me` など一部コマンドは失敗する（status で警告する）。
  return { path: execPath, source: 'electron-fallback', isElectron: true, exists: true };
}

/**
 * 実行結果の要約。
 * @typedef {object} GskRunResult
 * @property {number|null} code      終了コード（信頼できない場合がある。下記 ok を参照）
 * @property {boolean} ok            stdout が status:"ok" のエンベロープとして読めたか
 * @property {object|undefined} envelope パース済みエンベロープ
 * @property {unknown} data          envelope.data
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 * @property {boolean} aborted
 * @property {string[]} args         実際に渡した argv
 */

/**
 * ランナーを作る。`getConfig()` は毎回呼ばれる（設定のホット変更に追随するため）。
 */
export function createRunner({ getConfig, env = process.env } = {}) {
  /**
   * gsk を 1 回実行する。
   * @param {string[]} argv            CLI へ渡す引数（ツール名以降）
   * @param {object} [options]
   * @param {string} [options.cwd]     作業ディレクトリ（ローカルファイル相対パス解決のため）
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
    // 実行ランタイム。DSH は Electron 上で動くため `process.execPath` は Electron 本体
    // （"DeepSeek Harness.exe"）であり、そのまま起動すると commander の Electron 判定で
    // `error: unknown command '<...>/dist/index.js'` になる（実測）。実 Node を探して使う。
    const runtime = options.runtimePath
      ? { path: options.runtimePath, source: 'options.runtimePath', isElectron: false, exists: true }
      : resolveNodeRuntime({ config, env });
    // Electron 実行ファイルをランタイムに使う場合は、GUI が立ち上がらないよう必ず
    // RUN_AS_NODE を付ける（commander の Electron 判定は残るため一部コマンドは失敗しうる）。
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
        /* すでに終了している場合は無視 */
      }
    };
    const onAbort = () => {
      aborted = true;
      killChild();
    };

    try {
      child = spawn(runtime.path, args, {
        cwd: options.cwd && options.cwd.length > 0 ? options.cwd : process.cwd(),
        // パイプは使えない（EPERM）。stdin は閉じ、stdout/stderr は fd へ。
        stdio: ['ignore', outHandle.fd, errHandle.fd],
        windowsHide: true,
        env: {
          ...env,
          GSK_NO_AUTO_UPDATE: '1', // 自己更新を止める（終了コード汚染と遅延の回避）
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
      /** エンベロープでない JSON（`gsk ls` の {tools:[...]} など）も含めた解析結果 */
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
   * ツールを 1 つ実行する。引数は一時ファイルへ書き `--args-file` で渡すため、
   * シェル引用・`$` 展開・クォート崩れの影響を受けない。
   *
   * 注意: `--args-file` は「パラメータを持つツール」にだけ生えるオプション。引数が空のときに
   * 付けると `error: unknown option '--args-file'` で落ちる（実測: `me`）。空なら付けない。
   */
  async function runTool(toolName, toolArgs, options = {}) {
    const config = (typeof getConfig === 'function' ? getConfig() : getConfig) ?? {};
    // グループ付きコマンド（例: social_twitter → `gsk social twitter`）は呼び出し側が
    // セグメント配列で渡す。未指定なら従来どおりツール名を 1 語のコマンドとして実行する。
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
 * 引数オブジェクトを一時ファイルへ書き、`--args-file` 用のパスを返す。
 * 返り値は必ず絶対パスにする（子プロセスの cwd に依存させないため）。
 */
export async function writeArgsFile(dir, args) {
  const path = resolve(join(dir, 'args.json'));
  await writeFile(path, JSON.stringify(args ?? {}), 'utf8');
  return path;
}
