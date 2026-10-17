# Stripe Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A minimal Next.js app selling "purpose learning" plan subscriptions through Stripe Checkout + Customer Portal, with webhook-driven local subscription status.

**Architecture:** Modular monolith in one Next.js 16 deployable. `app → features → server/modules → server/db`; server actions and route handlers only parse → delegate → respond. Dev-only HMAC-cookie email auth; drizzle + better-sqlite3; webhook idempotency via a `webhook_events` table.

**Tech Stack:** Next.js 16.4.0, React 19.3.0, stripe@23, drizzle-orm + better-sqlite3, ulidx, server-only, biome, vitest, tsx, pnpm 9 (mise: node 22).

**Spec:** `docs/superpowers/specs/2026-10-17-stripe-subscriptions-design.md`

## Global Constraints

- Every `src/server/**` and `src/features/**` file: `import "server-only";` first line (features files use `"use server"` + server-only is implied by Next; still add it to `src/server/**` only).
- Money: integer cents, `_cents` column suffix. Timestamps: unixepoch **ms**, `_at` suffix. IDs: text ULIDs via `ulidx`.
- `current_period_end` lives on `SubscriptionItem` in stripe@23 (`sub.items.data[0].current_period_end`, seconds → store ×1000). There is no `sub.current_period_end`.
- `Stripe.Subscription["status"]` includes `"paused"` — it is in our union and is NOT access-granting.
- Actions redirect with `redirect(url)`; never catch a thrown `NEXT_REDIRECT` (it is not a `BillingError` — `instanceof` guards suffice).
- Webhook: raw body via `req.text()`; 404 without `STRIPE_WEBHOOK_SECRET`/`STRIPE_SECRET_KEY`; let `processBillingEvent` errors propagate to a 500 so Stripe retries.
- Test scripts and drizzle-kit run under `NODE_OPTIONS="--conditions=react-server"`; vitest aliases `server-only` to `tests/server-only.stub.ts`.
- Env names: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `SESSION_SECRET`, `DATABASE_URL` (`file:./data/app.db`), `NEXT_PUBLIC_APP_URL`.
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is NOT needed — checkout is a hosted redirect, no Stripe.js.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `mise.toml`, `biome.json`, `tsconfig.json`, `next.config.ts`, `drizzle.config.ts`, `vitest.config.ts`, `.editorconfig`, `.gitignore`, `.env.example`, `Makefile`, `tests/server-only.stub.ts`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`

**Interfaces:**
- Produces: `make setup|dev|lint|typecheck|check|db-*|stripe-seed` targets; `@/*` → `./src/*` path alias; `DATABASE_URL` convention.

- [ ] **Step 1: Write config files**

`package.json`:
```json
{
  "name": "purpose-learning",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "biome check ."
  },
  "dependencies": {
    "better-sqlite3": "^13.0.3",
    "drizzle-orm": "^0.45.4",
    "next": "16.4.0",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "server-only": "^0.0.1",
    "stripe": "^23.0.0",
    "ulidx": "^2.4.1"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.5.15",
    "@types/better-sqlite3": "^9.6.0",
    "@types/node": "^22.20.5",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "drizzle-kit": "^0.31.11",
    "tsx": "^4.23.15",
    "typescript": "^5",
    "vite-tsconfig-paths": "^6.1.1",
    "vitest": "^5.0.4"
  },
  "packageManager": "pnpm@9.15.0"
}
```

`mise.toml`:
```toml
[tools]
node = "22"
pnpm = "9"
```

`biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.15/schema.json",
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": { "enabled": true, "rules": { "preset": "recommended" } },
  "files": { "includes": ["src/**", "tests/**", "scripts/**", "*.ts", "*.json", "!.worktrees"] }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts",
    ".next/dev/types/**/*.ts",
    "**/*.mts"
  ],
  "exclude": ["node_modules"]
}
```

`next.config.ts`:
```ts
import type { NextConfig } from "next";
const nextConfig: NextConfig = {};
export default nextConfig;
```

`drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL?.replace("file:", "") ?? "./data/app.db" },
});
```

`vitest.config.ts`:
```ts
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

  plugins: [tsconfigPaths()],
  resolve: {
    // `server-only` throws outside an RSC bundler; stub it out in tests.
    alias: { "server-only": new URL("./tests/server-only.stub.ts", import.meta.url).pathname },
  },
  test: {
    passWithNoTests: true,
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    env: { DATABASE_URL: "file:./tests/.tmp/test.db" },
  },
});
```

`tests/server-only.stub.ts`:
```ts
export {};
```

`.editorconfig`:
```
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false
```

`.gitignore`:
```
# .gitignore
node_modules/
.next/
data/*.db*
tests/.tmp/
.env
*.tsbuildinfo
next-env.d.ts
```

`.env.example`:
```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
SESSION_SECRET=change-me-in-production
DATABASE_URL=file:./data/app.db
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

`Makefile`:
```make
.PHONY: setup dev build lint format typecheck test test-unit test-integration \
        db-generate db-migrate db-seed db-reset stripe-seed check verify

setup: ; pnpm install && pnpm next typegen
dev: ; pnpm dev
build: ; pnpm build
lint: ; pnpm biome check .
format: ; pnpm biome check --write .
typecheck: ; pnpm next typegen && pnpm tsc --noEmit
test: test-unit test-integration
test-unit: ; pnpm vitest run tests/unit
test-integration: ; pnpm vitest run tests/integration
# NODE_OPTIONS: server-only resolves to an empty module under the react-server
# condition, letting drizzle-kit/tsx load src/server/** files.
db-generate: ; NODE_OPTIONS="--conditions=react-server" pnpm drizzle-kit generate
db-migrate: ; NODE_OPTIONS="--conditions=react-server" pnpm tsx --env-file-if-exists=.env scripts/db-migrate.ts
db-seed: ; NODE_OPTIONS="--conditions=react-server" pnpm tsx --env-file-if-exists=.env scripts/db-seed.ts
db-reset: ; rm -f data/*.db* && $(MAKE) db-migrate db-seed
stripe-seed: ; NODE_OPTIONS="--conditions=react-server" pnpm tsx --env-file-if-exists=.env scripts/stripe-seed.ts
check: lint typecheck test
verify: check build
```

- [ ] **Step 2: Minimal app shell so `next dev` boots**

`src/app/layout.tsx`:
```tsx
import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Purpose Learning" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
```

`src/app/page.tsx`:
```tsx
import Link from "next/link";

export default function Home() {
  return (
    <>
      <h1>Purpose Learning</h1>
      <p>Learn on purpose.</p>
      <Link href="/pricing">See plans</Link>
    </>
  );
}
```

`src/app/globals.css`:
```css
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0; }
.wrap { max-width: 40rem; margin: 0 auto; padding: 2rem 1rem; }
.plans { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); }
.plan { border: 1px solid #8884; border-radius: 0.5rem; padding: 1rem; }
.error { color: #c33; }
button, .btn { padding: 0.5rem 1rem; }
```

- [ ] **Step 3: Install and smoke**

Run: `mise install && make setup && pnpm next typegen && timeout 15 pnpm dev` (or `pnpm build`)
Expected: installs clean; dev server compiles `/` without error.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: scaffold next.js 16 app"
```

---

### Task 2: Database layer

**Files:**
- Create: `src/server/db/schema.ts`, `src/server/db/client.ts`, `src/server/env.ts`, `scripts/plans.ts`, `scripts/db-migrate.ts`, `scripts/db-seed.ts`, `tests/helpers/db.ts`
- Test: `tests/integration/db.test.ts`

**Interfaces:**
- Produces:
  - `createDb(path: string): DB` — opens sqlite (mkdir -p parent), sets WAL + foreign_keys, returns drizzle instance bound to schema.
  - `migrateDb(db: DB): void` — applies `./drizzle` migrations.
  - `getDb(): DB` — lazy singleton on `DATABASE_URL`.
  - `type DB = ReturnType<typeof createDb>`
  - `type User`, `type Plan`, `type Subscription` = drizzle `$inferSelect` of each table.
  - `PLAN_DEFS: readonly {slug,name,priceCents,currency,interval}[]` in `scripts/plans.ts`.
  - `appUrl()`, `sessionSecret()` from `env.ts`.

- [ ] **Step 1: Write the failing test**

`tests/integration/db.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { plans, subscriptions, users } from "@/server/db/schema";
import { makeTestDb } from "../helpers/db";

describe("db layer", () => {
  let db: ReturnType<typeof makeTestDb>;
  afterEach(() => db?.$client.close());

  it("migrates cleanly and enforces FK + unique email", () => {
    db = makeTestDb("fk");
    const now = Date.now();
    db.insert(users).values({ id: "u1", email: "a@b.c", createdAt: now }).run();
    expect(() =>
      db.insert(users).values({ id: "u2", email: "a@b.c", createdAt: now }).run(),
    ).toThrow();
    expect(() =>
      db
        .insert(subscriptions)
        .values({ id: "s1", userId: "ghost", stripeSubscriptionId: "sub_1", stripePriceId: "p", status: "active", createdAt: now, updatedAt: now })
        .run(),
    ).toThrow(); // FK violation
  });

  it("schema queries round-trip via db.query", () => {
    db = makeTestDb("query");
    db.insert(users).values({ id: "u1", email: "q@b.c", createdAt: Date.now() }).run();
    const row = db.query.users.findFirst({ where: eq(users.email, "q@b.c") });
    expect(row?.id).toBe("u1");
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run tests/integration/db.test.ts`
Expected: FAIL — `@/server/db/schema` not found.

- [ ] **Step 3: Implement**

`src/server/env.ts`:
```ts
import "server-only";

export function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export function sessionSecret(): string {
  return process.env.SESSION_SECRET ?? "dev-only-insecure-secret";
}

export function dbPath(): string {
  return (process.env.DATABASE_URL ?? "file:./data/app.db").replace(/^file:/, "");
}
```

`src/server/db/schema.ts`:
```ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: integer("created_at").notNull(),
});

export const plans = sqliteTable("plans", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull(),
  currency: text("currency").notNull(),
  interval: text("interval").notNull(), // "month" | "year"
  stripePriceId: text("stripe_price_id"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
});

export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  stripeSubscriptionId: text("stripe_subscription_id").notNull().unique(),
  stripePriceId: text("stripe_price_id").notNull(),
  status: text("status").notNull(),
  currentPeriodEnd: integer("current_period_end"),
  cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const webhookEvents = sqliteTable("webhook_events", {
  stripeEventId: text("stripe_event_id").primaryKey(),
  type: text("type").notNull(),
  processedAt: integer("processed_at").notNull(),
});

export type User = typeof users.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
```

`src/server/db/client.ts`:
```ts
import "server-only";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { dbPath } from "@/server/env";
import * as schema from "./schema";

export function createDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

export type DB = ReturnType<typeof createDb>;

export function migrateDb(db: DB): void {
  migrate(db, { migrationsFolder: "./drizzle" });
}

let singleton: DB | undefined;

/** Lazy singleton; resolves DATABASE_URL on first use. */
export function getDb(): DB {
  singleton ??= createDb(dbPath());
  return singleton;
}
```

`tests/helpers/db.ts`:
```ts
import { createDb, migrateDb } from "@/server/db/client";

