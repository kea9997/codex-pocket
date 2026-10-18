// Explicit optional export of original generated media. No encoder/download/source mutation.
import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { sampleVideo } from './sample-video.mjs';
const destination = process.argv[2];
if (!destination || !isAbsolute(destination)) throw new Error('NEW_ABSOLUTE_OUTPUT_REQUIRED');
writeFileSync(destination, sampleVideo(), { flag: 'wx' });
process.stdout.write('Generated synthetic silent MP4. Review decoder compatibility separately; no install or delivery.\n');
