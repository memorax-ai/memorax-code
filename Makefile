.PHONY: test test-ts test-codex-adapter test-claude-adapter test-dsh-adapter test-dsh-e2e test-opencode-adapter test-opencode-e2e test-npm-package docs-check npm-package-build npm-package-check npm-publish-dry-run release-version-check clean

NPM ?= npm

test: release-version-check test-ts test-npm-package

test-ts:
	$(NPM) ci --prefix packages/ts/memorax-code-backend
	$(NPM) run typecheck --prefix packages/ts/memorax-code-backend
	$(NPM) test --prefix packages/ts/memorax-code-backend
	$(MAKE) test-codex-adapter
	$(MAKE) test-claude-adapter
	$(MAKE) test-dsh-adapter
	$(MAKE) test-opencode-adapter

test-codex-adapter:
	$(NPM) test --prefix packages/ts/memorax-code-codex-adapter

test-claude-adapter:
	$(NPM) test --prefix packages/ts/memorax-code-claude-adapter

test-dsh-adapter:
	$(NPM) test --prefix packages/ts/memorax-code-dsh-adapter

test-dsh-e2e:
	node scripts/dsh-npm-package-e2e.mjs

test-opencode-adapter:
	$(NPM) test --prefix packages/ts/memorax-code-opencode-adapter

test-opencode-e2e:
	$(NPM) ci --prefix packages/ts/memorax-code-backend
	node scripts/opencode-e2e.mjs

test-npm-package:
	$(NPM) ci --prefix packages/ts/memorax-code-backend
	node --test packages/npm/memorax-code/test/*.test.mjs scripts/check-local-trace-only.test.mjs
	node scripts/check-local-trace-only.mjs

docs-check:
	node --test scripts/check-docs.test.mjs
	node scripts/check-docs.mjs
	scripts/check-readme-sync.sh

npm-package-build: release-version-check
	scripts/build-npm-packages.sh

npm-package-check: release-version-check
	scripts/npm-package-check.sh

release-version-check:
	node scripts/sync-release-version.mjs --check

npm-publish-dry-run:
	scripts/npm-publish-dry-run.sh

clean:
	rm -rf packages/ts/memorax-code-backend/node_modules packages/ts/memorax-code-backend/dist
	find . -name '__pycache__' -type d -prune -exec rm -rf {} +
