# SKILL.md — Detailed reference for dsh-genspark

**Audience**: AI agents operating this plugin, or developers modifying it.
**How to read this**: For the human-facing overview, see [README.md](README.md). This file holds tool definitions, arguments, internal behaviour, measurement records, and verification steps.

Japanese: [SKILL_ja.md](SKILL_ja.md)

- Target: `dsh-genspark` v0.1.15 / `@genspark/cli` 1.15.0 / measured on 2026-10-18
- Prerequisite: already signed in with `gsk login` (credentials in `~/.genspark-tool-cli/config.json`; the plugin does not store them)
- Catalog as measured: **327 tools / 32 groups** (`gsk ls`)

---

## 1. Tools (functions the model calls)

### 1.1 General (category-independent, always registered)

| Tool | Purpose |
|---|---|
| `genspark_run` | Run any Genspark tool (`tool` + `args` (JSON) + `approve_write` if needed) |
| `genspark_tools` | Browse and search the catalog of 327 tools (`keyword` / `group` / `full=true` for the full schema) |
| `genspark_models` | List generation models (`kind`: image / video / audio / transcribe; `filter` for partial matches) |
| `genspark_status` | Authentication, CLI path, version, runtime, write policy, catalog state |

Typical flow:

```
1) genspark_tools(keyword: "slack send", full: true)   … confirm the exact tool name and arguments
2) genspark_run(tool: "slack", args: { action: "search", query: "..." })   … read-only calls run directly
3) genspark_run(tool: "slack", args: { action: "send", ... }, approve_write: true)
   … writes run only after the user approves
```

Model selection flow:

```
1) genspark_models(kind: "video")   … get the ids of the 21 models
2) genspark_run(tool: "get_model_info", args: { model_names: ["kling/v3"] })   … aspect ratios, duration, audio
3) genspark_generate_video({ query: "...", model: "gemini/veo3.1" })
```

### 1.2 Promoted tools (curated categories)

Selected by `promotedCategories` (default `["search","media","social"]`). They can be called directly, skipping argument discovery.
Any tool can also be run through `genspark_run`, but these save you from looking up argument names.

**`search` (search and research)**

| Tool | Genspark tool | Main arguments |
|---|---|---|
| `genspark_web_search` | `web_search` | `q` |
| `genspark_image_search` | `image_search` | `query` |
| `genspark_crawl` | `crawler` | `url`, `render_js`, `raw`, `offset` |
| `genspark_scholar_search` | `scholar_search` | `query` |
| `genspark_maps_search` | `maps_search` | `query_type`, `engine`, `query` / `start_addr`+`end_addr` |
| `genspark_summarize_document` | `summarize_large_document` | `url`, `question` |

**`media` (generation)**

| Tool | Genspark tool | Main arguments |
|---|---|---|
| `genspark_generate_image` | `image_generation` | `query`, `image_urls`, `model`, `aspect_ratio`, `image_size`, `save_to` |
| `genspark_generate_video` | `video_generation` | `query`, `model` (required), `image_urls`, `duration`, `audio_enable`, `save_to` |
| `genspark_generate_audio` | `audio_generation` | `prompt`, `model`, `audio_type`, `params`, `save_to` |

**`media` (analysis — understanding images, video, and audio)**

| Tool | Genspark tool | Main arguments |
|---|---|---|
| `genspark_analyze_media` | `understand_images` / `analyze_media` / `audio_transcribe` | `media`, `instruction` |

- `save_to` is passed to the CLI's `-o/--output-file` and **saves the file locally** (relative paths resolve against the session cwd).
  If omitted, only a URL is returned.
- After saving, the **actual format is detected from the leading bytes and the extension is renamed automatically if it disagrees**
  (the CLI does not validate extensions). A typical report:
  `Saved file: <path> (JPEG / 12345 bytes) (extension corrected because the content is JPEG)`
- `extra` (arbitrary JSON) is for arguments that exist in the schema but are not typed (e.g. `tier` / `first_frame_url` for video).
  **Keys that are not in the schema are rejected by the CLI** (before the server call, so no credits are spent).
- Generation models are **not constrained by an enum** (Genspark adds and retires them frequently). The real values come from `genspark_models`.
  Invalid ids are rejected by the CLI before the server call.
- `genspark_crawl` / `genspark_summarize_document` expect a URL. Pass an `http(s)://` URL or a local file path.
  If you pass a Japanese question (prose) instead, the plugin explains the problem in Japanese before the CLI starts
  (and points you to `web_search` / `genspark_run`).

