# SKILL.md — dsh-genspark の詳細リファレンス

**読者**: このプラグインを操作する AI エージェント、または改修する開発者。
**読み方**: 人間向けの概要は [README.md](README.md)。ここにはツール定義・引数・内部挙動・実測記録・検証手順を置く。

- 対象: `dsh-genspark` v0.1.4 / `@genspark/cli` 1.14.2 / 2026-10-18 実測
- 前提: `gsk login` 済み（認証情報は `~/.genspark-tool-cli/config.json`。プラグインは保持しない）
- カタログ実測: **327 ツール / 32 グループ**（`gsk ls`）

---

## 1. ツール（モデルが呼ぶ関数）

### 1.1 汎用（カテゴリ非依存・常に登録）

| ツール | 用途 |
|---|---|
| `genspark_run` | 任意の Genspark ツールを実行（`tool` + `args`(JSON) + 必要なら `approve_write`） |
| `genspark_tools` | 327 ツールのカタログを閲覧・検索（`keyword` / `group` / `full=true` で完全スキーマ） |
| `genspark_models` | 生成モデルの一覧（`kind`: image / video / audio / transcribe、`filter` で部分一致） |
| `genspark_status` | 認証・CLI パス・バージョン・実行ランタイム・書き込みポリシー・カタログ状態 |

典型フロー:

```
1) genspark_tools(keyword: "slack send", full: true)   … 正確なツール名と引数を確認
2) genspark_run(tool: "slack", args: { action: "search", query: "..." })   … 読み取り系はそのまま
3) genspark_run(tool: "slack", args: { action: "send", ... }, approve_write: true)
   … ユーザーが承認した書き込みのみ実行
```

モデル選択のフロー:

```
1) genspark_models(kind: "video")   … 21 モデルの id を取得
2) genspark_run(tool: "get_model_info", args: { model_names: ["kling/v3"] })   … 対応比率・尺・音声
3) genspark_generate_video({ query: "...", model: "gemini/veo3.1" })
```

### 1.2 昇格ツール（カテゴリ厳選）

`promotedCategories`（既定 `["search","media"]`）で選択。引数の探索を省略して直接呼べる。
どのツールも `genspark_run` から実行できるが、こちらは引数名を調べずに済む。

**`search`（検索・調査）**

| ツール | Genspark 側 | 主な引数 |
|---|---|---|
| `genspark_web_search` | `web_search` | `q` |
| `genspark_image_search` | `image_search` | `query` |
| `genspark_crawl` | `crawler` | `url`, `render_js`, `raw`, `offset` |
| `genspark_scholar_search` | `scholar_search` | `query` |
| `genspark_maps_search` | `maps_search` | `query_type`, `engine`, `query` / `start_addr`+`end_addr` |
| `genspark_summarize_document` | `summarize_large_document` | `url`, `question` |

**`media`（生成）**

| ツール | Genspark 側 | 主な引数 |
|---|---|---|
| `genspark_generate_image` | `image_generation` | `query`, `image_urls`, `model`, `aspect_ratio`, `image_size`, `save_to` |
| `genspark_generate_video` | `video_generation` | `query`, `model`(必須), `image_urls`, `duration`, `audio_enable`, `save_to` |
| `genspark_generate_audio` | `audio_generation` | `prompt`, `model`, `audio_type`, `params`, `save_to` |

**`media`（解析＝画像・動画・音声の理解）**

| ツール | Genspark 側 | 主な引数 |
|---|---|---|
| `genspark_analyze_media` | `understand_images` / `analyze_media` / `audio_transcribe` | `media`, `instruction` |

- `save_to` は CLI の `-o/--output-file` に渡され**ローカルへ保存**される（相対パスはセッション cwd 基準）。
  省略すると URL だけが返る。
- 保存後は**先頭バイトで実形式を判定し、拡張子が食い違えば自動改名**する（CLI は拡張子を検証しない）。
  報告文: `保存ファイル: <path>（JPEG / 12345 バイト）（実体が JPEG のため拡張子を修正）`
- `extra`（任意 JSON）は「スキーマにはあるが型付きにしていない」引数用（例: 動画の `tier` / `first_frame_url`）。
  **スキーマに無いキーは CLI が拒否**する（サーバー呼び出し前なのでクレジットは消費しない）。
