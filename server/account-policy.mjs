import { accountError } from './account-data.mjs';

const unsupported = () => accountError('ACCOUNT_STORAGE_UNSUPPORTED');
const sensitive = /credential|forced[_-]|auth|base_url|model_provider|include|managed|^env$/i;
function uncomment(line) {
  let quote = '', escaped = false, out = '';
  for (const c of line) {
    if (!quote && c === '#') break;
    out += c;
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && c === '\\') { escaped = true; continue; }
    if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
  }
  return out.trim();
}
function keys(value) {
  const parts = [], re = /\s*([A-Za-z0-9_-]+|"(?:[^"\\]|\\["\\])*"|'[^']*')\s*(\.|$)/gy;
  let match, at = 0;
  while ((match = re.exec(value))) {
    const token = match[1];
    parts.push(token[0] === '"' ? JSON.parse(token) : token[0] === "'" ? token.slice(1, -1) : token);
    at = re.lastIndex; if (!match[2]) break;
  }
  if (at !== value.length || !parts.length) unsupported();
  return parts;
}
// Bounded policy lexer, not a general TOML evaluator. MCP-local env/URLs cannot change Codex auth.
export function accountConfigPolicy(config) {
  if (typeof config !== 'string' || Buffer.byteLength(config) > 256 * 1024 || /\u0000|"""|'''/.test(config)) unsupported();
  let section = []; const assigned = new Set();
  for (const raw of config.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = uncomment(raw); if (!line) continue;
    if (line.startsWith('[') && !line.startsWith('[[')) {
      if (!line.endsWith(']')) unsupported(); section = keys(line.slice(1, -1));
      if (section[0] === 'mcp_servers' && section.length >= 2) continue;
      if (section.some(k => sensitive.test(k))) unsupported();
      continue;
    }
    if (line.startsWith('[[')) unsupported();
    const assignment = line.match(/^((?:[^="']|"(?:[^"\\]|\\.)*"|'[^']*')+)\s*=\s*(.*)$/);
    if (!assignment) continue; // Array continuation, never interpreted as a policy assignment.
    const path = [...section, ...keys(assignment[1].trim())], value = assignment[2].trim();
    if (path[0] === 'mcp_servers' && path.length >= 3) continue;
    // Whole profile inline tables can conceal auth/provider keys; only scoped leaf assignments are supported.
    if (path[0] === 'profiles' && path.length < 3) unsupported();
    const name = JSON.stringify(path); if (assigned.has(name)) unsupported(); assigned.add(name);
    if (!path.some(k => sensitive.test(k))) continue;
    if (path.length === 1 && ((path[0] === 'cli_auth_credentials_store' && /^(?:"file"|'file')$/.test(value)) || (path[0] === 'model_provider' && /^(?:"openai"|'openai')$/.test(value)))) continue;
    unsupported();
  }
}
