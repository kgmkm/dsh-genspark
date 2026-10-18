/**
 * gsk の標準出力を解釈する層。
 *
 * 実測で確定した 2 つの出力形:
 *   1. ツール実行: ApiResponse エンベロープ
 *      { status: 'ok'|'error', message, data, error_code?, http_status?, retry_after?, instruction_for_agent? }
 *   2. `gsk ls`（カタログ）: エンベロープ無しで { tools: ToolSchema[], features?: {...} } を直接出力
 *
 * 成功判定は終了コードではなく「stdout が JSON として読めたか」を主とする
 * （自動更新が走った実行では終了コードが 0xC0000409 になり得るため）。
 */

/** エンベロープらしいオブジェクトか（status を持つ）。 */
export function isEnvelope(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof value.status === 'string';
}

/**
 * stdout から JSON を 1 つ取り出す。
 * 既定は 1 行 JSON だが、将来の複数行出力にも耐えるよう後方から走査し、最後に全文解析も試す。
 */
export function parseEnvelope(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line.length === 0 || (line[0] !== '{' && line[0] !== '[')) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') return { value, raw: line, line: index + 1 };
    } catch {
      /* 次候補へ */
    }
  }
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === 'object') return { value, raw: trimmed, line: null };
    } catch {
      /* JSON ではない */
    }
  }
  return { value: undefined, raw: trimmed.slice(-2000), line: null };
}

/** 後方互換のための薄いラッパー（旧名）。 */
export function parseGskOutput(stdout) {
  const { value, raw } = parseEnvelope(stdout);
  return { envelope: isEnvelope(value) ? value : undefined, value, raw };
}

export const AUTH_HINT =
  'Genspark の認証がありません。ターミナルで `gsk login`（PowerShell では実行ポリシーの都合で `gsk.cmd login`）を実行してください。';
export const CONFIRM_HINT =
  'この操作は Genspark CLI 側で確認が必要で、承認が渡されていないため実行されませんでした（サーバー呼び出しなし）。' +
  'ユーザーの承認を得たうえで approve_write=true を付けて再実行してください。';
export const INTERACTIVE_HINT =
  'この操作は対話が必要な操作（interactive_only）です。プラグインからは実行できないため、ユーザーが手動で実行する必要があります。';
export const CRAWLER_HINT =
  'crawler は「ページの URL」を受け取るツールです（本文を取得して Markdown にする）。' +
  '調べたいことを日本語で渡すと、それを URL として取得しようとしてこのエラーになります。' +
  '質問を調べたい場合は web_search（コマンドなら /genspark-search）を使ってください。';

/** 長すぎる結果を切り詰める（末尾を残しつつ上限を守る）。 */
export function truncate(text, maxChars) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 100000;
  if (text.length <= limit) return { text, truncated: false, originalLength: text.length };
  return {
    text: `${text.slice(0, limit)}\n\n…（残り ${text.length - limit} 文字を省略。必要なら keyword / limit で絞ってください）`,
    truncated: true,
    originalLength: text.length,
  };
}

/** data をモデルに読ませるテキストへ整形する。 */
export function formatData(data, maxChars) {
  if (data === undefined) return '（data なし）';
  let text;
  if (typeof data === 'string') text = data;
  else {
    try {
      text = JSON.stringify(data, null, 2);
    } catch {
      text = String(data);
    }
  }
  return truncate(text, maxChars).text;
}

/**
 * 実行結果をモデル向けの 1 つのテキストに落とす。
 * @returns {{ ok: boolean, text: string }}
 */
