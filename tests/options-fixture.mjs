// Synthetic calling-host metadata, never a public/real account model list.
export const allEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
// Exact native prose from readonly evidence; model IDs below remain synthetic.
export const destinationNote = " A different destination host's model availability and reasoning combinations are validated when the tool runs.";
export function modelTool(name, rows = [{ id: 'fixture-fast', efforts: ['low', 'high'] }, { id: 'fixture-deep', efforts: ['medium', 'xhigh', 'ultra'] }]) {
  return { name, namespace: 'codex_app', inputSchema: { type: 'object', properties: {
    model: { type: 'string', description: 'Optional model. Models and supported reasoning efforts on the calling host: ' + rows.map(r => `${r.id} (Synthetic test model; supported reasoning efforts: ${r.efforts.join(', ')})`).join(', ') + '.' + (name === 'create_thread' ? destinationNote : '') },
    thinking: { type: 'string', enum: allEfforts }
  } } };
}
export const projects = { schemaVersion: 1, accountId: 'PRIVATE_ACCOUNT', projects: [
  { projectId: 'fixture-project', label: '합성 로컬 프로젝트', projectKind: 'local', hostId: 'local', path: 'PRIVATE_PATH', secret: 'SECRET' },
  { projectId: 'remote-project', label: '원격', projectKind: 'local', hostId: 'remote' },
  { projectId: 'cloud-project', label: '클라우드', projectKind: 'cloud', hostId: 'local' },
  { projectId: 'worktree-project', label: '트리', projectKind: 'worktree', hostId: 'local' }
] };
export function installOptions(desktop) {
  desktop.catalog = [...desktop.catalog.filter(t => !['create_thread', 'send_message_to_thread'].includes(t.name)), modelTool('create_thread'), modelTool('send_message_to_thread', [{ id: 'fixture-fast', efforts: ['low', 'high'] }])];
  desktop.hook = async tool => {
    if (tool === 'list_projects') return projects;
    if (tool === 'create_thread') return { threadId: 'created-fixture', hostId: 'local' };
  };
}
export function optionsView() {
  const cap = models => ({ available: true, state: 'ready', models });
  return { source: 'pc-desktop', checkedAt: Date.now(), refreshAfter: Date.now() + 60000,
    send: cap([{ id: 'fixture-fast', efforts: ['low', 'high'] }, { id: 'fixture-other', efforts: ['medium'] }]),
    create: cap([{ id: 'fixture-fast', efforts: ['low', 'high'] }, { id: 'fixture-deep', efforts: ['ultra'] }]),
    projects: { state: 'ready', items: [{ id: 'fixture-project', label: '합성 로컬 프로젝트' }] } };
}