- 生成モデルは **enum で縛らない**（Genspark 側の追加・廃止が頻繁なため）。実値は `genspark_models` が返す。
  壊れた id は CLI がサーバー呼び出し前に弾く。
- `social` カテゴリは枠だけ（ツール未実装）。
- `genspark_crawl` / `genspark_summarize_document` は URL 前提。`http(s)://` かローカルファイルパスを渡す。
  日本語の質問を渡すと CLI 起動前に日本語で案内する（`web_search` / `genspark_run` へ誘導）。

### 1.3 メディア解析の振り分け（`genspark_analyze_media`）

| 入力 | 実際に呼ぶツール | 備考 |
|---|---|---|
| 画像 | `understand_images` | 複数画像は `image_urls` に全部 |
| 動画 | `analyze_media` | `media_urls` + `requirements`（指示） |
| 音声 | `audio_transcribe` | モデルは既定 `whisper-1` 固定。本文は `segments` に入る |
| 画像＋動画/音声 | `understand_images` | 画像だけを対象にする |

- `media_list`（配列）を渡すと種類ごとに振り分ける。単数 `media` もある。
- モデル名はユーザーに指定させない（将来モデルが消えても壊れないよう既定の汎用モデルに固定）。
- 文字起こしの応答は `{ "<url>": { full_text, segments, words, … } }` で **`full_text` が空**のことが多い。
  表示は `full_text` → `segments`（文字列／配列）の順で本文だけを出し、`words`（単語別タイムスタンプ）は出さない。

---

## 2. コマンド（14 件）

ホストの `ctx.commands.register({name, description, input, handler})` で登録する。
`handler` は `{kind:'success'|'error', text}` を返す。名前は `/^[a-z][a-z0-9_-]*$/`。

| コマンド | 実装 | 添付 |
|---|---|---|
| `/genspark` | 状態表示（`me` 実行・コマンド一覧） | — |
| `/genspark-tools` | カタログ検索 | — |
| `/genspark-models` | モデル一覧 | — |
| `/genspark-run` | 任意ツール（読み取り専用） | — |
| `/genspark-search` | `web_search` | — |
| `/genspark-image-search` | `image_search` | — |
| `/genspark-crawl` | `crawler` | ✅ |
| `/genspark-scholar` | `scholar_search` | — |
| `/genspark-maps` | `maps_search` | — |
| `/genspark-summarize` | `summarize_large_document` | ✅ |
| `/genspark-image` | `image_generation` | ✅（参照画像） |
| `/genspark-video` | `video_generation` | ✅（先頭フレーム） |
| `/genspark-audio` | `audio_generation` | — |
| `/genspark-analyze-media` | `understand_images` / `analyze_media` / `audio_transcribe` | ✅ |

### 2.1 添付ファイル（コンポーザの画像・ファイル）

ホストの 3 段ゲート:

1. クライアント送信前 — 添付あり かつ `desc.input.attachments !== true` → 送信せずトーストで拒否
2. `dsh-commands` の `execute()` — 宣言が無いと `/{name} does not accept attachments` を返し**ハンドラを起動しない**
3. 宣言はあるが attachments サービスが無い — `no attachment store is composed`

宣言したコマンドは `invocation.attachments` に `ImageBlock`（`{type:'image', attachment:{attachmentId, mediaType, name}}`）
または `FileBlock` を受け取る。`leadingClaim()` は `claim.attachments = true` を会話側にも引き継ぐ。

- 実ストア（`dsh-attachment-local`）: 画像は `<root>/objects/xx/<sha256>`（**拡張子なし**）、
  ファイルは `<root>/files/xx/<sha256>/<name>`。root は `<dshHome>/attachments/v1`。
- 解決: `ctx.get('attachments')` の `imageHostPath` / `fileHostPath` にブロックを渡す。
  画像は拡張子が無いので `<cwd>/genspark-out/attachments/<sha>-<n>.<mediaType 由来>` へ**複製**してから渡す
  （gsk は拡張子で種別を判断する）。ファイルは名前があるのでそのまま使う。
