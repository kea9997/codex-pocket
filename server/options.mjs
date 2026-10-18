import { BridgeError } from './rpc.mjs';

export const OPTIONS_TTL = 60000;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
export const modelId = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(v);
const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export function choices(input) {
  const out = {};
  if ('model' in input) {
    if (!modelId(input.model)) throw new BridgeError('INVALID_MODEL_CHOICE', 400);
    out.model = input.model;
  }
  if ('thinking' in input) {
    if (!out.model || !efforts.includes(input.thinking)) throw new BridgeError('INVALID_MODEL_CHOICE', 400);
    out.thinking = input.thinking;
  }
  return out;
}
function strings(value, valid, max = 32) {
  return Array.isArray(value) && value.length > 0 && value.length <= max && value.every(valid) && new Set(value).size === value.length;
}
// Only the explicit calling-host advertisement is recognized; no product-name guesses or public model list.
export function advertisedModels(tool) {
  const schema = tool?.inputSchema, properties = schema?.properties;
  if (!object(properties)) return [];
  const thinking = properties.thinking?.enum;
  if (!strings(thinking, v => efforts.includes(v), 8)) return [];
  const model = properties.model;
  if (!object(model)) return [];
  const ids = model.enum;
  if (ids !== undefined && !strings(ids, modelId)) return [];
  if (schema.oneOf !== undefined) {
    if (!Array.isArray(schema.oneOf)) return [];
    if (!schema.oneOf.length || schema.oneOf.length > 32) return [];
    const rows = schema.oneOf.map(branch => {
      const p = branch?.properties, id = p?.model?.const ?? (p?.model?.enum?.length === 1 ? p.model.enum[0] : null);
      const values = p?.thinking?.enum;
      return modelId(id) && strings(values, v => efforts.includes(v), 8) ? { id, efforts: values.filter(v => thinking.includes(v)) } : null;
    });
    if (rows.some(v => !v) || new Set(rows.map(v => v.id)).size !== rows.length || (ids && rows.some(v => !ids.includes(v.id)))) return [];
    return rows;
  }
  const description = model.description, marker = 'Models and supported reasoning efforts on the calling host: ';
  if (description === undefined && ids) return ids.map(id => ({ id, efforts: [] }));
  if (typeof description !== 'string' || description.length > 24000) return [];
  const at = description.indexOf(marker);
  if (at < 0) return ids ? ids.map(id => ({ id, efforts: [] })) : [];
  if (description.indexOf(marker, at + marker.length) !== -1) return [];
  let rest = description.slice(at + marker.length).trim(), rows = [];
  const destinationNote = " A different destination host's model availability and reasoning combinations are validated when the tool runs.";
  // Native create advertises this exact note after the list period; no other trailing prose is accepted.
  if (tool.name === 'create_thread' && rest.endsWith('.' + destinationNote)) rest = rest.slice(0, -destinationNote.length);
  while (rest && rows.length < 32) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._:-]{0,99}) \(([^();\r\n]{1,1000}); supported reasoning efforts: ([a-z]+(?:, [a-z]+){0,7})\)(, |\.$|$)/.exec(rest);
    if (!match) return [];
    const values = match[3].split(', ');
    if (!strings(values, v => efforts.includes(v), 8) || rows.some(v => v.id === match[1])) return [];
    rows.push({ id: match[1], efforts: values.filter(v => thinking.includes(v)) });
    rest = rest.slice(match[0].length);
    if (match[4] === ', ' ? !rest : rest) return [];
  }
  if (rest || !rows.length || (ids && (rows.length !== ids.length || rows.some(v => !ids.includes(v.id))))) return [];
  return rows;
}
export function localProjects(data) {
  if (!object(data) || !Array.isArray(data.projects) || data.projects.length > 128) throw new BridgeError('OPTIONS_UNAVAILABLE', 503);
  const rows = [], seen = new Set();
  for (const p of data.projects) {
    if (p?.projectKind !== 'local' || p.hostId !== 'local') continue;
    if (typeof p.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(p.projectId) || seen.has(p.projectId) ||
        typeof p.label !== 'string' || !p.label.trim() || p.label.length > 160 || /[\x00-\x1f\x7f]/.test(p.label)) continue;
    seen.add(p.projectId); rows.push({ id: p.projectId, label: p.label });
    if (rows.length === 32) break;
  }
  return rows;
}
export class Options {
  constructor(desktop, { now = Date.now } = {}) { this.desktop = desktop; this.now = now; this.result = null; this.flight = null; }
  snapshot(fresh = false) {
    if (this.flight) return this.flight;
    if (!fresh && this.result && this.now() < this.result.refreshAfter) return Promise.resolve(this.result);
    this.flight = this.load().then(result => { this.result = result; return result; }).finally(() => { this.flight = null; });
    return this.flight;
  }
  async load() {
    const absent = () => ({ available: false, state: 'unavailable', models: [] });
    let send = absent(), create = absent(), projects = { state: 'unavailable', items: [] };
    try {
      const catalog = await this.desktop.tools({ refresh: true });
      if (!Array.isArray(catalog) || catalog.length > 256) throw new Error();
      const tool = name => { const found = catalog.filter(t => t?.namespace === 'codex_app' && t.name === name); return found.length === 1 ? found[0] : null; };
      const view = name => { const t = tool(name); if (!t) return { available: false, state: 'unsupported', models: [] }; const models = advertisedModels(t); return { available: true, state: models.length ? 'ready' : 'unknown', models }; };
      send = view('send_message_to_thread'); create = view('create_thread');
      if (tool('list_projects')) {
        try { projects = { state: 'ready', items: localProjects(await this.desktop.call('list_projects', {})) }; } catch { /* No stale project IDs on a failed read. */ }
      } else projects.state = 'unsupported';
    } catch { /* Default continuation needs no options source and remains usable. */ }
    const checkedAt = this.now();
    return { source: 'pc-desktop', checkedAt, refreshAfter: checkedAt + OPTIONS_TTL, send, create, projects };
  }
  async validate(operation, selection, target) {
    const result = await this.snapshot(true), capability = result[operation];
    if (!capability.available) throw new BridgeError('OPTIONS_UNAVAILABLE', 503);
    if (selection.model) {
      const row = capability.models.find(m => m.id === selection.model);
      if (!row || (selection.thinking && !row.efforts.includes(selection.thinking))) throw new BridgeError('MODEL_CHOICE_UNAVAILABLE', 409);
    }
    if (target?.type === 'project' && (result.projects.state !== 'ready' || !result.projects.items.some(p => p.id === target.projectId)))
      throw new BridgeError('PROJECT_UNAVAILABLE', 409);
  }
}
