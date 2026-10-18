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

## もっと詳しく

- ツール（モデルが呼ぶ関数）の一覧・引数・実装メモ・検証手順 → [SKILL.md](SKILL.md)
- 設計の経緯と実測記録 → [`../docs/`](../docs/)
- 変更履歴 → [SKILL.md の末尾](SKILL.md#変更履歴)
