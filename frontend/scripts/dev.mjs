import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';

// We rely on a stable dev port so other parts of the system (e.g. proxies, bookmarks)
// can always point to the same URL.
const DEV_PORT = 43124;
const DEV_URL = `http://localhost:${DEV_PORT}/`;

function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: 'localhost', port });

    // Keep this bounded so `npm run dev` never feels stuck.
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 250);

    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.end();
      resolve(true);
    });

    socket.once('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

async function looksLikeViteDevServer(url) {
  // Vite injects /@vite/client into the dev HTML in typical setups.
  // We also look for a project-specific marker to avoid treating some other app
  // on the same port as "already running".
  // Use node:http so we don't rely on a particular Node version's fetch implementation.
  return await new Promise((resolve) => {
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = http.get(url, { timeout: 500 }, (res) => {
      res.setEncoding('utf8');

      let body = '';
      let bytes = 0;
      const MAX_BYTES = 64 * 1024;

      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          req.destroy();
          finish(false);
          return;
        }

        body += chunk;
        if (body.includes('/@vite/client') && body.includes('MiraViewer')) {
          req.destroy();
          finish(true);
        }
      });

      res.on('end', () => finish(body.includes('/@vite/client') && body.includes('MiraViewer')));
    });

    req.on('timeout', () => {
      req.destroy();
      finish(false);
    });

    req.on('error', () => finish(false));
  });
}

if (await isPortListening(DEV_PORT)) {
  // If it's already our Vite dev server, do nothing (this is the "never start a second one" guarantee).
  if (await looksLikeViteDevServer(DEV_URL)) {
    console.log(`[dev] Vite already running at ${DEV_URL} — not starting another instance.`);
    process.exit(0);
  }

  console.error(`[dev] Port ${DEV_PORT} is already in use, but it doesn't look like the MiraViewer Vite dev server.`);
  console.error(`[dev] Stop whatever is using ${DEV_PORT} and try again.`);
  process.exit(1);
}

// Start Vite with a fixed port and strictPort so it will never auto-increment.
// `detached: true` makes Vite the leader of a new process group so we can reliably
// stop *all* of its subprocesses on Ctrl-C.
const child = spawn('vite', ['--port', String(DEV_PORT), '--strictPort'], {
  stdio: 'inherit',
  detached: true,
});

let shutdownStarted = false;
const shutdown = (signal) => {
  if (shutdownStarted) return;
  shutdownStarted = true;

  // Kill the whole process group (child PID is the PGID because it's detached).
  // This is much more reliable than signaling only the direct child.
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Ignore if it already exited.
  }

  // If it doesn't die promptly, force kill.
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Ignore.
    }
  }, 1500).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

child.on('exit', (code, signal) => {
  // Remove signal listeners so this wrapper doesn't stay alive after Vite exits.
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');

  if (signal) {
    // Mirror the termination signal for conventional exit codes.
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
  }

  process.exit(code ?? 1);
});
