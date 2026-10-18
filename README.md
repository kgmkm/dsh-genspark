# dsh-genspark

A plugin that brings **Genspark**'s AI capabilities into DeepSeek Harness (DSH).
Search, research, image/video/audio generation, media analysis, and social network search
(X / Instagram / Reddit) can all be called from the composer with `/genspark-*` commands.

Japanese: [README_ja.md](README_ja.md)

## Getting started

### 1. Install the CLI and log in

```powershell
npm install -g @genspark/cli
gsk login      # opens the browser → approve with your Genspark account
gsk me         # success if your email, plan, and remaining credits are shown
```

- Credentials are stored in `~/.genspark-tool-cli/config.json`. **This plugin never holds secrets**
  (it only uses what the CLI has saved).
- On machines without a browser (CI, servers), you can authenticate with an API key instead.

  ```powershell
  $env:GSK_API_KEY = "gsk_..."   # your Genspark API key
  ```

- To switch accounts, run `gsk logout` → `gsk login`.
- You can check the login state at any time with `/genspark` (or `gsk me`).

### 2. Install the plugin into a profile

```powershell
powershell -ExecutionPolicy Bypass -File .\install-to-profile.ps1 -Profile "$env:USERPROFILE\.dsh\profiles\web" -Sync
```

To install it into the desktop app as well, run the same command against `...\.dsh\profiles\desktop`.

### 3. Restart DSH

**Reloading the page is not enough** (the plugin is loaded only once, when the server starts).
After restarting, run `/genspark`; if your account and remaining credits appear, you are ready to go.

## Commands

Available from the composer's `+` menu, or by typing `/` at the start of a line.
(When opening the menu with `+`, **leave the input field empty** — commands that take arguments
only appear as suggestions when it is empty.)

### Search and research

| Command | What it does | Example |
|---|---|---|
| `/genspark` | Connection status, account, remaining credits | `/genspark` |
| `/genspark-search` | Web search | `/genspark-search DeepSeek V4 reviews` |
| `/genspark-image-search` | Image search | `/genspark-image-search cherry blossoms in full bloom` |
| `/genspark-crawl` | Read the body of a page | `/genspark-crawl https://example.com/article` |
| `/genspark-scholar` | Find academic papers | `/genspark-scholar diffusion model speech` |
| `/genspark-maps` | Look up maps and places | `/genspark-maps cafes near Tokyo Station` |
| `/genspark-summarize` | Summarize a long document (PDF supported) | `/genspark-summarize <URL> What are the key points?` |

### Create

| Command | What it does | Example |
|---|---|---|
| `/genspark-image` | Generate an image | `/genspark-image Mount Fuji at sunset` |
| `/genspark-video` | Generate a video | `/genspark-video cherry petals falling, 5 seconds` |
| `/genspark-audio` | Generate speech or music | `/genspark-audio Good morning` |

Artifacts are saved to `<working directory>/genspark-out/`, and the save path and size are displayed.

Typical wait times (measured): images 15–40 s / audio 30–60 s / **video 1–2 min** (about 50 s for a
5-second 720p clip; longer videos take longer). Generation and analysis commands reply with
"Sending to Genspark…" immediately after input, and the result arrives in the chat afterwards.

### Understand

| Command | What it does | Example |
|---|---|---|
| `/genspark-analyze-media` | Describe what is in an image, video, or audio file (audio is transcribed) | `/genspark-analyze-media genspark-out/test_cat.jpg What is it doing?` |

### Social search

`/genspark-social` lets the **AI decide** which service to search and runs the appropriate
search on X / Instagram / Reddit (the command itself calls no API, so credits are spent only on
the searches that are actually performed).

| Command | What it does | Example |
|---|---|---|
| `/genspark-social` | The AI picks and searches X, Instagram, and Reddit | `/genspark-social DeepSeek Harness reviews` |
| `/genspark-x` | Search X (Twitter) only (posts, users, profiles) | `/genspark-x recent posts from @elonmusk` |
| `/genspark-instagram` | Search Instagram only (posts, users) | `/genspark-instagram @natgeo` |
| `/genspark-reddit` | Search Reddit only (posts, comments, subreddits) | `/genspark-reddit local llm reviews` |

- You can get the same results by asking the AI (e.g. "check what people say about Genspark on X"
  → `genspark_x_search`).
- By default, results show up to **25** items with author, date, reaction counts, and post URL
  (newest first).
- About 1.6 credits per call (measured). Instagram searches take 10–15 seconds, and Reddit's
  "post with comments" and "subreddit posts" can take around 40 seconds.
- On X, passing "@username" returns **that user's posts**, while passing a "topic" runs a post
  search. Instagram works the same way. Reddit accepts `sort` (top / new, etc.) and a time range.
- **Search tips** (measured): keep queries to 1–2 words / for Japanese topics use `language="ja"`
  (the AI adds it when you ask for results "in Japanese") / "#hashtags" do not narrow anything /
  on Reddit, naming a subreddit such as "in r/LocalLLaMA" tends to work better.
- If you see "failed to execute", it does not necessarily mean the feature is unsupported
  (transient failures do happen). The plugin **retries automatically once**. If it still fails,
  wait a while or change the wording.
- Comment fetching is often empty in practice (that is not a failure). Reddit search results do
  not include score (vote count), so results are ordered by date instead.

### Advanced

