/**
 * dsh-genspark — DeepSeek Harness から Genspark の各種機能（検索・クロール・画像/動画/音声生成・
 * メディア理解・文字起こし・AI Drive・タスクエージェント・コネクタ・SNS・株価・電話 等、実測 327 ツール）を
 * 利用可能にする Cordis プラグイン。
 *
 * 方式（実測に基づく確定仕様。docs/00-genspark-cli-spec-review.md を参照）:
 *   - 認証は既存の `gsk login`（~/.genspark-tool-cli/config.json）をそのまま利用する。
 *     プラグインは秘密情報を保持しない。
 *   - `@genspark/cli` を子プロセスとして起動する（shim ではなく node <dist/index.js>）。
 *   - stdin は閉じ、stdout/stderr は一時ファイルの fd へリダイレクトする（パイプは EPERM のため）。
 *   - GSK_NO_AUTO_UPDATE=1 を注入する（自己更新は終了コードを汚染するため切り離す）。
 *   - 引数は `--args-file` で一時 JSON を渡す（シェル引用を一切経由しない）。
 *   - 副作用のある操作は既定で未承認＝`--no-input`（サーバー呼び出しなしで拒否）。
 *     ユーザーの承認後に `approve_write: true` で `--yes` を渡す。
 *
 * カテゴリ厳選の型付きツールは、このプラグインが提供する genspark_run / genspark_tools の上に
 * 後から追加できる（writeMode / enabled 等の設定は cordis.patch.yml から変更できる）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createCatalogCache } from './lib/catalog.js';
import { buildGensparkCommands } from './lib/commands.js';
import { createRunner } from './lib/gsk-cli.js';
import { buildPromotedTools, promotedSummary } from './lib/promoted.js';
import { buildGensparkTools } from './lib/tools.js';

/** Cordis プラグイン名（row id と一致させる）。 */
export const name = 'dsh-genspark';

/** ツールレジストリのみ必要（gsk の実行は子プロセスとファイルシステムだけで完結する）。 */
export const inject = ['tools'];

/**
 * 設定スキーマ（cordis.patch.yml の config から与えられる）。
 *
 * `@deepseek-ai/schemastery` はプロファイルに hoisted されている通常は解決できるが、
 * プラグインをシンボリックリンク/ジャンクションで参照した場合は実パス基準の解決になり
 * 見つからないことがある。スキーマが無くても生の config で動作するため、読み込みは任意化する。
 */