/** Fresh migrated sqlite under tests/.tmp/<name>.db. Caller closes $client. */
export function makeTestDb(name: string) {
  const db = createDb(`./tests/.tmp/${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  migrateDb(db);
  return db;
}
```

`scripts/plans.ts`:
```ts
export const PLAN_DEFS = [
  { slug: "starter", name: "Starter", priceCents: 900, currency: "usd", interval: "month" },
  { slug: "pro", name: "Pro", priceCents: 2900, currency: "usd", interval: "month" },
] as const;
```

`scripts/db-migrate.ts`:
```ts
import { createDb, migrateDb } from "@/server/db/client";
import { dbPath } from "@/server/env";

const db = createDb(dbPath());
migrateDb(db);
db.$client.close();
console.log("migrated", dbPath());
```

`scripts/db-seed.ts`:
```ts
import { ulid } from "ulidx";
import { createDb, migrateDb } from "@/server/db/client";
import { dbPath } from "@/server/env";
import { plans } from "@/server/db/schema";
import { PLAN_DEFS } from "./plans";

const db = createDb(dbPath());
migrateDb(db);
const now = Date.now();
for (const p of PLAN_DEFS) {
  db.insert(plans)
    .values({ id: ulid(), ...p, createdAt: now })
    .onConflictDoNothing({ target: plans.slug })
    .run();
}
db.$client.close();
console.log("seeded", PLAN_DEFS.length, "plans");
```

- [ ] **Step 4: Generate migration, run test**

Run: `make db-generate && pnpm vitest run tests/integration/db.test.ts`
Expected: `drizzle/0000_*.sql` created; both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: db schema, client, migrate/seed scripts"
```

---

### Task 3: Billing module — Stripe + events + subscriptions

**Files:**
- Create: `src/server/modules/billing/errors.ts`, `src/server/modules/billing/plans.ts`, `src/server/modules/billing/subscriptions.ts`, `src/server/modules/billing/stripe.ts`
- Test: `tests/unit/subscriptions.test.ts`, `tests/integration/billing.test.ts`

**Interfaces:**
- Consumes: `DB`, `User`, `Plan` from Task 2; `appUrl()` from `env.ts`.
- Produces:
  - `class BillingError extends Error { constructor(readonly code: BillingErrorCode) }`; `type BillingErrorCode = "UNAUTHENTICATED" | "PLAN_NOT_FOUND" | "STRIPE_NOT_CONFIGURED" | "NO_STRIPE_CUSTOMER"`
  - `type SubscriptionStatus` (union incl. `"paused"`); `isActive(s): boolean`
  - `getActivePlans(db): Plan[]`, `getPlanById(db, id): Plan | undefined`
  - `getLatestSubscription(db, userId): Subscription | undefined`
  - `getStripe(): Stripe` (throws `STRIPE_NOT_CONFIGURED`), `setStripeForTests()`
  - `checkoutUrlForPlan(db, user, plan): Promise<string>`
  - `portalUrlForUser(user): Promise<string>`
  - `processBillingEvent(db, stripe, event): Promise<"APPLIED" | "IGNORED">`
  - `handleStripeWebhook(db, payload, signature): Promise<{ status: number }>`

- [ ] **Step 1: Write failing unit test**

`tests/unit/subscriptions.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { isActive, mapSubscriptionStatus } from "@/server/modules/billing/subscriptions";

describe("mapSubscriptionStatus", () => {
  it.each(["active", "trialing", "past_due", "canceled", "paused", "incomplete", "incomplete_expired", "unpaid"] as const)(
    "passes through %s",
    (s) => expect(mapSubscriptionStatus(s)).toBe(s),
  );
  it("maps unknown future statuses to unpaid (never grants access)", () => {
    expect(mapSubscriptionStatus("some_future_status")).toBe("unpaid");
  });
});

describe("isActive", () => {
  it("grants access only for active/trialing", () => {
    expect(isActive("active")).toBe(true);
    expect(isActive("trialing")).toBe(true);
    expect(isActive("paused")).toBe(false);
    expect(isActive("past_due")).toBe(false);
  });
});
```

- [ ] **Step 2: Write failing integration test**

`tests/integration/billing.test.ts` — fixtures + stubbed `stripe.subscriptions.retrieve`:
```ts
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, describe, expect, it } from "vitest";
import { processBillingEvent } from "@/server/modules/billing/stripe";
import { subscriptions, users } from "@/server/db/schema";
import { makeTestDb } from "../helpers/db";

const user = { id: "u1", email: "u@x.y", stripeCustomerId: "cus_1", createdAt: Date.now() };

const stripeSub = (over: Partial<Stripe.Subscription> = {}): Stripe.Subscription =>
  ({
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    metadata: { userId: user.id },
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_1" }, current_period_end: 1_800_000_000 }] },
    ...over,
  }) as unknown as Stripe.Subscription;

const event = (type: string, object: unknown): Stripe.Event =>
  ({ id: `evt_${type}`, type, data: { object } }) as unknown as Stripe.Event;

const stripeClient = {
  subscriptions: { retrieve: async () => stripeSub() },
} as unknown as Stripe;

describe("processBillingEvent", () => {
  let db: ReturnType<typeof makeTestDb>;
  afterEach(() => db?.$client.close());

  const seed = () => {
    db = makeTestDb("billing");
    db.insert(users).values(user).run();
  };

  it("checkout.session.completed → active subscription row", async () => {
    seed();
    const session = { mode: "subscription", subscription: "sub_1" };
    const out = await processBillingEvent(db, stripeClient, event("checkout.session.completed", session));
    expect(out).toBe("APPLIED");
    const row = db.select().from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, "sub_1")).get();
    expect(row?.status).toBe("active");
    expect(row?.userId).toBe(user.id);
    expect(row?.currentPeriodEnd).toBe(1_800_000_000_000); // s → ms
  });

  it("replaying the same event id is ignored (idempotent)", async () => {
    seed();
    const e = event("customer.subscription.updated", stripeSub());
    await processBillingEvent(db, stripeClient, e);
    const second = await processBillingEvent(db, stripeClient, e);
    expect(second).toBe("IGNORED");
    expect(db.select().from(subscriptions).all()).toHaveLength(1);
  });

  it("customer.subscription.deleted → canceled", async () => {
    seed();
    await processBillingEvent(db, stripeClient, event("customer.subscription.updated", stripeSub()));
    await processBillingEvent(
      db,
      stripeClient,
      event("customer.subscription.deleted", stripeSub({ status: "canceled" })),
    );
    const row = db.select().from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, "sub_1")).get();
    expect(row?.status).toBe("canceled");
  });

  it("unresolvable user → IGNORED (no row)", async () => {
    seed();
    const out = await processBillingEvent(
      db,
      stripeClient,
      event("customer.subscription.updated", stripeSub({ metadata: {}, customer: "cus_unknown" })),
    );
    expect(out).toBe("IGNORED");
    expect(db.select().from(subscriptions).all()).toHaveLength(0);
  });

  it("portalUrlForUser without stripe customer → NO_STRIPE_CUSTOMER", async () => {
    const { portalUrlForUser } = await import("@/server/modules/billing/stripe");
    const bare = { ...user, stripeCustomerId: null };
    await expect(portalUrlForUser(bare)).rejects.toMatchObject({ code: "NO_STRIPE_CUSTOMER" });
  });
});
```

- [ ] **Step 3: Run to confirm fail**

Run: `pnpm vitest run tests/unit tests/integration/billing.test.ts`
Expected: FAIL — module files missing.

- [ ] **Step 4: Implement**

`errors.ts`:
```ts
import "server-only";

