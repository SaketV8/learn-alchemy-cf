# Learning Alchemy for Cloudflare

> A practical, from-scratch guide to **Alchemy** — the TypeScript-native Infrastructure-as-Code tool this project (`portfolio-cf`) uses to run and deploy to Cloudflare. It covers the Effect TS concepts you need to read `alchemy.run.ts`, the full catalog of Cloudflare services Alchemy can manage, and a deep dive on **D1 locally vs. remotely** (the thing you used to do by hand with `wrangler`).
>
> Grounded in the version installed here — `alchemy@2.0.0-beta.80` (the Effect-based **v2** line) — and the official docs at <https://alchemy.run>. Note: the v2 API documented here is _different_ from the older v1 API at <https://v1.alchemy.run>. If you find a tutorial using `await Worker(...)` / `await app.finalize()`, that's v1 — ignore it for this repo.

---

## Table of contents

1. [What Alchemy is (and isn't)](#1-what-alchemy-is-and-isnt)
2. [The Effect TS concepts you actually need](#2-the-effect-ts-concepts-you-actually-need)
3. [Anatomy of a Stack](#3-anatomy-of-a-stack)
4. [Credentials, profiles, and state](#4-credentials-profiles-and-state)
5. [The dev vs. deploy lifecycle](#5-the-dev-vs-deploy-lifecycle)
6. [Workers: the core compute primitive](#6-workers-the-core-compute-primitive)
7. [Bindings: how a Worker talks to other services](#7-bindings-how-a-worker-talks-to-other-services)
8. [The Cloudflare service catalog](#8-the-cloudflare-service-catalog)
9. [Deep dive: D1 locally vs. remotely](#9-deep-dive-d1-locally-vs-remotely)
10. [CLI reference](#10-cli-reference)
11. [How this maps to the portfolio-cf repo](#11-how-this-maps-to-the-portfolio-cf-repo)
12. [Further reading](#12-further-reading)

---

## 1. What Alchemy is (and isn't)

**Alchemy is Infrastructure-as-Code written as plain TypeScript.** You describe the cloud resources you want (a Worker, a D1 database, an R2 bucket…) in a file called `alchemy.run.ts`, and Alchemy reconciles your description against the real world: creating what's missing, updating what changed, and deleting what you removed.

How it differs from the tools you may already know:

| Tool | What it is | Relationship to Alchemy |
| --- | --- | --- |
| **Wrangler** | Cloudflare's official CLI; config lives in `wrangler.toml` | Alchemy _replaces_ it. No `wrangler.toml`; your bindings and resources are defined in TypeScript, and dev/deploy go through the `alchemy` CLI. |
| **Terraform / Pulumi / SST** | General IaC | Same category as Alchemy, but Alchemy is Cloudflare-first, has no separate DSL/state service to stand up, and runs your app locally for you during dev. |
| **CDK** | AWS-centric IaC in code | Similar "infra as code" spirit; Alchemy is multi-cloud but shines on Cloudflare. |

The mental model, in one line: **a resource is a cloud entity (bucket, database, worker) that Alchemy drives through a lifecycle of `create → update → delete`, tracked in state by a stable logical ID.**

Three things make Alchemy distinctive:

- **It's just TypeScript.** No HCL, no YAML. You get types, autocomplete, loops, conditionals, and imports.
- **It runs your app for you in dev.** `alchemy dev` boots your Workers in a local Cloudflare runtime (`workerd`) with local emulations of D1, KV, R2, Queues, etc. — no cloud round-trips for the data plane.
- **v2 is built on [Effect](https://effect.website).** This is the part that trips people up coming from v1 or from Wrangler, so we cover it next.

---

## 2. The Effect TS concepts you actually need

You do **not** need to master Effect to use Alchemy. But `alchemy.run.ts` is an Effect program, so you need to recognize five things. Here's the minimum.

### 2.1 `Effect<A, E, R>` — a description of work

An `Effect` is a _lazy description_ of a computation that, when run, produces a value of type `A`, may fail with error `E`, and requires an environment `R`. Declaring an Effect does nothing — building `Cloudflare.R2.Bucket("Bucket")` makes **zero** API calls. The work only happens when Alchemy _runs_ the program (during `deploy`/`dev`). This laziness is why Alchemy can build the whole resource graph first, compute a plan, and _then_ touch the cloud.

### 2.2 `Effect.gen` + `yield*` — write it like async/await

`Effect.gen(function* () { ... })` lets you write Effect code in a familiar, sequential style. Think of `yield*` as `await`:

```typescript
Effect.gen(function* () {
  const bucket = yield* Cloudflare.R2.Bucket("Bucket"); // like: const bucket = await ...
  const db = yield* Cloudflare.D1.Database("db");
  return { bucketName: bucket.bucketName }; // becomes the stack's output
});
```

Each `yield*` "runs" an Effect and unwraps its result. Inside a Stack, `yield*`-ing a resource **registers it on the stack** and returns typed output references. Whatever the generator `return`s becomes the **stack output** (printed after each deploy — you saw `{ server: '...', web: '...' }` in this repo's dev log).

### 2.3 `Layer` — how capabilities are provided

A **Layer** is a recipe for building part of the environment `R`. In Alchemy:

- `Cloudflare.providers()` is a Layer that provides every Cloudflare _resource provider_ (the code that knows how to create/update/delete a bucket, a worker, a D1 db…).
- To use multiple clouds in one stack, you merge Layers: `Layer.mergeAll(Cloudflare.providers(), AWS.providers())`. The type system then _enforces_ that any AWS resource you declare has `AWS.providers()` present — forget it and you get a compile error, not a runtime surprise.

You rarely write Layers yourself; you just pass the provider Layer(s) and a state Layer to the Stack.

### 2.4 `Config` — typed, deferred configuration values

`effect/Config` reads configuration (usually from environment variables) as part of the Effect, with validation. This repo uses it for the Worker's CORS origin:

```typescript
import * as Config from "effect/Config";

env: {
  CORS_ORIGIN: Config.String("CORS_ORIGIN"), // read from env, typed as string, fails loudly if missing
}
```

`Config.String("X")`, `Config.Boolean("X")`, `Config.withDefault(...)` are the common forms. Alchemy itself exposes config keys this way, e.g. `ALCHEMY_DEV` (a `Config.Boolean`) is `true` only under `alchemy dev`.

### 2.5 Tagged errors, `Option`, `Stream` (recognize, don't sweat)

You'll see these in Alchemy's own source and occasionally in return types:

- **Tagged errors** — errors are typed values (e.g. `CredentialsUnavailable`, `InvalidReferenceError`), not thrown strings. That's why the dev failure you hit was a precise `CredentialsUnavailable: Provider 'Cloudflare' is not configured…` rather than a stack-trace soup.
- **`Option<A>`** — an explicit "value or nothing" (`Option.some` / `Option.none`) instead of `null`/`undefined`.
- **`Stream<A>`** — a lazy sequence (used internally for things like log tailing).

That's genuinely all the Effect you need to read and extend this project's infra.

---

## 3. Anatomy of a Stack

> _"A Stack is just an Effect that you `export default` from a TypeScript file."_ — Alchemy docs

`Alchemy.Stack` takes **three** arguments:

```typescript
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "portfolio-cf", // 1. Name — identifies the stack in state storage
  {
    // 2. Options (both required)
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // 3. The Effect that declares resources & returns outputs
    const bucket = yield* Cloudflare.R2.Bucket("Bucket");
    return { bucketName: bucket.bucketName };
  })
);
```

### Key concepts

- **Logical ID** — the string you pass to each resource (`"Bucket"`, `"server"`, `"database"`). Alchemy tracks state **by this ID**. Keep the ID stable and you keep updating the same cloud resource, even if you rename the variable or move the code. Change the ID and Alchemy plans a _replacement_ (create new, delete old) — unless you use `Alchemy.renamedFrom` to migrate the state row instead.
- **Outputs** — resources expose lazy, typed attributes (e.g. `bucket.bucketName`, `worker.url`). Passing one resource's output into another's config **creates a dependency**, and Alchemy deploys in topological order (independent resources in parallel).
- **Stages** — an isolated instance of the stack. The default stage is `dev_$USER` — that's why this repo's dev log says `Dev · dev_sasuke`. Each stage has its own state and its own physical resource names, so your `dev_sasuke` environment never collides with `prod` or a teammate's `dev_sam`. Destroying one stage doesn't touch the others.
- **Physical names** — Alchemy generates real resource names as `{stack}-{stage}-{logicalId}-{instanceId}`, so parallel stages stay isolated automatically.

---

## 4. Credentials, profiles, and state

### Credentials & profiles

Alchemy stores cloud credentials in **profiles** on your machine (not in the repo). First-time Cloudflare setup:

```bash
alchemy profile edit --add Cloudflare          # OAuth login or paste an API token → saved to 'default' profile
alchemy profile edit --reconfigure Cloudflare  # change them later
alchemy profile create prod                     # a separate named profile
alchemy profile edit --profile prod
```

The error you hit on first `pnpm run dev` — `Provider 'Cloudflare' is not configured in profile 'default'` — was exactly this: no credentials in the `default` profile.

### State

**State** is Alchemy's record of what it has deployed — the mapping from logical IDs to real cloud resources. It's a separate, _required_ option from `providers`, and you pick one state backend regardless of how many clouds you target. Options installed here include:

| State backend | What it does | When to use |
| --- | --- | --- |
| `Cloudflare.state()` | Stores state in your Cloudflare account | Shared/durable team state; production |
| `Alchemy.localState()` | Stores state in a local `.alchemy/state` directory | Local dev with **no credentials** needed |
| `Alchemy.inMemoryState()` | Ephemeral, in-process | Tests |
| `alchemy/State/PostgresState` | Postgres-backed (deep import) | Self-hosted shared state |

> **This repo's twist.** `portfolio-cf` was configured with `state: Cloudflare.state()`, which authenticates to Cloudflare _before anything else_ (the very first dev step is `Loading stack state`). That's why local dev demanded credentials even though the app itself runs locally. The fix applied here makes the state backend conditional:
>
> ```typescript
> state: process.env.ALCHEMY_DEV ? Alchemy.localState() : Cloudflare.state(),
> ```
>
> `ALCHEMY_DEV` is set automatically to `true` by the `alchemy dev` command, so **dev uses local state (no creds)** and **deploy uses Cloudflare state (shared/durable)** — all from one line.

---

## 5. The dev vs. deploy lifecycle

### Declaring vs. running

- **Declare** — building the Effect (`Cloudflare.R2.Bucket("Bucket")`) makes no API calls. `yield*`-ing it in the Stack only registers it and returns typed outputs.
- **Plan** — Alchemy diffs your declared graph against state and computes what must change. You saw this: `Computing plan → Plan: 2 to update, 1 binding changes`.
- **Apply** — only now is the cloud (or the local runtime) touched. Providers decide via `diff` whether a change is in-place or forces a **replacement** (create new → repoint references → delete old).
- **Delete** — remove a resource from the graph and the next deploy deletes it.

### `alchemy dev` (local)

`alchemy dev` runs the **entire app locally**:

- Your Workers run in `workerd` (the real Cloudflare runtime), not a mock.
- Data services (D1, KV, R2, Queues, Durable Objects…) are **emulated locally**, persisting to a `.alchemy/local` directory.
- It watches files and hot-reloads.
- In this repo it also runs the Vite dev server for the web app and wires `VITE_SERVER_URL` to the local server Worker.

From this repo's successful dev run:

```
[database] noop (local)          ← D1 emulated locally, nothing to provision
[server]   ready at http://localhost:3000   ← Hono worker in local workerd
[web]      ready (Vite)                      ← http://localhost:3001
Done: 2 succeeded
```

### `alchemy deploy` (remote)

`alchemy deploy` provisions the **real** Cloudflare resources, uploads your Worker code, applies D1 migrations against the real database, shows a plan, asks `Proceed?`, and prints the live URLs. `alchemy destroy` tears a stage back down.

---

## 6. Workers: the core compute primitive

A Worker is your deployed code. The constructor takes a logical ID and props:

```typescript
export const server = Cloudflare.Worker("server", {
  main: "../../apps/server/src/index.ts", // entry file
  compatibility: { flags: ["nodejs_compat"] },
  env: {
    // ← bindings (see §7)
    DB: db,
    CORS_ORIGIN: Config.String("CORS_ORIGIN"),
  },
  dev: { port: 3000 }, // local dev port
});

export type ServerEnv = Cloudflare.InferEnv<typeof server>; // typed env for your worker code
```

Notable bits:

- **`main`** points at your TypeScript entry; Alchemy bundles it.
- **`compatibility.flags`** maps to Cloudflare compatibility flags (here `nodejs_compat`).
- **`dev.port`** fixes the local port.
- **`Cloudflare.InferEnv<typeof server>`** derives the exact `Env` type your Worker code receives — so `env.DB` is a typed D1 binding, `env.CORS_ORIGIN` a string, with no hand-written interface.
- **`worker.url`** is an output you can pass elsewhere (this repo passes the server's URL into the web app as `VITE_SERVER_URL`).

Alchemy also supports static sites and full-stack frameworks on top of Workers via `Cloudflare.Website.*` (e.g. `Cloudflare.Website.Vite(...)`, which this repo uses for the React/TanStack web app) and `Cloudflare.Pages`.

---

## 7. Bindings: how a Worker talks to other services

A **binding** connects a Worker to a resource or value. You declare them in the Worker's `env`, and they show up (typed) on the `Env` object inside your Worker at runtime.

```typescript
const db = yield * Cloudflare.D1.Database("database");
const kv = yield * Cloudflare.KV.Namespace("cache");
const bucket = yield * Cloudflare.R2.Bucket("uploads");

const api =
  yield *
  Cloudflare.Worker("api", {
    main: "./src/index.ts",
    env: {
      DB: db, // D1 binding
      CACHE: kv, // KV binding
      UPLOADS: bucket, // R2 binding
      STAGE: Config.String("STAGE"), // plain config value
      API_KEY: alchemy.secret("API_KEY"), // secret (encrypted in state)
    },
  });
```

Inside the Worker, `env.DB`, `env.CACHE`, `env.UPLOADS`, `env.STAGE` are all available and typed via `InferEnv`. Values in `env` can be:

- **resource outputs** (D1, KV, R2, Queues, Durable Objects, another Worker as a service binding, Vectorize, Hyperdrive, Workers AI…),
- **config** (`Config.String`, etc.),
- **secrets** (encrypted at rest in state).

The binding changes you saw in the dev plan (`[web/VITE_SERVER_URL] update`, `[server/DB] noop`) are exactly these env entries being reconciled.

---

## 8. The Cloudflare service catalog

Alchemy covers a very large slice of the Cloudflare API — effectively the whole platform, from compute to networking to zero-trust. You create each as a resource with `yield* Cloudflare.<Namespace>.<Resource>(...)`. Below are the ones you'll reach for most, grouped by area. (Exact constructor names and props are in the [Cloudflare provider docs](https://alchemy.run) and in the typed source under `alchemy/Cloudflare/*`.)

### Compute & hosting

| Service | Constructor (typical) | Use |
| --- | --- | --- |
| **Workers** | `Cloudflare.Worker("api", { main, env })` | Serverless compute at the edge |
| **Static sites / SSR** | `Cloudflare.Website.Vite("web", { rootDir })` | Vite/React/TanStack/Solid apps on Workers |
| **Pages** | `Cloudflare.Pages(...)` | Cloudflare Pages projects |
| **Workers for Platforms** | `Cloudflare.WorkersForPlatforms.*` | Multi-tenant "dispatch" Workers |
| **Containers** | `Cloudflare.Containers.*` | Container workloads |

### Data & storage

| Service | Constructor (typical) | Use |
| --- | --- | --- |
| **D1** | `Cloudflare.D1.Database("db", { migrations })` | Serverless SQLite (see §9) |
| **KV** | `Cloudflare.KV.Namespace("cache")` | Key-value store |
| **R2** | `Cloudflare.R2.Bucket("assets")` | S3-compatible object storage |
| **Durable Objects** | bound via a `DurableObject` class in a Worker | Strongly-consistent stateful objects (incl. DO SQLite) |
| **Queues** | `Cloudflare.Queues.Queue("jobs")` + `Consumer` | Async message queues |
| **Hyperdrive** | `Cloudflare.Hyperdrive.Connection("pg", { ... })` | Pooled/cached access to external Postgres/MySQL |
| **Pipelines** | `Cloudflare.Pipelines.*` | Streaming data ingestion |
| **Vectorize** | `Cloudflare.Vectorize.Index("vectors", { ... })` | Vector database for embeddings/RAG |
| **Analytics Engine** | `Cloudflare.AnalyticsEngine.*` | Write-time analytics datasets |

### AI

| Service | Constructor (typical) | Use |
| --- | --- | --- |
| **Workers AI** | AI binding on a Worker | Run models at the edge (`env.AI.run(...)`) |
| **AI Gateway** | `Cloudflare.AI.Gateway(...)` | Cache/observe/route LLM traffic |
| **AI Search / datasets** | `Cloudflare.AI.SearchInstance`, `Cloudflare.AI.Dataset` | Managed search & training data |

### Orchestration

| Service | Constructor (typical) | Use |
| --- | --- | --- |
| **Workflows** | `Cloudflare.Workflows.*` + `Workflows.task` / `Workflows.sleep` | Durable, multi-step, long-running workflows |
| **Cron / scheduled** | scheduled event source on a Worker | Cron triggers |

### Networking, DNS & domains

| Area | Constructors |
| --- | --- |
| **DNS & zones** | `Cloudflare.DNS.*`, `Cloudflare.Zone.*` |
| **Registrar** | `Cloudflare.Registrar.*` (domain registration) |
| **Custom hostnames / certs** | `Cloudflare.CustomHostname.*`, `Cloudflare.CustomCertificate.*`, `Cloudflare.Ssl.*` |
| **Load balancing** | `Cloudflare.LoadBalancer.*` |
| **Tunnels / Spectrum** | `Cloudflare.Tunnel.*`, `Cloudflare.Spectrum.*` |
| **Magic networking** | `Cloudflare.MagicTransit.*`, `Cloudflare.MagicNetworkMonitoring.*`, `Cloudflare.NetworkInterconnects.*` |

### Security & Zero Trust

| Area | Constructors |
| --- | --- |
| **Access (Zero Trust)** | `Cloudflare.Access.*` (apps, policies, IdPs, service tokens) |
| **Gateway / Devices / DLP** | `Cloudflare.Gateway.*`, `Cloudflare.Devices.*`, `Cloudflare.Dlp.*` |
| **WAF / rules** | `Cloudflare.Ruleset.*`, `Cloudflare.Rules.*`, `Cloudflare.Firewall.*`, `Cloudflare.PageRule.*` |
| **Bot / DDoS / Turnstile** | `Cloudflare.BotManagement.*`, `Cloudflare.DdosProtection.*`, `Cloudflare.Turnstile.*` |
| **Secrets** | `Cloudflare.SecretsStore.*`, plus `alchemy.secret(...)` bindings |
| **API tokens / mTLS** | `Cloudflare.ApiToken.*`, `Cloudflare.MtlsCertificate.*` |

### Media, performance & misc

| Area | Constructors |
| --- | --- |
| **Images / Stream** | `Cloudflare.Images.*`, `Cloudflare.Stream.*` |
| **Cache / Speed / Rum** | `Cloudflare.Cache.*`, `Cloudflare.Speed.*`, `Cloudflare.Rum.*` |
| **Email routing** | `Cloudflare.Email.*` |
| **Logs** | `Cloudflare.Logpush.*`, `alchemy tail` / `alchemy logs` |
| **Waiting Room / Snippets / Web3** | `Cloudflare.WaitingRoom.*`, `Cloudflare.Snippets.*`, `Cloudflare.Web3.*` |

> This isn't exhaustive — the provider also includes Spectrum, Zaraz, Turnstile, Healthcheck, Logpush, Realtime (Calls/RealtimeKit), Account/Org/IAM management, and more. The pattern is always the same: `yield* Cloudflare.<Area>.<Resource>(logicalId, props)`, then either bind it to a Worker or reference its outputs.

---

## 9. Deep dive: D1 locally vs. remotely

This is the part that maps directly onto your old workflow:

> _"I previously ran D1 from the build folder for testing locally, then put it on remote via `wrangler`."_

Here's how the two approaches compare, and what Alchemy does under the hood.

### Your old Wrangler workflow

1. `wrangler d1 create my-db` → creates a remote DB, you copy the ID into `wrangler.toml`.
2. Locally, `wrangler dev` used a **local SQLite file** (under `.wrangler/state/.../d1`) for testing.
3. You applied migrations separately: `wrangler d1 migrations apply my-db --local` for local, `--remote` for production.
4. Promotion to remote was a manual, separate step with its own flags.

Two databases, two sets of migration commands, manual ID wiring, and it was on _you_ to keep local and remote in sync.

### The Alchemy workflow

You declare the database **once**, with its migrations, and the _same code_ works in both dev and deploy:

```typescript
const db =
  yield *
  Cloudflare.D1.Database("database", {
    migrations: "../../packages/db/src/migrations", // ← this repo's setup
  });

const server =
  yield *
  Cloudflare.Worker("server", {
    main: "../../apps/server/src/index.ts",
    env: { DB: db }, // bound as env.DB in the worker
  });
```

Then:

- `pnpm run dev` (`alchemy dev`) → **local D1**, migrations applied to the local database automatically.
- `pnpm run deploy` (`alchemy deploy`) → **remote D1** provisioned (if needed) and migrations applied to the real database automatically.

No `--local` / `--remote` juggling, no copy-pasting a database ID, no separate migration step. The plan line `[database] noop (local)` in this repo's dev log is exactly this: Alchemy saw the local D1 already matched the desired state, so nothing to do.

### What "local D1" actually is in Alchemy

This is more faithful than a bare SQLite file. Under `alchemy dev`, Alchemy runs a **local Cloudflare runtime (`workerd`)** and inside it stands up the _real_ D1 simulator:

```
Node (migration runner / queries)
   │  via workerd "platform proxy"
   ▼
 d1 service  ──▶  per-database D1DatabaseObject (a Durable Object over DO SQLite)
   │
   ▼
 .alchemy/local/.../d1   (on-disk persistence, same dir every local binding reads)
```

Key points from the implementation:

- The local D1 is the same `d1` service → `D1DatabaseObject` (Durable Object on DO SQLite) that Cloudflare uses — not a hand-rolled mock. So local behavior closely matches production.
- Your Worker's `env.DB.prepare(...).all()` calls hit this local simulator; **no network, no credentials**.
- Data persists on disk in `.alchemy/local`, so it survives restarts (delete that dir to reset).
- Alchemy's Node-side tooling (the migration runner) reaches _into_ workerd through a "platform proxy" so it can run full multi-statement D1 SQL locally, exactly as it would remotely.

### Migrations: one source of truth

Point `migrations` at a folder (or a Drizzle schema). Then:

- Alchemy keeps its bookkeeping in a `__alchemy_migrations` table it owns.
- On each deploy it detects pending migration files and applies them **in order** as part of the update.
- **Adoption of existing databases is automatic and safe.** If your database was previously migrated by `drizzle-kit migrate` or `wrangler d1 migrations apply`, Alchemy does a **one-way conversion on first deploy**: it copies the old tool's applied history into `__alchemy_migrations` (validated against your local files) and leaves the old tracking table _frozen_ — never written, never dropped. From then on Alchemy owns migration state. No baselining required.

So if you're migrating this project off Wrangler-managed D1, your existing applied migrations are recognized rather than re-run.

### Other D1 options worth knowing

The `Database` resource supports (all optional):

- `primaryLocationHint` — region of the primary copy (`wnam`, `enam`, `weur`, `eeur`, `apac`, `oc`). Immutable (changing it replaces the DB).
- `readReplication: { mode: "auto" | "disabled" }` — the **only** mutable-after-create property; toggling it is an in-place update.
- `jurisdiction` — `"default" | "eu" | "fedramp"` for data-residency. Immutable.
- `importFiles: string[]` — extra `.sql` files imported after migrations (hashed; only re-imported when changed).
- `clone` — seed a new DB from an existing one (by resource, `{ databaseId }`, or `{ name }`) during create.

---

## 10. CLI reference

| Command | What it does |
| --- | --- |
| `alchemy dev` | Run the whole app locally (workerd + local D1/KV/R2/…), hot reload. Sets `ALCHEMY_DEV=true`. |
| `alchemy deploy` | Plan + apply to the real cloud; prints outputs. |
| `alchemy plan` | Show the plan without applying. |
| `alchemy destroy` | Tear down the current stage's resources. |
| `alchemy tail` | Live-tail Worker logs. |
| `alchemy logs` | Fetch logs. |
| `alchemy state` | Inspect/manage state. |
| `alchemy profile edit --add Cloudflare` | Configure Cloudflare credentials in a profile. |
| `alchemy profile create <name>` / `--profile <name>` | Manage named profiles (e.g. `prod`). |

In this repo these are wrapped by Turbo scripts: `pnpm run dev`, `pnpm run deploy`, `pnpm run destroy`.

---

## 11. How this maps to the portfolio-cf repo

Putting the whole guide together against the actual infra file ([`packages/infra/alchemy.run.ts`](../packages/infra/alchemy.run.ts)):

```typescript
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import "varlock/auto-load"; // loads env vars (varlock) before the stack evaluates

// A D1 database with migrations from the db package
export const db = Cloudflare.D1.Database("database", {
  migrations: "../../packages/db/src/migrations",
});

// The API server Worker (Hono), with the DB bound and CORS from config
export const server = Cloudflare.Worker("server", {
  main: "../../apps/server/src/index.ts",
  compatibility: { flags: ["nodejs_compat"] },
  env: {
    DB: db,
    CORS_ORIGIN: Config.String("CORS_ORIGIN"),
  },
  dev: { port: 3000 },
});

// Typed Env for the worker code
export type ServerEnv = Cloudflare.InferEnv<typeof server>;

export default Alchemy.Stack(
  "portfolio-cf",
  {
    providers: Cloudflare.providers(),
    // dev → local state (no creds); deploy → Cloudflare state (shared/durable)
    state: process.env.ALCHEMY_DEV ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    const serverWorker = yield* server;

    // The web app (Vite) as a Worker-hosted site, with the API URL injected
    const webWorker = yield* Cloudflare.Website.Vite("web", {
      rootDir: "../../apps/web",
      compatibility: { flags: ["nodejs_compat"] },
      env: {
        VITE_SERVER_URL: serverWorker.url.as<string>(),
      },
      dev: { port: 3001 },
    });

    return {
      web: webWorker.url,
      server: serverWorker.url,
    };
  })
);
```

Reading it with everything above:

- **`db`, `server`** are declared at module scope (lazy — no API calls yet).
- **`server.env.DB = db`** is a D1 binding; **`CORS_ORIGIN`** is a typed config value.
- The **Stack** merges in `Cloudflare.providers()` and chooses state based on `ALCHEMY_DEV`.
- Inside `Effect.gen`, `yield* server` registers the server and gives back outputs; `serverWorker.url.as<string>()` feeds the server's URL into the web app as `VITE_SERVER_URL` — creating a dependency so the server is wired before the web app.
- The returned object `{ web, server }` is the **stack output** you see printed after dev/deploy.
- `pnpm run dev` → local workerd, **local D1** (`[database] noop (local)`), server on `:3000`, web on `:3001`, no credentials.
- `pnpm run deploy` → real Workers + **remote D1** with migrations applied, Cloudflare-backed state.

---

## 12. Further reading

- **Alchemy docs (v2):** <https://alchemy.run> — start with _Getting Started_, then _Concepts → Stack / Resource / State Store_, and the _Cloudflare_ provider section.
- **Cloudflare tutorial (full app):** linked from the Getting Started page — builds a Worker + bindings end-to-end.
- **Effect docs:** <https://effect.website> — read _Getting Started_, _Creating Effects_, _Using Generators_ (`Effect.gen`), and _Layers_ and _Config_. You only need the basics.
- **This project's infra:** [`packages/infra/alchemy.run.ts`](../packages/infra/alchemy.run.ts).
- **Cloudflare platform docs:** <https://developers.cloudflare.com> — authoritative for each service's own semantics (D1, R2, Queues, Workers AI, etc.), which Alchemy provisions but doesn't replace.

> Versions this guide was written against: `alchemy@2.0.0-beta.80`, `effect@4.0.0`. The v2 API is still in beta and may shift between betas — when in doubt, trust the typed source in `node_modules/alchemy/src/Cloudflare/*` and the live docs over any single blog, including this one.
