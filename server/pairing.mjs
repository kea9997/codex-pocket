import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeError } from './rpc.mjs';
import { keys, loadJson, saveJson } from './security.mjs';

// Same-user private file only. No HTTP renewal endpoint, code output or session revocation.
export function processPairingRequest(auth, dir) {
  const requestPath = join(dir, 'pairing.request');
  if (!existsSync(requestPath)) return false;
  const request = loadJson(requestPath, null);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new BridgeError('PAIRING_RENEWAL_INVALID');
  keys(request, ['requestId', 'requestedAt']);
  if (!/^[a-f0-9]{32}$/i.test(request.requestId ?? '') || !Number.isFinite(request.requestedAt) ||
      Math.abs(auth.now() - request.requestedAt) > 60000) throw new BridgeError('PAIRING_RENEWAL_INVALID');
  const responsePath = join(dir, 'pairing-renewed.json');
  if (loadJson(responsePath, null)?.requestId !== request.requestId) {
    auth.issuePairing({ force: true });
    saveJson(responsePath, { requestId: request.requestId, expires: auth.pairing.expires });
  }
  unlinkSync(requestPath);
  return true;
}
