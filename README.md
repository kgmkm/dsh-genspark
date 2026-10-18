# dsh-genspark

DeepSeek Harness（DSH）から **Genspark** の各種機能を使えるようにする Cordis プラグインです。
[@genspark/cli](https://www.npmjs.com/package/@genspark/cli)（`gsk`）を子プロセスとして呼び出します。

実測（2026-10-18 時点 / gsk 1.14.2）で **327 ツール / 46 グループ**が利用可能です。
検索・クロール・画像/動画/音声生成・メディア理解・文字起こし・AI Drive・タスクエージェント（docs/slides/deep_research 等）・
コネクタ（Gmail/Slack/Notion/MCP 等）・SNS・株価・電話・ホスティングまで含みます。

> ✅ **DSH からの全機能を実証済み**: 検索 6 種・画像生成・動画生成・音声生成のすべてが DSH のツール／コマンド経由で動作確認済みです。
> 動画生成は `minimax/h3`（768p / 5秒）、画像生成は `nano-banana-2-flash-lite`（1024×1024）、音声生成は `qwen-audio-3-tts` で実測しています。

## 提供するツール

### 汎用（カテゴリ非依存・常に登録）

| ツール | 用途 |
|---|---|
| `genspark_run` | 任意の Genspark ツールを実行する（`tool` + `args`(JSON) + 必要なら `approve_write`） |
| `genspark_tools` | 327 ツールのカタログを閲覧・検索（`keyword` / `group` / `full=true` で完全スキーマ） |
| `genspark_status` | 認証・CLI パス・バージョン・実行ランタイム・書き込みポリシー・カタログ状態の確認（コマンド登録の結果も表示） |

典型フロー:

```
1) genspark_tools(keyword: "slack send", full: true)   … 正確なツール名と引数を確認
2) genspark_run(tool: "slack", args: { action: "search", query: "..." })   … 読み取り系はそのまま実行
3) genspark_run(tool: "slack", args: { action: "send", ... }, approve_write: true)
   … ユーザーが承認した書き込みのみ実行
```

### カテゴリ厳選の型付きツール（昇格ツール）

利用頻度が高く引数が安定したものは、**引数の探索を省略できる型付きツール**として登録されます
（設定 `promotedCategories` で選択。既定は `search` と `media`）。
どのツールも `genspark_run` からでも実行できますが、こちらは引数名を調べずに直接呼べます。

**`search`（検索・調査）**

| ツール | Genspark 側 | 主な引数 |
|---|---|---|
| `genspark_web_search` | `web_search` | `q` |
| `genspark_image_search` | `image_search` | `query` |
| `genspark_crawl` | `crawler` | `url`, `render_js`, `raw`, `offset` |
| `genspark_scholar_search` | `scholar_search` | `query` |
| `genspark_maps_search` | `maps_search` | `query_type`, `engine`, `query` / `start_addr`+`end_addr` |
| `genspark_summarize_document` | `summarize_large_document` | `url`, `question` |

**`media`（生成メディア）**

| ツール | Genspark 側 | 主な引数 |
|---|---|---|
| `genspark_generate_image` | `image_generation` | `query`, `image_urls`, `model`, `aspect_ratio`, `image_size`, `save_to` |
| `genspark_generate_video` | `video_generation` | `query`, `model`(必須), `image_urls`, `duration`, `audio_enable`, `save_to` |
| `genspark_generate_audio` | `audio_generation` | `prompt`, `model`, `audio_type`, `params`, `save_to` |
| `genspark_vision` | `understand_images` / `analyze_media` / `audio_transcribe` | `media`, `instruction` |

- 生成メディアの `save_to` は CLI の `-o/--output-file` に渡され、**ローカルへダウンロード**されます
  （相対パスはセッションの作業ディレクトリ基準）。省略すると URL だけが返ります。
- 保存後は**先頭バイトで実際の形式を判定し、拡張子が食い違っていれば自動で改名**します
  （CLI は拡張子を検証しないため、`.png` の名前で JPEG が保存されることがあります）。報告文には
  `保存ファイル: <path>（JPEG / 12345 バイト）（実体が JPEG のため拡張子を修正）` のように出ます。
- 各ツールの `extra`（任意 JSON）は「そのツールのスキーマにはあるが型付きにしていない」パラメータ用です
  （例: 動画の `tier` / `first_frame_url` / `video_urls`）。**スキーマに無いキーは CLI が拒否**します
  （サーバー呼び出し前なのでクレジットは消費しません）。正確な名前は `genspark_tools(full: true)` で確認できます。
- `social` カテゴリは枠だけ用意してあります（ツールは未実装）。
- `genspark_crawl` と `genspark_summarize_document` は **URL 前提**です。`http(s)://` で始まる URL か、
  存在するローカルファイルのパス（CLI が自動アップロード）を渡してください。日本語の質問などを渡すと
  CLI を起動する前に日本語で案内します（`web_search` / `genspark_run` への誘導）。生の引数をそのまま
  渡したい場合は `genspark_run`（コマンドなら `/genspark-run`）を使ってください。

## 提供するコマンド（コンポーザの `+` メニュー / `/`）

コンポーザの `+` ボタンと `/` は同じメニューを開きます。ここに **13 コマンド**が並びます
（設定 `commands: false` で無効化、`promotedCategories` に連動）。

> `+` ボタンで開くときは**入力欄を空にした状態**で押してください。ホストの仕様で、引数付きコマンド
> （`input.hint` を持つ行）は下書きが空のときだけ候補に出ます。文字を入力した状態で押すと `/genspark` だけが
> 残ります（`/` を**行頭で**打てば同じ 13 件が出ます）。

**なぜコマンドなのか**: コマンド自体は**モデルメッセージを作りません**（結果はモデル履歴の外＝コマンド欄に描画）。
そのうえで実行後は結果をモデルへ引き継ぎ、**AI がチャットで要点と解釈を返せる**ようにしています（下記）。

| コマンド | 動き | 入力 |
|---|---|---|
| `/genspark` | 接続状態・アカウント・残クレジット・ツール数・使い方 | なし（即実行） |
| `/genspark-tools` | カタログ検索。1 件に絞れると引数の完全スキーマ。`--refresh` でキャッシュ更新 | キーワード（省略でグループ一覧） |
| `/genspark-run` | 任意ツールの実行（読み取り専用。対話必須・要確認は事前拒否） | `ツール名 [JSON引数]` |
| `/genspark-search` | Web 検索 | 検索クエリ |
| `/genspark-image-search` | 画像検索 | 検索語 |
| `/genspark-crawl` | ページ本文の取得（**添付ファイル可**） | URL |
| `/genspark-scholar` | 学術論文検索 | クエリ |
| `/genspark-maps` | 地図・場所検索（`search`/`maps` 固定） | 検索語 |
| `/genspark-summarize` | 長い文書の要約（**添付ファイル可**） | `URL [質問]`（質問は省略可） |
| `/genspark-image` | 画像生成 → `genspark-out/` へ保存（**添付画像は参照画像**） | 生成したい画像の説明 |
| `/genspark-video` | 動画生成（既定 `kling/v3`）→ 保存（**添付画像は先頭フレーム**） | 生成したい動画の説明 |
| `/genspark-audio` | 音声・音楽生成 → 保存 | 読み上げ原稿 or 生成内容 |
| `/genspark-vision` | メディア理解（画像・動画・音声を既定の汎用モデルで説明。**添付ファイル可**） | `<パス or URL> [指示]` |

- **添付ファイル（コンポーザの画像・ファイル）に対応しています**（`/genspark-vision`・`/genspark-summarize`・
  `/genspark-crawl`・`/genspark-image`・`/genspark-video`）。添付を付けてコマンドを送ると、入力欄の文字は
  「指示・質問」として扱われ、対象は添付ファイルになります（例: 画像を添付して `/genspark-vision 猫を数えて`）。
  ホストは `input.attachments = true` を宣言したコマンドにだけ添付を渡すため、未宣言だと送信時に
  「添付ファイルを受け付けません」で拒否されます（実機で発生した不具合。`lib/commands.js` で宣言）。
  添付は `invocation.attachments`（`ImageBlock` / `FileBlock`）として届き、プラグインが
  `ctx.get('attachments')` の `imageHostPath` / `fileHostPath` でホスト上の実パスへ解決して gsk に渡します。
  実ストアの画像パスは拡張子を持たない（`<root>/objects/xx/<sha256>`）ため、その場合だけ
  `<cwd>/genspark-out/attachments/<sha>-<n>.<mediaType 由来の拡張子>` へ複製します（gsk は拡張子で種別を判断）。
  パスも実体も取れないバックエンドでは、日本語で「パスを文字で入力してください」と案内します。

- 検索系の結果は**人間向けに整形**して表示します（`organic_results: 10 件（先頭 5 件を表示）` の形式。
  一覧として解釈できない応答は JSON をそのまま表示）。
- 実行後、結果は **AI（モデル）にも渡されます**（`agent.followup`）。コマンド欄に出た内容を AI が読んで、
  チャットで要点・解釈・次の一手を日本語で返します（「生の出力を繰り返さない」よう指示済み）。
  これが無いとコマンド欄の結果を AI が解釈できないため、既定で有効です。設定 `commandFollowup: false` で
  従来どおり「結果はコマンド欄だけ・モデル履歴を消費しない」動作になります。
  引き継ぎは `user/message` として会話にも残ります（DSH はモデルが見たものをすべて記録する方針のため）。
  **`source` は `{ kind: 'plugin:dsh-genspark' }`**（セッション形式 V4 の producer kind）。V3 の
  `{ kind: 'plugin', plugin: '…' }` は V4 の検証で拒否され、ターンごと失敗する（実機で発生）。
  `tests/preflight-message-source.mjs` が実物の検証器でこの形を固定しています。
  また引き継ぎは**コマンド完了を待たせません**（次のティックへ遅延＋Promise は握り潰し）。
- 時間のかかるコマンド（画像・動画・音声生成、検索など）は、**既定 2.5 秒でコマンド欄を先に完了**させ、
  結果は上の引き継ぎでチャットへ届けます。ホストはコマンドが完了するまで送信トランザクション中
  （phase = submitting）で**入力欄が編集不可**になり下書きも保持されるため（実測: 画像生成で 8 秒間
  入力欄が凍結）、その待ち時間を短くする措置です。設定 `commandInlineWaitMs` を 0 以下にすると
  従来どおり完了まで待って結果をコマンド欄に出します（引き継ぎが無効なとき・ホストが `followup` を
  持たないときは、結果を届ける手段が無いため自動的に待ちます）。
- どのコマンドも**例外を投げません**。想定外の失敗は日本語のエラー結果に変換し、原因はログに残します
  （`tests/preflight-error-sweep.mjs` が 13 コマンド × 失敗の型を総当たりで検証）。
- 生成系は成果物を `<セッションの作業ディレクトリ>/genspark-out/` へ自動保存し、保存先とサイズを表示します。
- **コマンドには承認の仕組みがありません**。そのため副作用のある操作は常に `--no-input` で実行し、
  確認が必要な操作・対話必須の操作は事前に拒否します（書き込みは `genspark_run` ツールから）。

## 前提

- `@genspark/cli` がグローバル導入済みで、`gsk login` 済みであること
  - 認証情報は `~/.genspark-tool-cli/config.json` をそのまま利用します（**プラグインは秘密情報を保持しません**）
- Node.js >= 20.18
- CLI のエントリは自動探索します（`%APPDATA%\npm\node_modules\@genspark\cli\dist\index.js` など）。
  見つからない場合は設定 `cliEntry` に絶対パスを指定してください。

## 設定

| キー | 既定 | 説明 |
|---|---|---|
| `enabled` | `true` | false でツール登録をすべて解除 |
| `cliEntry` | `""` | CLI エントリの絶対パス（空なら自動探索） |
| `nodePath` | `""` | 子プロセスの node.exe の絶対パス（空なら自動探索。Electron 実行ファイルは使わない） |
| `writeMode` | `approve` | `approve`（未承認は拒否／`approve_write`で`--yes`） / `deny`（書き込み禁止） / `allow`（CLI 既定） |
| `timeoutMs` | `600000` | gsk 1 回あたりのタイムアウト |
| `maxOutputChars` | `100000` | モデルへ返す最大文字数 |
| `tmpDir` | `""` | 一時ファイル置き場（空なら OS の一時領域） |
| `catalogTtlMs` | `900000` | カタログのキャッシュ期間 |
| `catalogTimeoutMs` | `120000` | `gsk ls` のタイムアウト |
| `promotedCategories` | `["search","media"]` | 型付きツールとして登録するカテゴリ（`search` / `media` / `social`）。空配列で汎用 3 ツールのみ |
| `commands` | `true` | コンポーザの `+` メニュー / `/` にコマンドを登録する（`promotedCategories` に連動） |
| `commandFollowup` | `true` | コマンド結果を `agent.followup` でモデルへ渡し、AI がチャットで解釈を返せるようにする（false でモデル履歴を消費しない従来動作） |
| `commandInlineWaitMs` | `2500` | コマンドの完了を待つ上限（ミリ秒）。過ぎたら「実行中です」を返して入力欄の凍結を解き、結果は引き継ぎでチャットへ届ける。0 以下で従来どおり完了まで待つ |
| `debug` | `false` | stderr をログへ出す |

## 実装上の要点（実測に基づく。詳細は `../docs/00-genspark-cli-spec-review.md`）

- **起動**: shim（`gsk.cmd`）は Node から spawn すると EINVAL のため、`node <dist/index.js>` を直接起動する。
- **ランタイム**: DSH は Electron 上で動くため `process.execPath` は `DeepSeek Harness.exe` になる。
  これをそのまま子プロセスに使うと commander が Electron 用の argv 解釈に切り替わり
  `error: unknown command '<...>/dist/index.js'` で落ちる（commander の分岐は
  `node_modules/commander/lib/command.js:981-983, 1010-1018`）。そこで **実 Node（node.exe）を探索して使う**
  （`config.nodePath` → 環境変数 → `PATH` → 既定インストール先）。見つからない場合のみ Electron を
  `ELECTRON_RUN_AS_NODE=1` で起動するが、その場合 `me` など一部コマンドは失敗し `genspark_status` が警告する。
- **stdio**: Windows サンドボックス下では `stdio:'pipe'` が EPERM。**stdout/stderr を一時ファイルの fd にリダイレクト**する。
- **stdin**: `'ignore'`（確認プロンプトは EOF → 拒否に倒れる。サーバー呼び出しなし）。
- **環境**: `GSK_NO_AUTO_UPDATE=1` を必ず注入（自動更新を試みる実行は終了コードが `0xC0000409` になり成功判定に使えない）。
- **引数**: JSON を一時ファイルへ書き `--args-file` で渡す（シェルの `$` 展開・クォート崩れを回避）。
  CLI は**サーバー呼び出しの前にこの JSON をスキーマ検証**するため、引数名を間違えると
  `[ERROR] --args-file: "x" is not a param` で即座に落ちる（クレジットは消費しない）。
  - 一時ファイルの置き場は `resolveTmpRoot()` で**必ず絶対パス**にする（`tmpDir` が空文字でも
    `??` が空文字を「値あり」と扱わないようにしてある）。子プロセスはセッションの cwd で起動するため、
    相対パスだと CLI が引数ファイルを開けず `ENOENT` になる。
  - `--args-file` は**パラメータを持つツールにだけ生える**オプション。引数が空のときは付けない
    （付けると `error: unknown option '--args-file'`）。
- **成功判定**: 終了コードではなく「stdout が JSON として読めるか」を主判定にする。
- **承認**: 確認が必要な操作は未承認だと `--no-input` で拒否（exit code 2）。
  ユーザーの承認後に `approve_write: true` で `--yes` を渡す。
  対話必須（`interactive_only`: slack send/react/upload/invite、google_drive share、x_post_tweet 等）は
  原理的に自動化できないため、事前にカタログで判定して明示的に拒否する。
- **コマンド**: ホストの `commands` サービスへ `ctx.commands.register({name, description, input, handler})` で登録する
  （`inject` には入れず `ctx.inject(['commands'], …)` で**任意依存**にする。非 GUI プロファイルで
  プラグイン全体が読み込まれなくなるのを避けるため）。`handler` は
  `{kind:'success'|'error', text}` を返す。名前は `/^[a-z][a-z0-9_-]*$/` に一致し、
  同一スコープで重複すると throw するため、1 件ずつ try/catch して 1 つの失敗が他を巻き込まないようにしている。
  `input: { hint }` を付けた行は、メニューから選ぶと即実行せず入力欄にヒントを出す。

## 開発

```powershell
# 単体テスト（ホスト不要・ネットワーク不要）
node tests/unit.test.mjs
node tests/runtime.test.mjs
node tests/promoted.test.mjs
node tests/commands.test.mjs

# ホスト実物の dsh-tools / dsh-commands で検証（再起動前のプリフライト。ネットワーク不要）
node tests/preflight-host-schema.mjs     # defineTool の DSL・引数検証を通す
node tests/preflight-commands-host.mjs   # 実物 CommandRuntime に 13 コマンドを登録できるか
node tests/preflight-commands-exec.mjs   # 実物ディスパッチャにコマンド行を流して実行経路を検証
node tests/preflight-commands-exec.mjs --with-cli  # 上に加えて実 CLI で実行（読み取りのみ・数クレジット）
node tests/preflight-plugin-load.mjs     # 出荷物の index.js を実際に読み込み apply() まで走らせる
node tests/preflight-plugin-load.mjs --with-cli  # 上に加えて実 CLI で status を実行（読み取りのみ・無料）
node tests/preflight-message-source.mjs  # 引き継ぎメッセージが実物の V4 検証（assertV4RowAdmission）を通るか
node tests/preflight-error-sweep.mjs     # 13 コマンド × 失敗の型（例外・エラー応答・時間切れ・不正な戻り値）
node probe/extract-host-chain.mjs reference/asar dsh-session-format-v3-to-v4  # 検証器の依存を asar から連鎖抽出

# 実 CLI に対する統合テスト（ログイン済み環境が必要）
node tests/integration.mjs
node tests/promoted-integration.mjs                    # 読み取り系のみ（無料）
node tests/promoted-integration.mjs --with-generation  # 画像・音声生成も実行（クレジット消費）
node tests/promoted-integration.mjs --with-generation --with-video  # 動画生成も（高コスト）
node tests/commands-integration.mjs                    # 13 コマンド（読み取り系）
node tests/commands-integration.mjs --with-generation  # 画像生成と genspark-out への保存も確認

# DSH と同じ条件（親プロセスが Electron）での検証
$env:ELECTRON_RUN_AS_NODE='1'; & 'D:\deepseek\DeepSeek Harness.exe' tests/electron-runtime.mjs
```

## 配布形態

現状は**ローカル開発用の非公開パッケージ**です（npm 未公開）。
desktop プロファイルへは `../install-to-profile.ps1`（`-Sync` / `-Uninstall`）で導入します
（`node_modules/dsh-genspark` へコピーし、プロファイルの `dsh.profile.bundles` に登録。反映には DSH の再起動が必要）。

### プロファイルの `dependencies` にも登録する理由（重要）

`bundles` だけでは、DSH のプラグイン管理 UI 上で **未インストール扱い**になります。
plugin_manager の `listBundles()` は次のように判定しているためです:

```js
const installed = dependencies.includes(name);
const removable = installed && !Object.hasOwn(installation.dependencies ?? {}, name);
```

`dependencies` に無いものは `installed=false` / `removable=false` となり、
管理画面の一覧に「インストール済み」として出てこなくなります（`@deepseek-ai/dsh-base` などの
組み込みバンドルが `readOnlyReason: "management-required"` で出るのとは別扱い）。

`install-to-profile.ps1` はこれを避けるため、`bundles` への登録に加えて
`pnpm add --lockfile-only file:./node_modules/dsh-genspark` を実行し、
`dependencies` と `pnpm-lock.yaml` にもエントリを作ります（**`node_modules` の実体は動かしません**）。
`-Uninstall` は `dependencies` と lockfile のエントリも削除します。

> 補足: DSH は `--profile desktop` を「Electron アプリ専用」として CLI からの操作を拒否するため、
> desktop プロファイルに対しては `dsh plugin --profile desktop add` が使えません。
> そのためスクリプトは `pnpm` を直接呼び出しています（`--lockfile-only` なので安全）。

反映は**アプリ本体の再起動**で行います（ページのリフレッシュでは効きません。プラグインはサーバープロセスが
起動時に一度だけ読み込み、ローダにファイル監視が無いため）。再起動後に `genspark_status` の
`コマンド: 13 件を登録しました（…）` 行が出れば反映済みです（実機で確認済み）。

## 変更履歴

- **0.1.1**: コマンドの添付ファイル対応。`/genspark-vision`・`/genspark-summarize`・`/genspark-crawl`・
  `/genspark-image`・`/genspark-video` がコンポーザの画像／ファイルを受け取れるようになりました。
  実機では、宣言が無いために送信時に「添付ファイルを受け付けません」で拒否されていました（ホストの
  `dsh-commands` は `input.attachments = true` を宣言したコマンドにだけ添付を渡す仕様）。
  また vision 系の結果は一覧整形ではなく分析本文を表示するようにしました（`{results:[{url, result}]}` の
  `result` が一覧整形で落ちていたため）。
- **0.1.0**: 初版（`/genspark-model` を `/genspark-vision` に置き換え、既定の汎用モデルで画像・動画・音声を理解）。
