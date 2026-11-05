'use strict';

/**
 * Deploy-Drift Guard
 *
 * Detects "silent deploy failure": CI reports a deploy as successful, but
 * the live production app is still serving an old commit. This script
 * fetches a public URL, extracts a commit SHA the live app reports about
 * itself (via response header, JSON body field, or plain-text body), and
 * compares it against the SHA that is supposed to be live.
 *
 * Deliberately requires NO API token, deploy-platform credential, or
 * secret of any kind — see README.md for the rationale.
 */

// ---------------------------------------------------------------------------
// Pure helpers (exported for the self-test in test/index.test.js)
// ---------------------------------------------------------------------------

/**
 * Resolve a dot-notation path (with optional numeric array indices) against
 * a plain object, e.g. getByPath(obj, 'data.commits.0.sha').
 * Returns undefined if any segment along the way is missing.
 */
function getByPath(obj, path) {
  if (obj === null || obj === undefined || !path) return undefined;
  const segments = String(path).split('.').filter(Boolean);
  let current = obj;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    current = current[segment];
  }
  return current;
}

/** True if `value` is a string that looks like a plausible hex commit SHA. */
function isHexSha(value, minLength) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  const re = new RegExp(`^[0-9a-f]{${minLength},40}$`, 'i');
  return re.test(trimmed);
}

/**
 * Try to pull a SHA-shaped string out of a parsed JSON body, either via an
 * explicit dot-path or by trying a short list of conventional field names.
 */
function extractShaFromJson(json, jsonPath, minMatchLength) {
  if (jsonPath) {
    const value = getByPath(json, jsonPath);
    return coerceCandidate(value, minMatchLength);
  }

  const candidateKeys = [
    'sha',
    'commitSha',
    'commit_sha',
    'commit.sha',
    'gitSha',
    'git_sha',
    'version',
    'revision',
  ];

  for (const key of candidateKeys) {
    const value = getByPath(json, key);
    const coerced = coerceCandidate(value, minMatchLength);
    if (coerced) return coerced;
  }

  return undefined;
}

/**
 * A "candidate" value found via JSON may itself be a string, or an object
 * like { sha: '...' } (e.g. when "commit" resolves to a nested object).
 * Normalize it down to a hex-SHA string, or undefined if it doesn't qualify.
 */
function coerceCandidate(value, minMatchLength) {
  if (typeof value === 'string' && isHexSha(value, minMatchLength)) {
    return value.trim().toLowerCase();
  }
  if (value && typeof value === 'object' && typeof value.sha === 'string') {
    return coerceCandidate(value.sha, minMatchLength);
  }
  return undefined;
}

/**
 * Compare two SHAs that may be short or long form. Truncates both to the
 * length of the shorter one before comparing, case-insensitively.
 */
function compareShas(deployedSha, expectedSha) {
  const a = String(deployedSha).trim().toLowerCase();
  const b = String(expectedSha).trim().toLowerCase();
  const len = Math.min(a.length, b.length);
  if (len === 0) return false;
  return a.slice(0, len) === b.slice(0, len);
}

/**
 * Core extraction logic, given an already-fetched response's headers and
 * body text. Tries, in order: (a) response header, (b) JSON body field,
 * (c) plain-text body that IS the SHA.
 *
 * `headers` only needs a `.get(name)` method (a Fetch API Headers object
 * satisfies this, as does a plain Map-like test double).
 */
function extractDeployedSha(headers, bodyText, options) {
  const { shaHeader, jsonPath, minMatchLength } = options;

  // (a) response header
  if (shaHeader) {
    const headerValue = headers.get(shaHeader);
    const coerced = coerceCandidate(headerValue, minMatchLength);
    if (coerced) return { sha: coerced, source: 'header' };
  }

  // (b) JSON body field
  if (typeof bodyText === 'string' && bodyText.trim().length > 0) {
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = undefined;
    }
    if (json && typeof json === 'object') {
      const fromJson = extractShaFromJson(json, jsonPath, minMatchLength);
      if (fromJson) return { sha: fromJson, source: 'json' };
    }

    // (c) plain-text body that IS the SHA
    const plain = coerceCandidate(bodyText, minMatchLength);
    if (plain) return { sha: plain, source: 'text' };
  }

  return { sha: undefined, source: undefined };
}

// ---------------------------------------------------------------------------
// GitHub Actions plumbing (no @actions/core dependency on purpose — this
// action ships with zero runtime dependencies)
// ---------------------------------------------------------------------------

