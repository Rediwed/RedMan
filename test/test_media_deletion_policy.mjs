import assert from 'node:assert/strict';
import {
  DELETE_AFTER_IMPORT_AVAILABLE,
  validateDeleteAfterImportSetting,
} from '../app/backend/src/services/mediaDeletionPolicy.js';

assert.equal(DELETE_AFTER_IMPORT_AVAILABLE, true);
assert.equal(validateDeleteAfterImportSetting(false), 0);
assert.equal(validateDeleteAfterImportSetting(0), 0);
assert.equal(validateDeleteAfterImportSetting(true), 1);
assert.equal(validateDeleteAfterImportSetting(1), 1);

console.log('Verified media deletion policy: 5 cases passed');