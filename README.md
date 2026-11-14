# PayProof

An invoice-processing agent for Canadian construction businesses. It reads a supplier email, looks up the supplier in MongoDB Atlas, and proposes a payment. A changed bank account is held until a human records an independent check using the **saved supplier contact**. The exact invoice revision, amount, destination, supplier revision and authorization policy are bound to the approval before a simulated payment can execute.

Built for **Agents in Context Toronto: a MongoDB Hackathon**, in the **Agents You Can Audit** track.

## What the demonstration shows

1. A finance operator submits a synthetic invoice email.
2. A real tool-calling language model looks up a saved supplier and requests a payment proposal. Email instructions cannot grant approval authority or modify the trusted supplier record.
3. The server compares the requested destination with Atlas. A changed destination becomes **Verification needed**.
4. A separately authenticated payment approver uses the saved contact, records the independent check and approves the exact payment details.
5. The operator delegates execution to the payment agent. The server checks live authority and revisions in an Atlas transaction before calling the separate HTTP simulated-payment service.
6. The returned ledger receipt is checked against the approved instruction. The decision trail records the responsible identity and reason for each step.

Amending the amount or destination invalidates verification and approval. Parallel dispatches share one operation ID; the payment service binds that ID to one immutable instruction. An uncertain HTTP result is reconciled against the same operation rather than generating a fresh payment ID.

**Payments are simulated.** The ledger records synthetic transfers; the application does not connect to a bank or send email. MongoDB Atlas and the configured language-model API are real. This is an application-level audit trail, not a tamper-proof database or a certification of regulatory compliance.

## Run locally

Nix supplies Node 26, pnpm and the `vp` tool wrapper. No global Node or pnpm installation is required.

```sh
nix develop
vp install --frozen-lockfile
pnpm codegen
cp .env.example .env
chmod 600 .env
```

Fill `.env` with the hackathon-provided Atlas cluster, a tool-calling OpenAI-compatible API endpoint and private access keys. Use different operator and approver keys. Keep the signing and payment keys at least 32 random characters long. The application refuses to start if required values are missing; it does not substitute an in-memory database or a fake model response.

```sh
pnpm dev
```

- UI: `http://127.0.0.1:5173`
- Application GraphQL API: `http://127.0.0.1:4100/api/graphql`
- Private simulated-payment API: `http://127.0.0.1:4101/api/graphql`

Sign in with the operator access key to process an email. Use a separate browser profile or sign out and sign in with the approver key to verify and approve. A role selector does not grant authority. The sample buttons use fictional businesses, reserved `.example` domains, fictional bank identifiers and `555-01xx` phone numbers. Change the invoice number in the email when repeating a scenario: supplier/invoice-number uniqueness intentionally prevents duplicate invoices.

The server initializes validation rules, indexes and synthetic demo principals/suppliers on startup. Existing invoices are retained. `pnpm seed` initializes those records explicitly without deleting existing data.

### Environment contract

| Variable                                       | Purpose                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`, `MONGODB_DB`                    | Application database in the event's Atlas Sandbox                                                              |
| `PAYMENT_MONGODB_URI`, `PAYMENT_MONGODB_DB`    | Simulated ledger database; provision a separate database credential for isolation                              |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`     | OpenAI-compatible `/chat/completions` endpoint with function tools; base URL includes `/v1` where required     |
| `MOCK_PAYMENT_API_URL`                         | Private ledger GraphQL URL                                                                                     |
| `PAYMENT_API_KEY`                              | Shared private authorization key between application and ledger                                                |
| `SESSION_SIGNING_KEY`                          | Signs expiring server-issued session cookies                                                                   |
| `OPERATOR_ACCESS_KEY`, `APPROVER_ACCESS_KEY`   | Different private keys for the two human demo identities                                                       |
| `APP_ORIGIN`                                   | Exact browser origin for request validation and cookie security                                                |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`    | Optional server-only credentials for voice transcription and spoken answers; omit to use typed audit questions |
| `ELEVENLABS_STT_MODEL`, `ELEVENLABS_TTS_MODEL` | Optional voice model IDs; defaults are `scribe_v2` and `eleven_multilingual_v2`                                |

Only the API process receives the model key. The language model receives a restricted supplier-lookup tool and a payment-proposal tool; it never receives database credentials, a payment-service key, a human session or an approval tool. Requests and responses at external boundaries are validated with Zod.

### Read-only voice questions

On an invoice, record a question (up to 20 seconds) or type one. ElevenLabs transcribes recordings, the existing configured language model explains permitted Atlas records with validated evidence references, and ElevenLabs generates the spoken answer. The screen shows the transcript, answer, supporting records, invoice revision and observation time. Microphone recording requires HTTPS or localhost and browser permission. Missing voice configuration is shown explicitly; typed questions still return real model answers and Atlas evidence. A synthesis failure preserves the text answer and reports that audio is unavailable.

The voice service receives only `principal` and `get` database capabilities. It checks the signed human session, enabled identity and invoice tenant before any provider request, then checks authority and snapshot freshness again before returning an answer. Its only model tool returns a cited explanation. It cannot verify, approve, amend, cancel or dispatch a payment, even when the spoken question requests those actions. Those actions remain in the existing authorized controls. Raw recordings are forwarded for transcription and are not stored by PayProof. The model receives the question and a bounded evidence snapshot, not the original invoice email, browser cookie or credentials. Only the answer text is sent for speech synthesis; provider retention follows the configured service account's terms.

Adapters follow the official [ElevenLabs speech-to-text](https://elevenlabs.io/docs/api-reference/speech-to-text/convert) and [text-to-speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert) APIs. Provider mocks verify the protocol and permission boundaries; a real-key smoke test is a separate validation step.

For the built application, set `APP_ORIGIN=http://127.0.0.1:4100` and run:

```sh
pnpm build
pnpm start
```

`nix run` builds and starts the same application and ledger from a Nix store artifact. Supply environment variables in the invoking shell. The application and ledger listen only on loopback. A deployment must provide a same-origin reverse proxy, set `APP_ORIGIN` to its HTTPS origin, keep ledger access private and inject secrets outside the source tree.

## Restore the presenter demo

On the presenter workstation, keep the existing application, ledger, UI and pitch servers running on ports 4100, 4101, 5173 and 4174. With the local `.env` and Chrome DevTools profile `conao3` available, run:

```sh
./scripts/reset-demo.sh
```

This adds a fresh synthetic invoice in `received`, revision 0, with no extraction or payment. It reuses the recorded, isolated operator and approver windows when they still exist, or creates isolated replacements. The operator starts on the Demo slide; the application has the new invoice selected by its exact ID. Click **Run invoice agent** yourself to demonstrate the changed-account hold.

The script never deletes or rewinds invoices, audit history or ledger entries, never runs the invoice/payment agent, and never starts another server. Credentials stay in the local Node process and HTTP-only session cookies. If browser preparation fails, it exits unsuccessfully and prints the fresh invoice ID, manifest path and manual recovery URLs; the new invoice remains available.

## Checks

```sh
nix develop --command vp run check
nix build
```

`vp run check` generates GraphQL types and checks formatting, lint, types and unit/HTTP-protocol tests. It needs no model or database credentials. The committed `schema.graphql` is the schema source; generated resolver and client types are rebuilt rather than committed.

Real Atlas authorization and concurrency tests use a new, uniquely named temporary database and drop only that database afterwards:

```sh
nix develop --command pnpm test:atlas
```

They verify independent confirmation, human/agent separation, tenant isolation, approval invalidation, concurrent approval and dispatch, supplier-revision conflicts, canonical duplicate invoice numbers and cancellation races. The simulated ledger is exercised against real MongoDB in this suite. Unit tests exercise the actual HTTP function-calling protocol against an explicitly controlled provider; they are not presented as live model evaluation.

The check suite includes ten voice authorization and protocol tests, covering tenant isolation, disabled identities, read-only tool access, rejected action requests, unknown citations and snapshot changes. A live smoke test also generated a synthetic question with ElevenLabs, submitted it through the authenticated HTTP endpoint, transcribed it with Scribe v2, obtained an OpenAI answer from actual Atlas records and synthesized that answer with ElevenLabs. All eight returned evidence references matched the invoice. The invoice hash and simulated-ledger count were unchanged. This validated a synthetic audio roundtrip; a person's microphone input is a separate browser test.

## Structure

- `packages/core`: validated domain data, canonical payment hashes and authority checks.
- `apps/api`: Hono/Apollo API, signed sessions, bounded LLM tool loop and Atlas persistence.
- `apps/mock-payment`: separate authenticated HTTP GraphQL ledger with idempotent recording.
- `apps/web`: React 19, React Aria Components, Tailwind CSS v4 and Apollo Client.
- `schema.graphql`, `codegen.ts`: committed API contract and generated types.
- `test/atlas`: opt-in tests against the actual Atlas cluster.
- `flake.nix`: reproducible developer shell, checks and runnable build.

## Work created during the hackathon

The PayProof-specific domain rules, Atlas state transitions, approval binding, audit events, agent tools, simulated-payment service, workflow UI and tests were written during the November 14 event build period. The repository was initialized on November 14; no prior application or proprietary business data was imported.

External libraries provide the general infrastructure: React, React Aria Components, Tailwind CSS, Lucide, Apollo Server/Client, Hono, the Hono Apollo integration, GraphQL Code Generator, MongoDB's Node driver, Zod, Vite+, Vitest and MSW. Nixpkgs, flake-parts and treefmt-nix provide the build environment. This repository does not use an external application starter template. The supplier, invoice and ledger examples are synthetic fixtures written for this project. The configured model is an external API, not a model trained during the event.

The Canadian Anti-Fraud Centre describes payment-redirection attacks against small and medium businesses, including construction and contracting, and recommends independently verifying banking changes with trusted contact information. PayProof demonstrates an enforceable workflow for that problem; it does not claim to detect every fraudulent invoice. [CAFC, May 13, 2026](https://antifraudcentre-centreantifraude.ca/news-nouvelles/2026/2026-05-13-eng.htm).

Function-calling implementation follows the [official OpenAI function-calling guide](https://developers.openai.com/api/docs/guides/function-calling). The server uses the configured provider and model and does not silently switch providers.

## License

Apache-2.0. External libraries retain their respective licenses.