| Command | What it does | Example |
|---|---|---|
| `/genspark-models` | List the generation models you can choose from | `/genspark-models video` |
| `/genspark-tools` | Search across all 327 tools | `/genspark-tools slack` |
| `/genspark-run` | Run any tool once | `/genspark-run me` |

### Using attachments

The following 5 commands accept images, video, audio, and documents **attached directly**.
When you attach something, the text in the input field is treated as the instruction or question.

| Command | How the attachment is used |
|---|---|
| `/genspark-analyze-media` | The target to analyze (image, video, audio) |
| `/genspark-summarize` | The document to summarize |
| `/genspark-crawl` | The page file to read |
| `/genspark-image` | A reference image (editing, style transfer) |
| `/genspark-video` | The first frame (create a video from an image) |

Example: attach a photo of a cat and run `/genspark-analyze-media What is it doing?`

## Choosing a generation model

Each command runs with a default model, but **Genspark offers many models and you can switch
between them**.

| Kind | Default | Available |
|---|---|---|
| Image generation | `nano-banana-2-flash-lite` | 15 models |
| Video generation | `kling/v3` | 21 models |
| Audio / music generation | Genspark's own default | 25 models |
| Transcription | `whisper-1` | 3 models |

How to use them:

- **See the list** — `/genspark-models` (filter by `video`, `image`, `audio`, `transcribe`, or part
  of an id)
- **Ask the AI** — "Which video models are available?" "List the audio models"
  → the AI returns the list via `genspark_models`
- **Generate with a specific model** — "Create a sunset video with gemini/veo3.1"
  → the AI runs it with the `model` argument set
- **Model details** — "Tell me the specs of kling/v3"
  → the AI reports supported aspect ratios, durations, and whether audio is available via
  `get_model_info`

> Model names are not pinned in the plugin. The list is read from Genspark's catalog every time,
> so models that are added or retired are picked up automatically.

> If you type "model list" or "usage" into a generation command (`/genspark-image`,
> `/genspark-video`, `/genspark-audio`), it returns the list or the usage **without generating
> anything** (no credits are spent). When you want to generate, just describe what you want.

## Settings

You normally do not need to change anything. Only when necessary, add these to the plugin
settings of your profile.

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Set to false to unregister all tools |
| `cliEntry` | `""` | Absolute path to the CLI entry (auto-detected when empty) |
| `nodePath` | `""` | node.exe for child processes (auto-detected when empty) |
| `writeMode` | `approve` | `approve` (reject unapproved writes) / `deny` / `allow` |
| `timeoutMs` | `600000` | Timeout per gsk invocation |
| `promotedCategories` | `["search","media","social"]` | Categories registered as typed tools |
| `commands` | `true` | Register the composer commands |
| `commandFollowup` | `true` | Hand command results to the AI for interpretation |
| `commandInlineWaitMs` | `2500` | Upper bound for holding the input field (milliseconds) |
| `debug` | `false` | Send the CLI's stderr to the log |

## Troubleshooting

| Symptom | What to do |
|---|---|
| "API key is required" appears | Run `gsk login` (or set `GSK_API_KEY`) |
| A "CLI not found" message appears | Run `npm install -g @genspark/cli`. If it still fails, set `cliEntry` |
| Commands do not show up in the list | Check that DSH was restarted (setting `commands: true`) |
| Attaching a file says it is not accepted | Only the 5 commands listed above support attachments |
| The input field freezes for a few seconds while sending | By design (it clears after 2.5 s by default, and the AI reports the result in the chat) |
| Generation fails | Check your remaining credits with `gsk me` |
| A model list appears instead of a generation | By design (the request was detected as a "model list" request, and no credits were spent) |
| `/genspark` shows nothing in a new conversation | Right after "New session", session creation (the screen transition) may not have finished. Wait until the display settles before running it, or send a short message first. If it still shows nothing, note the time and let us know (this is host behaviour and cannot be controlled from the plugin) |
| `/genspark-video` stays unresponsive for a while in a new conversation | Generation commands raise a short turn as soon as they accept the input, which dismisses the hero screen (0.1.10+). If it is still unresponsive, the session transition may not have finished |
| Videos and images are not saved / generation ends immediately | The result includes `status`, `failure_reason`, and `task_id` (0.1.11+). If it is `FAILED`, the prompt may have been **rejected by the sensitive-content filter** (try different wording). Re-running the same command starts a new generation, so credits are spent |
| `/genspark-social` only replies that the AI will choose and search | By design. The AI then calls the actual search tools and explains the results in the chat |
| A social search says "failed to execute" | This can be a transient upstream failure (one automatic retry has already been made). Wait a little and change the wording, or change the action. Some actions, such as `count_posts` and Reddit comment search, are not supported upstream |
| Social search results are off-topic | This is upstream search quality. Keep queries to 1–2 words, ask for "in Japanese" on X so `language=ja` is added, and name a subreddit on Reddit such as "in r/LocalLLaMA" |
| Comments come back as 0 items | The upstream API often returns nothing (this is not a failure). Do not dig further; judge from the post search results |

## Learn more

- Tools (the functions the model calls), arguments, implementation notes, and verification steps → [SKILL.md](SKILL.md)
- Design history and measurement records → [`../docs/`](../docs/)
- Changelog → [end of SKILL.md](SKILL.md#changelog)