async function loadConfigSchema() {
  try {
    const z = (await import('@deepseek-ai/schemastery')).default;
    return z.object({
      /** 総スイッチ。false でツール登録をすべて解除する（設定を変えた場合は再読込で反映）。 */
      enabled: z.boolean().default(true),
      /**
       * @genspark/cli のエントリ（dist/index.js）の絶対パス。
       * 空なら npm のグローバル導入先などを自動探索する。
       */
      cliEntry: z.string().default(''),
      /**
       * 子プロセスの実行に使う Node 実行ファイル（node.exe）の絶対パス。
       * 空なら自動探索する。DSH は Electron 上で動くため process.execPath は Electron 本体で
       * あり、そのまま使うと commander が Electron 用の argv 解釈に切り替わって
       * `error: unknown command '<dist/index.js>'` で落ちる。実 Node を優先採用する。
       */
      nodePath: z.string().default(''),
      /**
       * 副作用のある操作の扱い。
       *   approve … 未承認なら --no-input（拒否）、approve_write=true で --yes（既定）
       *   deny    … 常に --no-input（書き込みは一切実行しない）
       *   allow   … CLI の既定（対話プロンプトは stdin が閉じているため拒否に倒れる）
       */
      writeMode: z.union([z.const('approve'), z.const('deny'), z.const('allow')]).default('approve'),
      /** gsk 1 回あたりのタイムアウト（ミリ秒）。長時間タスクは run_id を受け取って後から確認する。 */
      timeoutMs: z.number().default(600000),
      /** ツール結果としてモデルへ返す最大文字数。 */
      maxOutputChars: z.number().default(100000),
      /** 一時ファイル（--args-file と stdout/stderr）を置くディレクトリ。空なら OS の一時領域。 */
      tmpDir: z.string().default(''),
      /** ツールカタログのキャッシュ有効期間（ミリ秒）。既定 15 分。 */
      catalogTtlMs: z.number().default(900000),
      /** カタログ取得（gsk ls）のタイムアウト（ミリ秒）。 */
      catalogTimeoutMs: z.number().default(120000),
      /** 子プロセスの stderr をログへ出す。 */
      debug: z.boolean().default(false),
      /**
       * 型付きツール（昇格ツール）として登録するカテゴリ。
       *   search … 検索・調査（web_search / image_search / crawler / scholar_search / maps_search / summarize）
       *   media  … 生成メディア（image / video / audio / vision）
       *   social … ソーシャルメディア（枠のみ。ツールは未実装）
       * 空配列にすると genspark_run / genspark_tools / genspark_status の 3 つだけになる。
       */
      promotedCategories: z.array(z.string()).default(['search', 'media']),
      /**
       * コンポーザの `+` メニュー / `/` から呼べるホストコマンドを登録する。
       * コマンド自体はモデルメッセージを作らない（結果はモデル履歴の外に描画される）。
       * どのコマンドを出すかは promotedCategories に従う（search / media を外せばそのカテゴリの
       * コマンドも消える）。ホストに commands サービスが無い場合は何もしない（登録は任意依存）。
       */
      commands: z.boolean().default(true),
      /**
       * コマンドの実行結果をエージェントの次のターンへ引き継ぎ、AI がチャットで解釈を返せるようにする。
       *
       * ホストコマンドの結果は既定では画面のコマンド欄にしか出ないため、そのままでは
       * 「検索結果の山」を AI が読めない。有効にすると実行後に `agent.followup` で結果を
       * モデルへ渡し、要点と解釈を日本語で答えさせる（トークンは通常の入力と同じだけ消費する）。
       * false にすると従来どおりモデル履歴を消費しない。
       */
      commandFollowup: z.boolean().default(true),
      /**
       * コマンド handler の完了を待つ上限（ミリ秒）。
       *
       * ホストはコマンドが完了するまで送信トランザクション中（phase = submitting）で、
       * その間コンポーザは編集不可・下書きは保持される。画像生成など 8 秒かかるコマンドでは
       * その間ずっと入力欄が凍結するため、この時間でコマンドを先に完了させ、
       * 結果は commandFollowup の引き継ぎ（チャット）で届ける。
       * 0 以下にすると従来どおり完了まで待ち、結果をコマンド欄に出す。
       */
      commandInlineWaitMs: z.number().default(2500),
    });
  } catch {
    return undefined;
  }
}

export const Config = await loadConfigSchema();

