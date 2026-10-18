/**
 * Assembly of DSH tool definitions (host-independent).
 *
 * `defineTool` is received as an argument so that this layer can be unit-tested without a host.
 * index.js passes defineTool from the host's `@deepseek-ai/dsh-tools` and calls this function.
 *
 * It registers 4 category-independent tools:
 *   - genspark_run    : Run any Genspark tool (arguments are a JSON object)
 *   - genspark_tools  : Browse, search, and show the full schema of the actual catalog (327 tools)
 *   - genspark_models : List of generation models (image / video / audio / transcription)
 *   - genspark_status : Check authentication, the CLI entry, and the write policy
 *
 * Category-curated "typed tools" can be added later on top of these 4 (enabled via settings).
 */
import { describeCatalogFull, describeToolFull, filterTools, groupSummary, summarizeCatalog, toolInvocation } from './catalog.js';
import { collectModels, formatModelList } from './models.js';
import { AUTH_HINT, CONFIRM_HINT, INTERACTIVE_HINT, describeRun, formatData, truncate } from './result.js';

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
};

/** Resolve how write operations are handled from the settings. */
export function resolveWritePolicy(config, approveWrite) {
  const mode = String(config?.writeMode ?? 'approve');
  if (mode === 'deny') {
    return { flags: ['--no-input'], approved: false, mode, note: 'write operations are disabled (always --no-input)' };
  }
  if (mode === 'allow') {
    return { flags: [], approved: true, mode, note: 'CLI default behavior (interactive prompts are declined at EOF)' };
  }
  return approveWrite
    ? { flags: ['--yes'], approved: true, mode, note: 'approved (--yes)' }
    : { flags: ['--no-input'], approved: false, mode, note: 'not approved (--no-input. Operations that require approval are rejected without a server call)' };
}

/** Whether the operation requires confirmation according to the tool schema. */
export function schemaRequiresConfirmation(schema, args) {
  const cli = schema?.cli ?? {};
  if (cli.requires_confirmation) return true;
  if (cli.interactive_only) return true;
  const action = args?.action;
  if (action && schema?.actions?.[action]) {
    const info = schema.actions[action];
    if (info.requires_confirmation || info.interactive_only) return true;
  }
  return false;
}

