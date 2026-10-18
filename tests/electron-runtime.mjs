/**
 * Verification under the real DSH environment conditions (the parent process is Electron).
 *
 * Background: the DSH server runs on Electron, so process.execPath is "DeepSeek Harness.exe".
 * Using that as the child process runtime makes commander switch to Electron-style argv handling
 * (node_modules/commander/lib/command.js:981-983, 1010-1018. When launched with ELECTRON_RUN_AS_NODE,
 * process.defaultApp is unset, so argv.slice(1) becomes the user arguments),
 * and it fails with
 *   error: unknown command '<...>/dist/index.js'
 * (observed on real hardware). The fix searches for and uses a real Node executable.
 *
 * Run (recommended = actually run it on Electron):
 *   $env:ELECTRON_RUN_AS_NODE='1'; & 'D:\deepseek\DeepSeek Harness.exe' tests/electron-runtime.mjs
 * Run (plain Node; confirms the breakage when the Electron executable is known):
 *   node tests/electron-runtime.mjs
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRunner, resolveNodeRuntime } from '../lib/gsk-cli.js';
import { describeRun } from '../lib/result.js';

const onElectron = Boolean(process.versions?.electron);
console.log(`Parent process: ${process.execPath}`);
console.log(`process.versions.electron: ${process.versions?.electron ?? '(none = plain Node)'}`);

const checks = [];
const record = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  console.log(`\n[${pass ? 'OK' : 'NG'}] ${name}\n  ${String(detail).replace(/\s+/g, ' ').slice(0, 400)}`);
};

// 1) Runtime resolution
const resolved = resolveNodeRuntime({ config: {}, env: process.env });
record(
  'Runtime resolution',
  !resolved.isElectron,
  `path=${resolved.path} / source=${resolved.source} / isElectron=${resolved.isElectron}`,
);

if (onElectron) {
  record(
    'The Electron executable is excluded from the candidates',
    resolved.path !== process.execPath,
    `resolved=${resolved.path} / execPath=${process.execPath}`,
  );
}

// 2) Does me pass with the default settings? (the path that used to fail with unknown command)
const config = { timeoutMs: 120000 };
const runner = createRunner({ getConfig: () => config });
console.log(`\nentry: ${runner.resolveEntry()}`);
console.log(`runner.resolveRuntime(): ${JSON.stringify(runner.resolveRuntime())}`);

const me = await runner.run(['--output', 'json', 'me'], { cwd: process.cwd(), timeoutMs: 60000 });
const described = describeRun(me, { tool: 'me', maxChars: 2000 });
record('me (account retrieval)', described.ok, `code=${me.code} runtime=${me.runtime?.path} ${described.text}`);

// 3) Does the catalog (ls) pass through the same path?
const ls = await runner.run(['--output', 'json', 'ls'], { cwd: process.cwd(), timeoutMs: 120000 });
const toolCount = Array.isArray(ls.value?.tools) ? ls.value.tools.length : 0;
record('ls (catalog fetch)', toolCount > 100, `code=${ls.code} tools=${toolCount} ${ls.stderr.trim()}`);

// 4) Does a promoted tool (typed) pass under the same conditions as DSH?
//    Set the parent cwd to another directory to also reproduce "parent and child cwd differ"
//    (confirming the real-hardware bug where tmpDir='' became a relative path and --args-file hit ENOENT).
const otherCwd = tmpdir();
const promotedRunner = createRunner({ getConfig: () => ({ ...config, tmpDir: '' }) });
const promoted = await promotedRunner.runTool('web_search', { q: 'DeepSeek Harness' }, {
  cwd: otherCwd,
  globalArgs: ['--output', 'json', '--no-input'],
  timeoutMs: 120000,
});
record(
  'Promoted tool path (--args-file + cwd mismatch)',
  /"organic_results"|"result_type"|"status"\s*:\s*"ok"/.test(promoted.stdout ?? ''),
  `parent cwd=${process.cwd()} / child cwd=${otherCwd} / code=${promoted.code} / ${promoted.stderr.trim().slice(0, 120)}`,
);

// 5) Reference: forcing the Electron executable reproduces it (proof that the fix works)
const electronPath = process.env.DSH_ELECTRON_PATH ?? (onElectron ? process.execPath : '');
if (electronPath && existsSync(electronPath)) {
  const broken = await runner.run(['--output', 'json', 'me'], {
    cwd: process.cwd(),
    timeoutMs: 60000,
    runtimePath: electronPath,
  });
  const reproduced = !broken.ok && /unknown command/i.test(broken.stderr);
  record(
    'Reference: forcing the Electron executable reproduces the same symptom',
    reproduced,
    `code=${broken.code} stderr=${broken.stderr.split('\n').slice(0, 2).join(' | ')}`,
  );
} else {
  console.log('\n[SKIP] the Electron executable is unknown, so the reproduction check is omitted');
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n=== ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`} / ${checks.length} checks ===`);
if (!onElectron) {
  console.log('* The parent is plain Node; re-run with ELECTRON_RUN_AS_NODE=1 to verify on real Electron.');
}
process.exit(failed.length === 0 ? 0 : 1);