- 添付があるときは**入力欄の全文が指示・質問**になる。空入力でも実行する。
- 解決できない環境では日本語で「パスを文字で入力してください」と案内し、CLI は起動しない。

### 2.2 結果の引き継ぎ

- 実行後、結果は `agent.followup(message)` で **AI にも渡る**（チャットで要点・解釈を返す）。
  設定 `commandFollowup: false` で無効化（モデル履歴を消費しない従来動作）。
- `source` は `{ kind: 'plugin:dsh-genspark' }`（V4 形式）。V3 の `{kind:'plugin', plugin:'…'}` は
  V4 検証で拒否されターンごと失敗する（実機で発生）。`tests/preflight-message-source.mjs` が形を固定。
- 引き継ぎは**コマンド完了を待たせない**（次ティックへ遅延＋Promise は握り潰し）。
- 既定 2.5 秒（`commandInlineWaitMs`）でコマンド欄を先に完了させ、結果は引き継ぎで届ける。
  ホストはコマンド完了まで送信トランザクション中で入力欄が凍結するため（実測: 画像生成で 8 秒）。
  0 以下にすると従来どおり完了まで待つ（引き継ぎ無効時は自動的に待つ）。
- 早期リターンの完了文言は生成種別ごとの目安入り（画像 15〜40 秒 / 動画 1〜2 分 / 音声 30〜60 秒。
  2026-10-18 実測: 5 秒・720p の動画で約 50 秒、画像で約 10 秒）。
- どのコマンドも**例外を投げない**。想定外は日本語のエラー結果に変換し、原因はログへ。
- 生成系は成果物を `<cwd>/genspark-out/` へ自動保存し、保存先とサイズを表示する。
- **コマンドに承認の仕組みは無い**。副作用のある操作は常に `--no-input` で実行し、確認必須・対話必須は
  事前に拒否する（書き込みは `genspark_run` ツールから）。

### 2.3 誤爆ガード（生成コマンドにモデル一覧・使い方を書いたとき）

- 生成コマンド（`/genspark-image` `/genspark-video` `/genspark-audio`）は入力を**そのまま生成プロンプト**へ
  渡すため、`動画モデルのリスト` のようなメタな依頼が生成として実行され、クレジットを消費する事故があった
  （2026-10-18 実測: `/genspark-video 動画モデルのリストください` を 2 回実行し、約 924 クレジット）。
- `lib/guard.js` の `detectMetaIntent()` が「モデル一覧」「使い方」だけを検出し、**生成せずに**
  モデル一覧（カタログの実 enum）や使い方を返す。
- 判定は狭く取る（`モデル` を含むだけの生成プロンプトは素通し。例: 「モデルのような女性が歩く動画」）。
  添付があるときは生成対象が明確なのでガードしない。

### 2.4 新しい会話（スレッド作成中）ではコマンドを実行できない

- クライアントは `/` コマンドを**そのセッションのコマンドディレクトリ**で解決する。セッションがまだ
  open になっていない遷移中に送ると解決できず、何も表示されないことがある（2026-10-18 ユーザー報告。
  同じ操作を遷移後にやり直すと成功する）。
- これはホスト（`dsh-client-ui-commands` / `dsh-commands`）側の挙動で、**プラグインからは回避できない**
  （プラグインはコマンドを登録するだけで、セッションの作成やクライアントの解決には関与しない）。
- README では「表示が落ち着いてから実行する」を案内している。恒久対策はクライアント側で
  「セッションが open になるまで待ってから解決する」こと（上流の改善候補）。

---

## 3. 認証

| 方法 | 手順 | 備考 |
|---|---|---|
| ブラウザ | `gsk login` | `~/.genspark-tool-cli/config.json` に保存。`--config` / `GSK_CONFIG` で別プロファイル |
| API キー | `GSK_API_KEY=gsk_...` | 環境変数が config より優先 |
| 確認 | `gsk me`（`gsk login-info`） | メール・プラン・残クレジット |
| 解除 | `gsk logout` | 保存キーを削除 |

優先順位: CLI オプション > 環境変数（`GSK_API_KEY` / `GSK_BASE_URL` / `GSK_PROJECT_ID`）> config ファイル。
プラグイン側は**何も保持しない**。`genspark_status` が `me` の結果でログイン状態を表示する。

