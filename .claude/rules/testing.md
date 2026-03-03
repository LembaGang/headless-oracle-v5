# Testing Rules
Framework: Vitest. All tests in test/index.spec.ts. Current count: 165. Never decrease without approval.
Every new feature needs: happy path test, error/edge case test, signature coverage test (if receipt field), DST boundary test (if schedule).
After every change: run full suite, all must pass before commit, all must pass before deploy.
