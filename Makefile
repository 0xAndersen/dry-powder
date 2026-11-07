.PHONY: build test coverage abis deploy-testnet keeper-check frontend-check up

build:
	cd contracts && forge build --sizes

test:
	cd contracts && forge test -vvv

coverage:
	cd contracts && forge coverage --no-match-coverage "(test|script|lib)/"

# Regenerate the typed ABIs used by the keeper and the frontend after changing a contract.
abis: build
	node scripts/export-abis.mjs

# Requires ARC_TESTNET_RPC_URL and a Foundry keystore account: make deploy-testnet ACCOUNT=<name>
deploy-testnet:
	cd contracts && forge script script/Deploy.s.sol:Deploy --rpc-url arc_testnet --broadcast --account $(ACCOUNT)

keeper-check:
	cd keeper && npm ci && npm run typecheck && npm test && npm run build

frontend-check:
	cd frontend && npm ci && npx tsc --noEmit && npm run build

up:
	docker compose up --build