---

## 4. 生成モデル

モデル一覧は `gsk ls` の `model` 引数 enum から取得する（`lib/models.js`）。

| kind | ツール | 件数（2026-10-18） | 既定 |
|---|---|---|---|
| `image` | `image_generation` | 15 | `nano-banana-2-flash-lite` |
| `video` | `video_generation` | 21 | `kling/v3`（コマンドの既定） |
| `audio` | `audio_generation` | 25 | Genspark 側の既定 |
| `transcribe` | `audio_transcribe` | 3 | `whisper-1` |

- 一覧: `genspark_models({ kind, filter })` / `/genspark-models [動画|kling]`
- 個別仕様: `gsk get_model_info`（引数 `model_names`、配列で複数可）
- モデル追加・廃止には自動追随する（静的リストを持たない）

---

## 5. 実装上の要点（実測に基づく）

- **起動**: shim（`gsk.cmd`）は Node から spawn すると EINVAL。`node <dist/index.js>` を直接起動する。
- **ランタイム**: DSH は Electron 上で動くため `process.execPath` は `DeepSeek Harness.exe`。
  そのまま使うと commander が Electron 用 argv 解釈に切り替わり
  `error: unknown command '<...>/dist/index.js'` で落ちる。**実 Node（node.exe）を探索**して使う
  （`config.nodePath` → 環境変数 → `PATH` → 既定インストール先）。見つからない場合のみ
  `ELECTRON_RUN_AS_NODE=1` で Electron を使うが、`me` など一部が失敗し `genspark_status` が警告する。
- **stdio**: Windows サンドボックス下では `stdio:'pipe'` が EPERM。stdout/stderr を一時ファイルの fd へリダイレクト。
- **stdin**: `'ignore'`（確認プロンプトは EOF → 拒否。サーバー呼び出しなし）。
- **環境**: `GSK_NO_AUTO_UPDATE=1` を必ず注入（自動更新を試みる実行は終了コード `0xC0000409` になり成功判定に使えない）。
- **引数**: JSON を一時ファイルへ書き `--args-file` で渡す（シェル展開・クォート崩れを回避）。
  CLI は**サーバー呼び出し前にスキーマ検証**するため、引数名の誤りは
  `[ERROR] --args-file: "x" is not a param` で即落ちる（クレジット消費なし）。
  - 一時ファイルは `resolveTmpRoot()` で**必ず絶対パス**にする（子プロセスの cwd 依存を避ける。
    `tmpDir` が空文字でも `??` が「値あり」と扱わないようにしてある）。
  - `--args-file` は**パラメータを持つツールにだけ**生える。引数が空なら付けない
    （付けると `error: unknown option '--args-file'`）。
- **成功判定**: 終了コードではなく「stdout が JSON として読めるか」を主判定にする。
- **承認**: 未承認の確認必須操作は `--no-input` で拒否（exit code 2）。承認後は `--yes`。
  対話必須（`interactive_only`: slack send/react/upload/invite、google_drive share、x_post_tweet 等）は
  原理的に自動化できないため、カタログで判定して事前に拒否する。
- **コマンド登録**: `ctx.inject(['commands'], …)` で**任意依存**にする（非 GUI プロファイルで
  プラグイン全体が読み込まれなくなるのを避ける）。同一スコープで重複すると throw するため 1 件ずつ try/catch。
  `input: { hint }` を付けた行は、メニューから選ぶと即実行せず入力欄にヒントを出す。
  `input.attachments = true` が添付受け取りの宣言。

## 6. 開発