function getInput(name, fallback) {
  const envName = `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
  const value = process.env[envName];
  if (value === undefined || value === '') return fallback;
  return value;
}

function getBooleanInput(name, fallback) {
  const value = getInput(name, undefined);
  if (value === undefined) return fallback;
  return /^true$/i.test(value.trim());
}

function getNumberInput(name, fallback) {
  const value = getInput(name, undefined);
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  const line = `${name}=${value}\n`;
  if (outputFile) {
    require('fs').appendFileSync(outputFile, line);
  } else {
    // Fallback for local runs / older runners.
    console.log(`::set-output name=${name}::${value}`);
  }
}

function logInfo(message) {
  console.log(message);
}

function logWarning(message) {
  console.log(`::warning::${message}`);
}

function logError(message) {
  console.log(`::error::${message}`);
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const bodyText = await response.text();
    return { response, bodyText };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const url = getInput('url', undefined);
  const expectedSha = getInput('expected-sha', process.env.GITHUB_SHA || '');
  const shaHeader = getInput('sha-header', 'x-deployed-sha');
  const jsonPath = getInput('json-path', '');
  const minMatchLength = getNumberInput('min-match-length', 7);
  const timeoutMs = getNumberInput('timeout-ms', 10000);
  const failOnDrift = getBooleanInput('fail-on-drift', true);

  if (!url) {
    logError('Input "url" is required.');
    setOutput('status', 'error');
    setOutput('drift-detected', 'unknown');
    process.exitCode = 1;
    return;
  }

  if (!expectedSha) {
    logError(
      'Input "expected-sha" could not be resolved (and GITHUB_SHA was not set). ' +
        'Pass expected-sha explicitly if you are running outside a normal GitHub Actions context.'
    );
    setOutput('status', 'error');
    setOutput('drift-detected', 'unknown');
    process.exitCode = 1;
    return;
  }

  logInfo(`Deploy-Drift Guard: checking ${url} against expected SHA ${expectedSha}`);

  let response;
  let bodyText;
  try {
    const result = await fetchWithTimeout(url, timeoutMs);
    response = result.response;
    bodyText = result.bodyText;
  } catch (err) {
    const message = err && err.name === 'AbortError'
      ? `Request to ${url} timed out after ${timeoutMs}ms.`
      : `Request to ${url} failed: ${err && err.message ? err.message : err}`;
    logWarning(
      `${message} Could not determine the deployed SHA, so no drift check was ` +
        'performed. This is reported as a warning, not a failure, so a flaky ' +
        'or misconfigured endpoint cannot silently break CI.'
    );
    setOutput('status', 'error');
    setOutput('expected-sha', expectedSha);
    setOutput('drift-detected', 'unknown');
    return;
  }

  if (!response.ok) {
    logWarning(
      `Request to ${url} returned HTTP ${response.status}. Could not determine ` +
        'the deployed SHA, so no drift check was performed.'
    );
    setOutput('status', 'error');
    setOutput('expected-sha', expectedSha);
    setOutput('drift-detected', 'unknown');
    return;
  }

  const { sha: deployedSha, source } = extractDeployedSha(response.headers, bodyText, {
    shaHeader,
    jsonPath,
    minMatchLength,
  });

  setOutput('expected-sha', expectedSha);

  if (!deployedSha) {
    logWarning(
      `Could not find a commit SHA in the response from ${url} (checked header ` +
        `"${shaHeader}", JSON body${jsonPath ? ` at path "${jsonPath}"` : ' (common field names)'}, ` +
        'and plain-text body). No drift check was performed. See the README for ' +
        'how to expose the SHA from your app.'
    );
    setOutput('status', 'not-found');
    setOutput('drift-detected', 'unknown');
    return;
  }

  setOutput('deployed-sha', deployedSha);

  const matches = compareShas(deployedSha, expectedSha);

  if (matches) {
    logInfo(`Deploy-Drift Guard: OK — live deployment reports SHA "${deployedSha}" (via ${source}), matches expected "${expectedSha}".`);
    setOutput('status', 'match');
    setOutput('drift-detected', 'false');
    return;
  }

  setOutput('status', 'drift');
  setOutput('drift-detected', 'true');

  const driftMessage =
    `Deploy drift detected! The workflow expects commit "${expectedSha}" to be ` +
    `live, but ${url} reports commit "${deployedSha}" (via ${source}). The ` +
    'deploy likely failed, is still rolling out, or is serving a stale cache/CDN edge.';

  if (failOnDrift) {
    logError(driftMessage);
    process.exitCode = 1;
  } else {
    logWarning(`${driftMessage} (fail-on-drift is false, so this step is not failing.)`);
  }
}

module.exports = {
  getByPath,
  isHexSha,
  coerceCandidate,
  extractShaFromJson,
  compareShas,
  extractDeployedSha,
  run,
};

if (require.main === module) {
  run().catch((err) => {
    logError(`Deploy-Drift Guard crashed unexpectedly: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  });
}