**`social` (social search — 30 APIs across X / Instagram / Reddit)**

| Tool | Genspark tool | Main arguments |
|---|---|---|
| `genspark_x_search` | `social_twitter` (`gsk social twitter`) | `query`, `action` (default: auto), `post_id`, `post_ids`, `start_date`, `end_date`, `language`, `limit` (default: 25), `raw` |
| `genspark_instagram_search` | `social_instagram` (`gsk social instagram`) | `query`, `action`, `post_id`, `post_ids`, `start_date`, `end_date`, `limit`, `raw` |
| `genspark_reddit_search` | `social_reddit` (`gsk social reddit`) | `query`, `action`, `subreddit`, `sort`, `time`, `start_date`, `end_date`, `limit`, `raw` |

- Omitting `action` lets `autoAction()` in `lib/social.js` decide. `@handle` means **that user's posts**
  (X → `get_posts_by_author` / Instagram → `get_posts_by_user` / Reddit → `get_user`); `from:handle` behaves
  the same; anything else becomes `search_posts`. `get_user` returns **only id / username / name**
  (no bio, follower count, or URL; measured), so auto never chooses it. When a human wants that, use `search_users`.
- **Ordering is re-sorted here into descending date order** (because `get_posts_by_author` does not return items
  chronologically; measured). Rows whose date cannot be read keep their original order and go to the end.
  `get_comments` / `search_comments` preserve the original order.
- **The server ignores `limit` and returns 100–127 items**, so the display is cut to 25 items by default
  (`limit` accepts 1–100; use the JSON from `raw: true` if you need every item and field).
  The cut is made explicit: "showing M of N items returned by the server (the rest …)".
- Dates (`start_date` / `end_date`) are **sent only to `search_posts`**. In measurement,
  `get_posts_by_author` + `start_date` failed and succeeded once the date was removed. Dates passed to other
  actions are dropped.
- **Transient failures are retried automatically once** (when a date was sent, the retry drops it).
  In measurement, the same query with the same arguments succeeded a few dozen seconds later.
  `count_posts` / Reddit `search_comments` / `search_subreddits` are unsupported upstream, so they are not retried
  (the message offers alternatives instead).
- Post URLs are sometimes missing from the raw data (X / Reddit), so they are assembled from the id
  (`https://x.com/<user>/status/<id>` / `https://www.reddit.com/r/<sub>/comments/<id>`).
- Empty results produce a fixed message, "No matching results (0 items returned by the server)" (no raw JSON dump).
- `get_post_with_comments` / `get_subreddit_with_posts` return nested `{result:{post,comments}}` /
  `{result:{subreddit,posts}}` structures (measured). Dedicated formatting shows the title, URL, comments, and
  subreddit heading. **Comments are often empty in measurement** (this is not a failure).
- When `language` is specified for X, only rows whose `lang` matches are kept (if nothing matches, no filtering is applied).
- Billing is **about 1.6 credits per call** (measured: 20.8 for 13 calls). Instagram post search takes 10–15 seconds,
  and Reddit `get_post_with_comments` / `get_subreddit_with_posts` can take around 40 seconds.
- Reddit search quality depends on the upstream service; with `query` alone, unrelated subreddits slip in
  (e.g. 1 in 50 items). Narrow with `subreddit` or use a single word. Search result rows
  **do not include score or comment counts**.

### 1.3 Media analysis routing (`genspark_analyze_media`)

| Input | Tool actually called | Notes |
|---|---|---|
| Image | `understand_images` | For multiple images, put all of them in `image_urls` |
| Video | `analyze_media` | `media_urls` + `requirements` (the instruction) |
| Audio | `audio_transcribe` | The model is fixed to the default `whisper-1`. The body lands in `segments` |
| Image + video/audio | `understand_images` | Only the images are targeted |

- Passing `media_list` (an array) routes each type accordingly. A singular `media` is also accepted.
- Do not let the user choose the model (it is pinned to the default general-purpose model so nothing breaks when a model disappears).
- Transcription responses look like `{ "<url>": { full_text, segments, words, … } }` and **`full_text` is often empty**.
  The display shows the body from `full_text` → `segments` (string or array) in that order, and never shows `words`
  (word-level timestamps).

---

## 2. Commands (18)

Registered with the host's `ctx.commands.register({name, description, input, handler})`.
`handler` returns `{kind:'success'|'error', text}`. Names must match `/^[a-z][a-z0-9_-]*$/`.

