// Preflight that feeds real command lines into the host's actual dsh-commands **execute() (dispatcher)**
// and validates the whole path: admission → command/run → handler → formatting → command/done.
//
// Purpose: being registerable (preflight-commands-host.mjs) and actually working (this file) are different.
//          Here `/genspark-…` lines are passed to the real CommandRuntime.execute(), and the return value,
//          the command/run and command/done events written to the session log, and error behaviour are checked.
//
// Usage: node tests/preflight-commands-exec.mjs [--with-cli]
//        With --with-cli, checks that use the real CLI also run (read-only only; a few credits).
// Requires: reference/asar/node_modules/@deepseek-ai/{cordis,dsh-commands} (extracted)

import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const hostModules = join(root, 'reference/asar/node_modules/@deepseek-ai');
const withCli = process.argv.includes('--with-cli');

const load = (relative) =>
  import(new URL(`file://${join(hostModules, relative).replace(/\\/g, '/')}`).href);
const loadLocal = (relative) =>
  import(new URL(`file://${join(here, '..', relative).replace(/\\/g, '/')}`).href);

const cordis = await load('cordis/lib/index.js');
const commandsModule = await load('dsh-commands/lib/index.js');
const { buildGensparkCommands } = await loadLocal('lib/commands.js');

const log = { info() {}, warn() {}, error() {}, debug() {} };
const settle = () => new Promise((done) => setTimeout(done, 50));

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

const FAKE_TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web',
    cli: { aliases: ['ws'], group: 'search' },
    parameters: { properties: { q: { type: 'string', description: 'query' } }, required: ['q'] },
  },
];

/** Build an execution environment with recording stub runner / catalog. */
async function makeRuntime({ runTool, tools = FAKE_TOOLS, attachments, cwd } = {}) {
  const calls = [];
  const envelope = (data) => ({ status: 'ok', message: 'success', data });
  const stubRunner = {
    async runTool(toolName, toolArgs, options) {
      calls.push({ kind: 'runTool', toolName, toolArgs, options });
      if (runTool) return await runTool({ toolName, toolArgs, options });
      return { code: 0, ok: true, stdout: JSON.stringify(envelope({ echo: toolArgs })), stderr: '' };
    },
    async run(argv) {
      calls.push({ kind: 'run', argv });
      return { code: 0, ok: true, stdout: JSON.stringify(envelope({ email: 'test@example.com', plan: 'plus' })), stderr: '' };
    },
    resolveEntry: () => 'C:\\fake\\@genspark\\cli\\dist\\index.js',
    resolveRuntime: () => ({ path: 'C:\\Program Files\\nodejs\\node.exe', source: 'auto' }),
  };
  const stubCatalog = {
    async load(_runner, options) {
      calls.push({ kind: 'catalog', options });
      return { tools, features: {} };
    },
    peek: () => undefined,
  };

  const config = { promotedCategories: ['search', 'media'], timeoutMs: 300000, maxChars: 4000, debug: false };

  const app = new cordis.Context();
  const fiber = app.plugin(commandsModule.default ?? commandsModule.CommandRuntime);
  await settle();
  // Mount the host's attachments-service equivalent only when validating the attachment path
  if (attachments !== undefined) app.provide('attachments', attachments);
  const definitions = buildGensparkCommands({ getConfig: () => config, runner: stubRunner, catalog: stubCatalog, log, ctx: app });
  for (const definition of definitions) app.commands.register(definition);

  const appends = [];
  const agent = {
    session: {
      header: { cwd: cwd ?? process.cwd() },
      append(type, data) {
        appends.push({ type, data });
      },
    },
  };
  const ranTools = () => calls.filter((call) => call.kind === 'runTool');
  return { app, fiber, service: app.commands, definitions, calls, ranTools, appends, agent };
}

const line = (name, rest = '') => `/${name}${rest === '' ? '' : ` ${rest}`}`;
const signal = () => new AbortController().signal;

console.log('Checks run through the real host CommandRuntime.execute()\n');

const env = await makeRuntime({});
const { service, appends, calls, ranTools, agent } = env;
check('commands service is mounted', typeof service?.execute === 'function');