export type BillingErrorCode =
  | "UNAUTHENTICATED"
  | "PLAN_NOT_FOUND"
  | "STRIPE_NOT_CONFIGURED"
  | "NO_STRIPE_CUSTOMER";

export class BillingError extends Error {
  constructor(readonly code: BillingErrorCode) {
    super(code);
    this.name = "BillingError";
  }
}
```

`plans.ts`:
```ts
import "server-only";
import { eq } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { plans, type Plan } from "@/server/db/schema";

export function getActivePlans(db: DB): Plan[] {
  return db.select().from(plans).where(eq(plans.active, true)).all();
}

export function getPlanById(db: DB, id: string): Plan | undefined {
  return db.select().from(plans).where(eq(plans.id, id)).get();
}
```

`subscriptions.ts`:
```ts
import "server-only";
import { desc, eq } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { subscriptions, type Subscription } from "@/server/db/schema";

export type SubscriptionStatus =
  | "active" | "trialing" | "past_due" | "canceled" | "paused"
  | "incomplete" | "incomplete_expired" | "unpaid";

const KNOWN: ReadonlySet<string> = new Set<SubscriptionStatus>([
  "active", "trialing", "past_due", "canceled", "paused",
  "incomplete", "incomplete_expired", "unpaid",
]);

