import test from 'node:test';
import assert from 'node:assert/strict';
import { accountConfigPolicy } from '../server/account-policy.mjs';

for (const config of [
  '', 'model_provider = "openai"\ncli_auth_credentials_store = "file"',
  '[mcp_servers.example]\ncommand="example"\nargs=["--auth", "#not-comment"]\n[mcp_servers.example.env]\nAUTH_TOKEN="synthetic-only"\nOPENAI_BASE_URL="https://example.invalid"',
  '[mcp_servers."second.example".env]\nCODEX_HOME="synthetic-only"\n[features]\nexample=true',
  'model="example#literal" # comment\n[projects.\'D:\\synthetic\']\ntrust_level="trusted"',
  'mcp_servers.example.env = { AUTH_TOKEN = "synthetic-only" }',
  'profile="example"\n[profiles.example]\nmodel="example"\nmodel_reasoning_effort="high"'
]) test('policy accepts benign section-aware synthetic config: ' + config.slice(0, 45), () => assert.doesNotThrow(() => accountConfigPolicy(config)));
for (const config of [
  'cli_auth_credentials_store="keyring"', 'cli_auth_credentials_store="auto"', 'forced_login_method="chatgpt"',
  'forced_chatgpt_workspace_id="synthetic"', 'model_provider="other"', 'base_url="https://example.invalid"',
  '[model_providers.openai]\nbase_url="https://example.invalid"', '[profiles.example]\nmodel_provider="other"',
  'include="synthetic.toml"', 'env={CODEX_HOME="synthetic"}', '"auth_mode"="chatgpt"',
  '[mcp_servers.example.env]\nAUTH="synthetic"\n[profiles.example]\ncli_auth_credentials_store="keyring"',
  'model_provider="openai"\nmodel_provider="other"', 'x="""\nmodel_provider="other"\n"""',
  '["model_providers".openai]\nname="example"', '[forced_auth]\nmode="file"',
  'profile="example"\nprofiles={example={model_provider="other"}}',
  'profile="example"\n[profiles]\nexample={cli_auth_credentials_store="keyring"}',
  'profiles.example={forced_chatgpt_workspace_id="synthetic"}'
]) test('policy refuses auth/provider/managed override: ' + config.slice(0, 55), () => assert.throws(() => accountConfigPolicy(config), { code: 'ACCOUNT_STORAGE_UNSUPPORTED' }));