// --- 1. Lines that fail at admission record nothing -------------------------------
const noSlash = await service.execute(agent, 'genspark-search Tokyo', [], signal());
check('a line without a slash is not resolved (undefined)', noSlash === undefined);
const unknown = await service.execute(agent, '/nope test', [], signal());
check('an unknown command name is not resolved (undefined)', unknown === undefined);
check('an admission miss records no command/run', appends.length === 0, `${appends.length} items`);

// --- 2. Broken JSON is rejected inside the handler and does not launch the CLI ----
const broken = await service.execute(agent, line('genspark-run', 'web_search {oops}'), [], signal());
check('broken JSON yields an error result', broken?.result?.kind === 'error', broken?.result?.text?.slice(0, 60));
check('broken JSON touches neither the CLI nor the catalog', calls.length === 0, `runner calls: ${calls.length}`);

// --- 3. Lifecycle (command/run → command/done) pairs correctly --------------------
const [runEvent, doneEvent] = appends;
check('command/run is recorded', runEvent?.type === 'command/run');
check('command/run name and args', runEvent?.data?.name === 'genspark-run' && runEvent?.data?.args === ' web_search {oops}', JSON.stringify(runEvent?.data?.args));
check('command/run source is user', runEvent?.data?.source?.kind === 'user');
check('command/done is recorded', doneEvent?.type === 'command/done');
check('commandId pairs up', runEvent?.data?.commandId === doneEvent?.data?.commandId, String(doneEvent?.data?.commandId));
check('command/done kind is error', doneEvent?.data?.kind === 'error');
check('command/done contains body text', typeof doneEvent?.data?.text === 'string' && doneEvent.data.text.length > 0, `${doneEvent?.data?.text?.length ?? 0} chars`);

// --- 4. Happy path: arguments reach the stub runner -------------------------------
appends.length = 0;
const search = await service.execute(agent, line('genspark-search', 'Tokyo'), [], signal());
check('/genspark-search succeeds', search?.result?.kind === 'success', search?.result?.text?.slice(0, 50));
check('web_search was called', ranTools().length === 1 && ranTools()[0].toolName === 'web_search', ranTools()[0]?.toolName);
check('the query reaches the arguments', String(ranTools()[0]?.toolArgs?.q ?? '').includes('Tokyo'), JSON.stringify(ranTools()[0]?.toolArgs));
check('done is recorded as success', appends.at(-1)?.data?.kind === 'success');

// --- 5. Missing input is rejected by the handler with an English message ----------
calls.length = 0;
const noArg = await service.execute(agent, line('genspark-search'), [], signal());
check('missing input yields an error result', noArg?.result?.kind === 'error', noArg?.result?.text?.slice(0, 50));
check('missing input does not launch the CLI', calls.length === 0, `runner calls: ${calls.length}`);

// --- 5.5 Results are handed off to agent.followup through the real dispatcher ------
// Command results normally appear only in the on-screen command pane, so after execution the
// result is passed to the model (scheduleFollowup in lib/commands.js). Here the real dispatcher
// confirms that "the agent the handler receives is the very object the adapter passed to execute".
const followups = [];
const followupAgent = {
  session: {
    append(type, data) {
      appends.push({ type, data });
    },
  },
  followup(message) {
    followups.push(message);
  },
};
calls.length = 0;
const followSearch = await service.execute(followupAgent, line('genspark-search', 'Tokyo'), [], signal());
check('succeeds even with a followup-capable agent', followSearch?.result?.kind === 'success', followSearch?.result?.text?.slice(0, 50));
// The hand-off is deferred to the next tick so it does not delay command completion (and does not block command/done)
await new Promise((resolve) => setTimeout(resolve, 0));
check('followup is called exactly once', followups.length === 1, `calls: ${followups.length}`);
check(
  'followup source is the canonical V4 producer kind',
  followups[0]?.source?.kind === 'plugin:dsh-genspark',
  JSON.stringify(followups[0]?.source),
);
const followText = followups[0]?.content?.[0]?.text ?? '';
check('followup text contains the heading and the result', followText.includes('Genspark command result for /genspark-search Tokyo.') && followText.includes('Status: success'), followText.slice(0, 70));
check('followup includes the result body (same content as the command pane)', followText.length > followSearch.result.text.length, `${followText.length} chars`);

