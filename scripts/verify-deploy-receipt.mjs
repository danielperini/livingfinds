import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function verifyDeployReceipt(output, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid release SHA');
  if (!output.split(/\r?\n/).includes(`DEPLOY_VERIFIED_SHA=${sha}`)) {
    throw new Error('Deploy ended without confirming the installed release');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyDeployReceipt(readFileSync(process.argv[2], 'utf8'), process.argv[3]);
  console.log(`REMOTE_DEPLOY_RECEIPT=confirmed|sha=${process.argv[3]}`);
}
