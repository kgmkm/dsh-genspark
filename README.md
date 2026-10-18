# dsh-genspark

DeepSeek Harness（DSH）から **Genspark** の AI 機能を使えるようにするプラグインです。
検索・調査・画像/動画/音声の生成・メディア解析を、コンポーザから `/genspark-*` コマンドで呼び出せます。

## はじめかた

### 1. CLI を入れてログインする

```powershell
npm install -g @genspark/cli
gsk login      # ブラウザが開く → Genspark アカウントで承認
gsk me         # メール・プラン・残クレジットが出れば成功
```

- 認証情報は `~/.genspark-tool-cli/config.json` に保存されます。**このプラグインは秘密情報を保持しません**
  （CLI が保存したものを使うだけです）。
- ブラウザを使えない環境（CI・サーバー）では API キーでも認証できます。

  ```powershell
  $env:GSK_API_KEY = "gsk_..."   # Genspark の API キー
  ```

- アカウントを変えるときは `gsk logout` → `gsk login`。
- ログイン状態は `/genspark`（または `gsk me`）でいつでも確認できます。

### 2. プラグインを配置する

```powershell
powershell -ExecutionPolicy Bypass -File .\install-to-profile.ps1 -Profile "$env:USERPROFILE\.dsh\profiles\web" -Sync
```

desktop アプリ側にも入れる場合は `...\.dsh\profiles\desktop` に対して同じコマンドを実行します。

### 3. DSH を再起動する

**ページのリロードでは反映されません**（プラグインはサーバー起動時に一度だけ読み込まれます）。
再起動後に `/genspark` を実行して、アカウントと残クレジットが出れば準備完了です。

## コマンド一覧

コンポーザの `+` メニュー、または行頭の `/` から選べます。
（`+` で開くときは**入力欄を空**にしてください。引数付きコマンドは空のときだけ候補に出ます）

### 調べる

| コマンド | できること | 例 |
|---|---|---|
| `/genspark` | 接続状態・アカウント・残クレジット | `/genspark` |
| `/genspark-search` | Web 検索 | `/genspark-search DeepSeek V4 の評判` |
| `/genspark-image-search` | 画像検索 | `/genspark-image-search 桜 満開` |
| `/genspark-crawl` | ページ本文を読み取る | `/genspark-crawl https://example.com/article` |
| `/genspark-scholar` | 学術論文を探す | `/genspark-scholar diffusion model speech` |
| `/genspark-maps` | 地図・場所を調べる | `/genspark-maps 東京駅周辺のカフェ` |
| `/genspark-summarize` | 長い文書を要約する（PDF 可） | `/genspark-summarize <URL> 要点は何？` |

### 作る

| コマンド | できること | 例 |
|---|---|---|
| `/genspark-image` | 画像を生成する | `/genspark-image 夕焼けの富士山` |
| `/genspark-video` | 動画を生成する | `/genspark-video 桜の花びらが舞う 5 秒` |
| `/genspark-audio` | 音声・音楽を生成する | `/genspark-audio おはようございます` |

成果物は `<作業ディレクトリ>/genspark-out/` に保存され、保存先とサイズが表示されます。

待ち時間の目安（実測）: 画像 15〜40 秒 / 音声 30〜60 秒 / **動画 1〜2 分**（5 秒・720p で約 50 秒。
長い動画はさらにかかります）。生成・解析系は入力直後に「Genspark に送信中です」と返り、
結果はこのあとチャットに届きます。

### 理解する

| コマンド | できること | 例 |
|---|---|---|
| `/genspark-analyze-media` | 画像・動画・音声の内容を説明する（音声は文字起こし） | `/genspark-analyze-media genspark-out/test_cat.jpg 何をしている？` |

### 上級者向け

| コマンド | できること | 例 |
|---|---|---|
| `/genspark-models` | 選べる生成モデルの一覧 | `/genspark-models 動画` |
| `/genspark-tools` | 全ツール（327 件）から探す | `/genspark-tools slack` |
| `/genspark-run` | 任意のツールを 1 回だけ実行する | `/genspark-run me` |

### 添付ファイルを使う

次の 5 コマンドは、画像・動画・音声・文書を**そのまま添付**して送れます。
添付したときは、入力欄の文字が「指示・質問」として扱われます。

| コマンド | 添付したものの扱い |
|---|---|
| `/genspark-analyze-media` | 解析する対象（画像・動画・音声） |
| `/genspark-summarize` | 要約する文書 |
| `/genspark-crawl` | 読み取るページのファイル |
| `/genspark-image` | 参照画像（編集・スタイル変換） |
| `/genspark-video` | 先頭フレーム（画像から動画を作る） |