// --- 5.6 Attachments: real dispatcher admission → local path resolution in the handler ---
// The host passes `invocation.attachments` only to commands that declare `input.attachments === true`.
// If the declaration is missing, the user gets a "this command does not accept attachments" toast (the bug at hand).
const IMAGE_BASE64 = Buffer.from('fake-image-bytes').toString('base64');
// The real store (dsh-attachment-local) imageHostPath returns `<root>/objects/xx/<sha256>` = no extension.
// Use the same shape here to confirm the command can copy it to an extension-bearing path.
const attachRoot = mkdtempSync(join(tmpdir(), 'genspark-attach-store-'));
const imageObjectPath = join(attachRoot, 'objects', 'ab', 'ab'.padEnd(64, 'c'));
mkdirSync(dirname(imageObjectPath), { recursive: true });
writeFileSync(imageObjectPath, 'fake-image-bytes');
const attachmentStore = {
  async saveImages(inputs) {
    return inputs.map((input, index) => ({
      attachmentId: `sha256:img${index}`,
      mediaType: input.mediaType,
      ...(input.name === undefined ? {} : { name: input.name }),
    }));
  },
  imageHostPath: () => imageObjectPath,
};
const attachEnv = await makeRuntime({ attachments: attachmentStore, cwd: attachRoot });
const imageAttachment = { type: 'image', mediaType: 'image/png', data: IMAGE_BASE64, name: 'cat.png' };

attachEnv.calls.length = 0;
const refused = await attachEnv.service.execute(attachEnv.agent, line('genspark-search', 'Tokyo'), [imageAttachment], signal());
check(
  'the host rejects an undeclared attachment at admission',
  refused?.result?.kind === 'error' && /does not accept attachments/.test(refused.result.text),
  refused?.result?.text?.slice(0, 60),
);
check('no CLI call on rejection', attachEnv.calls.length === 0, `runner calls: ${attachEnv.calls.length}`);

attachEnv.calls.length = 0;
const visionWithImage = await attachEnv.service.execute(attachEnv.agent, line('genspark-analyze-media'), [imageAttachment], signal());
const attachRun = attachEnv.ranTools()[0];
check(
  'a command that declares attachments runs with one attached',
  visionWithImage?.result?.kind === 'success',
  visionWithImage?.result?.text?.split('\n')[0]?.slice(0, 60),
);
check(
  'the attachment resolves to a host path, is copied with an extension, and reaches understand_images',
  attachRun?.toolName === 'understand_images' &&
    /\.png$/.test(String(attachRun?.toolArgs?.image_urls?.[0] ?? '')) &&
    existsSync(String(attachRun?.toolArgs?.image_urls?.[0] ?? '')),
  JSON.stringify(attachRun?.toolArgs),
);

attachEnv.calls.length = 0;
const visionWithFile = await attachEnv.service.execute(
  attachEnv.agent,
  line('genspark-analyze-media'),
  [{ type: 'file', receiptId: 'rcpt-unknown' }],
  signal(),
);
check(
  'file attachments are accepted (an unknown receipt is explained by the host in English)',
  visionWithFile?.result?.kind === 'error' && /File upload receipt is unknown/.test(visionWithFile.result.text),
  visionWithFile?.result?.text?.slice(0, 60),
);
attachEnv.fiber.dispose();
await settle();

// In profiles without the attachments service, the host returns the reason even when declared
const noStoreEnv = await makeRuntime({});
const noStore = await noStoreEnv.service.execute(noStoreEnv.agent, line('genspark-analyze-media'), [imageAttachment], signal());
check(
  'the host returns a reason when the attachments service is absent',
  noStore?.result?.kind === 'error' && /no attachment store is composed/.test(noStore.result.text),
  noStore?.result?.text?.slice(0, 70),
);
noStoreEnv.fiber.dispose();
await settle();

// --- 6. All 14 commands resolve through the dispatcher ----------------------------
const unresolved = [];
for (const definition of env.definitions) {
  const settled = await service.execute(agent, `/${definition.name}`, [], signal());
  if (settled === undefined) unresolved.push(definition.name);
}
check('all 14 commands resolve through execute', unresolved.length === 0, unresolved.join(', ') || '14/14');

// --- 7. An aborted signal does not run the handler --------------------------------
calls.length = 0;
const controller = new AbortController();
controller.abort();
let aborted = false;
try {
  await service.execute(agent, line('genspark-search', 'Tokyo'), [], controller.signal);
} catch {
  aborted = true;
}
check('an already-aborted signal throws', aborted);
check('no CLI call on abort', calls.length === 0, `runner calls: ${calls.length}`);

