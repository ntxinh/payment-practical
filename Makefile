.PHONY: setup dev build lint format typecheck test test-unit test-integration \
        db-generate db-migrate db-seed db-reset stripe-seed finix-webhook-seed check verify

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
finix-webhook-seed: ; NODE_OPTIONS="--conditions=react-server" pnpm tsx --env-file-if-exists=.env scripts/finix-webhook-seed.ts
check: lint typecheck test
verify: check build