```powershell
# 単体テスト（ホスト不要・ネットワーク不要）
node tests/unit.test.mjs
node tests/runtime.test.mjs
node tests/promoted.test.mjs
node tests/commands.test.mjs

# ホスト実物の dsh-tools / dsh-commands で検証（再起動前のプリフライト）
node tests/preflight-host-schema.mjs     # defineTool の DSL・引数検証
node tests/preflight-commands-host.mjs   # 実物 CommandRuntime に 14 コマンドを登録できるか
node tests/preflight-commands-exec.mjs   # 実物ディスパッチャで実行経路を検証
node tests/preflight-commands-exec.mjs --with-cli  # 実 CLI でも実行（読み取りのみ・数クレジット）
node tests/preflight-plugin-load.mjs     # 出荷物の index.js を実際に読み込み apply() まで走らせる
node tests/preflight-message-source.mjs  # 引き継ぎが実物の V4 検証を通るか
node tests/preflight-error-sweep.mjs     # 14 コマンド × 失敗の型（例外・エラー応答・時間切れ・不正な戻り値）

# 実 CLI に対する統合テスト（ログイン済み環境が必要）
node tests/integration.mjs
node tests/promoted-integration.mjs                    # 読み取り系のみ（無料）
node tests/promoted-integration.mjs --with-generation  # 画像・音声生成（クレジット消費）
node tests/promoted-integration.mjs --with-generation --with-video  # 動画生成（高コスト）
node tests/commands-integration.mjs                    # 14 コマンド（読み取り系）

# DSH と同じ条件（親プロセスが Electron）での検証
$env:ELECTRON_RUN_AS_NODE='1'; & 'D:\deepseek\DeepSeek Harness.exe' tests/electron-runtime.mjs
```

現状の結果: 単体 129 件 / ホスト プリフライト 432 チェック（すべて成功）。

## 7. 配布形態

ローカル開発用の非公開パッケージ（npm 未公開）。
プロファイルへは `../install-to-profile.ps1`（`-Sync` / `-Uninstall`）で導入する
（`node_modules/dsh-genspark` へコピーし、`dsh.profile.bundles` に登録。反映には DSH の再起動が必要）。

### プロファイルの `dependencies` にも登録する理由

`bundles` だけでは plugin_manager の `listBundles()` が
`installed = dependencies.includes(name)` で判定するため**未インストール扱い**になる
（`removable` も false）。スクリプトは `pnpm add --lockfile-only file:./node_modules/dsh-genspark` を実行して
`dependencies` と lockfile にもエントリを作る（`node_modules` の実体は動かさない）。

> DSH は `--profile desktop` を Electron 専用として CLI 操作を拒否するため、
> desktop には `dsh plugin add` が使えない。そのため `pnpm` を直接呼んでいる。

## 変更履歴

- **0.1.6**: コマンド欄の完了文言に生成種別ごとの待ち時間の目安を追加（画像 15〜40 秒 / 動画 1〜2 分 /
  音声 30〜60 秒）。動画は実測で約 50 秒かかるため「止まった」と誤解されやすかった。
  新規セッションの件は「遷移が終わる前の実行」であることを README / SKILL に反映。
- **0.1.5**: 生成コマンドの**誤爆ガード**を追加。`/genspark-video 動画モデルのリスト` のような依頼で
  生成（＝課金）されていた問題を修正し、モデル一覧・使い方を返すようにした（`lib/guard.js`）。
  新しい会話でコマンドが動かない件はホスト側の仕様として README / SKILL に回避策を明記。
- **0.1.4**: 生成モデル一覧を追加（`genspark_models` / `/genspark-models`。カタログ enum を実値で返す）。
  モデル指定の enum 制約を外し、Genspark 側の追加・廃止に追随できるようにした。
  README を人間向け（セットアップ・認証・コマンド）に整理し、詳細を SKILL.md へ分離。
- **0.1.3**: `/genspark-vision` → **`/genspark-analyze-media`**、`genspark_vision` → **`genspark_analyze_media`**
  に改名（音声・動画も扱うため `vision` は実態と合わない）。旧名のエイリアスは置かない。
- **0.1.2**: 文字起こし結果の表示を修正。`full_text` が空のとき `segments` を本文として出す
  （JSON 全体・`words` の単語別タイムスタンプを流していた）。
- **0.1.1**: コマンドの添付ファイル対応（5 コマンド）。ホストは `input.attachments = true` を
  宣言したコマンドにだけ添付を渡すため、未宣言だと送信時に拒否される。vision 系の結果は
  一覧整形ではなく分析本文を表示するようにした。
- **0.1.0**: 初版（`/genspark-model` を置き換え、既定の汎用モデルで画像・動画・音声を理解）。
