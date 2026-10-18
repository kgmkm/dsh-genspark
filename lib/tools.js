/**
 * DSH ツール定義の組み立て（ホスト非依存）。
 *
 * `defineTool` を引数で受け取るのは、この層をホスト無しで単体テストできるようにするため。
 * index.js がホストの `@deepseek-ai/dsh-tools` から defineTool を渡して呼ぶ。
 *
 * 登録するのはカテゴリ非依存の 4 ツール:
 *   - genspark_run    : 任意の Genspark ツールを実行（引数は JSON オブジェクト）
 *   - genspark_tools  : 実カタログ（327 ツール）の閲覧・検索・完全スキーマ表示
 *   - genspark_models : 生成モデル（画像・動画・音声・文字起こし）の一覧
 *   - genspark_status : 認証・CLI エントリ・書き込みポリシーの確認
 *
 * カテゴリ厳選の「型付きツール」は、この 4 つの上に後から追加できる（設定で有効化）。
 */
import { describeCatalogFull, describeToolFull, filterTools, groupSummary, summarizeCatalog, toolInvocation } from './catalog.js';
import { collectModels, formatModelList } from './models.js';
import { AUTH_HINT, CONFIRM_HINT, INTERACTIVE_HINT, describeRun, formatData, truncate } from './result.js';

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
};

/** 書き込み系の扱いを設定から解決する。 */
export function resolveWritePolicy(config, approveWrite) {
  const mode = String(config?.writeMode ?? 'approve');
  if (mode === 'deny') {
    return { flags: ['--no-input'], approved: false, mode, note: '書き込み系は無効（--no-input 固定）' };
  }
  if (mode === 'allow') {
    return { flags: [], approved: true, mode, note: 'CLI の既定動作（対話プロンプトは EOF で拒否）' };
  }
  return approveWrite
    ? { flags: ['--yes'], approved: true, mode, note: '承認済み（--yes）' }
    : { flags: ['--no-input'], approved: false, mode, note: '未承認（--no-input。承認が必要な操作はサーバー呼び出しなしで拒否）' };
}

/** ツールスキーマ上、確認が必要な操作かどうか。 */
export function schemaRequiresConfirmation(schema, args) {
  const cli = schema?.cli ?? {};
  if (cli.requires_confirmation) return true;
  if (cli.interactive_only) return true;
  const action = args?.action;
  if (action && schema?.actions?.[action]) {
    const info = schema.actions[action];
    if (info.requires_confirmation || info.interactive_only) return true;
  }
  return false;
}

