// Stable command and import entrypoint for the current native recording runtime.
import { fileURLToPath } from 'node:url';
import { startRuntime } from './runtime.mjs';
export { AstroRelay } from './relay.mjs';
export { createAstroServer } from './http-server.mjs';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--legacy-recorder')) {
    console.error('The legacy recorder is archived; use the native recording runtime.');
    process.exitCode = 1;
  } else {
    startRuntime({allowSend:process.argv.includes('--allow-send')})
      .catch(error=>{console.error(error.message);process.exitCode=1;});
  }
}
