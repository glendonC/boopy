import { createHash } from 'node:crypto';

/** Only fixed-query identities/reference fields survive the vendor subprocess boundary. */
export function federationReceipt(stdout, exitCode, mode) {
  if (stdout.length > 32768) throw new Error('Invalid federation receipt.');
  const value = JSON.parse(stdout);
  if (exitCode === 1 && value?.syntheticContext === true && value?.outcome === 'failed') {
    if (
      ![
        'credentials',
        'connect',
        'discover',
        'register',
        'join',
        'create-source',
        'register-table',
        'provision-reader',
        'verify-reader',
        'reference',
      ].includes(value.stage) ||
      typeof value.errorClass !== 'string' ||
      !/^[A-Za-z0-9_]{1,64}$/.test(value.errorClass) ||
      ![
        'unclassified',
        'parse',
        'syntax',
        'not-supported',
        'already-exists',
        'permission',
        'not-found',
        'timeout',
        'no-viable-alternative',
        'mismatched-input',
      ].includes(value.failureKind)
    )
      throw new Error('Invalid failure receipt.');
    const allowedSignals = [
      'database',
      'datasource',
      'table',
      'null',
      'catalog',
      'syntax',
      'unsupported',
      'not supported',
      'lightning',
      'executequery',
      'no result',
      'default',
      'boopy_selected',
      'boopy_reference',
      'already exists',
      'not found',
      'unrecognized',
      'mismatched',
      'cannot',
      'parse',
      'permission',
      'reserved',
    ];
    const signals = Array.isArray(value.signals)
      ? value.signals.filter((signal) => allowedSignals.includes(signal))
      : [];
    return {
      mode: 'zetaris-runtime',
      operation: mode,
      outcome: 'failed',
      stage: value.stage,
      errorClass: value.errorClass,
      failureKind: value.failureKind,
      signals,
    };
  }
  if (
    exitCode !== 0 ||
    value?.syntheticContext !== true ||
    value?.outcome !== 'passed' ||
    value?.result?.mode !== mode
  )
    throw new Error('Federation probe failed.');
  if (mode === 'provision-reader' || mode === 'verify-reader') {
    const fields =
      mode === 'provision-reader'
        ? ['referenceOnlyGrant']
        : ['referenceReadPassed', 'selectedContextReadDenied'];
    if (fields.some((field) => value.result[field] !== true))
      throw new Error('Reader permission check failed.');
    return {
      mode: 'zetaris-runtime',
      operation: mode,
      ...Object.fromEntries(fields.map((field) => [field, true])),
    };
  }
  if (mode === 'reference') {
    if (!Array.isArray(value.result.rows) || value.result.rows.length !== 1)
      throw new Error('Invalid reference result.');
    return {
      mode: 'zetaris-runtime',
      operation: 'reference-lookup',
      rows: value.result.rows.map(referenceRow),
    };
  }
  if (mode === 'discover') {
    if (
      !Number.isInteger(value.result.datasourceCount) ||
      value.result.datasourceCount < 0 ||
      value.result.datasourceCount > 100
    )
      throw new Error('Invalid datasource count.');
    return {
      mode: 'zetaris-runtime',
      operation: mode,
      datasourceCount: value.result.datasourceCount,
      selectedDatabasePresent: value.result.selectedDatabasePresent === true,
      referenceDatabasePresent: value.result.referenceDatabasePresent === true,
    };
  }
  if (mode === 'register') {
    if (value.result.isolatedSources !== 2) throw new Error('Invalid isolated registration.');
    return { mode: 'zetaris-runtime', operation: mode, isolatedSources: 2 };
  }
  if (mode !== 'join' || !Array.isArray(value.result.rows) || value.result.rows.length > 10)
    throw new Error('Invalid federation rows.');
  const fields = [
    'sourceId',
    'packageId',
    'evidenceId',
    'revisionId',
    'capturedAt',
    'humanVerification',
    'disposition',
    'modelConfidence',
    'referenceSourceId',
    'referenceId',
    'koreanTerm',
    'englishGloss',
    'referenceVersion',
    'updatedAt',
    'referenceStatus',
    'referenceUrl',
    'license',
    'sourceRecordSha256',
    'conceptKey',
  ];
  const rows = value.result.rows.map((row) => {
    const result = {};
    for (const field of fields) {
      const entry = row[field];
      if (field === 'modelConfidence') {
        if (
          entry !== null &&
          (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0 || entry > 1)
        )
          throw new Error('Invalid confidence.');
      } else if ((field === 'revisionId' || field === 'capturedAt') && entry === null) {
        // Missing source associations stay null.
      } else if (
        typeof entry !== 'string' ||
        !entry ||
        entry.length > 2048 ||
        Array.from(entry).some((character) => character.codePointAt(0) < 32)
      )
        throw new Error('Invalid reference field.');
      result[field] = entry;
    }
    if (
      result.sourceId !==
        `${encodeURIComponent(result.packageId)}:${encodeURIComponent(result.evidenceId)}` ||
      result.disposition !== 'context' ||
      !['accepted', 'confirmed', 'authored', 'corrected', 'unconfirmed'].includes(
        result.humanVerification,
      )
    )
      throw new Error('Invalid selected evidence.');
    if (!/^[a-f0-9]{64}$/.test(result.sourceRecordSha256))
      throw new Error('Invalid evidence hash.');
    if (
      !/^wikidata:Q\d+$/.test(result.referenceSourceId) ||
      result.referenceSourceId !== `wikidata:${result.referenceId}` ||
      !/^\d+$/.test(result.referenceVersion) ||
      result.referenceUrl !== `https://www.wikidata.org/wiki/${result.referenceId}` ||
      result.license !== 'CC0-1.0' ||
      result.referenceStatus !== 'external-unreviewed'
    )
      throw new Error('Invalid independent attribution.');
    return result;
  });
  return { mode: 'zetaris-runtime', operation: mode, contextSynthetic: true, rows };
}

/** Stable full-record identity; unknown associations and human actions are included. */
export function evidenceRecordHash(record) {
  const stable = (value) =>
    Array.isArray(value)
      ? value.map(stable)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, stable(value[key])]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(stable(record)))
    .digest('hex');
}

function referenceRow(row) {
  const fields = [
    'referenceSourceId',
    'referenceId',
    'koreanTerm',
    'englishGloss',
    'referenceVersion',
    'updatedAt',
    'referenceStatus',
    'referenceUrl',
    'license',
  ];
  const result = Object.fromEntries(fields.map((field) => [field, row[field]]));
  if (
    fields.some(
      (field) =>
        typeof result[field] !== 'string' ||
        !result[field] ||
        result[field].length > 2048 ||
        Array.from(result[field]).some((character) => character.codePointAt(0) < 32),
    )
  )
    throw new Error('Invalid reference row.');
  if (
    !['Q25391', 'Q8514', 'Q71516'].includes(result.referenceId) ||
    result.referenceSourceId !== `wikidata:${result.referenceId}` ||
    !/^\d+$/.test(result.referenceVersion) ||
    result.referenceUrl !== `https://www.wikidata.org/wiki/${result.referenceId}` ||
    result.license !== 'CC0-1.0' ||
    result.referenceStatus !== 'external-unreviewed' ||
    !Number.isFinite(Date.parse(result.updatedAt))
  )
    throw new Error('Invalid reference attribution.');
  return result;
}