export function buildGensparkTools({ defineTool, getConfig, runner, catalog, log, statusLines } = {}) {
  const config = () => (typeof getConfig === 'function' ? getConfig() : getConfig) ?? {};
  const maxChars = () => Number(config().maxOutputChars ?? 100000);

  const runTool = defineTool({
    name: 'genspark_run',
    description:
      'Genspark の任意のツールを実行する（Genspark CLI `gsk` 経由）。' +
      'tool に Genspark のツール名（例: web_search, crawler, image_generation, video_generation, audio_generation, ' +
      'understand_images, aidrive, create_task, connector_call, stock_price …）、args にそのツールの引数を JSON オブジェクトで渡す。' +
      '利用可能なツール名と引数は genspark_tools で確認できる（keyword で絞り、full=true で完全スキーマ）。' +
      'グループ付きのツール（例: social_twitter → `gsk social twitter`、x_search_tweets → `gsk x search_tweets`）も、' +
      'カタログの cli 情報から正しいコマンド名を解決して実行する。' +
      '結果は Genspark API の JSON（status/message/data）を整形して返す。' +
      '副作用のある操作（メール送信・Slack 投稿・SNS 投稿・電話発信など）は確認が必要で、' +
      '未承認のまま呼ぶと実行されずに拒否される。その場合はユーザーの承認を得てから approve_write=true を付けて再実行する。',
    parameters: {
      tool: {
        type: 'string',
        required: true,
        description: 'Genspark のツール名（例: web_search, crawler, image_generation, create_task）。',
      },
      args: {
        type: 'json',
        description:
          'そのツールへ渡す引数の JSON オブジェクト（例: {"q":"latest AI news"}）。' +
          'genspark_tools を full=true で呼ぶと、各ツールの正確な引数名・型・必須が分かる。',
      },
      approve_write: {
        type: 'boolean',
        description:
          'ユーザーが明示的に承認した場合のみ true。true のとき確認プロンプトをスキップして実行する（--yes）。' +
          '読み取り専用のツールでは不要。',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const cfg = config();
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
      const toolName = String(args.tool ?? '').trim();
      if (toolName.length === 0) return 'tool 名を指定してください。';

      // カタログのキャッシュがあれば、対話必須の操作を事前に弾く（無駄なプロセス起動を避ける）
      const cached = catalog?.peek?.();
      const schema = cached?.tools?.find((item) => item.name === toolName);
      if (schema?.cli?.interactive_only) return INTERACTIVE_HINT;

      const policy = resolveWritePolicy(cfg, args.approve_write === true);
      if (schema && schemaRequiresConfirmation(schema, args.args) && !policy.approved) {
        log?.(`[genspark] ${toolName} は確認が必要なため未承認として実行します`);
      }

      const timeoutMs = Number(cfg.timeoutMs ?? 600000);
      const runOnce = (segments) =>
        runner.runTool(toolName, args.args ?? {}, {
          cwd,
          signal: exec?.signal,
          timeoutMs,
          globalArgs: ['--output', 'json', '--timeout', String(timeoutMs), ...policy.flags],
          toolCommand: segments,
        });

      // グループ付きツール（social_twitter → `gsk social twitter`）はカタログの cli 情報で解決する。
      // キャッシュが無い状態でも呼べるよう、`unknown command` で落ちたときだけカタログを取り直して再試行する。
      let segments = schema ? toolInvocation(schema) : [toolName];
      let result;
      try {
        result = await runOnce(segments);
      } catch (error) {
        if (error?.code === 'GSK_ENTRY_NOT_FOUND') return error.message;
        return `実行に失敗しました: ${error?.message ?? String(error)}`;
      }

      if (!result.ok && segments.length === 1 && /unknown command/i.test(result.stderr ?? '')) {
        let resolved = [];
        try {
          const loaded = await catalog.load(runner, { signal: exec?.signal, cwd });
          const found = loaded.tools.find((item) => item.name === toolName);
          if (found) resolved = toolInvocation(found);
        } catch {
          /* カタログが取れない場合は元のエラーをそのまま返す */
        }
        if (resolved.length > 1) {
          log?.(`[genspark] ${toolName} を \`gsk ${resolved.join(' ')}\` として再実行します`);
          segments = resolved;
          try {
            result = await runOnce(segments);
          } catch (error) {
            if (error?.code === 'GSK_ENTRY_NOT_FOUND') return error.message;
            return `実行に失敗しました: ${error?.message ?? String(error)}`;
          }
        }
      }

      const described = describeRun(result, { tool: toolName, maxChars: maxChars() });
      if (cfg.debug && result.stderr?.trim()) {
        log?.(`[genspark] ${toolName} stderr: ${result.stderr.trim().slice(0, 500)}`);
      }
      return described.text;
    },
  });

  const toolsTool = defineTool({
    name: 'genspark_tools',
    description:
      'Genspark のツールカタログ（実測 327 ツール / 32 グループ）を調べる。' +
      '引数なしでグループ別件数と主要ツールの一覧を返す。keyword または group で絞り込み、' +
      'full=true を付けると該当ツールの完全な引数スキーマ（args に渡すキー・型・必須・enum・action 一覧）を返す。' +
      'genspark_run を呼ぶ前に、正確なツール名と引数を確認するために使う。',
    parameters: {
      keyword: {
        type: 'string',
        description: '名前・エイリアス・説明・グループを対象にした絞り込み（空白区切りで AND）。例: "slack send"、"gmail"、"task"。',
      },
      group: { type: 'string', description: 'グループ名で絞り込む（例: email, x, connector, hosted, agentbase）。' },
      full: { type: 'boolean', description: 'true で該当ツールの完全な引数スキーマを返す（既定 false は 1 行要約）。' },
      limit: { type: 'number', description: '返す最大件数（既定 60、full 時は 12）。' },
      refresh: { type: 'boolean', description: 'true でサーバーからカタログを取り直す（既定は 15 分キャッシュ）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
      let loaded;
      try {
        loaded = await catalog.load(runner, { refresh: args.refresh === true, signal: exec?.signal, cwd });
      } catch (error) {
        const message = String(error?.message ?? error);
        const hint = /API key is required/i.test(message) ? `\n${AUTH_HINT}` : '';
        return `カタログを取得できませんでした: ${message}${hint}`;
      }

      const config_ = { keyword: args.keyword, group: args.group };
      if (args.full === true) {
        const limit = Number(args.limit ?? 12);
        const matched = filterTools(loaded.tools, config_);
        if (matched.length === 0) return `該当ツールなし（全 ${loaded.tools.length} ツール）。`;
        return truncate(describeCatalogFull(loaded, { ...config_, limit }), maxChars()).text;
      }
      return summarizeCatalog(loaded, { ...config_, limit: Number(args.limit ?? 60) });
    },
  });

  const modelsTool = defineTool({
    name: 'genspark_models',
    description:
      '画像・動画・音声・文字起こしで**選べるモデルの一覧**を返す（サーバーのカタログの実値をそのまま読むため、' +
      'モデルの追加・廃止に自動で追随する）。「使える動画モデルは？」「音声のモデル一覧」と聞かれたらこれを使う。' +
      'kind で絞り込み、filter で id の部分一致ができる。' +
      '特定モデルの対応比率・尺・音声の有無まで知りたいときは、続けて ' +
      'genspark_run で get_model_info {"model_names":[id]} を実行する。',
    parameters: {
      kind: {
        type: 'string',
        enum: ['image', 'video', 'audio', 'transcribe'],
        description: 'image=画像生成 / video=動画生成 / audio=音声・音楽生成 / transcribe=文字起こし。省略で全部。',
      },
      filter: { type: 'string', description: 'モデル id の部分一致（例: "kling"、"veo"、"elevenlabs"）。' },
      refresh: { type: 'boolean', description: 'true でサーバーからカタログを取り直す（既定はキャッシュ）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
      let loaded;
      try {
        loaded = await catalog.load(runner, { refresh: args.refresh === true, signal: exec?.signal, cwd });
      } catch (error) {
        const message = String(error?.message ?? error);
        const hint = /API key is required/i.test(message) ? `\n${AUTH_HINT}` : '';
        return `モデル一覧を取得できませんでした: ${message}${hint}`;
      }
      const entries = collectModels(loaded);
      if (entries.length === 0) return 'カタログからモデル一覧を取得できませんでした（`genspark_tools` で引数を確認してください）。';
      return truncate(formatModelList(entries, { kind: args.kind, filter: args.filter }), maxChars()).text;
    },
  });

  const statusTool = defineTool({
    name: 'genspark_status',
    description:
      'Genspark 連携の状態を確認する。CLI の解決パスとバージョン、ログインしているアカウント、' +
      '現在の書き込みポリシー（未承認の副作用操作がどう扱われるか）、カタログのキャッシュ状態を返す。' +
      '認証エラーや「ツールが見つからない」と感じたときの一次切り分けに使う。',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute(_args, exec) {
      const cfg = config();
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
      const lines = [];

      const entry = runner.resolveEntry();
      lines.push(`CLI エントリ: ${entry ?? '未検出（npm install -g @genspark/cli が必要、または設定 cliEntry を指定）'}`);

      const runtime = runner.resolveRuntime?.();
      if (runtime) {
        lines.push(
          `実行ランタイム: ${runtime.path}（${runtime.source}）` +
            (runtime.isElectron
              ? ' ※Electron 実行ファイルのため一部コマンドが失敗します。設定 nodePath に node.exe の絶対パスを指定してください'
              : ''),
        );
      }

      try {
        const version = await runner.run(['--version'], { cwd, timeoutMs: 30000, signal: exec?.signal });
        lines.push(`CLI バージョン: ${String(version.stdout ?? '').trim() || `(不明 / exit ${version.code})`}`);
      } catch (error) {
        lines.push(`CLI バージョン: 取得失敗 (${error?.message ?? error})`);
      }

      try {
        const me = await runner.run(['--output', 'json', 'me'], { cwd, timeoutMs: 60000, signal: exec?.signal });
        const described = describeRun(me, { tool: 'me', maxChars: 4000 });
        lines.push(
          described.ok
            ? `アカウント: ${described.text.replace(/\s+/g, ' ').slice(0, 500)}`
            : `アカウント: ${described.text.replace(/\s+/g, ' ').slice(0, 600)}`,
        );
      } catch (error) {
        lines.push(`アカウント: 取得失敗 (${error?.message ?? error})`);
      }

      const policy = resolveWritePolicy(cfg, false);
      lines.push(`書き込みポリシー: writeMode=${policy.mode}（未承認時: ${policy.note}）`);
      const extra = typeof statusLines === 'function' ? statusLines(cfg) : [];
      for (const line of Array.isArray(extra) ? extra : []) lines.push(line);
      lines.push(`タイムアウト: ${cfg.timeoutMs ?? 600000} ms / 出力上限: ${cfg.maxOutputChars ?? 100000} 文字`);
      const cached = catalog.peek();
      lines.push(
        cached
          ? `カタログ: ${cached.tools.length} ツールをキャッシュ済み（${new Date(cached.fetchedAt).toLocaleString()}）`
          : 'カタログ: 未取得（genspark_tools を呼ぶと取得します）',
      );
      if (entry === null) lines.push(`\n${AUTH_HINT}`);
      return lines.join('\n');
    },
  });

  return [runTool, toolsTool, modelsTool, statusTool];
}

export { CONFIRM_HINT, INTERACTIVE_HINT, formatData, groupSummary, describeToolFull, summarizeCatalog };
