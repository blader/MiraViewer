# AGENTS.md

## Project

MiraViewer is a client-side Vite + React + TypeScript application in `frontend/`. Imported DICOM bytes and saved work live in the browser; HTTP serves application/runtime assets, not a processing backend.

The [architecture and validation guide](agent_docs/design-docs/miraviewer-architecture.md) is the current code map, ownership model and command reference. The [audit implementation ledger](agent_docs/exec-plans/active/2026-09-02-full-codebase-audit-implementation.md) distinguishes implemented changes, exact evidence and remaining work. Prior execution plans describe their own historical scopes.

## Working here

Run package commands from `frontend/`. `npm run dev` uses fixed port **43124** and fails if another process owns it. The offline launcher uses **43125**; browser acceptance uses an isolated **43134** origin. Origin/profile changes select different browser storage, not another view of the same scans.

`npm run lint`, `npm run test -- --maxWorkers=2`, and `npm run build` cover local lint, unit contracts and the production build. `npm run build:browser` prepares the fingerprinted build used by `test:browser`, `test:gpu`, `test:performance` and `test:inference`. Their receipts identify the actual fixture, browser/provider and evidence scope. An empty shell, software-renderer result or unit mock is not proof of a populated hardware/model workflow.

Keep source identity and physical geometry with their existing owners. Display settings, inferred detail, model proposals and committed labels are different facts; hard marks and saved work must survive failures and cancellation. Current resource policies and known limits are documented in the guide.

## Protected local data

`Critical MRI Source Images (LLM Agent - do not delete)/` contains private MRI source images used for local testing. Do not delete it or publish its identifiers, pixels or derived patient media. Preserve dirty/untracked concurrent work and active services. Use synthetic fixtures for shareable verification.
