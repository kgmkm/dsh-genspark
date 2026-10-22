# SKILL.md — dsh-genspark の詳細リファレンス

**読者**: このプラグインを操作する AI エージェント、または改修する開発者。
**読み方**: 人間向けの概要は [README.md](README.md)。ここにはツール定義・引数・内部挙動・実測記録・検証手順を置く。

- 対象: `dsh-genspark` v0.1.9 / `@genspark/cli` 1.14.2 / 2026-10-18 実測
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

`promotedCategories`（既定 `["search","media","social"]`）で選択。引数の探索を省略して直接呼べる。
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
- `genspark_crawl` / `genspark_summarize_document` は URL 前提。`http(s)://` かローカルファイルパスを渡す。
  日本語の質問を渡すと CLI 起動前に日本語で案内する（`web_search` / `genspark_run` へ誘導）。

**`social`（SNS 検索。X / Instagram / Reddit の計 30 API）**

| ツール | Genspark 側 | 主な引数 |
|---|---|---|
| `genspark_x_search` | `social_twitter`（`gsk social twitter`） | `query`, `action`（既定 auto）, `post_id`, `post_ids`, `start_date`, `end_date`, `language`, `limit`（既定 25）, `raw` |
| `genspark_instagram_search` | `social_instagram`（`gsk social instagram`） | `query`, `action`, `post_id`, `post_ids`, `start_date`, `end_date`, `limit`, `raw` |
| `genspark_reddit_search` | `social_reddit`（`gsk social reddit`） | `query`, `action`, `subreddit`, `sort`, `time`, `start_date`, `end_date`, `limit`, `raw` |

- `action` を省くと `lib/social.js` の `autoAction()` が判定する。`@handle` は**その人の投稿**
  （X → `get_posts_by_author` / Instagram → `get_posts_by_user` / Reddit → `get_user`）、
  `from:handle` も同じ、それ以外は `search_posts`。`get_user` は **id / username / name しか返さない**
  （bio・フォロワー数・URL は無い。実測）ので auto では選ばない。人が知りたいときは `search_users`。
- **並び順はこちらで日付降順に直す**（`get_posts_by_author` の返却順が時系列でないため。実測）。
  日付が読めない行は元の順序で末尾へ。`get_comments` / `search_comments` は元の順序を保つ。
- **サーバーは `limit` を無視して 100〜127 件返す**ため、表示は既定 25 件に切る
  （`limit` で 1〜100、全件・全フィールドが必要なら `raw: true` の JSON）。
  切り口は「サーバー返却 N 件中 M 件を表示（残り …）」と**何を切ったか**を明示する。
- 日付（`start_date` / `end_date`）は **`search_posts` にだけ送る**。実測で
  `get_posts_by_author` + `start_date` は失敗し、外すと成功した。他の action に渡された日付は落とす。
- **一時的な失敗は 1 回だけ自動で再試行する**（日付を送っていた場合は日付を落として再試行）。
  実測では同一クエリ・同一引数でも数十秒後に成功した。`count_posts` / Reddit の `search_comments` /
  `search_subreddits` は上流が未対応なので再試行しない（文言で代替案を出す）。
- 投稿 URL は生データに無いことがある（X / Reddit）ので id から組み立てる
  （`https://x.com/<user>/status/<id>` / `https://www.reddit.com/r/<sub>/comments/<id>`）。
- 空結果は「該当する結果はありませんでした（サーバー返却 0 件）」の定型文にする（生 JSON を出さない）。
- `get_post_with_comments` / `get_subreddit_with_posts` は `{result:{post,comments}}` /
  `{result:{subreddit,posts}}` の入れ子で返る（実測）。専用の整形でタイトル・URL・コメント・
  サブレディット見出しを出す。**コメントは実測でも空が多い**（失敗ではない）。
