/**
 * dsh-genspark — A Cordis plugin that makes Genspark's various features available from DeepSeek Harness
 * (search, crawling, image/video/audio generation, media understanding, transcription, AI Drive, task agents,
 * connectors, social media, stock prices, telephony, etc. — 327 tools as measured).
 *
 * Approach (the confirmed spec based on measurement; see docs/00-genspark-cli-spec-review.md):
 *   - Authentication reuses the existing `gsk login` (~/.genspark-tool-cli/config.json).
 *     The plugin does not hold any secrets.
 *   - Launch `@genspark/cli` as a child process (not the shim, but node <dist/index.js>).
 *   - Close stdin and redirect stdout/stderr to temp-file fds (pipes yield EPERM).
 *   - Inject GSK_NO_AUTO_UPDATE=1 (self-update pollutes the exit code, so it is decoupled).
 *   - Pass arguments via `--args-file` with a temporary JSON file (bypassing shell quoting entirely).
 *   - Operations with side effects are unapproved by default = `--no-input` (rejected without a server call).
 *     After the user's approval, pass `--yes` with `approve_write: true`.
 *
 * Category-curated typed tools can be added later on top of the genspark_run / genspark_tools provided
 * by this plugin (settings such as writeMode / enabled can be changed from cordis.patch.yml).
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createCatalogCache } from './lib/catalog.js';
import { buildGensparkCommands } from './lib/commands.js';
import { createRunner } from './lib/gsk-cli.js';
import { buildPromotedTools, promotedSummary } from './lib/promoted.js';
import { buildGensparkTools } from './lib/tools.js';

/** Cordis plugin name (must match the row id). */
export const name = 'dsh-genspark';

/** Only the tool registry is needed (gsk execution completes with just a child process and the filesystem). */
export const inject = ['tools'];

/**
 * Settings schema (given from the config in cordis.patch.yml).
 *
 * `@deepseek-ai/schemastery` is usually resolvable because it is hoisted into the profile, but when the plugin
 * is referenced via a symlink/junction, resolution is based on the real path, so it may not be found.
 * The plugin works with raw config even without a schema, so loading it is optional.
 */
