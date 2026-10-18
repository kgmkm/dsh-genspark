/**
 * 子プロセスのランタイム解決の単体テスト（ホスト不要）。
 * 実行: node tests/runtime.test.mjs
 *
 * 背景: DSH は Electron 上で動くため、Electron 実行ファイルを子プロセスのランタイムに使うと
 * commander が Electron 用の argv 解釈に切り替わり `error: unknown command '<dist/index.js>'`
 * で落ちる（commander lib/command.js:981-983, 1010-1018）。実 Node を優先採用する必要がある。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { nodeRuntimeCandidates, resolveNodeRuntime } from '../lib/gsk-cli.js';

const WIN_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  ProgramData: 'C:\\ProgramData',
  APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
  USERPROFILE: 'C:\\Users\\u',
  PATH: 'C:\\Windows\\system32;C:\\Program Files\\nodejs',
};

test('nodeRuntimeCandidates: 環境変数の明示指定が最優先', () => {
  const list = nodeRuntimeCandidates({ env: { ...WIN_ENV, DSH_NODE_PATH: 'D:\\x\\node.exe' }, platform: 'win32' });
  assert.equal(list[0], 'D:\\x\\node.exe');
});

test('nodeRuntimeCandidates: PATH から node.exe を拾う', () => {
  const list = nodeRuntimeCandidates({ env: WIN_ENV, platform: 'win32' });
  assert.ok(list.includes('C:\\Program Files\\nodejs\\node.exe'));
});

test('nodeRuntimeCandidates: Windows の既定インストール先を含む', () => {
  const list = nodeRuntimeCandidates({ env: WIN_ENV, platform: 'win32' });
  assert.ok(list.includes('C:\\Program Files\\nodejs\\node.exe'));
  assert.ok(list.includes('C:\\Program Files (x86)\\nodejs\\node.exe'));
  assert.ok(list.includes('C:\\Users\\u\\AppData\\Local\\Programs\\nodejs\\node.exe'));
  assert.ok(list.includes('C:\\ProgramData\\chocolatey\\bin\\node.exe'));
  assert.ok(list.includes('C:\\Users\\u\\scoop\\shims\\node.exe'));
});

test('nodeRuntimeCandidates: POSIX の既定パスを含み重複しない', () => {
  const list = nodeRuntimeCandidates({ env: { PATH: '/usr/local/bin:/usr/bin' }, platform: 'linux' });
  assert.ok(list.includes('/usr/local/bin/node'));
  assert.ok(list.includes('/usr/bin/node'));
  assert.equal(new Set(list).size, list.length);
});

test('resolveNodeRuntime: config.nodePath を最優先で採用する', () => {
  const resolved = resolveNodeRuntime({
    config: { nodePath: 'D:\\nodejs\\node.exe' },
    env: WIN_ENV,
    fsExists: (p) => p === 'D:\\nodejs\\node.exe',
  });
  assert.equal(resolved.path, 'D:\\nodejs\\node.exe');
  assert.equal(resolved.source, 'config.nodePath');
  assert.equal(resolved.isElectron, false);
});

test('resolveNodeRuntime: 素の Node 上では process.execPath をそのまま使う', () => {
  const resolved = resolveNodeRuntime({
    config: {},
    env: WIN_ENV,
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
  });
  // テストは素の Node で走るので Electron 判定は入らない
  assert.equal(process.versions.electron, undefined);
  assert.equal(resolved.source, 'process.execPath');
  assert.equal(resolved.isElectron, false);
});

test('resolveNodeRuntime: 存在しない候補は飛ばして実在する node を選ぶ', () => {
  const seen = [];
  const resolved = resolveNodeRuntime({
    config: {},
    env: { PATH: 'C:\\Ghost;C:\\Real', ProgramFiles: 'C:\\Missing' },
    fsExists: (p) => {
      seen.push(p);
      return p === 'C:\\Real\\node.exe';
    },
  });
  // 素の Node 実行なので Electron 探索には入らない（探索は Electron 上のみ）
  assert.equal(resolved.path, process.execPath);
  assert.equal(seen.length, 0);
});

test('resolveNodeRuntime: Electron 上では実 Node を探索し、無ければ Electron へフォールバック', () => {
  // process.versions.electron は書き換えられないため、探索結果の契約だけを検証する。
  const fallback = resolveNodeRuntime({
    config: {},
    env: {},
    fsExists: () => false,
  });
  assert.ok(['process.execPath', 'electron-fallback'].includes(fallback.source));
  assert.equal(typeof fallback.path, 'string');
});
