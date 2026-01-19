#!/usr/bin/env python3
"""Run MiraViewer from a local folder.

Why this exists:
- Opening the built files via file:// can break fetch/XHR and WASM pipeline loading.
- Running a tiny local HTTP server keeps everything same-origin and works offline.

This script:
- serves the current directory over http://127.0.0.1:<random free port>/
- opens the default browser
- keeps running until you close this window (or press Ctrl+C)
"""

from __future__ import annotations

import http.server
import os
import webbrowser


def main() -> int:
  root = os.path.dirname(os.path.abspath(__file__))
  os.chdir(root)

  handler = http.server.SimpleHTTPRequestHandler

  # Make sure modern browsers get correct types for WASM.
  handler.extensions_map.update(
    {
      ".wasm": "application/wasm",
      ".zst": "application/octet-stream",
    }
  )

  # Bind to localhost on an ephemeral port to avoid conflicts.
  server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
  port = int(server.server_address[1])
  url = f"http://127.0.0.1:{port}/"

  print("MiraViewer is running.")
  print("If your browser does not open automatically, open this URL:")
  print(f"  {url}")
  print("\nClose this window to stop MiraViewer.")

  try:
    webbrowser.open(url, new=2)
  except Exception:
    # Browser opening is best-effort.
    pass

  try:
    server.serve_forever()
  except KeyboardInterrupt:
    pass
  finally:
    server.server_close()

  return 0


if __name__ == "__main__":
  raise SystemExit(main())