/** Unknown/future Stripe statuses map to unpaid — never grant access on ambiguity. */
export function mapSubscriptionStatus(status: string): SubscriptionStatus {
  return KNOWN.has(status) ? (status as SubscriptionStatus) : "unpaid";
}

export function isActive(status: SubscriptionStatus): boolean {
  return status === "active" || status === "trialing";
}

export function getLatestSubscription(db: DB, userId: string): Subscription | undefined {
  return db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.updatedAt))
    .limit(1)
    .get();
}
```

`stripe.ts`:
```ts
import "server-only";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { ulid } from "ulidx";
import type { DB } from "@/server/db/client";
import { subscriptions, users, webhookEvents, type Plan, type User } from "@/server/db/schema";
import { appUrl } from "@/server/env";
import { BillingError } from "./errors";
import { mapSubscriptionStatus, type SubscriptionStatus } from "./subscriptions";

// process.env (not env.ts) so tests can inject keys after module load.
let client: Stripe | null | undefined;

/** Test hook: stub client, force unconfigured (null), or reset (undefined). */
export function setStripeForTests(stub: Stripe | null | undefined): void {
  client = stub;
}

/** Lazy singleton; throws STRIPE_NOT_CONFIGURED without STRIPE_SECRET_KEY. */
export function getStripe(): Stripe {
  if (client === undefined) {
    client = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  }
  if (!client) throw new BillingError("STRIPE_NOT_CONFIGURED");
  return client;
}