例: 猫の画像を添付して `/genspark-analyze-media 何をしている？`

## 生成モデルを選ぶ

各コマンドは既定のモデルで動きますが、**Genspark は多数のモデルを提供しており、切り替えられます**。

| 種類 | 既定 | 選べる数 |
|---|---|---|
| 画像生成 | `nano-banana-2-flash-lite` | 15 モデル |
| 動画生成 | `kling/v3` | 21 モデル |
| 音声・音楽生成 | Genspark 側の既定 | 25 モデル |
| 文字起こし | `whisper-1` | 3 モデル |

使い方:

- **一覧を見る** — `/genspark-models`（`動画` `画像` `音声` `文字起こし` で絞り込み、id の一部でも可）
- **AI に聞く** — 「使える動画モデルは？」「音声モデルの一覧を出して」
  → AI が `genspark_models` で一覧を返します
- **モデルを指定して作る** — 「gemini/veo3.1 で夕焼けの動画を作って」
  → AI が `model` 引数を指定して実行します
- **モデルの詳細** — 「kling/v3 の仕様を教えて」
  → 対応比率・尺・音声の有無を `get_model_info` で調べて返します

> モデル名はプラグイン側で固定していません。一覧は毎回 Genspark のカタログから読むため、
> モデルの追加・廃止に自動で追随します。

> 生成コマンド（`/genspark-image` `/genspark-video` `/genspark-audio`）に「モデル一覧」「使い方」と
> 書いた場合は、**生成せずに一覧・使い方を返します**（クレジットは消費しません）。
> 生成するときは、作りたい内容をそのまま書いてください。

## 設定

通常は変更不要です。必要になったときだけプロファイルのプラグイン設定に書いてください。

| キー | 既定 | 説明 |
|---|---|---|
| `enabled` | `true` | false でツール登録をすべて解除 |
| `cliEntry` | `""` | CLI エントリの絶対パス（空なら自動探索） |
| `nodePath` | `""` | 子プロセスの node.exe（空なら自動探索） |
| `writeMode` | `approve` | `approve`（未承認の書き込みは拒否） / `deny` / `allow` |
| `timeoutMs` | `600000` | gsk 1 回あたりのタイムアウト |
| `promotedCategories` | `["search","media"]` | 型付きツールとして登録するカテゴリ |
| `commands` | `true` | コンポーザにコマンドを登録する |
| `commandFollowup` | `true` | コマンド結果を AI に渡して解釈させる |
| `commandInlineWaitMs` | `2500` | 入力欄を待たせる上限（ミリ秒） |
| `debug` | `false` | CLI の stderr をログへ出す |

## 困ったとき

| 症状 | 対処 |
|---|---|
| 「API key is required」と出る | `gsk login`（または `GSK_API_KEY` を設定） |
| 「CLI が見つかりません」と出る | `npm install -g @genspark/cli`。それでも駄目なら設定 `cliEntry` |
| コマンド一覧に出てこない | DSH を再起動したか確認（設定 `commands: true`） |
| 添付すると「受け付けません」と出る | 添付に対応しているのは上記 5 コマンドだけ |
| 送信中に入力欄が数秒固まる | 仕様です（既定 2.5 秒で解け、結果は AI がチャットで返します） |
| 生成が失敗する | `gsk me` で残クレジットを確認 |
| 生成せずにモデル一覧が出る | 仕様です（「モデル一覧」の依頼と判定し、クレジットを消費していません） |
| 新しい会話で `/genspark` が何も出ない | 「新規セッション」直後はセッション作成（画面の遷移）が終わっていないことがあります。表示が落ち着いてから実行するか、先に一言送ってください。それでも出ないときは、その時刻を控えてお知らせください（ホスト側の挙動で、プラグインからは制御できません） |
| 新しい会話で `/genspark-video` がしばらく無反応 | 生成系は受付と同時に短いターンを起こしてヒーロー画面を解除します（0.1.10〜）。それでも無反応なら、セッションの遷移が終わっていない可能性があります |
| 動画・画像が保存されない／生成がすぐ終わる | 結果に `status` と `failure_reason`、`task_id` が出ます（0.1.11〜）。`FAILED` ならプロンプトが**センシティブ判定**で拒否された可能性があります（表現を変えてください）。同じコマンドの再実行は新しい生成＝クレジット消費です |

## もっと詳しく

- ツール（モデルが呼ぶ関数）の一覧・引数・実装メモ・検証手順 → [SKILL.md](SKILL.md)
- 設計の経緯と実測記録 → [`../docs/`](../docs/)
- 変更履歴 → [SKILL.md の末尾](SKILL.md#変更履歴)