// --- 8. How the host handles a handler that throws (why this design was chosen) ---
service.register({
  name: 'genspark-throw-probe',
  description: 'probe',
  handler: async () => {
    throw new Error('probe failure');
  },
});
appends.length = 0;
let thrown = false;
try {
  await service.execute(agent, '/genspark-throw-probe', [], signal());
} catch {
  thrown = true;
}
check('handler throws propagate from execute', thrown);
check('command/done still records an error on throw', appends.at(-1)?.type === 'command/done' && appends.at(-1)?.data?.kind === 'error');

env.fiber.dispose();
await settle();

// --- 9. Run through the real CLI (--with-cli) -------------------------------------
if (withCli) {
  console.log('\nVia the real CLI (read-only only)\n');
  const { createRunner } = await loadLocal('lib/gsk-cli.js');
  const { createCatalogCache } = await loadLocal('lib/catalog.js');
  const config = { promotedCategories: ['search', 'media'], timeoutMs: 600000, maxChars: 100000, debug: false };
  const runner = createRunner({ getConfig: () => config, env: process.env });
  const catalog = createCatalogCache({ getConfig: () => config, log });
  const definitions = buildGensparkCommands({ getConfig: () => config, runner, catalog, log });
  const app = new cordis.Context();
  const fiber = app.plugin(commandsModule.default ?? commandsModule.CommandRuntime);
  await settle();
  for (const definition of definitions) app.commands.register(definition);
  const appends = [];
  const agent = { session: { append(type, data) { appends.push({ type, data }); } } };

  const cliSearch = await app.commands.execute(agent, '/genspark-search DeepSeek Harness plugin', [], signal());
  check(
    '/genspark-search succeeds with the real CLI',
    cliSearch?.result?.kind === 'success' && /organic_results/.test(cliSearch.result.text),
    cliSearch?.result?.text?.split('\n')[0]?.slice(0, 70),
  );
  const cliVisionAvailable = (() => {
    try { return agent.session?.header?.cwd ?? process.cwd(), true; } catch { return true; }
  })();
  // Vision requires a local file, but here we only confirm command registration (the real image is covered in integration)
  const cliVision = await app.commands.execute(agent, '/genspark-analyze-media D:\\Documents\\deepseek-harness\\default-workspace\\genspark-out\\test_cat.jpg', [], signal());
  check(
    '/genspark-analyze-media succeeds with the real CLI (image)',
    cliVision?.result?.kind === 'success' && /cat|analysis/i.test(cliVision.result.text),
    cliVision?.result?.text?.split('\n')[0]?.slice(0, 70),
  );
  void cliVisionAvailable;
  const cliStatus = await app.commands.execute(agent, '/genspark', [], signal());
  check(
    '/genspark succeeds with the real CLI',
    cliStatus?.result?.kind === 'success' && /Available commands:/.test(cliStatus.result.text),
    cliStatus?.result?.text?.split('\n')[0]?.slice(0, 70),
  );
  check('lifecycle events remain on real CLI runs', appends.filter((e) => e.type === 'command/run').length === 3, `${appends.filter((e) => e.type === 'command/run').length} events`);

  // The real CLI result is passed to the model as-is (the exact path requested in this work)
  const cliFollowups = [];
  const followupAgent = {
    session: { append(type, data) { appends.push({ type, data }); } },
    followup(message) { cliFollowups.push(message); },
  };
  const cliFollowSearch = await app.commands.execute(followupAgent, '/genspark-search DeepSeek Harness plugin', [], signal());
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cliFollowText = cliFollowups[0]?.content?.[0]?.text ?? '';
  check(
    'real CLI search results are handed off to the model',
    cliFollowups.length === 1 && cliFollowText.includes('Status: success') && cliFollowText.includes(cliFollowSearch.result.text),
    `${cliFollowText.length} chars / ${cliFollowups.length} calls`,
  );
  check(
    'the follow-up text ends with the English instruction',
    cliFollowText.includes('Do not repeat it; briefly state the key points and what they mean.'),
    cliFollowText.slice(-60).replace(/\n/g, ' '),
  );
  fiber.dispose();
  await settle();
}

console.log(`\nResult: ${ok} passed / ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
