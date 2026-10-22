/** Allowlisted subprocess receipt. Never forward arbitrary producer JSON or contradictory exits. */
export function probeReceipt(stdout, exitCode) {
  if (stdout.length > 4096) throw new Error('Invalid probe receipt.');
  const value = JSON.parse(stdout.trim());
  if (
    value === null ||
    typeof value !== 'object' ||
    value.synthetic !== true ||
    value.query !== 'select-one' ||
    value.totalDeadlineMs !== 20000 ||
    !['passed', 'failed', 'timeout'].includes(value.outcome) ||
    !Number.isInteger(exitCode) ||
    (value.outcome === 'passed' ? exitCode !== 0 : exitCode !== 1)
  )
    throw new Error('Invalid probe receipt.');
  const receipt = {
    synthetic: true,
    outcome: value.outcome,
    query: 'select-one',
    totalDeadlineMs: 20000,
  };
  if (value.outcome === 'passed') {
    if (
      value.rows !== 1 ||
      value.columns !== 1 ||
      typeof value.loginTimeoutConfigured !== 'boolean' ||
      typeof value.queryTimeoutConfigured !== 'boolean' ||
      !Number.isInteger(value.schemaCount) ||
      value.schemaCount < 0 ||
      value.schemaCount > 100 ||
      typeof value.driverVersion !== 'string' ||
      !/^[A-Za-z0-9._+-]{1,64}$/.test(value.driverVersion)
    )
      throw new Error('Invalid probe metadata.');
    return {
      ...receipt,
      rows: 1,
      columns: 1,
      loginTimeoutConfigured: value.loginTimeoutConfigured,
      queryTimeoutConfigured: value.queryTimeoutConfigured,
      schemaCount: value.schemaCount,
      driverVersion: value.driverVersion,
    };
  }
  if (
    !['credentials', 'load-driver', 'connect', 'query', 'metadata'].includes(value.stage) ||
    typeof value.errorClass !== 'string' ||
    !/^[A-Za-z0-9._+-]{1,64}$/.test(value.errorClass) ||
    ![
      'unclassified',
      'connection-refused',
      'connection-reset',
      'broken-pipe',
      'invalid-argument',
      'network-is-unreachable',
      'operation-not-permitted',
    ].includes(value.failureKind)
  )
    throw new Error('Invalid probe failure metadata.');
  return {
    ...receipt,
    stage: value.stage,
    errorClass: value.errorClass,
    failureKind: value.failureKind,
  };
}
