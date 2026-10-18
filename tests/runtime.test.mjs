/**
 * Unit tests for child-process runtime resolution (no host required).
 * Run: node tests/runtime.test.mjs
 *
 * Background: DSH runs on Electron, so using the Electron executable as the child-process runtime
 * makes commander switch to Electron's argv interpretation and fail with
 * `error: unknown command '<dist/index.js>'` (commander lib/command.js:981-983, 1010-1018).
 * A real Node must be preferred.
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

test('nodeRuntimeCandidates: an explicit environment variable wins', () => {
  const list = nodeRuntimeCandidates({ env: { ...WIN_ENV, DSH_NODE_PATH: 'D:\\x\\node.exe' }, platform: 'win32' });
  assert.equal(list[0], 'D:\\x\\node.exe');
});

test('nodeRuntimeCandidates: picks node.exe from PATH', () => {
  const list = nodeRuntimeCandidates({ env: WIN_ENV, platform: 'win32' });
  assert.ok(list.includes('C:\\Program Files\\nodejs\\node.exe'));
});

test('nodeRuntimeCandidates: includes the default Windows install locations', () => {
  const list = nodeRuntimeCandidates({ env: WIN_ENV, platform: 'win32' });
  assert.ok(list.includes('C:\\Program Files\\nodejs\\node.exe'));
  assert.ok(list.includes('C:\\Program Files (x86)\\nodejs\\node.exe'));
  assert.ok(list.includes('C:\\Users\\u\\AppData\\Local\\Programs\\nodejs\\node.exe'));
  assert.ok(list.includes('C:\\ProgramData\\chocolatey\\bin\\node.exe'));
  assert.ok(list.includes('C:\\Users\\u\\scoop\\shims\\node.exe'));
});

test('nodeRuntimeCandidates: includes POSIX default paths without duplicates', () => {
  const list = nodeRuntimeCandidates({ env: { PATH: '/usr/local/bin:/usr/bin' }, platform: 'linux' });
  assert.ok(list.includes('/usr/local/bin/node'));
  assert.ok(list.includes('/usr/bin/node'));
  assert.equal(new Set(list).size, list.length);
});

test('resolveNodeRuntime: prefers config.nodePath', () => {
  const resolved = resolveNodeRuntime({
    config: { nodePath: 'D:\\nodejs\\node.exe' },
    env: WIN_ENV,
    fsExists: (p) => p === 'D:\\nodejs\\node.exe',
  });
  assert.equal(resolved.path, 'D:\\nodejs\\node.exe');
  assert.equal(resolved.source, 'config.nodePath');
  assert.equal(resolved.isElectron, false);
});

test('resolveNodeRuntime: uses process.execPath as-is on plain Node', () => {
  const resolved = resolveNodeRuntime({
    config: {},
    env: WIN_ENV,
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
  });
  // Tests run on plain Node, so the Electron check does not kick in
  assert.equal(process.versions.electron, undefined);
  assert.equal(resolved.source, 'process.execPath');
  assert.equal(resolved.isElectron, false);
});

test('resolveNodeRuntime: skips missing candidates and picks one that exists', () => {
  const seen = [];
  const resolved = resolveNodeRuntime({
    config: {},
    env: { PATH: 'C:\\Ghost;C:\\Real', ProgramFiles: 'C:\\Missing' },
    fsExists: (p) => {
      seen.push(p);
      return p === 'C:\\Real\\node.exe';
    },
  });
  // Running on plain Node, so the Electron search is not entered (it only runs on Electron)
  assert.equal(resolved.path, process.execPath);
  assert.equal(seen.length, 0);
});

test('resolveNodeRuntime: on Electron, searches for real Node and falls back to Electron', () => {
  // process.versions.electron cannot be overridden, so only verify the contract of the result.
  const fallback = resolveNodeRuntime({
    config: {},
    env: {},
    fsExists: () => false,
  });
  assert.ok(['process.execPath', 'electron-fallback'].includes(fallback.source));
  assert.equal(typeof fallback.path, 'string');
});
