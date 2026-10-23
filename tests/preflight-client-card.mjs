// Preflight for the browser half (`lib/client.js`), the card that appears in the Plugins panel.
//
// It runs the shipped file against a fake `window.__ModuleLoader__` and a fake `require`, so the
// client contract is checked without a browser: the module id, the required services, that the card
// only mounts while the Host serves the namespace, and that each checkbox writes the mutation the
// Host expects.
//
// Usage: node tests/preflight-client-card.mjs

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..');

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

// --- a fake React: element trees, function components, and the two hooks the card uses ---
const createElement = (type, props, ...children) => ({
  type,
  props: {
    ...(props ?? {}),
    ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
  },
});
const fakeReact = {
  Fragment: Symbol('Fragment'),
  createElement,
  useCallback: (fn) => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

/** Expand function components so their props and children can be inspected. */
const render = (node) => {
  if (Array.isArray(node)) return node.map(render);
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (typeof node.type === 'function') return render(node.type(node.props));
  if (node.props?.children === undefined) return node;
  return { ...node, props: { ...node.props, children: render(node.props.children) } };
};

/** Collect every element in a rendered tree. */
const walk = (node, out = []) => {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out);
    return out;
  }
  if (node === null || node === undefined || typeof node !== 'object') return out;
  out.push(node);
  walk(node.props?.children, out);
  return out;
};

const findInput = (tree, id) => walk(tree).find((node) => node.type === 'input' && node.props?.id === id);

/** Flatten a rendered tree to its text content. */
const textOf = (tree) =>
  walk(tree)
    .flatMap((node) => [node.props?.children])
    .filter((child) => typeof child === 'string')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

// --- the loader facade the bundle expects ---
let loaded;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, exports: factory((name) => (name === 'react' ? fakeReact : undefined)) };
    },
  },
};

await import(pathToFileURL(join(pluginDir, 'lib/client.js')).href);

