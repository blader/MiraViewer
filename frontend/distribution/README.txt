MiraViewer (Offline) — Quick Start

1) Unzip this folder somewhere (Desktop is fine).
2) Start MiraViewer:
   - macOS: double-click start.command
   - Windows: double-click start.bat
   - Linux: run start.sh
3) Your default web browser should open automatically.
4) Keep the Terminal / Command Prompt window open while using MiraViewer.
   Closing it will stop MiraViewer.

Notes
- The launcher starts a local HTTP server for the app. All image processing happens in your browser; scans are not sent to an imaging backend.
- Your scans are stored locally in your browser on this computer (IndexedDB).
- MiraViewer always uses http://127.0.0.1:43125/ so saved scans remain available after every restart.
- If port 43125 is occupied, close its other application; do not run MiraViewer on a different port.
- Open Application menu > Export backup (ZIP) to create a backup.
- Current full-backup restore is limited to 512 MiB of declared payloads. Export can create a larger archive, so keep the original images and verify restoration before relying on a backup.

Troubleshooting
- If the window closes immediately or nothing happens, you likely need Python 3 installed.
  Install Python 3 from python.org, then try again.
