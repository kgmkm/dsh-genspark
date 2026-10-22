// Preflight for the live (volatile) settings of the web search provider.
//
// Purpose: the whole feature hangs on two host behaviours that a plain unit test cannot prove:
//   1. `SettingsForms.describe()` only returns an entry when the plugin's Config has at least one
//      volatile field. Without one there is **no settings card at all** — the switch would be
//      unreachable from the GUI.
//   2. The loader hands volatile fields to `apply()` as live references (`{ get() }`), not plain
//      values, so `readLive()` must unwrap them and `webSearch.enabled` must still default to false.
//
// Usage: node tests/preflight-web-settings.mjs
// Requires: reference/asar/node_modules/@deepseek-ai/* and schemastery/cosmokit from the profile
//           (same prerequisites as preflight-plugin-load.mjs).

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..');
const root = resolve(pluginDir, '..');
const hostModules = join(root, 'reference/asar/node_modules/@deepseek-ai');
const profileModules = 'C:\\Users\\narukami\\.dsh\\profiles\\desktop\\node_modules\\@deepseek-ai';

let ok = 0;
let fail = 0;
const check = (label, passed, detail = '') => {
  if (passed) {
    ok += 1;
    console.log(`  ✔ ${label}${detail === '' ? '' : ` — ${detail}`}`);
  } else {
    fail += 1;
    console.log(`  ✘ ${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
};

// --- 1. Lay the shipped package out next to the host-provided modules ---------------
const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
const temp = mkdtempSync(join(tmpdir(), 'dsh-genspark-web-settings-'));
console.log(`Temporary directory: ${temp}\n`);
for (const entry of manifest.files ?? []) {
  const source = join(pluginDir, entry);
  if (existsSync(source)) cpSync(source, join(temp, entry), { recursive: true });
}
const vendorDir = join(temp, 'node_modules/@deepseek-ai');
cpSync(hostModules, vendorDir, { recursive: true, filter: (src) => !src.includes('dsh-client') });
for (const extra of ['schemastery', 'cosmokit']) {
  const from = join(profileModules, extra);
  if (existsSync(from)) cpSync(from, join(vendorDir, extra), { recursive: true });
}

const mod = await import(pathToFileURL(join(temp, 'index.js')).href);
const z = (await import(pathToFileURL(join(vendorDir, 'schemastery/lib/index.mjs')).href)).default;
const { isVolatile } = await import(pathToFileURL(join(vendorDir, 'cosmokit/lib/index.js')).href);
const { readLive } = await import(pathToFileURL(join(temp, 'lib/web-provider.js')).href);

check('Config is a schemastery schema', mod.Config !== undefined && typeof mod.Config === 'function');
check('Config exposes toJSON (the host requires it for a settings card)', typeof mod.Config.toJSON === 'function');

// --- 2. The settings-card projection the host uses (dsh-settings volatileForm) -----
/** Mirror of dsh-settings' `volatileForm()`: returns the live-editable subtree, if any. */
function volatileForm(node) {
  if (node.meta?.volatile) return true;
  if (node.type !== 'object') return undefined;
  const dict = Object.fromEntries(
    Object.entries(node.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child);
      return field === undefined ? [] : [[key, field]];
    }),
  );
  return Object.keys(dict).length === 0 ? undefined : dict;
}

const form = volatileForm(mod.Config);
check(
  'a settings card exists (the schema has volatile fields)',
  form !== undefined && form !== true,
  form === undefined ? 'volatileForm() is empty => the GUI would show no card' : Object.keys(form).join(', '),
);
check(
  'the card contains exactly webSearch (enabled, autoSelect)',
  form !== true &&
    Object.keys(form ?? {}).length === 1 &&
    Object.keys(form.webSearch ?? {}).sort().join(',') === 'autoSelect,enabled',
  JSON.stringify(Object.keys(form?.webSearch ?? {})),
);

// --- 3. Resolved config: defaults and live references ------------------------------
const defaults = mod.Config({});
check(
  'webSearch.enabled defaults to false (the feature is opt-in)',
  readLive(defaults.webSearch?.enabled, false) === false,
  String(readLive(defaults.webSearch?.enabled, 'n/a')),
);
check('webSearch.autoSelect defaults to true', readLive(defaults.webSearch?.autoSelect, true) === true);

const enabled = mod.Config({ webSearch: { enabled: true } });
check(
  'webSearch.enabled arrives as a live reference',
  isVolatile(enabled.webSearch.enabled),
  typeof enabled.webSearch.enabled,
);
check('readLive() unwraps it back to true', readLive(enabled.webSearch.enabled, false) === true);
check(
  'the untouched sibling stays a live reference too (both are volatile)',
  isVolatile(enabled.webSearch.autoSelect),
);
check(
  'ordinary fields stay plain values (only webSearch is live)',
  isVolatile(enabled.enabled) === false && isVolatile(enabled.promotedCategories) === false,
);

// A live edit is what the host does on `loader/volatile-update`: the reference content changes
// without remounting the plugin, which is why the plugin re-reads it on every call.
// The write channel is cosmokit's `Symbol.for('cosmokit.volatile.write')` (not exported by name).
const live = mod.Config({ webSearch: { enabled: true } });
const before = readLive(live.webSearch.enabled, false);
const write = Symbol.for('cosmokit.volatile.write');
live.webSearch.enabled[write]?.(false);
check(
  'the reference is read on every call (before: true, after a host write: false)',
  before === true && readLive(live.webSearch.enabled, false) === false,
  `${before} → ${readLive(live.webSearch.enabled, false)}`,
);

rmSync(temp, { recursive: true, force: true });
console.log(`\nResult: ${ok} passed / ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