- X の `language` を指定すると、行に `lang` がある場合だけ一致する行へ絞る（一致 0 件なら絞らない）。
- 課金は 1 回あたり **約 1.6 クレジット**（実測: 13 回で 20.8）。Instagram の投稿検索は 10〜15 秒、
  Reddit の `get_post_with_comments` / `get_subreddit_with_posts` は 40 秒前後かかることがある。
- Reddit の検索精度は上流依存で、`query` だけだと無関係なサブレディットが混ざる（50 件中 1 件など）。
  `subreddit` で絞るか 1 語にする。検索結果の行に **score / コメント数は含まれない**。

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

## 2. コマンド（18 件）

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
| `/genspark-social` | AI がサービスと action を選ぶ（API は呼ばない） | — |
| `/genspark-x` | 同上（X のみ） | — |
| `/genspark-instagram` | 同上（Instagram のみ） | — |
| `/genspark-reddit` | 同上（Reddit のみ） | — |

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
- 生成・解析系（`ACK_TOOLS`: image/video/audio_generation, understand_images, analyze_media,
  audio_transcribe, summarize_large_document, crawler）は**入力直後 150ms で受付メッセージ**を返す:
  「Genspark に送信中です（目安…）。結果はこのあとチャットに届きます。」
  待ち時間は `commandInlineWaitMs`（既定 2500）の値ではなく **最大 150ms** を優先する
  （設定に従うと受付が 2.5 秒遅れ、入力欄もその間凍結するため）。`commandInlineWaitMs` が 0 以下なら
  従来どおり完了まで待ち、結果をコマンド欄に出す。
  150ms 以内に終わった検証エラー（入力不足など）はそのまま結果として返す。
  一覧・状態確認など速いコマンドは従来どおり、間に合えば結果をその場で返す。
- 早期リターンの完了文言は生成種別ごとの目安入り（画像 15〜40 秒 / 動画 1〜2 分 / 音声 30〜60 秒。
  2026-10-18 実測: 5 秒・720p の動画で約 50 秒、画像で約 10 秒）。
- **新しい会話のヒーロー画面対策**: DSH は「blank」なセッションでヒーロー画面を出し、チャット欄
  （コマンド欄を含む）を覆う。blank は `turn/start` でしか解除されないため、生成が終わるまで
  受付メッセージすら見えない（2026-10-18 実機: 動画で約 70 秒間なにも表示されない）。
  そこで受付時に `agent.session.snapshotEvents()` でログを調べ、`turn/start` が無い（＝新しい会話）
  ときだけ followup を 1 通送ってターンを起こし、ヒーローを解除する（`scheduleReceipt`）。
  既存の会話ではコマンド欄がそのまま見えるので何もしない（余計なターン＝トークンを使わない）。
  DSH 本体は変更しない（プラグインだけで完結する）。
- どのコマンドも**例外を投げない**。想定外は日本語のエラー結果に変換し、原因はログへ。
- 生成系は成果物を `<cwd>/genspark-out/` へ自動保存し、保存先とサイズを表示する。
  保存できなかったときは **黙って成功にしない**（0.1.11〜）:
  - URL があれば `genspark.ai` のファイル配信に限り自前で取得して保存する（CLI の `-o` が失敗した保険）。
  - URL が無ければ `status` / `failure_reason` / `task_id` を表示し、**エラーとして返す**。
    `failure_reason` が safety / policy / rejected 系なら「**安全ポリシー（センシティブ判定）により
    拒否されました**」と日本語で案内する（0.1.12〜。英語のまま出していた）。
    実測（2026-10-18）: NSFW の動画は `status: FAILURE` +
    「Content was rejected by the platform's safety policy…」を返し、6 秒で終わった。
    正常な動画は約 50 秒かかるので、**所要時間が極端に短い＝拒否**の目安になる。
  - 同じコマンドの再実行は**新しい生成**（クレジット消費）になる。まず表現を変えるか、
    Genspark の画面（履歴）で確認するよう案内する。
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
- 遷移が終わって open になったあとも、まだ一度もターンが無いセッションではヒーロー画面が
  チャット欄を覆う。こちらは 2.2 の `scheduleReceipt`（プラグイン側）で解除する。