| Command | Implementation | Attachments |
|---|---|---|
| `/genspark` | Status display (runs `me`, lists commands) | — |
| `/genspark-tools` | Catalog search | — |
| `/genspark-models` | Model list | — |
| `/genspark-run` | Arbitrary tool (read-only) | — |
| `/genspark-search` | `web_search` | — |
| `/genspark-image-search` | `image_search` | — |
| `/genspark-crawl` | `crawler` | ✅ |
| `/genspark-scholar` | `scholar_search` | — |
| `/genspark-maps` | `maps_search` | — |
| `/genspark-summarize` | `summarize_large_document` | ✅ |
| `/genspark-image` | `image_generation` | ✅ (reference image) |
| `/genspark-video` | `video_generation` | ✅ (first frame) |
| `/genspark-audio` | `audio_generation` | — |
| `/genspark-analyze-media` | `understand_images` / `analyze_media` / `audio_transcribe` | ✅ |
| `/genspark-social` | The AI chooses the service and action (no API call) | — |
| `/genspark-x` | Same, X only | — |
| `/genspark-instagram` | Same, Instagram only | — |
| `/genspark-reddit` | Same, Reddit only | — |

### 2.1 Attachments (composer images and files)

The host applies three gates:

1. Before the client sends — attachments present AND `desc.input.attachments !== true` → not sent; rejected with a toast
2. `execute()` in `dsh-commands` — without the declaration, returns `/{name} does not accept attachments` and **does not invoke the handler**
3. Declaration present but no attachment service — `no attachment store is composed`

Commands that declare support receive an `ImageBlock`
(`{type:'image', attachment:{attachmentId, mediaType, name}}`) or a `FileBlock` in `invocation.attachments`.
`leadingClaim()` also propagates `claim.attachments = true` to the conversation side.

- Real store (`dsh-attachment-local`): images under `<root>/objects/xx/<sha256>` (**no extension**),
  files under `<root>/files/xx/<sha256>/<name>`. The root is `<dshHome>/attachments/v1`.
- Resolution: pass the block to `imageHostPath` / `fileHostPath` on `ctx.get('attachments')`.
  Images have no extension, so they are **copied** to `<cwd>/genspark-out/attachments/<sha>-<n>.<derived from mediaType>`
  before being passed (gsk determines the type from the extension). Files already have a name, so they are used as-is.
- When attachments are present, **the entire text in the input field becomes the instruction / question**.
  It runs even with empty input.
- In environments where this cannot be resolved, it explains in Japanese that the path should be typed as text,
  and the CLI is not launched.

### 2.2 Handing results over

- After execution, the result is **also passed to the AI** via `agent.followup(message)` (the AI returns the key points and
  interpretation in the chat). Disable it with `commandFollowup: false` (the previous behaviour, which does not consume model history).
- `source` is `{ kind: 'plugin:dsh-genspark' }` (V4 format). The V3 form `{kind:'plugin', plugin:'…'}` is rejected by
  V4 validation and fails the whole turn (observed on real hardware). `tests/preflight-message-source.mjs` pins the shape.
- The handover **does not make the command wait for completion** (it defers to the next tick and swallows the promise).
- By default the command field completes after 2.5 seconds (`commandInlineWaitMs`) and the result is delivered through the handover.
  The host freezes the input field while the send transaction is open until the command completes (measured: 8 seconds for
  image generation). Setting it to 0 or lower waits for completion as before (it waits automatically when the handover is disabled).
- Generation and analysis commands (`ACK_TOOLS`: image/video/audio_generation, understand_images, analyze_media,
  audio_transcribe, summarize_large_document, crawler) **return an acknowledgement 150 ms after input**:
  "Sending to Genspark (estimate …). The result will arrive in the chat shortly."
  The wait prefers **at most 150 ms** rather than the value of `commandInlineWaitMs` (default 2500)
  (following the setting would delay the acknowledgement by 2.5 seconds and freeze the input field for that long).
  If `commandInlineWaitMs` is 0 or lower, it waits for completion as before and shows the result in the command field.
  Validation errors that finish within 150 ms (missing input, etc.) are returned as the result as-is.
  Fast commands such as list and status checks behave as before and return the result inline when it is ready in time.
- The completion text for early returns includes an estimate per generation type (images 15–40 s / video 1–2 min /
  audio 30–60 s. Measured 2026-10-18: about 50 seconds for a 5-second 720p video, about 10 seconds for an image).