console.log('Manifest');
{
  // Same field rules the host's `parseDshClient` enforces (`dsh-client-modules`): a typo here is a
  // boot-time composition error, so it is cheaper to catch it before a restart.
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
  const decl = manifest.dsh?.client;
  check('declares dsh.client', decl !== undefined && typeof decl === 'object');
  check('declares the browser platform', decl?.platform === 'web', decl?.platform);
  check(
    'declares no inject/external entries (nothing to pre-load)',
    decl?.inject === undefined && decl?.external === undefined,
  );
  const clientPath = manifest.exports?.['./client'];
  check('exports ./client', typeof clientPath === 'string', clientPath);
  check('the exported file exists in the published files', clientPath !== undefined && existsSync(join(pluginDir, clientPath)));
  check('the bundle patch exists', existsSync(join(pluginDir, manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml')));
}

console.log('\nClient bundle');
check('loads through window.__ModuleLoader__', loaded !== undefined);
check('registers under the package id', loaded?.id === 'dsh-genspark', loaded?.id);
check(
  'requires only published client services',
  JSON.stringify(loaded?.exports.inject) === JSON.stringify(['slots', 'configForms']),
  JSON.stringify(loaded?.exports.inject),
);
check('exports apply()', typeof loaded?.exports.apply === 'function');

// --- a fake client context ---
function makeContext({ served = true } = {}) {
  const registrations = [];
  const effects = [];
  const calls = { whileServed: [], slotNames: [], mutations: [] };
  const form = {
    snapshot: { status: 'ready', writable: true, revision: 1, value: { webSearch: { enabled: false, autoSelect: true } } },
    getSnapshot() {
      return this.snapshot;
    },
    subscribe(listener) {
      this.listener = listener;
      return () => {
        this.listener = undefined;
      };
    },
    mutate(ops, revision) {
      calls.mutations.push({ ops, revision });
      this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1 };
      return Promise.resolve(true);
    },
    dispose() {
      calls.dispose = (calls.dispose ?? 0) + 1;
      this.disposed = true;
    },
  };
  const slots = {
    register(options, component) {
      registrations.push({ options, component });
      return () => {
        registrations.length = 0;
      };
    },
    inject(name, register) {
      calls.slotNames.push(name);
      return register();
    },
  };
  const ctx = {
    configForms: {
      get(id) {
        calls.get = id;
        return form;
      },
      whileServed(namespaces, register) {
        calls.whileServed.push(namespaces);
        return served ? register(new Set(namespaces)) : () => {};
      },
    },
    slots,
    effect(fn, label) {
      effects.push({ dispose: fn(), label });
    },
  };
  return { ctx, form, registrations, effects, calls };
}

console.log('\nSlot registration');
{
  const { ctx, registrations, calls } = makeContext();
  loaded.exports.apply(ctx);
  check('asks the Host form cache for this plugin entry', calls.get === 'dsh-genspark', calls.get);
  check('watches the entry namespace', JSON.stringify(calls.whileServed[0]) === JSON.stringify(['dsh-genspark']));
  check('contributes to the Plugins panel', calls.slotNames[0] === 'plugins.item', calls.slotNames[0]);
  const options = registrations[0]?.options;
  check('card id is unique', options?.id === 'dsh-genspark', options?.id);
  check('card has an order', typeof options?.order === 'number', String(options?.order));
  check('card label is "Genspark"', options?.label?.() === 'Genspark', options?.label?.());
  check('card props carry the shared form', options?.inject?.().form !== undefined);
}
{
  const { ctx, registrations } = makeContext({ served: false });
  loaded.exports.apply(ctx);
  check('no card while the Host serves no such namespace', registrations.length === 0);
}

console.log('\nCard behaviour');
/** Mount the card for one settings value and return the rendered tree plus the write log. */
const mount = (value, { status = 'ready', writable = true } = {}) => {
  const host = makeContext();
  loaded.exports.apply(host.ctx);
  const component = host.registrations[0].component;
  host.form.snapshot = { ...host.form.snapshot, status, writable, value: { webSearch: value } };
  return { ...host, tree: render(createElement(component, { form: host.form })) };
};

{
  const { tree, calls } = mount({ enabled: false, autoSelect: true });
  const toggle = findInput(tree, 'dsh-genspark-enabled');
  const auto = findInput(tree, 'dsh-genspark-autoselect');
  check('the enable switch renders unchecked (opt-in default)', toggle?.props.checked === false);
  check('the auto-select switch renders checked (opt-in default)', auto?.props.checked === true);
  check('auto-select is unavailable until the feature is on', auto?.props.disabled === true);
  toggle.props.onChange({ currentTarget: { checked: true } });
  check(
    'enabling writes webSearch.enabled through the settings namespace',
    JSON.stringify(calls.mutations[0]?.ops) === JSON.stringify([{ op: 'set', path: ['webSearch', 'enabled'], value: true }]),
    JSON.stringify(calls.mutations[0]?.ops),
  );
}

{
  const { tree, calls } = mount({ enabled: true, autoSelect: false });
  const toggle = findInput(tree, 'dsh-genspark-enabled');
  const auto = findInput(tree, 'dsh-genspark-autoselect');
  check('the enable switch reflects the stored value', toggle?.props.checked === true);
  check('auto-select is editable once the feature is on', auto?.props.disabled === false);
  check('auto-select reflects the stored value', auto?.props.checked === false);
  auto.props.onChange({ currentTarget: { checked: true } });
  check(
    'auto-select writes webSearch.autoSelect',
    JSON.stringify(calls.mutations[0]?.ops) === JSON.stringify([{ op: 'set', path: ['webSearch', 'autoSelect'], value: true }]),
    JSON.stringify(calls.mutations[0]?.ops),
  );
  check('the Host revision fences the write', calls.mutations[0]?.revision === undefined);
}

{
  const { tree } = mount({ enabled: false }, { status: 'loading' });
  check('a loading form shows no switches', findInput(tree, 'dsh-genspark-enabled') === undefined);
  check('a loading form says so', /Loading/.test(textOf(tree)), textOf(tree).slice(0, 40));
}

{
  const { tree } = mount({ enabled: false }, { writable: false });
  check('a read-only profile disables the switches', findInput(tree, 'dsh-genspark-enabled')?.props.disabled === true);
  check('a read-only profile explains why', /does not accept settings edits/.test(textOf(tree)));
}

{
  const { tree } = mount({ enabled: false });
  const text = textOf(tree);
  check('the card names the feature', /Genspark web search/.test(text));
  check('the card mentions the cost', /credits/.test(text) && /web_fetch/.test(text));
}

console.log('\nTeardown');
{
  const { ctx, form, effects, registrations } = makeContext();
  loaded.exports.apply(ctx);
  check('one effect carries the card', effects.length === 1 && typeof effects[0].label === 'string', effects.map((e) => e.label).join(' + '));
  for (const effect of effects) effect.dispose();
  check('disposing the effect removes the card', registrations.length === 0);
  check('the shared form is left to its owner', form.disposed === undefined);
}

console.log(`\nResult: ${ok} passed / ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
