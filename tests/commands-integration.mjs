/**
 * ホストコマンド（`+` メニュー / `/` から実行される 13 コマンド）の実 CLI 統合テスト。
 *
 * 実行:
 *   node tests/commands-integration.mjs                  … 読み取り系のみ（ほぼ無料）
 *   node tests/commands-integration.mjs --with-generation … 画像生成も実行し genspark-out への保存を確認（クレジット消費）
 *
 * コマンドは「モデルメッセージを作らない」ため、ここでは handler を直接呼んで
 * CommandResult（{kind, text}）と実際の CLI 呼び出し結果を検証する。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createCatalogCache } from '../lib/catalog.js';
import { createRunner } from '../lib/gsk-cli.js';
import { buildGensparkCommands } from '../lib/commands.js';

const argv = process.argv.slice(2);
const withGeneration = argv.includes('--with-generation');

const cwd = process.cwd();
const config = {
  timeoutMs: 600000,
  maxOutputChars: 20000,
  writeMode: 'approve',
  promotedCategories: ['search', 'media'],
  debug: false,
};
const runner = createRunner({ getConfig: () => config });
const catalog = createCatalogCache({ getConfig: () => config, log: () => {} });
const commands = buildGensparkCommands({
  getConfig: () => config,
  runner,
  catalog,
  log: (message) => console.log(message),
});
const byName = new Map(commands.map((command) => [command.name, command]));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const flat = (text) => String(text).replace(/\s+/g, ' ').slice(0, 160);
const invoke = (name, rawInput) => {
  const command = byName.get(name);
  if (!command) throw new Error(`コマンド ${name} が登録されていません`);
  return command.handler({ agent: { session: { header: { cwd } } }, rawInput, signal: undefined });
};

if (!runner.resolveEntry()) {
  console.error('CLI エントリが見つかりません（npm install -g @genspark/cli が必要）');
  process.exit(1);
}

// 1) 登録数
record('コマンドの登録数', commands.length === 13, `${commands.length} 件: ${commands.map((c) => c.name).join(', ')}`);

// 2) /genspark（引数なし・状態表示）
const status = await invoke('genspark', '');
record(
  '/genspark（状態表示）',
  status.kind === 'success' && /CLI/.test(status.text) && /昇格ツール/.test(status.text) && /genspark-search/.test(status.text),
  flat(status.text),
);

// 3) /genspark-tools（グループ一覧 → 単一一致で完全スキーマ）
const groups = await invoke('genspark-tools', '');
record('/genspark-tools（グループ一覧）', groups.kind === 'success' && /ツール/.test(groups.text), flat(groups.text));
const oneTool = await invoke('genspark-tools', 'crawler');
record(
  '/genspark-tools crawler（完全スキーマ）',
  oneTool.kind === 'success' && /crawler/.test(oneTool.text) && /url/.test(oneTool.text) && /実行例/.test(oneTool.text),
  flat(oneTool.text),
);

// 4) /genspark-run（読み取り系の実行）
const me = await invoke('genspark-run', 'me');
record('/genspark-run me', me.kind === 'success' && /backorz@gmail\.com|plan/i.test(me.text), flat(me.text));

// 5) /genspark-run の事前拒否（CLI を起動しない）
const broken = await invoke('genspark-run', 'web_search {"q":');
record('壊れた JSON を拒否', broken.kind === 'error' && /JSON/.test(broken.text), flat(broken.text));
const unknown = await invoke('genspark-run', 'no_such_tool_xyz');
record('存在しないツールを拒否', unknown.kind === 'error' && /というツールはありません/.test(unknown.text), flat(unknown.text));

const full = await catalog.load(runner, { cwd });
const interactive = (full.tools ?? []).find((tool) => tool.cli?.interactive_only);
const confirming = (full.tools ?? []).find((tool) => tool.cli?.requires_confirmation && !tool.cli?.interactive_only);
if (interactive) {
  const blocked = await invoke('genspark-run', interactive.name);
  record(`対話必須を拒否（${interactive.name}）`, blocked.kind === 'error' && /対話必須/.test(blocked.text), flat(blocked.text));
} else {
  record('対話必須を拒否', false, 'interactive_only のツールが見つかりません');
}
if (confirming) {
  const blocked = await invoke('genspark-run', confirming.name);
  record(`要確認を拒否（${confirming.name}）`, blocked.kind === 'error' && /確認が必要/.test(blocked.text), flat(blocked.text));
} else {
  record('要確認を拒否', false, 'requires_confirmation のツールが見つかりません');
}

// 6) 昇格コマンドの入力検証
const emptySearch = await invoke('genspark-search', '');
record('空入力は CLI を起動せずエラー', emptySearch.kind === 'error' && /入力が必要/.test(emptySearch.text), flat(emptySearch.text));

// 7) 実検索（結果が人間向けに整形され、生 JSON を出さない）
const search = await invoke('genspark-search', 'DeepSeek Harness plugin');
record(
  '/genspark-search（実検索・整形）',
  search.kind === 'success' && /件/.test(search.text) && /https?:\/\//.test(search.text) && !/\{"[a-z_]+":/.test(search.text),
  flat(search.text),
);

// 8) analyze-media（メディア解析）— サンプル画像で実走（読み取りのみ）
const visionImage = await invoke('genspark-analyze-media', 'D:\\Documents\\deepseek-harness\\default-workspace\\genspark-out\\test_cat.jpg');
record('/genspark-analyze-media 画像', visionImage.kind === 'success' && /猫|ねこ|cat/i.test(visionImage.text) || /analysis|内容/i.test(visionImage.text), flat(visionImage.text));

// 9) 生成コマンド（任意・クレジット消費）
if (withGeneration) {
  const outDir = join(cwd, 'genspark-out');
  const before = existsSync(outDir) ? readdirSync(outDir).length : 0;
  const image = await invoke('genspark-image', 'a red cube on a white background');
  const after = existsSync(outDir) ? readdirSync(outDir).length : 0;
  const newest = existsSync(outDir)
    ? readdirSync(outDir)
        .map((file) => join(outDir, file))
        .filter((file) => statSync(file).isFile())
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
    : undefined;
  const size = newest ? statSync(newest).size : 0;
  record(
    '/genspark-image（生成 + genspark-out 保存）',
    image.kind === 'success' && after > before && size > 1000 && /保存ファイル/.test(image.text),
    `${newest ?? '(保存なし)'} (${size} バイト)`,
  );
} else {
  console.log('ℹ 生成コマンドの実走はスキップ（--with-generation で実行）');
}

// 10) 長時間かかるコマンドの早期リターン（入力欄の凍結を短くする経路）
//     ホストはコマンド完了まで送信トランザクション中で入力欄が凍結するため、
//     commandInlineWaitMs を過ぎたら「実行中です」を返し、結果は引き継ぎでチャットへ届ける。
const seen = [];
const followupAgent = {
  session: { header: { cwd } },
  followup(message) {
    seen.push(message);
  },
};
const waitForFollowup = async (timeoutMs) => {
  const started = Date.now();
  while (seen.length === 0 && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};
config.commandInlineWaitMs = 1;
const early = await byName
  .get('genspark-run')
  .handler({ agent: followupAgent, rawInput: 'me', signal: undefined });
config.commandInlineWaitMs = 2500;
await waitForFollowup(30000);
const followupText = seen[0]?.content?.[0]?.text ?? '';
record(
  '早期リターン（結果は引き継ぎで届く）',
  early.kind === 'success' &&
    /結果はこのあとチャットに届きます/.test(early.text) &&
    seen.length === 1 &&
    /状態: 成功/.test(followupText) &&
    /backorz@gmail\.com|plan/i.test(followupText),
  `${flat(early.text)} / 引き継ぎ ${seen.length} 件: ${flat(followupText)}`,
);

const failed = results.filter((entry) => !entry.ok);
console.log(`\n== ${results.length - failed.length}/${results.length} 成功 ==`);
if (failed.length > 0) {
  console.log('失敗: ' + failed.map((entry) => entry.name).join(', '));
  process.exit(1);
}
