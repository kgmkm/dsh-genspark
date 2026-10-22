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
import {
  GENSPARK_SEARCH_PROVIDER_ID,
  createGensparkSearchProvider,
  createSearchSelectionGuard,
  readLive,
} from './lib/web-provider.js';

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
      /**
       * Replace the built-in `web_search` with the Genspark backend (default OFF).
       *
       * Enabled  … the plugin registers a `genspark` search provider on `ctx.web`, and (with autoSelect)
       *            points `web.searchProvider` at it. That is the same settings field the official
       *            "Web search" page writes, so no DSH internals are patched.
       * Disabled … nothing is registered and the selection is never touched.
       *
       * Both fields are `.volatile()`: that is what makes them editable from the plugin's settings
       * card without restarting DSH (the host only renders a card for live fields).
       */
      webSearch: z.object({
        enabled: z
          .boolean()
          .default(false)
          .volatile()
          .description(
            'Replace the built-in web_search with Genspark. Each search spends Genspark credits and waits for the gsk process to start.',
          ),
        autoSelect: z
          .boolean()
          .default(true)
          .volatile()
          .description(
            'Point web.searchProvider at "genspark" automatically. Turn this off to register the provider only and choose it yourself (web.searchProvider or DSH_WEB_SEARCH_PROVIDER=genspark).',
          ),
      }),
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
   * Genspark search provider (the optional replacement for the built-in web_search).
   *
   * `webState` is shown by `genspark_status` so that "web_search still goes to DeepSeek" is visible
   * in the GUI without chasing logs.
   */
  let webFiber = null;
  let webState = 'disabled (default)';

  /** Live values of the volatile `webSearch` settings. */
  const webConfig = () => {
    const search = (getConfig() ?? {}).webSearch ?? {};
    return {
      enabled: readLive(search.enabled, false) === true,
      autoSelect: readLive(search.autoSelect, true) !== false,
    };
  };

  /**
   * The settings service, if this host has one.
   *
   * Non-strict `get` (second argument `false`) so an instance that exists but is not yet marked
   * active is still usable: the handover is a normal settings write, and refusing it here would
   * leave `web.searchProvider` untouched at start-up for ordering reasons the user cannot see.
   */
  const getSettingsService = () => {
    if (typeof ctx.get !== 'function') return undefined;
    try {
      return ctx.get('settings', false) ?? undefined;
    } catch {
      return undefined;
    }
  };

  const selection = createSearchSelectionGuard({
    getSettings: getSettingsService,
    log,
  });

  /**
   * Register the `genspark` search provider on `ctx.web`.
   *
   * `web` is an optional dependency (a host without the web seam simply keeps the feature inert), so
   * wait for it with `ctx.inject`-style semantics through a child fiber. The provider is unregistered
   * by disposing that fiber: `registerSearchProvider` scopes its effect to the calling fiber.
   */
  const installWebSearch = () => {
    if (webFiber !== null) return;
    if (typeof ctx.inject !== 'function') {
      webState = 'cannot register on this host (no ctx.inject)';
      return;
    }
    try {
      webFiber = ctx.inject(['web'], (inner) => {
        const provider = createGensparkSearchProvider({
          getConfig,
          runner,
          isEnabled: () => webConfig().enabled,
          log: (message) => {
            try {
              inner.logger?.debug?.(message);
            } catch {
              /* noop */
            }
          },
        });
        inner.web.registerSearchProvider(provider);
        inner.logger?.info?.(`[genspark] registered the "${GENSPARK_SEARCH_PROVIDER_ID}" web search provider`);
      });
    } catch (error) {
      webFiber = null;
      webState = `failed to register the provider: ${String(error)}`;
      ctx.logger?.warn?.(`[genspark] failed to register the web search provider: ${String(error)}`);
    }
  };

  const uninstallWebSearch = () => {
    if (webFiber === null) return;
    const current = webFiber;
    webFiber = null;
    Promise.resolve(current.dispose()).catch((error) => {
      ctx.logger?.warn?.(`[genspark] failed to unregister the web search provider: ${String(error)}`);
    });
  };

  /**
   * Bring the provider registration and the `web.searchProvider` handover in line with the settings.
   *
   * Order matters: register before writing the selection, and clear the selection before
   * unregistering, so no search can observe a selection without a provider behind it.
   */
  const syncWebSearch = () => {
    const search = webConfig();
    if (search.enabled !== true) {
      // Also covers a value left behind by a previous session, so turning the feature off heals it.
      void selection
        .release()
        .then((outcome) => {
          if (outcome?.released === true) {
            ctx.logger?.info?.('[genspark] gave the web search provider selection back');
          }
        })
        .catch(() => {
          /* release() already reports through its own outcome */
        });
      uninstallWebSearch();
      webState = 'disabled (default)';
      return;
    }

    let entry = null;
    try {
      entry = runner.resolveEntry();
    } catch {
      entry = null;
    }
    if (typeof entry !== 'string' || entry.length === 0) {
      uninstallWebSearch();
      webState = 'enabled, but the @genspark/cli entry was not found (install @genspark/cli or set cliEntry)';
      return;
    }

    installWebSearch();
    if (search.autoSelect !== true) {
      webState =
        `enabled (registered as "${GENSPARK_SEARCH_PROVIDER_ID}"; autoSelect=false, so selecting it is up to you)`;
      return;
    }

    webState = `enabled (registered as "${GENSPARK_SEARCH_PROVIDER_ID}" and selected in web.searchProvider)`;
    void selection
      .take()
      .then((outcome) => {
        if (outcome?.applied === true) return;
        const reason = outcome?.reason ?? 'unknown reason';
        webState =
          `enabled, but the selection was not written (${reason}). ` +
          `Set web.searchProvider to "${GENSPARK_SEARCH_PROVIDER_ID}" yourself.`;
        ctx.logger?.warn?.(`[genspark] the web search selection was not written: ${reason}`);
      })
      .catch((error) => {
        ctx.logger?.warn?.(`[genspark] the web search selection failed: ${String(error)}`);
      });
  };

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
            `Web search (web_search): ${webState}`,
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
      // The provider belongs to this feature; a selection pointing at an id nobody registers would
      // break every web_search, so hand it back too.
      uninstallWebSearch();
      webState = 'disabled (master switch enabled=false)';
      return;
    }
    install();
    installCommands();
    syncWebSearch();
  };

  /**
   * Live settings edits do not remount the plugin.
   *
   * `webSearch.enabled` / `webSearch.autoSelect` are declared `.volatile()`, so the host commits the
   * new value into the running config and emits this event instead of reloading the entry; re-running
   * `sync()` is what applies the change without a restart.
   */
  if (typeof ctx.on === 'function') {
    ctx.on('loader/volatile-update', () => {
      try {
        sync();
      } catch (error) {
        ctx.logger?.warn?.(`[genspark] failed to apply the new settings: ${String(error)}`);
      }
    });
  }

  // Bundle order is not a contract: if the settings service shows up after this plugin, redo the
  // handover so a feature that was already enabled at start-up still gets its selection written.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['settings'], () => {
        try {
          syncWebSearch();
        } catch (error) {
          ctx.logger?.warn?.(`[genspark] failed to finish the web search handover: ${String(error)}`);
        }
      });
    } catch {
      /* optional dependency: without it the feature still registers, only the selection is manual */
    }
  }

  sync();
  ctx.effect(() => () => {
    uninstall();
    uninstallCommands();
    uninstallWebSearch();
  });
}

export { Config as config };