export async function checkoutUrlForPlan(db: DB, user: User, plan: Plan): Promise<string> {
  if (!plan.active || !plan.stripePriceId) throw new BillingError("PLAN_NOT_FOUND");
  const stripe = getStripe();
  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { userId: user.id },
    });
    customerId = customer.id;
    db.update(users).set({ stripeCustomerId: customerId }).where(eq(users.id, user.id)).run();
  }
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    success_url: `${appUrl()}/account/billing?success=1`,
    cancel_url: `${appUrl()}/pricing`,
    client_reference_id: user.id,
    metadata: { userId: user.id },
    subscription_data: { metadata: { userId: user.id } },
  });
  if (!session.url) throw new Error("stripe returned no checkout url");
  return session.url;
}

export async function portalUrlForUser(user: User): Promise<string> {
  if (!user.stripeCustomerId) throw new BillingError("NO_STRIPE_CUSTOMER");
  const session = await getStripe().billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${appUrl()}/account/billing`,
  });
  return session.url;
}

function resolveUserId(db: DB, sub: Stripe.Subscription): string | undefined {
  const fromMeta = sub.metadata?.userId;
  if (fromMeta) return fromMeta;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  if (!customerId) return undefined;
  return db.select().from(users).where(eq(users.stripeCustomerId, customerId)).get()?.id;
}

function upsertSubscription(db: DB, sub: Stripe.Subscription, userId: string): void {
  const item = sub.items.data[0];
  const now = Date.now();
  const row = {
    stripePriceId: item?.price.id ?? "",
    status: mapSubscriptionStatus(sub.status) satisfies SubscriptionStatus,
    currentPeriodEnd: item?.current_period_end ? item.current_period_end * 1000 : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    updatedAt: now,
  };
  db.insert(subscriptions)
    .values({ id: ulid(), userId, stripeSubscriptionId: sub.id, createdAt: now, ...row })
    .onConflictDoUpdate({ target: subscriptions.stripeSubscriptionId, set: row })
    .run();
}

/**
 * Applies one verified event. Dedupes on event id via webhook_events before
 * doing any work. Events we can't associate with a user are recorded and
 * IGNORED so Stripe stops retrying.
 */
export async function processBillingEvent(
  db: DB,
  stripe: Stripe,
  event: Stripe.Event,
): Promise<"APPLIED" | "IGNORED"> {
  const dedupe = db
    .insert(webhookEvents)
    .values({ stripeEventId: event.id, type: event.type, processedAt: Date.now() })
    .onConflictDoNothing()
    .run();
  if (dedupe.changes === 0) return "IGNORED";

  let sub: Stripe.Subscription | null = null;
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    if (session.mode !== "subscription" || !subId) return "IGNORED";
    // Errors propagate → route 500s → Stripe retries.
    sub = await stripe.subscriptions.retrieve(subId);
  } else if (event.type.startsWith("customer.subscription.")) {
    sub = event.data.object as Stripe.Subscription;
  }
  if (!sub) return "IGNORED";

  const userId = resolveUserId(db, sub);
  if (!userId) return "IGNORED";
  upsertSubscription(db, sub, userId);
  return "APPLIED";
}

/**
 * 404 unless STRIPE_WEBHOOK_SECRET + key configured, 400 on bad signature,
 * 200 ack for handled/ignored/unknown events.
 */
export async function handleStripeWebhook(
  db: DB,
  payload: string,
  signatureHeader: string | null,
): Promise<{ status: number }> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !process.env.STRIPE_SECRET_KEY || !signatureHeader) return { status: 404 };
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(payload, signatureHeader, secret);
  } catch {
    return { status: 400 };
  }
  await processBillingEvent(db, getStripe(), event);
  return { status: 200 };
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run tests/unit tests/integration/billing.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: billing module — checkout, portal, webhook event processing"
```

---

### Task 4: Auth — HMAC session cookie + login

**Files:**
- Create: `src/server/auth/session.ts`, `src/features/auth/actions.ts`, `src/app/login/page.tsx`
- Test: `tests/unit/session.test.ts`

**Interfaces:**
- Consumes: `getDb()`, `users`, `sessionSecret()`.
- Produces:
  - `verifySessionValue(value: string): string | null` (pure; exported for tests)
  - `setSessionCookie(userId)`, `clearSessionCookie()`, `getCurrentUser(): Promise<User | null>`
  - `login(formData)`, `logout()` server actions.

- [ ] **Step 1: Write failing unit test**

`tests/unit/session.test.ts`:
```ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySessionValue } from "@/server/auth/session";

describe("verifySessionValue", () => {
  // sign is not exported; forge a valid cookie through the same HMAC recipe.
  const make = (uid: string) => {
    return `${uid}.${createHmac("sha256", "dev-only-insecure-secret").update(uid).digest("hex")}`;
  };

  it("returns userId for a valid signature", () => {
    expect(verifySessionValue(make("u123"))).toBe("u123");
  });
  it("rejects tampered signature and malformed values", () => {
    expect(verifySessionValue(`${make("u123")}x`)).toBeNull();
    expect(verifySessionValue("u123.")).toBeNull();
    expect(verifySessionValue("no-separator")).toBeNull();
    expect(verifySessionValue("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run tests/unit/session.test.ts`
Expected: FAIL — module missing. (If the import chain pulls `next/headers` and explodes under vitest, move `verifySessionValue` + the `sign` helper into a sibling `session-crypto.ts` with no Next imports, and re-export from `session.ts`.)

- [ ] **Step 3: Implement**

`src/server/auth/session.ts`:
```ts
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "@/server/db/client";
import { users, type User } from "@/server/db/schema";
import { sessionSecret } from "@/server/env";

const COOKIE = "session";

function sign(userId: string): string {
  return createHmac("sha256", sessionSecret()).update(userId).digest("hex");
}

/** Pure verifier — returns the userId or null. */
export function verifySessionValue(value: string): string | null {
  const i = value.lastIndexOf(".");
  if (i <= 0) return null;
  const userId = value.slice(0, i);
  const sig = Buffer.from(value.slice(i + 1));
  const expected = Buffer.from(sign(userId));
  return sig.length === expected.length && timingSafeEqual(sig, expected) ? userId : null;
}

export async function setSessionCookie(userId: string): Promise<void> {
  (await cookies()).set(COOKIE, `${userId}.${sign(userId)}`, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export async function getCurrentUser(): Promise<User | null> {
  const value = (await cookies()).get(COOKIE)?.value;
  const userId = value && verifySessionValue(value);
  if (!userId) return null;
  return (await getDb().query.users.findFirst({ where: eq(users.id, userId) })) ?? null;
}
```

`src/features/auth/actions.ts`:
```ts
"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { clearSessionCookie, setSessionCookie } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";

export async function login(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email.includes("@")) redirect("/login?error=INVALID_EMAIL");
  const db = getDb();
  let user = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!user) {
    db.insert(users).values({ id: ulid(), email, createdAt: Date.now() }).run();
    user = await db.query.users.findFirst({ where: eq(users.email, email) });
  }
  if (!user) throw new Error("user insert failed");
  await setSessionCookie(user.id);
  redirect("/pricing");
}

export async function logout(): Promise<void> {
  await clearSessionCookie();
  redirect("/");
}
```

`src/app/login/page.tsx`:
```tsx
import { login } from "@/features/auth/actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <>
      <h1>Sign in</h1>
      {error && <p className="error">{error}</p>}
      <form action={login}>
        <input name="email" type="email" required placeholder="you@example.com" />
        <button type="submit">Continue</button>
      </form>
    </>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: dev email login with hmac session cookie"
```

---

### Task 5: Pages, billing actions, webhook route

**Files:**
- Create: `src/features/billing/actions.ts`, `src/app/pricing/page.tsx`, `src/app/account/billing/page.tsx`, `src/app/api/v1/webhooks/stripe/route.ts`, `scripts/stripe-seed.ts`
- Test: `tests/integration/webhook-route.test.ts`

**Interfaces:**
- Consumes: all of Tasks 2–4.
- Produces:
  - `subscribe(formData)` — form action on each plan card (`planId` hidden input).
  - `manageBilling(formData)` — portal action.
  - `POST /api/v1/webhooks/stripe` — `export async function POST(req: Request)`.

- [ ] **Step 1: Write failing route test**

`tests/integration/webhook-route.test.ts` — forge signatures offline with `Stripe.webhooks.generateTestHeaderString`; stub the stripe singleton and env:
```ts
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStripeForTests } from "@/server/modules/billing/stripe";
import { users } from "@/server/db/schema";
import { makeTestDb } from "../helpers/db";

const WHSEC = "whsec_test";
const stripe = new Stripe("sk_test_unused");

vi.mock("@/server/db/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/db/client")>();
  return { ...mod, getDb: () => current };
});
let current: ReturnType<typeof makeTestDb>;
let POST: typeof import("@/app/api/v1/webhooks/stripe/route").POST;

const post = (body: string, sig: string | null) =>
  POST(new Request("http://x/api/v1/webhooks/stripe", {
    method: "POST",
    headers: sig ? { "stripe-signature": sig } : {},
    body,
  }));

describe("POST /api/v1/webhooks/stripe", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_unused");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", WHSEC);
    current = makeTestDb("webhook");
    current.insert(users).values({ id: "u1", email: "a@b.c", stripeCustomerId: "cus_1", createdAt: Date.now() }).run();
    setStripeForTests(stripe);
    POST = (await import("@/app/api/v1/webhooks/stripe/route")).POST;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setStripeForTests(undefined);
    current?.$client.close();
  });

  it("400 on bad signature", async () => {
    const res = await post("{}", "bad");
    expect(res.status).toBe(400);
  });

  it("404 when webhook secret unset", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    const res = await post("{}", "any");
    expect(res.status).toBe(404);
  });

  it("200 for a valid customer.subscription.updated (resolved via customer id)", async () => {
    const payload = JSON.stringify({
      id: "evt_rt1",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_rt",
          status: "active",
          customer: "cus_1",
          metadata: {},
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_1" }, current_period_end: 1_800_000_000 }] },
        },
      },
    });
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
    const res = await post(payload, sig);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run tests/integration/webhook-route.test.ts`
Expected: FAIL — route file missing.

- [ ] **Step 3: Implement**

`src/app/api/v1/webhooks/stripe/route.ts`:
```ts
import { getDb } from "@/server/db/client";
import { handleStripeWebhook } from "@/server/modules/billing/stripe";

/**
 * POST /api/v1/webhooks/stripe — Stripe event sink. Raw body required for
 * signature verification; 404 unless STRIPE_WEBHOOK_SECRET is set.
 */
export async function POST(req: Request) {
  const payload = await req.text();
  const signature = req.headers.get("stripe-signature");
  const result = await handleStripeWebhook(getDb(), payload, signature);
  if (result.status === 404) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  if (result.status === 400) return Response.json({ error: "INVALID_SIGNATURE" }, { status: 400 });
  return Response.json({ data: { received: true } }, { status: 200 });
}
```

`src/features/billing/actions.ts`:
```ts
"use server";

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { BillingError } from "@/server/modules/billing/errors";
import { getPlanById } from "@/server/modules/billing/plans";
import { checkoutUrlForPlan, portalUrlForUser } from "@/server/modules/billing/stripe";

export async function subscribe(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const plan = getPlanById(getDb(), String(formData.get("planId") ?? ""));
  if (!plan) redirect("/pricing?error=PLAN_NOT_FOUND");
  let url: string;
  try {
    url = await checkoutUrlForPlan(getDb(), user, plan);
  } catch (e) {
    if (e instanceof BillingError) redirect(`/pricing?error=${e.code}`);
    throw e;
  }
  redirect(url);
}

export async function manageBilling(): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  let url: string;
  try {
    url = await portalUrlForUser(user);
  } catch (e) {
    if (e instanceof BillingError) redirect(`/account/billing?error=${e.code}`);
    throw e;
  }
  redirect(url);
}
```

`src/app/pricing/page.tsx`:
```tsx
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { subscribe } from "@/features/billing/actions";
import { getActivePlans } from "@/server/modules/billing/plans";

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { error } = await searchParams;
  const plans = getActivePlans(getDb());
  return (
    <>
      <h1>Plans</h1>
      {error && <p className="error">{error}</p>}
      <div className="plans">
        {plans.map((p) => (
          <div className="plan" key={p.id}>
            <h2>{p.name}</h2>
            <p>
              ${(p.priceCents / 100).toFixed(2)}/{p.interval}
            </p>
            {p.stripePriceId ? (
              <form action={subscribe}>
                <input type="hidden" name="planId" value={p.id} />
                <button type="submit">Subscribe</button>
              </form>
            ) : (
              <p>Unavailable — run make stripe-seed</p>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
```

`src/app/account/billing/page.tsx`:
```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { manageBilling } from "@/features/billing/actions";
import { isActive, getLatestSubscription, mapSubscriptionStatus } from "@/server/modules/billing/subscriptions";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const params = await searchParams;
  const sub = getLatestSubscription(getDb(), user.id);
  return (
    <>
      <h1>Billing</h1>
      {params.success && <p>Subscription activated.</p>}
      {params.error && <p className="error">{params.error}</p>}
      {sub ? (
        <p>
          Status: <strong>{sub.status}</strong>
          {isActive(mapSubscriptionStatus(sub.status)) ? "" : " (no access)"}
        </p>
      ) : (
        <p>
          No subscription. <Link href="/pricing">Pick a plan</Link>
        </p>
      )}
      <form action={manageBilling}>
        <button type="submit">Manage billing</button>
      </form>
    </>
  );
}
```

`scripts/stripe-seed.ts` — idempotent by `metadata.slug` product lookup and exact price match:
```ts
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { createDb } from "@/server/db/client";
import { dbPath } from "@/server/env";
import { plans } from "@/server/db/schema";
import { PLAN_DEFS } from "./plans";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error("STRIPE_SECRET_KEY required");
const stripe = new Stripe(key);
const db = createDb(dbPath());

for (const def of PLAN_DEFS) {
  const products = await stripe.products.list({ limit: 100 });
  const product =
    products.data.find((p) => p.metadata?.slug === def.slug) ??
    (await stripe.products.create({ name: def.name, metadata: { slug: def.slug } }));

  const existing = await stripe.prices.list({ product: product.id, limit: 100 });
  const price =
    existing.data.find(
      (x) =>
        x.unit_amount === def.priceCents &&
        x.currency === def.currency &&
        x.recurring?.interval === def.interval,
    ) ??
    (await stripe.prices.create({
      product: product.id,
      unit_amount: def.priceCents,
      currency: def.currency,
      recurring: { interval: def.interval },
    }));

  db.update(plans).set({ stripePriceId: price.id }).where(eq(plans.slug, def.slug)).run();
  console.log(`${def.slug} → ${price.id}`);
}
db.$client.close();
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: pricing, billing pages, actions, stripe webhook route, stripe-seed"
```

---

### Task 6: Docs + full verify

**Files:**
- Create: `AGENTS.md`, `README.md`, `DESIGN.md`, `docs/architecture/overview.md`, `docs/database/schema.md`, `docs/operations/local-development.md`, `docs/testing/strategy.md`

- [ ] **Step 1: `AGENTS.md`** — trimmed reference version; keep the `nextjs-agent-rules` HTML comment block verbatim at top, then:

```markdown
# AGENTS.md — Purpose Learning

Subscription-only app; modular monolith in one Next.js 16 deployable, SQLite
via Drizzle (Postgres-portable). Dev-only email auth — NOT production auth.

## Architecture boundaries

- Dependency direction: `app → features → server/modules → server/db`.
- Every `src/server/**` file starts with `import "server-only";`.
- Business rules live in `src/server/modules/billing`; route handlers and
  server actions only parse → authorize → delegate → serialize.

## Conventions

- IDs: text ULIDs. Money: integer cents, `_cents` suffix. Timestamps:
  unixepoch ms, `_at` suffix.
- Errors: `BillingError(code)`; actions redirect to `?error=<code>`.
- Stripe truth: local `subscriptions` rows are a cache — webhooks
  (`checkout.session.completed`, `customer.subscription.*`) are the only
  writers. Never set subscription status in app code.
- `current_period_end` is on `SubscriptionItem`, not `Subscription`.

## Commands

- Setup: `make setup`, `make db-reset`, `make stripe-seed`.
- Webhooks: `stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe`
  → copy `whsec_` into `.env`.
- Gates: `make check` (lint+typecheck+tests), `make verify` (+ build).

## Database safety

- Migrations via `make db-generate` only; never hand-edit applied SQL.
- `foreign_keys=ON` + WAL in `db/client.ts`; no SQLite-isms in services.

## Security

- `.env.example` placeholders only; never commit `.env` or `data/*.db`.
- `SESSION_SECRET` dev default is insecure; override in `.env`.
- Session cookie is HMAC-signed `userId.sig`, httpOnly — demo-grade only.

## Testing

- Unit for pure rules (status mapping, cookie verify); integration on real
  SQLite under `tests/.tmp` for webhook/event flows. Stripe SDK is stubbed
  at the `processBillingEvent` boundary, never HTTP-mocked.
```

- [ ] **Step 2: `README.md`** — quickstart:

```markdown
# Purpose Learning

Stripe subscription slice: plan picker → Checkout → webhook → local status → Customer Portal.

## Quickstart

    mise install
    make setup
    cp .env.example .env        # add your sk_test_ key
    make db-reset               # migrate + seed plans
    make stripe-seed            # create Stripe products/prices, link plans
    stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe
    # paste the printed whsec_ into .env as STRIPE_WEBHOOK_SECRET
    make dev                    # http://localhost:3000

Login with any email (dev auth). Subscribe with Stripe test card `4242 4242 4242 4242`.

## Commands

`make check` — lint + typecheck + tests. `make verify` — + build.
See `docs/operations/local-development.md` for details.
```

- [ ] **Step 3: `DESIGN.md`** — condensed spec: Goal, Architecture (the directory tree + boundary rule), Data model (4-table summary), Flow (the mermaid sequence diagram), Errors table. ~60 lines, links to `docs/superpowers/specs/2026-10-17-stripe-subscriptions-design.md`.

- [ ] **Step 4: `docs/` pages** — one screen each:
- `architecture/overview.md`: dependency direction, file map, why webhooks are sole writer.
- `database/schema.md`: the 4-table column listing from the spec + idempotency rationale.
- `operations/local-development.md`: env var table, `stripe listen` setup, `stripe trigger checkout.session.completed`, resetting DB.
- `testing/strategy.md`: unit vs integration split, `tests/.tmp` isolation, `setStripeForTests`/`generateTestHeaderString` mechanics, no-e2e rationale.

- [ ] **Step 5: Full verify + smoke**

Run: `make check && make verify`
Expected: lint clean, typecheck clean, all tests pass, `next build` succeeds.

Manual smoke (needs `.env` keys + `stripe listen` running): `make db-reset && make stripe-seed && make dev` → login → subscribe with `4242…` → watch webhook ack → `/account/billing` shows `active` → Manage billing opens portal → cancel in portal → status flips `canceled` on next load.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs: readme, agents, design, docs/"
```
