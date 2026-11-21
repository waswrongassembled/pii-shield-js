/**
 * @waswrongassembled/pii-shield/testing: conformance suites for storage adapters. They check the
 * contracts of `VaultStorage` and `CustomEntityStore` with `node:assert` only, so they run under any test
 * runner (vitest, jest, `node:test`, mocha) without a peer dependency. All test data is synthetic.
 */
export {
  verifyCustomEntityStore,
  type VerifyCustomEntityStoreOptions,
  verifyVaultStorage,
  type VerifyReport,
  type VerifyVaultStorageOptions,
} from './conformance.js';
