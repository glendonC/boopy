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
        'register-terms',
        'provision-practice',
        'verify-practice',
        'term-pick',
        'practice-stage',
        'term-pick-check',
        'practice-stage-check',
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
  if (PRACTICE_MODES.includes(mode)) return practiceReceipt(value.result, mode);
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

const PRACTICE_MODES = [
  'register-terms',
  'provision-practice',
  'verify-practice',
  'term-pick',
  'practice-stage',
  'term-pick-check',
  'practice-stage-check',
];
const VERIFIED = [
  'practiceReadPassed',
  'checkRewritePassed',
  'selectedContextReadDenied',
  'oldReferenceReadDenied',
  'scratchReadDenied',
];
const PICKED = [
  'referenceId',
  'matched',
  'matchedText',
  'term',
  'gloss',
  'description',
  'referenceSourceId',
  'revisionId',
  'modifiedAt',
  'retrievedAt',
  'referenceUrl',
  'license',
  'status',
  'attempts',
  'notHeard',
  'onSource',
  'lastAt',
  'lastResult',
  'why',
];
const NULLABLE = ['matchedText', 'term', 'gloss', 'description', 'lastAt', 'lastResult'];
const COUNTS = ['attempts', 'notHeard', 'onSource'];

/** The operations: fixed shapes, counts and public reference fields only. */
function practiceReceipt(result, mode) {
  const count = (value) => Number.isInteger(value) && value >= 0 && value <= 100000;
  if (mode === 'register-terms') {
    if (result.tables !== 3) throw new Error('Invalid registration.');
    return { mode: 'zetaris-runtime', operation: mode, tables: 3 };
  }
  if (mode === 'provision-practice') {
    if (result.practiceGrants !== true) throw new Error('Invalid practice grants.');
    return { mode: 'zetaris-runtime', operation: mode, practiceGrants: true };
  }
  if (mode === 'verify-practice') {
    if (
      !count(result.termRows) ||
      result.termRows < 1 ||
      VERIFIED.some((field) => result[field] !== true)
    )
      throw new Error('Practice permission check failed.');
    return {
      mode: 'zetaris-runtime',
      operation: mode,
      termRows: result.termRows,
      ...Object.fromEntries(VERIFIED.map((field) => [field, true])),
    };
  }
  const practice = result.practice;
  if (
    !count(practice?.tableRows) ||
    !count(practice?.journalRows) ||
    typeof practice?.restaged !== 'boolean'
  )
    throw new Error('Invalid practice stage.');
  const staged = {
    tableRows: practice.tableRows,
    journalRows: practice.journalRows,
    restaged: practice.restaged,
  };
  const ms = (value) => Number.isInteger(value) && value >= 0 && value <= 120000;
  const picking = mode.startsWith('term-pick');
  if (!ms(result.stageMs) || (picking && !ms(result.pickMs))) throw new Error('Invalid timing.');
  if (!picking)
    return { mode: 'zetaris-runtime', operation: mode, practice: staged, stageMs: result.stageMs };
  if (!Array.isArray(result.rows) || result.rows.length > 9)
    throw new Error('Invalid picked rows.');
  const rows = result.rows.map((row) => {
    const picked = {};
    for (const field of PICKED) {
      const entry = row[field];
      if (COUNTS.includes(field)) {
        if (!count(entry)) throw new Error('Invalid practice count.');
      } else if (entry === null && NULLABLE.includes(field)) {
        // Missing labels and an empty practice record stay null.
      } else if (
        typeof entry !== 'string' ||
        !entry ||
        entry.length > 2048 ||
        Array.from(entry).some((character) => character.codePointAt(0) < 32)
      )
        throw new Error('Invalid picked field.');
      picked[field] = entry;
    }
    if (
      !/^Q[1-9][0-9]{0,11}$/.test(picked.referenceId) ||
      picked.referenceSourceId !== `wikidata:${picked.referenceId}` ||
      picked.referenceUrl !== `https://www.wikidata.org/wiki/${picked.referenceId}` ||
      !/^[0-9]{1,20}$/.test(picked.revisionId) ||
      picked.license !== 'CC0-1.0' ||
      picked.status !== 'external-unreviewed' ||
      !['subject', 'recalled'].includes(picked.matched) ||
      (picked.matched === 'recalled' && picked.matchedText !== null) ||
      ![null, 'heard', 'not-heard', 'unclear'].includes(picked.lastResult) ||
      !['new', 'heard-before', 'not-heard-before', 'unclear-before'].includes(picked.why) ||
      picked.notHeard > picked.attempts ||
      picked.onSource > picked.attempts
    )
      throw new Error('Invalid picked attribution.');
    return picked;
  });
  return {
    mode: 'zetaris-runtime',
    operation: mode,
    practice: staged,
    stageMs: result.stageMs,
    pickMs: result.pickMs,
    rows,
  };
}