export function buildGensparkTools({ defineTool, getConfig, runner, catalog, log, statusLines } = {}) {
  const config = () => (typeof getConfig === 'function' ? getConfig() : getConfig) ?? {};
  const maxChars = () => Number(config().maxOutputChars ?? 100000);

  const runTool = defineTool({
    name: 'genspark_run',
    description:
      'Run any Genspark tool (via the Genspark CLI `gsk`).' +
      ' Pass a Genspark tool name to tool (e.g. web_search, crawler, image_generation, video_generation, audio_generation, ' +
      'understand_images, aidrive, create_task, connector_call, stock_price …), and the arguments of that tool to args as a JSON object.' +
      ' Available tool names and arguments can be checked with genspark_tools (filter by keyword; full=true shows the complete schema).' +
      ' Grouped tools (e.g. social_twitter → `gsk social twitter`, x_search_tweets → `gsk x search_tweets`) are also resolved ' +
      'to the correct command name from the catalog cli information and executed.' +
      ' Results are returned as formatted JSON from the Genspark API (status/message/data).' +
      ' Operations with side effects (sending email, posting to Slack, posting to social media, placing calls, etc.) require confirmation, ' +
      'and calling them without approval is rejected without execution. In that case, obtain the user\'s approval and run again with approve_write=true.',
    parameters: {
      tool: {
        type: 'string',
        required: true,
        description: 'Genspark tool name (e.g. web_search, crawler, image_generation, create_task).',
      },
      args: {
        type: 'json',
        description:
          'JSON object of arguments to pass to that tool (e.g. {"q":"latest AI news"}).' +
          ' Calling genspark_tools with full=true shows the exact argument names, types, and required flags for each tool.',
      },
      approve_write: {
        type: 'boolean',
        description:
          'true only when the user has explicitly approved. When true, the confirmation prompt is skipped and the command is executed (--yes).' +
          ' Not needed for read-only tools.',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const cfg = config();
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
      const toolName = String(args.tool ?? '').trim();
      if (toolName.length === 0) return 'Please specify a tool name.';

      // If a catalog cache exists, reject operations that require interaction up front (avoiding needless process launches)
      const cached = catalog?.peek?.();
      const schema = cached?.tools?.find((item) => item.name === toolName);
      if (schema?.cli?.interactive_only) return INTERACTIVE_HINT;

      const policy = resolveWritePolicy(cfg, args.approve_write === true);
      if (schema && schemaRequiresConfirmation(schema, args.args) && !policy.approved) {
        log?.(`[genspark] ${toolName} requires confirmation, so it runs as not approved`);
      }

      const timeoutMs = Number(cfg.timeoutMs ?? 600000);
      const runOnce = (segments) =>
        runner.runTool(toolName, args.args ?? {}, {
          cwd,
          signal: exec?.signal,
          timeoutMs,
          globalArgs: ['--output', 'json', '--timeout', String(timeoutMs), ...policy.flags],
          toolCommand: segments,
        });

      // Grouped tools (social_twitter → `gsk social twitter`) are resolved from the catalog cli information.
      // So that they can be called even without a cache, reload the catalog and retry only when the attempt fails with `unknown command`.
      let segments = schema ? toolInvocation(schema) : [toolName];
      let result;
      try {
        result = await runOnce(segments);
      } catch (error) {
        if (error?.code === 'GSK_ENTRY_NOT_FOUND') return error.message;
        return `Execution failed: ${error?.message ?? String(error)}`;
      }

      if (!result.ok && segments.length === 1 && /unknown command/i.test(result.stderr ?? '')) {
        let resolved = [];
        try {
          const loaded = await catalog.load(runner, { signal: exec?.signal, cwd });
          const found = loaded.tools.find((item) => item.name === toolName);
          if (found) resolved = toolInvocation(found);
        } catch {
          /* If the catalog cannot be fetched, return the original error as is */
        }
        if (resolved.length > 1) {
          log?.(`[genspark] retrying ${toolName} as \`gsk ${resolved.join(' ')}\``);
          segments = resolved;
          try {
            result = await runOnce(segments);
          } catch (error) {
            if (error?.code === 'GSK_ENTRY_NOT_FOUND') return error.message;
            return `Execution failed: ${error?.message ?? String(error)}`;
          }
        }
      }

      const described = describeRun(result, { tool: toolName, maxChars: maxChars() });
      if (cfg.debug && result.stderr?.trim()) {
        log?.(`[genspark] ${toolName} stderr: ${result.stderr.trim().slice(0, 500)}`);
      }
      return described.text;
    },
  });

  const toolsTool = defineTool({
    name: 'genspark_tools',
    description:
      'Inspect the Genspark tool catalog (measured: 327 tools / 32 groups).' +
      ' With no arguments it returns per-group counts and a list of the key tools. Filter by keyword or group;' +
      ' adding full=true returns the complete argument schema of the matching tools (keys passed in args, types, required flags, enums, action list).' +
      ' Use it before calling genspark_run to confirm the exact tool name and arguments.',
    parameters: {
      keyword: {
        type: 'string',
        description: 'Filter over name, aliases, description, and group (space-separated terms are ANDed). Examples: "slack send", "gmail", "task".',
      },
      group: { type: 'string', description: 'Filter by group name (e.g. email, x, connector, hosted, agentbase).' },
      full: { type: 'boolean', description: 'true returns the complete argument schema of the matching tools (the default false returns a one-line summary).' },
      limit: { type: 'number', description: 'Maximum number of items to return (default 60; 12 when full).' },
      refresh: { type: 'boolean', description: 'true re-fetches the catalog from the server (default is a 15-minute cache).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
      let loaded;
      try {
        loaded = await catalog.load(runner, { refresh: args.refresh === true, signal: exec?.signal, cwd });
      } catch (error) {
        const message = String(error?.message ?? error);
        const hint = /API key is required/i.test(message) ? `\n${AUTH_HINT}` : '';
        return `Could not retrieve the catalog: ${message}${hint}`;
      }

      const config_ = { keyword: args.keyword, group: args.group };
      if (args.full === true) {
        const limit = Number(args.limit ?? 12);
        const matched = filterTools(loaded.tools, config_);
        if (matched.length === 0) return `No matching tools (out of ${loaded.tools.length} tools in total).`;
        return truncate(describeCatalogFull(loaded, { ...config_, limit }), maxChars()).text;
      }
      return summarizeCatalog(loaded, { ...config_, limit: Number(args.limit ?? 60) });
    },
  });

  const modelsTool = defineTool({
    name: 'genspark_models',
    description:
      'Returns the **list of selectable models** for image, video, audio, and transcription (it reads the actual values from the server catalog, ' +
      'so it automatically follows model additions and removals). Use it when asked "Which video models are available?" or "List the audio models".' +
      ' Filter by kind, and use filter for a partial match on the id.' +
      ' To learn a specific model\'s supported aspect ratios, duration, and whether it has audio, follow up with ' +
      'genspark_run and get_model_info {"model_names":[id]}.',
    parameters: {
      kind: {
        type: 'string',
        enum: ['image', 'video', 'audio', 'transcribe'],
        description: 'image=image generation / video=video generation / audio=audio and music generation / transcribe=transcription. Omit to get all.',
      },
      filter: { type: 'string', description: 'Partial match on the model id (e.g. "kling", "veo", "elevenlabs").' },
      refresh: { type: 'boolean', description: 'true re-fetches the catalog from the server (default is the cache).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
      let loaded;
      try {
        loaded = await catalog.load(runner, { refresh: args.refresh === true, signal: exec?.signal, cwd });
      } catch (error) {
        const message = String(error?.message ?? error);
        const hint = /API key is required/i.test(message) ? `\n${AUTH_HINT}` : '';
        return `Could not retrieve the model list: ${message}${hint}`;
      }
      const entries = collectModels(loaded);
      if (entries.length === 0) return 'Could not retrieve the model list from the catalog (use `genspark_tools` to check the arguments).';
      return truncate(formatModelList(entries, { kind: args.kind, filter: args.filter }), maxChars()).text;
    },
  });

  const statusTool = defineTool({
    name: 'genspark_status',
    description:
      'Check the status of the Genspark integration. Returns the resolved CLI path and version, the logged-in account, ' +
      'the current write policy (how unapproved side-effecting operations are handled), and the catalog cache status. ' +
      'Use it as the first diagnostic step when authentication errors occur or when a tool seems to be missing.',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute(_args, exec) {
      const cfg = config();
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
      const lines = [];

      const entry = runner.resolveEntry();
      lines.push(`CLI entry: ${entry ?? 'not found (npm install -g @genspark/cli is required, or set the cliEntry setting)'}`);

      const runtime = runner.resolveRuntime?.();
      if (runtime) {
        lines.push(
          `Execution runtime: ${runtime.path} (${runtime.source})` +
            (runtime.isElectron
              ? ' * Because this is an Electron executable, some commands fail. Set the absolute path to node.exe in the nodePath setting'
              : ''),
        );
      }

      try {
        const version = await runner.run(['--version'], { cwd, timeoutMs: 30000, signal: exec?.signal });
        lines.push(`CLI version: ${String(version.stdout ?? '').trim() || `(unknown / exit ${version.code})`}`);
      } catch (error) {
        lines.push(`CLI version: retrieval failed (${error?.message ?? error})`);
      }

      try {
        const me = await runner.run(['--output', 'json', 'me'], { cwd, timeoutMs: 60000, signal: exec?.signal });
        const described = describeRun(me, { tool: 'me', maxChars: 4000 });
        lines.push(
          described.ok
            ? `Account: ${described.text.replace(/\s+/g, ' ').slice(0, 500)}`
            : `Account: ${described.text.replace(/\s+/g, ' ').slice(0, 600)}`,
        );
      } catch (error) {
        lines.push(`Account: retrieval failed (${error?.message ?? error})`);
      }

      const policy = resolveWritePolicy(cfg, false);
      lines.push(`Write policy: writeMode=${policy.mode} (when not approved: ${policy.note})`);
      const extra = typeof statusLines === 'function' ? statusLines(cfg) : [];
      for (const line of Array.isArray(extra) ? extra : []) lines.push(line);
      lines.push(`Timeout: ${cfg.timeoutMs ?? 600000} ms / Output limit: ${cfg.maxOutputChars ?? 100000} characters`);
      const cached = catalog.peek();
      lines.push(
        cached
          ? `Catalog: ${cached.tools.length} tools cached (${new Date(cached.fetchedAt).toLocaleString()})`
          : 'Catalog: not fetched yet (it is fetched when genspark_tools is called)',
      );
      if (entry === null) lines.push(`\n${AUTH_HINT}`);
      return lines.join('\n');
    },
  });

  return [runTool, toolsTool, modelsTool, statusTool];
}

export { CONFIRM_HINT, INTERACTIVE_HINT, formatData, groupSummary, describeToolFull, summarizeCatalog };
