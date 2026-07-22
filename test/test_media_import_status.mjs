import assert from 'node:assert/strict';
import { resolveMediaImportStatus } from '../app/backend/src/services/runStatus.js';

const partialProgress = { uploaded: 10, errors: 2 };
assert.equal(resolveMediaImportStatus('cancelled', 1, partialProgress), 'cancelled');
assert.equal(resolveMediaImportStatus('running', null, partialProgress), 'cancelled');
assert.equal(resolveMediaImportStatus('running', 143, partialProgress), 'cancelled');
assert.equal(resolveMediaImportStatus('running', 0, partialProgress), 'completed');
assert.equal(resolveMediaImportStatus('running', 23, partialProgress), 'partial');
assert.equal(resolveMediaImportStatus('running', 1, { uploaded: 0, errors: 1 }), 'failed');

console.log('Media import status: cancellation wins before retry, deletion, or eject');