export function apply(ctx, config) {
  const getConfig = () => {
    const value = typeof config?.get === 'function' ? config.get() : config;
    return value ?? {};
  };
  const log = (message) => {
    try {
      ctx.logger?.debug?.(message);
    } catch {
      /* ロガー未提供でも動作は継続する */
    }
  };

  const runner = createRunner({ getConfig });
  const catalog = createCatalogCache({ getConfig, log });

  let fiber = null;
  let commandFiber = null;
  /**
   * コマンド登録の結果。`genspark_status` に出す。
   * メニューに行が出ないときの切り分け（サービスが無いのか / 登録で throw したのか）を
   * ログを追わずに GUI 上で確認できるようにするためのもの。
   */
  let commandState = '未登録（ホストに commands サービスが無い、または commands=false）';

  /**
   * ホストコマンド（`+` メニュー / `/`）を登録する。
   *
   * `commands` はデスクトップ GUI にしか無いサービスなので、必須 inject にはせず
   * `ctx.inject(['commands'], …)`（＝任意依存）で待ち合わせる。サービスが現れなければ
   * コールバックは実行されず、ツール側はそのまま動く。
   */
  const installCommands = () => {
    if (commandFiber !== null) return;
    if (getConfig().commands === false) {
      commandState = '設定 commands=false のため無効';
      return;
    }
    if (typeof ctx.inject !== 'function') {
      commandState = 'このホストでは登録できません（ctx.inject が無い）';
      log('[genspark] このホストには commands サービスが無いためコマンドは登録しません');
      return;
    }
    try {
      commandFiber = ctx.inject(['commands'], (inner) => {
        const commands = buildGensparkCommands({
          getConfig,
          runner,
          catalog,
          log: (message) => {
            try {
              inner.logger?.debug?.(message);
            } catch {
              /* noop */
            }
          },
        });
        let registered = 0;
        for (const command of commands) {
          try {
            inner.commands.register(command);
            registered += 1;
          } catch (error) {
            inner.logger?.warn?.(`[genspark] コマンド ${command.name} の登録に失敗: ${String(error)}`);
          }
        }
        commandState =
          registered === commands.length
            ? `${registered} 件を登録しました（/${commands.map((c) => c.name).join(' /')}）`
            : `${commands.length} 件中 ${registered} 件のみ登録（失敗の詳細はログ）`;
        // 登録できたかどうかは再起動後の切り分けで効くので info で出す（debug は既定で出ないことがある）
        inner.logger?.info?.(`[genspark] コマンド ${commandState}`);
      });
    } catch (error) {
      commandFiber = null;
      commandState = `登録開始に失敗: ${String(error)}`;
      ctx.logger?.warn?.(`[genspark] コマンド登録の開始に失敗: ${String(error)}`);
    }
  };

  const uninstallCommands = () => {
    if (commandFiber === null) return;
    const current = commandFiber;
    commandFiber = null;
    commandState = '登録解除しました';
    Promise.resolve(current.dispose()).catch((error) => {
      ctx.logger?.warn?.(`[genspark] コマンド解除に失敗: ${String(error)}`);
    });
  };

  const install = () => {
    if (fiber !== null) return;
    fiber = ctx.plugin({
      name: 'dsh-genspark:tools',
      apply(inner) {
        // ツール登録は子 fiber のエフェクトなので、dispose で一括解除できる
        const tools = buildGensparkTools({
          defineTool,
          getConfig,
          runner,
          catalog,
          log: (message) => {
            try {
              inner.logger?.debug?.(message);
            } catch {
              /* noop */
            }
          },
          statusLines: (cfg) => [
            `昇格ツール: ${promotedSummary(cfg?.promotedCategories)}`,
            `コマンド: ${commandState}`,
          ],
        });
        for (const tool of tools) inner.tools.register(tool);

        // カテゴリ厳選の型付きツール（設定 promotedCategories で選択）
        const promoted = buildPromotedTools({
          defineTool,
          getConfig,
          runner,
          catalog,
          categories: getConfig().promotedCategories,
          log: (message) => {
            try {
              inner.logger?.debug?.(message);
            } catch {
              /* noop */
            }
          },
        });
        for (const tool of promoted) inner.tools.register(tool);
        log?.(`[genspark] 昇格ツール ${promoted.length} 件を登録しました`);
      },
    });
  };

  const uninstall = () => {
    if (fiber === null) return;
    const current = fiber;
    fiber = null;
    Promise.resolve(current.dispose()).catch((error) => {
      ctx.logger?.warn?.(`[genspark] ツール解除に失敗: ${String(error)}`);
    });
  };

  const sync = () => {
    if (getConfig().enabled === false) {
      uninstall();
      uninstallCommands();
      return;
    }
    install();
    installCommands();
  };

  sync();
  ctx.effect(() => () => {
    uninstall();
    uninstallCommands();
  });
}

export { Config as config };