### 2.5 振り分けコマンド（`/genspark-social` 系）

- これら 4 コマンドは **API を呼ばない**（クレジットを消費しない・数 ms で完了する）。
  受け付けた文言を `promptFor` で「どのサービスをどの action で調べるか」まで含む依頼文に変換し、
  `agent.followup` でモデルへ渡す。モデルが `genspark_x_search` / `genspark_instagram_search` /
  `genspark_reddit_search` を選んで実行する（`agent` が判断して API を割り振る形）。
- コマンド欄には「X（Twitter）・Instagram・Reddit を AI が選んで検索します:「…」」を返す。
- プロンプトには**実測に基づく検索作法**を書いてある（0.1.14〜）: 検索語は 1〜2 語／日本語は
  `language="ja"`／「#タグ」は効かない／Reddit は `subreddit` で絞る／サービスは最大 3 つだが
  **同一サービス内の言い換え再試行は 3 回まで**／「Failed to execute」は一時障害のこともある／
  コメントは空が多い。実運用で 1 タスク 29 回呼んだ反省（2026-10-18 の実地メモ）から。
- `commandFollowup: false` と `agent.followup` が無い環境では振り分けできないため、
  理由と代替（ツールを直接使う）をエラー結果として返す。
- 入力が空なら使い方だけを返し、引き継ぎは送らない（`promptFor` が `null` を返す）。
- `social` カテゴリを無効にすると、この 4 コマンドと 3 ツールは登録されない。

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
- **グループ付きコマンド**: `social_twitter` のようなツールは `gsk social twitter` で実行する
  （`gsk social_twitter` は `unknown command`）。`lib/catalog.js` の `toolInvocation()` が
  カタログの `cli.path` / `cli.group` から CLI 本体と同じ規則で解決し（path > group+sub > name）、
  `runner.runTool` の `toolCommand` に渡す。`genspark_run` もキャッシュ済みカタログで解決し、
  `unknown command` で落ちたときだけカタログを取り直して 1 回だけ再試行する
  （これで gmail / box / jira / linkedin など 31 グループのツールも `genspark_run` から実行できる）。
- **コマンド登録**: `ctx.inject(['commands'], …)` で**任意依存**にする（非 GUI プロファイルで
  プラグイン全体が読み込まれなくなるのを避ける）。同一スコープで重複すると throw するため 1 件ずつ try/catch。
  `input: { hint }` を付けた行は、メニューから選ぶと即実行せず入力欄にヒントを出す。
  `input.attachments = true` が添付受け取りの宣言。
- **Web 検索プロバイダ**（`lib/web-provider.js` / `webSearch.*`）:
  - `ctx.web.registerSearchProvider()` が公開の継ぎ目。DeepSeek の 2 バックエンド
    （`dsh-web-deepseek-api` → `deepseek-search-api`、`dsh-web-search-deepseek` → `deepseek-official`）も
    同じ呼び出しで登録している普通のプラグインなので、ホスト側の変更は要らない。
  - 登録は `ctx.inject(['web'], …)`（任意依存）で行い、解除はその fiber の dispose で行う。
    `registerSearchProvider` は内部で `this.ctx.effect(...)` を使っており、これは**呼び出し元の fiber** に
    紐づく（サービス自身の fiber ではない）。
  - `available()` は安価なローカル判定に限る（継ぎ目がネットワーク呼び出しを禁じている）。
    「有効 かつ CLI エントリが存在する」だけを返す。CLI が無いのに true を返すと、
    フォールバックではなく `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` になる。
  - 選択の受け渡し: `web.searchProvider` は公式の Web 検索ページが書いているのと同じ設定値。
    奪うときは `settings.update('web', { searchProvider: 'genspark' })`、返すときは
    `settings.mutate('web', [{op:'unset', path:['searchProvider']}])`（＝継承値に戻る）か、
    奪う前のユーザー明示値を記録できていればその値で `update`。順序は「登録 → 選択」「解除 → 登録解除」で、
    選択だけが残ってプロバイダが無い瞬間を作らない。
  - **再起動なしの設定反映**: `webSearch.enabled` / `webSearch.autoSelect` は `.volatile()`。
    ホストは新しい値を実行中の config に書き込み、fiber を再マウントせず `loader/volatile-update` を
    その fiber に emit する。よって `apply` はそのイベントから sync を再実行する必要がある。
    （非 volatile な項目は再読み込みまで反映されない。さらに**設定カードは volatile な項目にしか
    作られない** — `SettingsForms.describe()` は `volatileForm()` が空のエントリを飛ばす。）
  - 応答の写像は防御的に（`organic_results` / `results` / `items` / ネストした `data`、`url|link`、
    `snippet|description`、日付は ISO に変換できるときだけ）。CLI の仕様は「タイトル・スニペット・URL」までしか
    明記していないため。失敗は `describeRun()` 経由で `genspark_web_search` と同じ文言（認証案内・
    タイムアウト・stderr）を返す。

