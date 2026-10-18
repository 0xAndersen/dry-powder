## What and why

## Risk

<!-- Can this change what a trader can lose, what the vault owes, or who can move funds? How is that tested? -->

## Checks

- [ ] `cd contracts && forge test` (if contracts changed)
- [ ] `cd frontend && npx tsc --noEmit` (if the app changed)
- [ ] `cd sdk && npm test` (if the SDK changed)
- [ ] `frontend/e2e/with-keeper.sh` for anything that touches trading end to end
- [ ] Docs updated (README, AGENTS.md, docs/) where behaviour changed
