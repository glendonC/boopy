import { parseArgs } from 'node:util';
import { exportContext } from '../manual-handoff.ts';

const usage =
  'pnpm export:context --package ctx_ID --data-dir /private/boopy-data --output /private/new-context.txt [--port 47901]';
try {
  const args = process.argv.slice(2).filter((value, index) => !(index === 0 && value === '--'));
  const { values } = parseArgs({
    args,
    options: {
      package: { type: 'string' },
      'data-dir': { type: 'string' },
      output: { type: 'string' },
      port: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(usage);
  else if (!values.package || !values['data-dir'] || !values.output) {
    console.error(usage);
    process.exitCode = 1;
  } else {
    const result = await exportContext({
      packageId: values.package,
      dataDir: values['data-dir'],
      output: values.output,
      ...(values.port === undefined ? {} : { port: Number(values.port) }),
    });
    console.log(JSON.stringify({ ...result, sentToMuse: false }));
    console.log('Saved locally. Review the text before manually pasting it into Muse.');
  }
} catch {
  console.error(
    'Export failed. Check the explicit package ID, running local connector, data directory and new writable output path. No assistant delivery is claimed.',
  );
  process.exitCode = 1;
}
