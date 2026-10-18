// 引き継ぎメッセージが**ホスト実物のセッション形式 V4 検証**を通ることを固定するプリフライト。
//
// 背景（実機で起きた不具合）:
//   コマンド結果をモデルへ渡す `agent.followup` に `source: { kind: 'plugin', plugin: 'dsh-genspark' }`
//   を付けていたところ、ホストが
//     「format v4 message requires a producer-owned source kind」
//   で拒否し、そのターンが丸ごと失敗した（チャットが使えなくなる）。
//   V3 の `kind: 'plugin'` ラッパーは廃止済みで、V4 の正準は `kind: 'plugin:<プラグイン名>'`。
//   偽の agent を使う単体テストでは検証器を通らないため、この不具合は見えなかった。
//
// ここでは実物の `assertV4RowAdmission`（dsh-session-format-v3-to-v4）に、
// プラグインが実際に送るメッセージを `user/message` 行と `agent/inbox/spliced` 行の両方の形で通す。
//
// 使い方: node tests/preflight-message-source.mjs
// 前提  : reference/asar/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4（抽出済み）

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const hostModules = join(root, 'reference/asar/node_modules/@deepseek-ai');

const load = (relative) =>
  import(new URL(`file://${join(hostModules, relative).replace(/\\/g, '/')}`).href);
const loadLocal = (relative) =>
  import(new URL(`file://${join(here, '..', relative).replace(/\\/g, '/')}`).href);

const format = await load('dsh-session-format-v3-to-v4/lib/index.js');
const { buildGensparkCommands } = await loadLocal('lib/commands.js');

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

/** 行を実物の検証器に通す。拒否されたらそのメッセージを返す（通れば null）。 */
const admit = (row) => {
  try {
    format.assertV4RowAdmission(row);
    return null;
  } catch (error) {
    return error?.message ?? String(error);
  }
};

const settle = () => new Promise((done) => setTimeout(done, 0));

const FAKE_TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web',
    cli: { group: 'search' },
    parameters: { properties: { q: { type: 'string' } }, required: ['q'] },
  },
];

function makeCommands() {
  return buildGensparkCommands({
    getConfig: () => ({
      timeoutMs: 600000,
      maxOutputChars: 100000,
      promotedCategories: ['search', 'media'],
      writeMode: 'approve',
      commandFollowup: true,
    }),
    runner: {
      async runTool(toolName, toolArgs) {
        return {
          code: 0,
          stdout: JSON.stringify({ status: 'ok', message: 'success', data: { echo: toolArgs, tool: toolName } }),
          stderr: '',
          ok: true,
        };
      },
      resolveEntry: () => 'C:\\fake\\@genspark\\cli\\dist\\index.js',
      resolveRuntime: () => ({ path: 'C:\\node.exe', source: 'auto' }),
    },
    catalog: { async load() { return { tools: FAKE_TOOLS }; } },
  });
}

// ── 1. 実機の不具合（V3 ラッパー）が実物の検証器で今も拒否されることの確認 ───────────
console.log('1. 実物の検証器の挙動（実機で起きた拒否の再現）');
const legacyMessage = {
  content: [{ type: 'text', text: 'テスト' }],
  source: { kind: 'plugin', plugin: 'dsh-genspark' },
};
const legacyUserRow = admit({ type: 'user/message', data: legacyMessage });
check(
  'V3 の kind:"plugin" は user/message 行として拒否される（実機の不具合の再現）',
  typeof legacyUserRow === 'string' && /producer-owned source kind/.test(legacyUserRow),
  legacyUserRow ?? '（拒否されなかった）',
);
const legacyInboxRow = admit({
  type: 'agent/inbox/spliced',
  data: { target: 'next-turn', start: 0, inserted: [legacyMessage] },
});
check(
  'V3 の kind:"plugin" は agent/inbox/spliced 行としても拒否される',
  typeof legacyInboxRow === 'string' && /producer-owned source kind/.test(legacyInboxRow),
  legacyInboxRow ?? '（拒否されなかった）',
);

// ── 2. 14 コマンドすべての引き継ぎメッセージが検証を通ること ─────────────────────────
console.log('\n2. 14 コマンドの引き継ぎメッセージ（エラー経路 = 入力なし）');
const commands = makeCommands();
const seen = [];
const agent = {
  session: { header: { cwd: process.cwd() } },
  followup(message) {
    seen.push(message);
  },
};
const invocation = (rawInput) => ({ rawInput, commandId: 'c1', attachments: [], signal: undefined, agent });

for (const command of commands) {
  const before = seen.length;
  await command.handler(invocation(''));
  await settle();
  const message = seen[before];
  if (message === undefined) {
    check(`/${command.name} の引き継ぎメッセージが送られる`, false, '送られていない');
    continue;
  }
  const reason =
    admit({ type: 'user/message', data: message }) ??
    admit({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [message] } });
  check(
    `/${command.name} の引き継ぎメッセージが V4 検証を通る`,
    reason === null,
    reason === null ? `source=${JSON.stringify(message.source)}` : reason,
  );
}

// ── 3. 成功経路のメッセージも検証を通ること ────────────────────────────────────────
console.log('\n3. 成功経路（偽 CLI が ok を返す）');
for (const [name, input] of [
  ['genspark-search', 'テスト'],
  ['genspark-crawl', 'https://example.com/'],
  ['genspark-analyze-media', 'https://example.com/photo.jpg'],
]) {
  const command = commands.find((item) => item.name === name);
  const before = seen.length;
  const result = await command.handler(invocation(input));
  await settle();
  const message = seen[before];
  const reason = message === undefined ? '引き継ぎが送られていない' : admit({ type: 'user/message', data: message });
  check(
    `/${name}（成功）の引き継ぎメッセージが V4 検証を通る`,
    result.kind === 'success' && reason === null,
    reason === null ? `状態行=${/状態: (\S+)/.exec(message.content[0].text)?.[1]}` : reason,
  );
}

console.log(`\n結果: 成功 ${ok} / 失敗 ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
