import { type FileHandle, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ContextPackage } from './contracts.ts';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** An explicit local operator read, never an automatic send to an assistant. */
export async function exportContext(options: {
  packageId: string;
  dataDir: string;
  output: string;
  port?: number;
}): Promise<{ packageId: string; path: string; bytes: number }> {
  const port = options.port ?? 47901;
  if (!/^ctx_[a-zA-Z0-9_-]{1,128}$/.test(options.packageId))
    throw new Error('Choose an explicit saved Boopy package ID.');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Choose a valid local connector port.');
  if (!options.dataDir.trim() || !options.output.trim())
    throw new Error('Choose an explicit data directory and new output file.');
  const token = await readConnectorToken(options.dataDir);
  let pkg: ContextPackage;
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/context/${encodeURIComponent(options.packageId)}`,
      {
        headers: { authorization: `Bearer ${token}`, 'x-boopy-agent': 'local-manual-export' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok || !response.body) {
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
        if (bytes > MAX_RESPONSE_BYTES) throw new Error();
        chunks.push(chunk.value);
      }
    } catch {
      await reader.cancel();
      throw new Error();
    } finally {
      reader.releaseLock();
    }
    pkg = ContextPackage.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (pkg.id !== options.packageId) throw new Error();
  } catch {
    throw new Error(
      'Could not verify that saved package from the local connector. No text was exported.',
    );
  }
  const path = resolve(options.output);
  let file: FileHandle;
  try {
    file = await open(path, 'wx', 0o600);
  } catch {
    throw new Error('Choose a new writable output file; existing files are never overwritten.');
  }
  try {
    await file.writeFile(pkg.text, 'utf8');
    await file.sync();
  } catch {
    throw new Error(
      'Could not finish writing the local export. The selected output file may be incomplete.',
    );
  } finally {
    await file.close();
  }
  return { packageId: pkg.id, path, bytes: Buffer.byteLength(pkg.text, 'utf8') };
}

/** Read the already-configured local credential without printing it or creating a new one. */
export async function readConnectorToken(dataDir: string): Promise<string> {
  if (!dataDir.trim()) throw new Error('Choose an explicit data directory.');
  let token: string;
  try {
    const file = await open(join(resolve(dataDir), 'connector-token'), 'r');
    try {
      const bytes = Buffer.alloc(4097);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      token = bytes.subarray(0, bytesRead).toString('utf8').trim();
      if (!token || bytesRead > 4096 || /[\r\n]/.test(token)) throw new Error();
    } finally {
      await file.close();
    }
  } catch {
    throw new Error('Could not read the existing connector token from the selected directory.');
  }
  return token;
}
