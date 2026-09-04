# MiraViewer frontend

This package contains the client-side React/TypeScript application. Start with the [project README](../README.md) for setup and user workflows, and the [architecture and validation guide](../agent_docs/design-docs/miraviewer-architecture.md) for the code map, resource ownership, commands and evidence boundaries.

From this directory, `npm run dev` starts the fixed-port development server. `npm run lint`, `npm run test -- --maxWorkers=2` and `npm run build` cover local validation. Build browser acceptance output with `npm run build:browser` before running `test:browser`, `test:gpu`, `test:performance` or `test:inference`.

`npm run package:zip` produces `release/MiraViewer.zip`; the included `README.txt` explains its local launcher. Preserve the launcher's stable origin to retain access to browser-stored scans.
