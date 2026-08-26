#!/usr/bin/env python3
"""Run MiraViewer from a local folder.

Why this exists:
- Opening the built files via file:// can break fetch/XHR and WASM pipeline loading.
- Running a tiny local HTTP server keeps everything same-origin and works offline.

This script:
- serves the current directory over the durable origin http://127.0.0.1:43125/
- opens the default browser
- keeps running until you close this window (or press Ctrl+C)
"""

from __future__ import annotations

import http.server
import errno
import os
import webbrowser

PORT = 43125


class MiraViewerHandler(http.server.SimpleHTTPRequestHandler):
  def end_headers(self) -> None:
    self.send_header("Cross-Origin-Opener-Policy", "same-origin")
    self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
    super().end_headers()


def main() -> int:
  root = os.path.dirname(os.path.abspath(__file__))
  os.chdir(root)

  handler = MiraViewerHandler

  # Make sure modern browsers get correct types for WASM.
  handler.extensions_map.update(
    {
      ".wasm": "application/wasm",
      ".zst": "application/octet-stream",
    }
  )

  # IndexedDB belongs to the complete browser origin, including its port. Never
  # fall back to another port: doing so would hide every previously saved scan.
  try:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
  except OSError as error:
    if error.errno == errno.EADDRINUSE:
      print(f"MiraViewer cannot start because its required port {PORT} is already in use.")
      print("Close the other MiraViewer window or application using that port, then try again.")
    else:
      print(f"MiraViewer cannot bind its required local port {PORT}: {error.strerror or error}.")
      print("Check whether local network access is restricted, then try again.")
    return 1
  url = f"http://127.0.0.1:{PORT}/"

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
