'use strict';
// Preview-only controls. Never included in the production asset map.
document.getElementById('demoScenario').onclick = async () => {
  const response = await fetch('/demo/scenario', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Preview-Action': 'synthetic' }, body: '{}' });
  if (response.ok) location.reload();
};