- **Workaround for the hero screen in new conversations**: DSH shows a hero screen for a "blank" session and covers
  the chat area (including the command field). Because blank is only cleared by `turn/start`, not even the acknowledgement
  is visible until generation finishes (2026-10-18, real machine: nothing displayed for about 70 seconds for video).
  So on acknowledgement it inspects the log with `agent.session.snapshotEvents()` and, only when there is no `turn/start`
  (= a new conversation), sends one followup to start a turn and dismiss the hero (`scheduleReceipt`).
  In existing conversations the command field is already visible, so it does nothing (avoiding an extra turn, which costs tokens).
  DSH itself is not modified (everything is completed inside the plugin).
- No command **throws**. Unexpected cases are converted into an error result, and the cause goes to the log.
- Generation commands save artifacts to `<cwd>/genspark-out/` and show the path and size.
  When saving fails, it **does not silently report success** (0.1.11+):
  - If a URL exists, it fetches and saves it itself, but only for `genspark.ai` file delivery (a fallback for when the CLI's `-o` fails).
  - If there is no URL, it shows `status` / `failure_reason` / `task_id` and **returns an error**.
    If `failure_reason` is safety / policy / rejected, it explains that the content **was rejected by the safety policy
    (sensitive-content filter)** (0.1.12+; previously it was shown in English).
    Measured (2026-10-18): an NSFW video returned `status: FAILURE` +
    "Content was rejected by the platform's safety policy…" and finished in 6 seconds.
    A normal video takes about 50 seconds, so **an extremely short duration is a sign of rejection**.
  - Re-running the same command starts a **new generation** (credits are spent). First suggest changing the wording,
    or checking the Genspark screen (history).
- **Commands have no approval mechanism.** Operations with side effects always run with `--no-input`, and anything
  requiring confirmation or interaction is rejected up front (writes go through the `genspark_run` tool).

### 2.3 Meta-intent guard (when a generation command receives a model list or usage request)

- Generation commands (`/genspark-image` `/genspark-video` `/genspark-audio`) pass their input **straight through as the
  generation prompt**, so a meta request such as "video model list" was executed as a generation and burned credits
  (measured 2026-10-18: running `/genspark-video video model list` twice cost about 924 credits).
- `detectMetaIntent()` in `lib/guard.js` detects only "model list" and "usage" requests and, **without generating**,
  returns the model list (the catalog's real enum) or the usage.
- The detection is deliberately narrow (a generation prompt that merely contains "model" passes through, e.g.
  "a video of a woman like a model walking"). When attachments are present the generation target is clear, so the guard is not applied.

### 2.4 Commands cannot run while a new conversation (thread) is being created

- The client resolves `/` commands **against that session's command directory**. If you send one during a transition when
  the session is not open yet, it cannot be resolved and nothing may appear (user report, 2026-10-18; the same
  action repeated after the transition succeeds).
- This is behaviour on the host side (`dsh-client-ui-commands` / `dsh-commands`) and **cannot be avoided from the plugin**
  (the plugin only registers commands; it is not involved in creating sessions or in client-side resolution).
- The README advises "wait until the display settles before running it". The permanent fix is for the client to
  "wait until the session is open before resolving" (a candidate for an upstream improvement).
- Even after the transition finishes and the session is open, the hero screen still covers the chat area in a session that
  has never had a turn. That case is cleared by `scheduleReceipt` in 2.2 (on the plugin side).

### 2.5 Routing commands (`/genspark-social` family)

- These 4 commands **call no API** (they spend no credits and finish in a few milliseconds). They turn the accepted text
  into a request via `promptFor` that states which service to search with which action, and pass it to the model with
  `agent.followup`. The model chooses and runs `genspark_x_search` / `genspark_instagram_search` /
  `genspark_reddit_search` (the `agent` decides and dispatches the API calls).
- The command field returns a short notice: "X (Twitter), Instagram, and Reddit will be searched by the AI:", followed by the accepted request.
- The prompt contains **search practices based on measurement** (0.1.14+): 1–2 word queries / for Japanese use
  `language="ja"` / "#tags" do not work / on Reddit narrow with `subreddit` / at most 3 services, but
  **reworded retries within the same service are capped at 3** / "Failed to execute" can be a transient failure /
  comments are often empty. This came from a retrospective of calling 29 times in a single task during real operation
  (field note from 2026-10-18).
- In environments with `commandFollowup: false` or without `agent.followup`, routing is impossible, so it returns the reason
  and an alternative (use the tools directly) as an error result.
- If the input is empty, it returns only the usage and sends no handover (`promptFor` returns `null`).
- Disabling the `social` category means these 4 commands and 3 tools are not registered.

---

## 3. Authentication

| Method | Steps | Notes |
|---|---|---|
| Browser | `gsk login` | Saved to `~/.genspark-tool-cli/config.json`. Use `--config` / `GSK_CONFIG` for a different profile |
| API key | `GSK_API_KEY=gsk_...` | Environment variables take precedence over config |
| Check | `gsk me` (`gsk login-info`) | Email, plan, remaining credits |
| Sign out | `gsk logout` | Deletes the saved key |

Precedence: CLI options > environment variables (`GSK_API_KEY` / `GSK_BASE_URL` / `GSK_PROJECT_ID`) > config file.
The plugin **stores nothing**. `genspark_status` shows the login state from the result of `me`.

---

## 4. Generation models

The model list comes from the `model` argument enum of `gsk ls` (`lib/models.js`).

| kind | Tool | Count (2026-10-18) | Default |
|---|---|---|---|
| `image` | `image_generation` | 15 | `nano-banana-2-flash-lite` |
| `video` | `video_generation` | 21 | `kling/v3` (the command default) |
| `audio` | `audio_generation` | 25 | Genspark's own default |
| `transcribe` | `audio_transcribe` | 3 | `whisper-1` |

- List: `genspark_models({ kind, filter })` / `/genspark-models [video|kling]`
- Per-model specs: `gsk get_model_info` (argument `model_names`; an array of several is accepted)
- Model additions and retirements are followed automatically (there is no static list)

---

## 5. Implementation notes (based on measurement)

- **Launch**: the shim (`gsk.cmd`) returns EINVAL when spawned from Node. Run `node <dist/index.js>` directly.
- **Runtime**: DSH runs on Electron, so `process.execPath` is `DeepSeek Harness.exe`.
  Using it as-is switches commander into Electron argv parsing and fails with
  `error: unknown command '<...>/dist/index.js'`. The plugin **looks for a real Node (node.exe)** and uses it
  (`config.nodePath` → environment variable → `PATH` → default install location). Only when none is found does it
  fall back to Electron with `ELECTRON_RUN_AS_NODE=1`, but then some commands such as `me` fail and `genspark_status` warns about it.
- **stdio**: under the Windows sandbox, `stdio:'pipe'` returns EPERM. stdout/stderr are redirected to the file descriptors of temporary files.
- **stdin**: `'ignore'` (confirmation prompts hit EOF → rejected. No server call).
- **Environment**: `GSK_NO_AUTO_UPDATE=1` is always injected (a run that attempts an auto-update exits with code `0xC0000409`,
  which cannot be used for success detection).
- **Arguments**: JSON is written to a temporary file and passed with `--args-file` (avoiding shell expansion and quoting breakage).
  The CLI **validates against the schema before calling the server**, so a wrong argument name fails immediately with
  `[ERROR] --args-file: "x" is not a param` (no credits spent).
  - Temporary files are **always made absolute** by `resolveTmpRoot()` (avoiding dependence on the child process's cwd;
    `??` is prevented from treating an empty `tmpDir` as "has a value").
  - `--args-file` is **only added for tools that take parameters**. With empty arguments it is omitted
    (adding it produces `error: unknown option '--args-file'`).
- **Success detection**: the primary check is whether stdout can be read as JSON, not the exit code.
- **Approval**: operations that require confirmation and are not approved are rejected with `--no-input` (exit code 2).
  After approval they run with `--yes`. Interaction-only operations (`interactive_only`: slack send/react/upload/invite,
  google_drive share, x_post_tweet, etc.) cannot be automated by design, so the catalog is checked and they are rejected up front.
- **Grouped commands**: tools such as `social_twitter` are run as `gsk social twitter`
  (`gsk social_twitter` gives `unknown command`). `toolInvocation()` in `lib/catalog.js`
  resolves them from the catalog's `cli.path` / `cli.group` using the same rules as the CLI itself
  (path > group+sub > name) and passes the result to `toolCommand` of `runner.runTool`.
  `genspark_run` also resolves from the cached catalog, and only when it fails with `unknown command` does it
  refetch the catalog and retry once (this makes tools from 31 groups, including gmail / box / jira / linkedin,
  runnable from `genspark_run`).
- **Command registration**: use `ctx.inject(['commands'], …)` so the dependency is **optional**
  (avoiding the whole plugin failing to load in non-GUI profiles). Registering a duplicate in the same scope throws,
  so each registration is wrapped in try/catch. Lines with `input: { hint }` show a hint in the input field instead of
  running immediately when picked from the menu. `input.attachments = true` is the declaration for accepting attachments.
- **Web search provider** (`lib/web-provider.js`, `webSearch.*`):
  - `ctx.web.registerSearchProvider()` is the documented seam. The two DeepSeek backends
    (`dsh-web-deepseek-api` → `deepseek-search-api`, `dsh-web-search-deepseek` → `deepseek-official`) are ordinary
    plugin packages registering through the same call, so this needs no host change.
  - Registration goes through `ctx.inject(['web'], …)` (optional dependency) and the provider is unregistered by
    disposing that fiber: `registerSearchProvider` scopes its effect with `this.ctx.effect(...)`, which binds to the
    **calling** fiber.
  - `available()` must stay cheap and local (the seam forbids network calls there): enabled **and** the CLI entry exists.
    A provider that claims availability while the CLI is missing turns into `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`
    instead of a fallback.
  - Selection: `web.searchProvider` is the same settings field the official Web search page writes. The handover uses
    `settings.update('web', { searchProvider: 'genspark' })`; giving it back uses `settings.mutate('web', [{op:'unset',
    path:['searchProvider']}])`, which falls through to the inherited (base) value — or `update` with the value the user
    had chosen when one was recorded. Order matters: register → select, and clear → unregister, so no search ever sees a
    selection with no provider behind it.
  - **Live settings without a restart**: `webSearch.enabled` / `webSearch.autoSelect` are `.volatile()`. The host then
    commits the new value into the running config and emits `loader/volatile-update` on the plugin's own fiber instead of
    remounting it, so `apply` must re-run its sync from that event. (A non-volatile config field would only be applied on
    reload — and the settings card exists **only** for the volatile fields: `SettingsForms.describe()` skips entries whose
    `volatileForm()` is empty.)
  - Payload mapping is defensive (`organic_results` / `results` / `items` / nested `data`, `url|link`, `snippet|description`,
    date → ISO only if it parses) because the CLI documents the shape only as "titles, snippets, and URLs".
    Failures go through `describeRun()` so the wording matches `genspark_web_search` (auth hint, timeout, stderr).

## 6. Development

> Running `gsk --version` from a shell can **fail under ExecutionPolicy**
> (`gsk.ps1 cannot be loaded because running scripts is disabled`). To check the version,
> launch dist directly, e.g. `node <npm>\@genspark\cli\dist\index.js --version`.
> The plugin is unaffected because it uses `resolveNodeRuntime()` and launches dist directly.

```powershell
# Unit tests (no host, no network)
node tests/unit.test.mjs
node tests/runtime.test.mjs
node tests/promoted.test.mjs
node tests/social.test.mjs
node tests/web-provider.test.mjs
node tests/commands.test.mjs

# Verify against the host's real dsh-tools / dsh-commands (preflight before restarting)
node tests/preflight-host-schema.mjs     # defineTool DSL and argument validation
node tests/preflight-commands-host.mjs   # can the 14 commands be registered on the real CommandRuntime?
node tests/preflight-commands-exec.mjs   # verify the execution path with the real dispatcher
node tests/preflight-commands-exec.mjs --with-cli  # also run against the real CLI (read-only, a few credits)
node tests/preflight-plugin-load.mjs     # actually load the shipped index.js and run through apply()
node tests/preflight-message-source.mjs  # does the handover pass the real V4 validation?
node tests/preflight-error-sweep.mjs     # 14 commands × failure types (exception, error response, timeout, invalid return value)

# Integration tests against the real CLI (requires a signed-in environment)
node tests/integration.mjs
node tests/promoted-integration.mjs                    # read-only tools only (free)
node tests/promoted-integration.mjs --with-generation  # image and audio generation (credits are spent)
node tests/promoted-integration.mjs --with-generation --with-video  # video generation (high cost)
node tests/commands-integration.mjs                    # 14 commands (read-only tools)

# Verify under the same conditions as DSH (parent process is Electron)
$env:ELECTRON_RUN_AS_NODE='1'; & 'D:\deepseek\DeepSeek Harness.exe' tests/electron-runtime.mjs
```

Current results: 173 unit tests / 432 host preflight checks (all passing).

## 7. Distribution

A private package for local development (not published to npm).
Install it into a profile with `../install-to-profile.ps1` (`-Sync` / `-Uninstall`)
(it copies to `node_modules/dsh-genspark` and registers it in `dsh.profile.bundles`. DSH must be restarted for the change to take effect).

### Why it is also registered in the profile's `dependencies`

With `bundles` alone, plugin_manager's `listBundles()` checks
`installed = dependencies.includes(name)` and therefore treats the plugin as **not installed**
(`removable` is also false). The script runs `pnpm add --lockfile-only file:./node_modules/dsh-genspark`
to create entries in `dependencies` and in the lockfile as well (it does not move the files in `node_modules`).

> DSH rejects CLI operations for `--profile desktop` because it is Electron-only,
> so `dsh plugin add` cannot be used for desktop. That is why the script calls `pnpm` directly.

## Changelog

- **0.2.1**: The switch has a real UI. `lib/client.js` is the package's browser half (`dsh.client`,
  `exports["./client"]`) and contributes a **Genspark** card to the Plugins panel — the same
  `plugins.item` list the official Web search card uses. 0.2.0 shipped only the Host half, and the
  Web GUI has no page that renders a third-party plugin schema on its own, so the settings were
  invisible.
  - The card writes `webSearch.enabled` / `webSearch.autoSelect` through `ctx.configForms` (the
    shared settings form service), so a flip applies immediately through `loader/volatile-update`.
  - It mounts only while the Host serves the `dsh-genspark` settings namespace (`whileServed`), and
    it never disposes the shared form — the provider owns it.
  - Tests: `tests/preflight-client-card.mjs` (36 checks) runs the shipped bundle against a fake
    module loader and React.
- **0.2.0**: The built-in `web_search` can now be answered by Genspark (opt-in, **default OFF**).
  - New module `lib/web-provider.js`: registers a `genspark` search provider through
    `ctx.web.registerSearchProvider()` (the documented seam the two DeepSeek backends use) and runs
    one `gsk web_search` per query. No proxy, no extra port, no key to manage.
  - Settings card: `Settings → Plugins → dsh-genspark → webSearch.enabled` / `webSearch.autoSelect`.
    These are `.volatile()`, so turning them on takes effect **without restarting DSH**
    (`loader/volatile-update` → re-sync). They are the only fields the host renders, because a
    settings entry with no volatile field gets no card at all.
  - `autoSelect` (default true) writes `web.searchProvider = 'genspark'` — the same settings field the
    official Web search page writes. Turning the option off hands the selection back: the value the
    user had explicitly chosen, or the automatic one-provider selection. It never overwrites a
    selection the user changed afterwards.
  - `genspark_status` reports a `Web search (web_search):` line, so "did the replacement actually
    happen" is visible without digging through logs.
  - Failures are `WEB_PROVIDER_ERROR` / `WEB_ABORTED` with the `genspark_web_search` wording
    (auth hint, timeout, raw stderr); zero results are an error, not an empty citation list.
  - `web_fetch` is untouched (`dsh-web-fetch-http` ships with DSH base in both profiles).
- **0.1.15**: The plugin is now English-first.
  - Every model-facing and user-visible string is English: tool and parameter descriptions,
    command descriptions/hints, follow-up prompts, result headings and labels, error messages,
    `genspark_status` output and the catalog dump.
  - `README.md` / `SKILL.md` rewritten in English; the Japanese originals are kept as
    `README_ja.md` / `SKILL_ja.md`.
  - Model-facing prompts no longer force a reply language: follow-ups and social routing ask for
    "the same language the user is using".
  - Japanese **input matching** is preserved (meta-intent guard for generation commands and the
    `/genspark-models` kind aliases) via `\uXXXX` escapes, so the source stays ASCII-only without
    losing protection for Japanese "list of video models" input.
  - Number formatting switched to `en-US`; counts are pluralised (`1 result` / `2 results`).
- **0.1.14**: Fixed social search based on feedback from real use (two field notes from 2026-10-18).
  - Fixed **`get_post_with_comments` / `get_subreddit_with_posts` returning empty rows**
    (dedicated formatting for the `{result:{post,comments}}` / `{result:{subreddit,posts}}` nesting).
  - **Sorted posts by descending date** (some actions do not return items chronologically).
  - On failure it **drops the dates and retries automatically once** (transient failures were observed).
    The failure message also distinguishes "not necessarily unsupported".
  - `start_date` / `end_date` are sent only to `search_posts` (avoiding the `get_posts_by_author` + date failure).
  - `auto` for `@handle` now goes to **that user's posts** instead of `get_user` (`get_user` returns only id/name).
  - Raw JSON dumps for empty results became a fixed message, and the `limit` cut is stated as
    "M of N items returned by the server".
  - A simple filter keeps only rows whose `lang` matches when `language` is specified.
  - Added search practices to the routing prompt (1–2 words / `language=ja` / `subreddit` / up to 3 calls per service).
- **0.1.13**: Added social media search (X / Instagram / Reddit, 30 APIs in total).
  - Typed tools `genspark_x_search` / `genspark_instagram_search` / `genspark_reddit_search`
    (`social` category. When `action` is omitted, `@handle` → profile and anything else → post search are detected
    automatically. 25 items by default, formatted with post URLs; `raw: true` returns raw JSON).
  - Routing commands `/genspark-social` `/genspark-x` `/genspark-instagram` `/genspark-reddit`.
    The commands themselves call no API; `promptFor` passes the request to the model and lets it choose the service and action.
  - Implemented resolution of grouped commands (`gsk social twitter`) as `toolInvocation()`,
    and made tools from 31 groups such as gmail / box / jira / linkedin runnable from `genspark_run`.
- **0.1.12**: Generation failure reasons are now explained. status: FAILURE +
  "Content was rejected by the platform's safety policy…" (English) used to be shown as-is, so
  safety / policy / rejected cases are now translated into "rejected by the safety policy (sensitive-content filter)",
  with suggested fixes (soften the wording, change the input image, try another model).
- **0.1.11**: Generation media save results are now reported honestly. It used to say "status: success"
  even when there was no file; now `status` / `failure_reason` / `task_id` are shown and failures are returned as errors.
  When a `genspark.ai` file URL exists, it is fetched and saved by the plugin itself (a fallback for CLI `-o` failures).
- **0.1.10**: Fixed the problem where the acknowledgement message of generation commands was invisible in new conversations.
  DSH shows a hero screen for a blank session and covers the chat area (including the command field) until
  `turn/start` arrives. Nothing was displayed for about 70 seconds until generation finished (real machine, 2026-10-18).
  On acknowledgement, `scheduleReceipt` sends one followup to start a turn and dismiss the hero.
  Nothing is done in existing conversations. **DSH itself is not modified** (everything stays inside the plugin).
- **0.1.9**: Added `role: 'user'` and an `id` (UUID) to the handover message. Up to 0.1.8 only
  `{content, source}` was passed to `agent.followup`; saving succeeded, but **reopening the session later failed**
  with "session event at seq N lacks an identified message" (two sessions were corrupted on a real machine, 2026-10-18).
  Existing broken logs can be repaired with `tools/repair-session.mjs` (directly under the workspace).
- **0.1.8**: Fixed the acknowledgement message being dragged by `commandInlineWaitMs` (default 2500),
  which meant the 0.1.7 behaviour of "returning within 150 ms of input" did not work on real hardware.
  Generation and analysis commands now return within at most 150 ms regardless of the setting
  (0 or lower waits for completion as before).
- **0.1.7**: Generation and analysis commands now **return "Sending to Genspark" immediately after input (150 ms)**.
  Previously they waited 2.5 seconds before returning "running", which looked like no response during that time.
  Validation errors that finish within 150 ms are still returned inline as before.
- **0.1.6**: Added wait estimates per generation type to the command field's completion text
  (images 15–40 s / video 1–2 min / audio 30–60 s). Videos take about 50 seconds in measurement, so they were
  easily mistaken for a hang. The new-session issue was reflected in README / SKILL as "executed before the transition finished".
- **0.1.5**: Added a **meta-intent guard** to generation commands. Fixed the problem where requests such as
  `/genspark-video video model list` triggered a generation (and billing); it now returns the model list or usage
  (`lib/guard.js`). Documented the workaround for commands not working in new conversations in README / SKILL as host behaviour.
- **0.1.4**: Added the generation model list (`genspark_models` / `/genspark-models`, returning the catalog enum's real values).
  Removed the enum constraint on model names so Genspark's additions and retirements can be followed.
  Reorganised README for humans (setup, authentication, commands) and split the details into SKILL.md.
- **0.1.3**: Renamed `/genspark-vision` → **`/genspark-analyze-media`** and `genspark_vision` →
  **`genspark_analyze_media`** (since it also handles audio and video, `vision` did not match reality).
  No aliases for the old names are provided.
- **0.1.2**: Fixed the display of transcription results. When `full_text` is empty, `segments` is shown as the body
  (it used to dump the whole JSON and the word-level timestamps in `words`).
- **0.1.1**: Attachment support for commands (5 commands). The host passes attachments only to commands that declare
  `input.attachments = true`, so sending is rejected without the declaration. Vision results now show the analysis body
  instead of a list-style rendering.
- **0.1.0**: Initial release (replaced `/genspark-model`; understands images, video, and audio with the default general-purpose model).