async function loadConfigSchema() {
  try {
    const z = (await import('@deepseek-ai/schemastery')).default;
    return z.object({
      /** Master switch. false unregisters all tools (changing settings takes effect on reload). */
      enabled: z.boolean().default(true),
      /**
       * Absolute path to the @genspark/cli entry (dist/index.js).
       * If empty, the npm global installation location etc. is searched automatically.
       */
      cliEntry: z.string().default(''),
      /**
       * Absolute path to the Node executable (node.exe) used to run the child process.
       * If empty, it is searched automatically. Because DSH runs on Electron, process.execPath is the Electron binary,
       * and using it as is makes commander switch to Electron-style argv interpretation and fail with
       * `error: unknown command '<dist/index.js>'`. A real Node is preferred.
       */
      nodePath: z.string().default(''),
      /**
       * How to handle operations with side effects.
       *   approve … unapproved means --no-input (rejected); approve_write=true means --yes (default)
       *   deny    … always --no-input (no writes are ever executed)
       *   allow   … CLI default (interactive prompts fall back to rejection because stdin is closed)
       */
      writeMode: z.union([z.const('approve'), z.const('deny'), z.const('allow')]).default('approve'),
      /** Timeout for a single gsk run (milliseconds). For long-running tasks, receive a run_id and check later. */
      timeoutMs: z.number().default(600000),
      /** Maximum number of characters returned to the model as the tool result. */
      maxOutputChars: z.number().default(100000),
      /** Directory for temporary files (--args-file and stdout/stderr). If empty, the OS temp area is used. */
      tmpDir: z.string().default(''),
      /** Cache lifetime for the tool catalog (milliseconds). Default 15 minutes. */
      catalogTtlMs: z.number().default(900000),
      /** Timeout for catalog fetching (gsk ls) (milliseconds). */
      catalogTimeoutMs: z.number().default(120000),
      /** Emit the child process's stderr to the log. */
      debug: z.boolean().default(false),
      /**
       * Categories registered as typed tools (promoted tools).
       *   search … search and research (web_search / image_search / crawler / scholar_search / maps_search / summarize)
       *   media  … generated media and media analysis (generate_image / generate_video / generate_audio / analyze_media)
       *   social … social media (x / instagram / reddit search)
       * An empty array leaves only the 3 tools genspark_run / genspark_tools / genspark_status.
       */
      promotedCategories: z.array(z.string()).default(['search', 'media', 'social']),
      /**
       * Register host commands callable from the composer's `+` menu / `/`.
       * The commands themselves do not create model messages (results are drawn outside the model history).
       * Which commands appear follows promotedCategories (removing search / media also removes that category's
       * commands). If the host has no commands service, nothing is done (registration is an optional dependency).
       */
      commands: z.boolean().default(true),
      /**
       * Carry the command execution result over to the agent's next turn so the AI can return an interpretation in chat.
       *
       * By default, host command results appear only in the on-screen command pane, so as things stand
       * the AI cannot read "the pile of search results". When enabled, after execution the result is passed
       * to the model via `agent.followup`, which is asked to answer the key points and interpretation in Japanese
       * (consuming the same amount of tokens as a normal input). Setting it to false does not consume model history, as before.
       */
      commandFollowup: z.boolean().default(true),
      /**
       * Upper bound (milliseconds) for waiting on a command handler's completion.
       *
       * The host is in a submitting transaction (phase = submitting) until the command completes;
       * during that time the composer is not editable and the draft is preserved. For commands that take 8 seconds,
       * such as image generation, the input field stays frozen the whole time, so this duration lets the command complete first
       * and delivers the result through the commandFollowup handoff (chat).
       * Generation and analysis tools prioritize the immediate acknowledgment message, so they return within 150 ms
       * regardless of this value. Setting it to 0 or less waits for completion as before and shows the result in the command pane.
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
      /* Keep working even if no logger is provided */
    }
  };

  const runner = createRunner({ getConfig });
  const catalog = createCatalogCache({ getConfig, log });

  let fiber = null;
  let commandFiber = null;
  /**
   * Result of command registration. Shown in `genspark_status`.
   * This exists so that when no row appears in the menu, you can check in the GUI without chasing logs
   * (whether the service is missing or registration threw).
   */
  let commandState = 'not registered (the host has no commands service, or commands=false)';

  /**
   * Register host commands (the `+` menu / `/`).
   *
   * `commands` is a service that exists only in the desktop GUI, so it is not a required inject;
   * instead we wait with `ctx.inject(['commands'], …)` (an optional dependency). If the service never appears,
   * the callback does not run and the tools keep working as is.
   */
  const installCommands = () => {
    if (commandFiber !== null) return;
    if (getConfig().commands === false) {
      commandState = 'disabled because the setting commands=false';
      return;
    }
    if (typeof ctx.inject !== 'function') {
      commandState = 'cannot register on this host (no ctx.inject)';
      log('[genspark] this host has no commands service, so commands will not be registered');
      return;
    }
    try {
      commandFiber = ctx.inject(['commands'], (inner) => {
        const commands = buildGensparkCommands({
          getConfig,
          runner,
          catalog,
          // Pass ctx to resolve attachments (invocation.attachments) to host paths (attachments is an optional dependency)
          ctx: inner,
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
            inner.logger?.warn?.(`[genspark] failed to register command ${command.name}: ${String(error)}`);
          }
        }
        commandState =
          registered === commands.length
            ? `registered ${registered} commands (/${commands.map((c) => c.name).join(' /')})`
            : `registered only ${registered} of ${commands.length} commands (see the log for failure details)`;
        // Whether registration succeeded is useful for diagnosis after a restart, so log it at info level (debug may not be emitted by default)
        inner.logger?.info?.(`[genspark] commands: ${commandState}`);
      });
    } catch (error) {
      commandFiber = null;
      commandState = `failed to start registration: ${String(error)}`;
      ctx.logger?.warn?.(`[genspark] failed to start command registration: ${String(error)}`);
    }
  };

  const uninstallCommands = () => {
    if (commandFiber === null) return;
    const current = commandFiber;
    commandFiber = null;
    commandState = 'unregistered';
    Promise.resolve(current.dispose()).catch((error) => {
      ctx.logger?.warn?.(`[genspark] failed to unregister commands: ${String(error)}`);
    });
  };

  const install = () => {
    if (fiber !== null) return;
    fiber = ctx.plugin({
      name: 'dsh-genspark:tools',
      apply(inner) {
        // Tool registration is an effect of the child fiber, so dispose removes them all at once
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
            `Promoted tools: ${promotedSummary(cfg?.promotedCategories)}`,
            `Commands: ${commandState}`,
          ],
        });
        for (const tool of tools) inner.tools.register(tool);

        // Category-curated typed tools (selected by the promotedCategories setting)
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
        log?.(`[genspark] registered ${promoted.length} promoted tools`);
      },
    });
  };

  const uninstall = () => {
    if (fiber === null) return;
    const current = fiber;
    fiber = null;
    Promise.resolve(current.dispose()).catch((error) => {
      ctx.logger?.warn?.(`[genspark] failed to unregister tools: ${String(error)}`);
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
