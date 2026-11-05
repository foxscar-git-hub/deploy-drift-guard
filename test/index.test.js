'use strict';

/**
 * Self-test for Deploy-Drift Guard's pure logic. Deliberately uses only
 * Node's built-in `assert` and `test` modules — no test framework
 * dependency, matching the action's zero-runtime-dependency design.
 *
 * Run with: node test/index.test.js
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  getByPath,
  isHexSha,
  coerceCandidate,
  extractShaFromJson,
  compareShas,
  extractDeployedSha,
} = require('../index.js');

// ---------------------------------------------------------------------------
// getByPath
// ---------------------------------------------------------------------------

test('getByPath resolves a simple dot path', () => {
  assert.equal(getByPath({ a: { b: 'x' } }, 'a.b'), 'x');
});

test('getByPath resolves array indices', () => {
  assert.equal(getByPath({ commits: [{ sha: 'abc123' }] }, 'commits.0.sha'), 'abc123');
});

test('getByPath returns undefined for a missing path', () => {
  assert.equal(getByPath({ a: {} }, 'a.b.c'), undefined);
});

test('getByPath returns undefined for null/undefined input', () => {
  assert.equal(getByPath(null, 'a'), undefined);
  assert.equal(getByPath(undefined, 'a'), undefined);
});

// ---------------------------------------------------------------------------
// isHexSha
// ---------------------------------------------------------------------------

test('isHexSha accepts a full 40-char SHA', () => {
  assert.equal(isHexSha('a'.repeat(40), 7), true);
});

test('isHexSha accepts a short 7-char SHA', () => {
  assert.equal(isHexSha('abc1234', 7), true);
});

test('isHexSha rejects strings shorter than min length', () => {
  assert.equal(isHexSha('abc12', 7), false);
});

test('isHexSha rejects non-hex characters', () => {
  assert.equal(isHexSha('not-a-sha-at-all', 7), false);
});

test('isHexSha rejects non-string values', () => {
  assert.equal(isHexSha(12345678, 7), false);
  assert.equal(isHexSha(undefined, 7), false);
});

// ---------------------------------------------------------------------------
// coerceCandidate
// ---------------------------------------------------------------------------

test('coerceCandidate accepts a plain SHA string', () => {
  assert.equal(coerceCandidate('ABC1234', 7), 'abc1234');
});

test('coerceCandidate unwraps a nested { sha } object', () => {
  assert.equal(coerceCandidate({ sha: 'DEF5678' }, 7), 'def5678');
});

test('coerceCandidate rejects a non-SHA string', () => {
  assert.equal(coerceCandidate('hello world', 7), undefined);
});

test('coerceCandidate rejects numbers and other junk', () => {
  assert.equal(coerceCandidate(42, 7), undefined);
  assert.equal(coerceCandidate(null, 7), undefined);
});

// ---------------------------------------------------------------------------
// extractShaFromJson
// ---------------------------------------------------------------------------

test('extractShaFromJson uses an explicit json-path', () => {
  const json = { data: { commit: { sha: 'abc1234def5678' } } };
  assert.equal(extractShaFromJson(json, 'data.commit.sha', 7), 'abc1234def5678');
});

test('extractShaFromJson falls back to common field names when no path given', () => {
  assert.equal(extractShaFromJson({ sha: 'abc1234' }, '', 7), 'abc1234');
  assert.equal(extractShaFromJson({ commitSha: 'def5678' }, '', 7), 'def5678');
  assert.equal(extractShaFromJson({ version: '1234567' }, '', 7), '1234567');
});

test('extractShaFromJson returns undefined when nothing matches', () => {
  assert.equal(extractShaFromJson({ status: 'ok' }, '', 7), undefined);
});

// ---------------------------------------------------------------------------
// compareShas
// ---------------------------------------------------------------------------

test('compareShas matches identical full SHAs', () => {
  assert.equal(compareShas('a'.repeat(40), 'a'.repeat(40)), true);
});

test('compareShas matches a short SHA against a long one', () => {
  assert.equal(compareShas('abc1234', 'abc1234567890abcdef1234567890abcdef1234'), true);
});

test('compareShas matches case-insensitively', () => {
  assert.equal(compareShas('ABC1234', 'abc1234'), true);
});

test('compareShas detects a genuine mismatch', () => {
  assert.equal(compareShas('abc1234', 'def5678'), false);
});

test('compareShas treats empty strings as non-matching', () => {
  assert.equal(compareShas('', ''), false);
});

// ---------------------------------------------------------------------------
// extractDeployedSha (header > json > plain text precedence)
// ---------------------------------------------------------------------------

function fakeHeaders(map) {
  return {
    get(name) {
      const key = Object.keys(map).find((k) => k.toLowerCase() === String(name).toLowerCase());
      return key ? map[key] : null;
    },
  };
}

test('extractDeployedSha prefers the header over the body', () => {
  const headers = fakeHeaders({ 'x-deployed-sha': 'aaaaaaa' });
  const body = JSON.stringify({ sha: 'bbbbbbb' });
  const result = extractDeployedSha(headers, body, {
    shaHeader: 'x-deployed-sha',
    jsonPath: '',
    minMatchLength: 7,
  });
  assert.equal(result.sha, 'aaaaaaa');
  assert.equal(result.source, 'header');
});

test('extractDeployedSha falls back to JSON body when header is absent', () => {
  const headers = fakeHeaders({});
  const body = JSON.stringify({ sha: 'bbbbbbb' });
  const result = extractDeployedSha(headers, body, {
    shaHeader: 'x-deployed-sha',
    jsonPath: '',
    minMatchLength: 7,
  });
  assert.equal(result.sha, 'bbbbbbb');
  assert.equal(result.source, 'json');
});

test('extractDeployedSha falls back to plain text when body is not JSON', () => {
  const headers = fakeHeaders({});
  const body = '  ccccccc  \n';
  const result = extractDeployedSha(headers, body, {
    shaHeader: 'x-deployed-sha',
    jsonPath: '',
    minMatchLength: 7,
  });
  assert.equal(result.sha, 'ccccccc');
  assert.equal(result.source, 'text');
});

test('extractDeployedSha returns undefined when nothing matches anywhere', () => {
  const headers = fakeHeaders({});
  const body = '<html><body>not a sha</body></html>';
  const result = extractDeployedSha(headers, body, {
    shaHeader: 'x-deployed-sha',
    jsonPath: '',
    minMatchLength: 7,
  });
  assert.equal(result.sha, undefined);
});

test('extractDeployedSha respects an explicit json-path over common field names', () => {
  const headers = fakeHeaders({});
  const body = JSON.stringify({ sha: 'deadc0de', data: { commit: { sha: 'cafefeed1' } } });
  const result = extractDeployedSha(headers, body, {
    shaHeader: 'x-deployed-sha',
    jsonPath: 'data.commit.sha',
    minMatchLength: 7,
  });
  assert.equal(result.sha, 'cafefeed1');
  assert.equal(result.source, 'json');
});
