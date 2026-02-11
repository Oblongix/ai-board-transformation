# AI Board Transformation Simulator

Firebase-hosted board simulation app for AI transformation practice, aligned to:

- `The_CEOs_AI_Transformation_Framework_And_Implementation_UPDATED_WORD_FINAL.docx`
- `The_CEOs_Guide_to_AI_Transformation_V0.1.docx`
- `https://www.oblongix.com`

## Features

- Single-screen simulation UI with chat + option decisions.
- Selectable board role, sector, and scenario.
- Firebase Authentication (email/password).
- Firestore persistence for saved simulation snapshots and transcript history.
- Localhost mock mode for Auth + Firestore when Firebase config is not set.
- Harness tooling for scenario matrix runs and prompt-profile tuning.

## Local Run

```bash
npm install
npm start
```

Open:

```text
http://127.0.0.1:8080
```

By default on localhost, the app runs in mock Firebase mode.

## Configure Real Firebase

Run the bootstrap script to create/configure infra and deploy in one pass:

```powershell
npm run bootstrap:firebase -- `
  -ProjectId YOUR_FIREBASE_PROJECT_ID `
  -BillingAccount YOUR_BILLING_ACCOUNT_ID `
  -ProjectName "AI Board Transformation" `
  -Region us-central1 `
  -WebAppDisplayName "ai-board-transformation-web"
```

What it does:

- Creates project (if needed).
- Links billing account.
- Enables required APIs.
- Adds Firebase resources.
- Creates default Firestore database.
- Initializes Auth and enables email/password provider.
- Writes `.firebaserc` and `public/firebase-config.js`.
- Deploys hosting + Firestore rules/indexes.

Optional flags:

- `-SkipCreateProject`
- `-SkipNpmInstall`
- `-SkipDeploy`

On localhost, you can still force real Firebase with `window.FORCE_REAL_FIREBASE = true` before reload.

## Deploy

```bash
npm run deploy -- --project YOUR_FIREBASE_PROJECT_ID
```

## Firestore Data Model

- `users/{uid}`
  - `uid`, `email`, `name`, timestamps
- `simulationSessions/{sessionId}`
  - `ownerUid`, `roleId`, `sectorId`, `scenarioId`
  - live snapshot (`snapshot`) and `transcript`
  - score/turn/stage metadata

Security rules are in `firestore.rules`.

## Testing and Analysis

```bash
npm test
npm run harness
npm run scenario-review
```

Outputs:

- `harness-output/latest-report.md`
- `harness-output/scenario-matrix.md`
