/** Downloads only the explicit prepared packet from the running local service; no journal writer. */
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readConnectorToken } from '../manual-handoff.ts';

export async function exportPrepared(options: {
  packageId: string;
  dataDir: string;
  output: string;
  port?: number;
  requestId?: string;
}) {
  const port = options.port ?? 47901;
  if (
    !/^ctx_[a-zA-Z0-9_-]{1,128}$/.test(options.packageId) ||
    !options.output.trim() ||
    (options.requestId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(options.requestId)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('Choose an explicit package and new output file.');
  // Reserve a new private file before disclosing packet content. Never overwrites a file/symlink.
  const file = await open(resolve(options.output), 'wx', 0o600);
  try {
    const token = await readConnectorToken(options.dataDir);
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/local-handoffs/${options.packageId}/packet${options.requestId ? `?request=${encodeURIComponent(options.requestId)}` : ''}`,
      {
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: { authorization: `Bearer ${token}` },
      },
    );
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get('content-type')?.startsWith('text/plain')
    ) {
      await response.body?.cancel();
      throw new Error();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 8 * 1024 * 1024) throw new Error();
        chunks.push(chunk.value);
      }
    } catch {
      await reader.cancel();
      throw new Error();
    } finally {
      reader.releaseLock();
    }
    await file.writeFile(Buffer.concat(chunks));
    await file.sync();
    return {
      packageId: options.packageId,
      path: resolve(options.output),
      bytes,
      sentToMuse: false,
    };
  } catch {
    throw new Error('Prepared packet unavailable or export incomplete. No delivery is claimed.');
  } finally {
    await file.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2).filter((value, index) => !(index === 0 && value === '--')),
      options: {
        package: { type: 'string' },
        'data-dir': { type: 'string' },
        output: { type: 'string' },
        port: { type: 'string' },
        request: { type: 'string' },
      },
    });
    if (!values.package || !values['data-dir'] || !values.output) throw new Error();
    console.log(
      JSON.stringify(
        await exportPrepared({
          packageId: values.package,
          ...(values.request ? { requestId: values.request } : {}),
          dataDir: values['data-dir'],
          output: values.output,
          ...(values.port ? { port: Number(values.port) } : {}),
        }),
      ),
    );
  } catch {
    console.error(
      'Use export:prepared --package ctx_ID --data-dir /private/data --output /private/new-packet.txt [--request REQUEST_ID] [--port 47901]. Export failed; no delivery claimed.',
    );
    process.exitCode = 1;
  }
}
