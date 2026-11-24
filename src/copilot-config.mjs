import spawn from 'cross-spawn';

// This command inventories configuration; it never starts upstream MCP servers.
// Keep stdout private: configuration exports can contain authentication headers.
export async function copilotInventory({ workspace, copilotHome, signal, executable = process.env.SPEED_MCP_COPILOT_BIN || 'copilot', timeoutMs = 8000, commandArgs = ['mcp', 'list', '--json'] } = {}) {
  if (process.env.SPEED_MCP_DISCOVERY === 'json' || process.env.SPEED_MCP_SKIP_COPILOT_EXPORT === '1') return { mode: 'json', servers: null };
  if (signal?.aborted) return { mode: 'json', servers: null, warning: 'Copilot configuration discovery was canceled.' };
  return new Promise(resolve => {
    let done = false; let output = ''; let bytes = 0; let child; let timer;
    const finish = (servers, warning) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (!servers) child?.kill('SIGKILL');
      resolve({ mode: servers ? 'copilot+json' : 'json', servers, warning });
    };
    const cancel = () => finish(null, 'Copilot configuration discovery was canceled.');
    try {
      child = spawn(executable, commandArgs, {
        cwd: workspace, windowsHide: true, stdio: ['ignore','pipe','pipe'],
        env: { ...process.env, COPILOT_HOME: copilotHome, SPEED_MCP_SKIP_COPILOT_EXPORT: '1' }
      });
      child.stdout.setEncoding('utf8'); child.stderr.on('data', () => {});
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 2 * 1024 * 1024) finish(null, 'Copilot configuration export exceeded 2 MiB. Using JSON files instead.');
        else output += chunk;
      });
      child.once('error', () => finish(null, 'Copilot configuration export is unavailable. Using JSON files; set SPEED_MCP_COPILOT_BIN if Copilot is not on PATH.'));
      child.once('close', code => {
        if (done) return;
        try {
          if (code !== 0) throw new Error();
          const parsed = JSON.parse(output.replace(/^\uFEFF/, ''));
          if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) throw new Error();
          finish(parsed.mcpServers);
        } catch { finish(null, 'Copilot did not provide a supported MCP configuration export. Using JSON files instead.'); }
      });
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => finish(null, 'Copilot configuration export timed out. Using JSON files instead.'), timeoutMs);
    } catch { finish(null, 'Copilot configuration export is unavailable. Using JSON files instead.'); }
  });
}