## 6. 開発

> シェルから `gsk --version` を叩くと **ExecutionPolicy で落ちる**ことがある
> （`gsk.ps1 cannot be loaded because running scripts is disabled`）。バージョン確認は
> `node <npm>\@genspark\cli\dist\index.js --version` のように dist を直接起動する。
> プラグインは `resolveNodeRuntime()` + dist 直接起動なので影響を受けない。

```powershell
# 単体テスト（ホスト不要・ネットワーク不要）
node tests/unit.test.mjs
node tests/runtime.test.mjs
node tests/promoted.test.mjs
node tests/social.test.mjs
node tests/web-provider.test.mjs
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

現状の結果: 単体 173 件 / ホスト プリフライト 432 チェック（すべて成功）。

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

- **0.2.0**: 組み込みの `web_search` を Genspark で答えられるようにした（任意・**既定 OFF**）。
  - 新モジュール `lib/web-provider.js`。`ctx.web.registerSearchProvider()`（DeepSeek の 2 バックエンドも
    使っている公開の継ぎ目）で `genspark` プロバイダを登録し、1 クエリごとに `gsk web_search` を 1 回実行する。
    プロキシも追加ポートも鍵管理も要らない。
  - 設定カード: `設定 → プラグイン → dsh-genspark → webSearch.enabled` / `webSearch.autoSelect`。
    `.volatile()` なので**DSH を再起動せずに**反映される（`loader/volatile-update` → sync 再実行）。
    この 2 つが設定カードに出る唯一の項目（volatile な項目が無いエントリにはカード自体が作られない）。
  - `autoSelect`（既定 true）は `web.searchProvider = 'genspark'` を書く。公式の Web 検索ページと同じ設定値。
    オフにすると選択を返却する（前に明示選択していた値、無ければ自動選択）。こちらが奪った後に
    ユーザーが変えた値は上書きしない。
  - `genspark_status` に `Web search (web_search):` 行を追加。「置き換わったかどうか」をログを追わずに確認できる。
  - 失敗は `WEB_PROVIDER_ERROR` / `WEB_ABORTED` で、`genspark_web_search` と同じ文言（認証案内・
    タイムアウト・生 stderr）。0 件は空の引用リストではなくエラー。
  - `web_fetch` は変更なし（`dsh-web-fetch-http` は両プロファイルの DSH base に入っている）。
- **0.1.14**: ソーシャル検索を実運用のフィードバック（2026-10-18 の実地メモ 2 本）に基づいて直した。
  - **`get_post_with_comments` / `get_subreddit_with_posts` が空行になっていた**のを修正
    （`{result:{post,comments}}` / `{result:{subreddit,posts}}` の入れ子を専用整形）。
  - 投稿を**日付降順に並べ替え**（返却順が時系列でない action がある）。
  - 失敗時は**日付を落として 1 回だけ自動再試行**（一時的な失敗が実測されたため）。
    失敗文言も「未対応とは限らない」と分岐。
  - `start_date` / `end_date` は `search_posts` にだけ送る（`get_posts_by_author` + 日付の失敗を回避）。
  - `auto` の `@handle` を `get_user` から**その人の投稿**へ変更（`get_user` は id/名前しか返さない）。
  - 空結果の生 JSON ダンプを定型文に、`limit` の切り口を「サーバー返却 N 件中 M 件」に明示。
  - `language` 指定時に `lang` 一致の行へ絞る簡易フィルタ。
  - 振り分けプロンプトに検索作法（1〜2 語 / `language=ja` / `subreddit` / 同一サービス 3 回まで）を追加。
- **0.1.13**: ソーシャルメディア検索（X / Instagram / Reddit、計 30 API）を追加した。
  - 型付きツール `genspark_x_search` / `genspark_instagram_search` / `genspark_reddit_search`
    （`social` カテゴリ。`action` 省略時は `@handle`→プロフィール／それ以外→投稿検索を自動判定。
    既定 25 件・投稿 URL 付きで整形、`raw: true` で生 JSON）。
  - 振り分けコマンド `/genspark-social` `/genspark-x` `/genspark-instagram` `/genspark-reddit`。
    コマンド自身は API を呼ばず、`promptFor` でモデルへ依頼を渡してサービスと action を選ばせる。
  - グループ付きコマンドの解決（`gsk social twitter`）を `toolInvocation()` として実装し、
    `genspark_run` からも gmail / box / jira / linkedin など 31 グループのツールを実行できるようにした。
- **0.1.12**: 生成の失敗理由を日本語で案内するようにした。status: FAILURE +
  「Content was rejected by the platform's safety policy…」（英語）がそのまま出ていたため、
  safety / policy / rejected 系を「安全ポリシー（センシティブ判定）により拒否されました」と訳し、
  対処（表現を弱める・入力画像を変える・別モデル）を添える。

- **0.1.11**: 生成メディアの保存結果を正直に報告するようにした。ファイルが無いのに「状態: 成功」と
  出ていたのを直し、`status` / `failure_reason` / `task_id` を表示して失敗ならエラーとして返す。
  `genspark.ai` のファイル URL があるときは自前で取得して保存する（CLI の `-o` 失敗時の保険）。
- **0.1.10**: 新しい会話で生成コマンドの受付メッセージが見えない問題を修正した。DSH は blank な
  セッションでヒーロー画面を出し、`turn/start` が来るまでチャット欄（コマンド欄を含む）を覆う。
  生成が終わるまで約 70 秒間なにも表示されなかった（2026-10-18 実機）。受付時に
  `scheduleReceipt` で followup を 1 通送ってターンを起こし、ヒーローを解除する。
  既存の会話では何もしない。**DSH 本体は変更しない**（プラグインだけで完結）。
- **0.1.9**: 引き継ぎメッセージに `role: 'user'` と `id`（UUID）を付与した。0.1.8 までは
  `{content, source}` だけを `agent.followup` へ渡しており、保存は通るが**次にセッションを開くときに
  「session event at seq N lacks an identified message」で開けなくなる**（2026-10-18 実機で 2 セッションが破損）。
  既存の壊れたログは `tools/repair-session.mjs`（ワークスペース直下）で修復できる。
- **0.1.8**: 受付メッセージが `commandInlineWaitMs`（既定 2500）に引きずられ、0.1.7 の
  「入力直後 150ms で返す」が実機で効いていなかったのを修正。生成・解析系は設定値に関わらず
  最大 150ms で返す（0 以下なら従来どおり完了まで待つ）。
- **0.1.7**: 生成・解析系のコマンドは**入力直後（150ms）に「Genspark に送信中です」**を返すようにした。
  従来は 2.5 秒待ってから「実行中です」を返していたため、その間は無反応に見えていた。
  150ms 以内に終わる検証エラーは従来どおりその場で返す。
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