export function describeRun(result, { tool, maxChars } = {}) {
  const { value, raw } = parseEnvelope(result.stdout);

  if (result.aborted) return { ok: false, text: '実行はキャンセルされました。' };
  if (result.timedOut) {
    return {
      ok: false,
      text:
        `Genspark 側の処理が時間内に終了しませんでした（tool: ${tool}）。` +
        '長時間処理（task create / deep_research / video_generation など）は、結果を待たずに run_id や project_id を受け取って ' +
        'task_status / task_info で後から確認する経路を使ってください。',
    };
  }

  // 1) ApiResponse エンベロープ
  if (isEnvelope(value)) {
    if (value.status === 'error') {
      const parts = [`Genspark API エラー: ${value.message ?? '(message なし)'}`];
      if (value.error_code) parts.push(`error_code: ${value.error_code}`);
      if (value.http_status) parts.push(`http_status: ${value.http_status}`);
      if (value.retry_after) parts.push(`retry_after: ${value.retry_after} 秒後に再試行してください`);
      if (value.instruction_for_agent) parts.push(`指示: ${value.instruction_for_agent}`);
      if (typeof value.message === 'string' && /api key/i.test(value.message)) parts.push(AUTH_HINT);
      if (typeof value.message === 'string' && /crawler failed|error fetching url/i.test(value.message)) {
        parts.push(CRAWLER_HINT);
      }
      return { ok: false, text: parts.join('\n') };
    }
    const head = value.message ? `${value.message}\n` : '';
    return { ok: true, text: `${head}${formatData(value.data, maxChars)}` };
  }

  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const stdoutEmpty = typeof result.stdout !== 'string' || result.stdout.trim().length === 0;

  // 2) 確認プロンプトで止められた（--no-input 指定時の仕様: exit code 2 / サーバー未呼び出し）
  if (result.code === 2) return { ok: false, text: CONFIRM_HINT };

  // 3) 認証なし
  if (/API key is required/i.test(stderr)) return { ok: false, text: `${AUTH_HINT}\n(${stderr.trim().split('\n')[0] ?? ''})` };

  // 4) 引数名の誤り。CLI はサーバー呼び出しの前に --args-file をスキーマ検証するため、
  //    このエラーはクレジットを消費しない（実測: `[ERROR] --args-file: "x" is not a param`）。
  //    注: `--args-file` の語だけで判定してはいけない。ファイルが読めない等の別の失敗
  //    （ENOENT など）まで「引数名の誤り」と誤診してしまうため、症状を限定する。
  if (/is not a param/i.test(stderr)) {
    return {
      ok: false,
      text:
        `引数の名前が Genspark 側のスキーマと一致しません（tool: ${tool}）。サーバーは呼び出されていません。\n` +
        'genspark_tools（keyword=<ツール名>, full=true）で正確な引数名を確認してください。\n' +
        stderr.trim().slice(0, 600),
    };
  }

  // 4b) 引数ファイル自体を CLI が読めなかった（プラグイン側の不具合。再試行しても直らない）
  if (/--args-file/i.test(stderr) && /ENOENT|EACCES|EPERM|no such file/i.test(stderr)) {
    return {
      ok: false,
      text:
        `引数ファイルを Genspark CLI が読み取れませんでした（tool: ${tool} / exit code: ${result.code ?? '不明'}）。` +
        'これはプラグイン側の一時ファイル作成の問題です（サーバーは呼び出されていません）。\n' +
        stderr.trim().slice(0, 600),
    };
  }

  // 5) 存在しないツール・引数エラー
  if (/unknown command|unknown option|error: unknown/i.test(stderr)) {
    return { ok: false, text: `CLI がコマンド/オプションを解釈できませんでした（tool: ${tool}）。\n${stderr.trim().slice(0, 1200)}` };
  }

  // 6) それ以外: stdout が JSON でない（text 出力・クラッシュ・空）
  const detail = [
    `Genspark CLI の出力を JSON として解釈できませんでした（tool: ${tool} / exit code: ${result.code ?? '不明'}）。`,
    stdoutEmpty ? 'stdout は空でした。' : `stdout 先頭: ${raw.slice(0, 400)}`,
    stderr.trim().length > 0 ? `stderr: ${stderr.trim().slice(0, 1200)}` : '',
  ].filter(Boolean);
  return { ok: false, text: detail.join('\n') };
}
