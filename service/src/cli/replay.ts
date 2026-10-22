import { pathToFileURL } from 'node:url';
import {
  inspectRecordedMedia,
  isSelectedLocalPath,
  RecordedMediaError,
} from '../recorded-media.ts';

type Summary = {
  videoFrames: number;
  audioTracks: number;
  captureOrigin: { status: 'unknown' | 'conflict' | 'unverified' };
};
export async function runReplayCli(
  args: string[],
  dependencies: {
    inspect?: (path: string) => Promise<Summary>;
    print?: (line: string) => void;
  } = {},
): Promise<number> {
  const print = dependencies.print ?? console.log;
  const [command, flag, input] = args;
  if (
    args.length !== 3 ||
    command !== 'inspect' ||
    flag !== '--input' ||
    !input ||
    !isSelectedLocalPath(input)
  ) {
    print('recorded-media: invalid_arguments');
    return 1;
  }
  try {
    const result = await (dependencies.inspect ?? inspectRecordedMedia)(input);
    print(
      `recorded-media: inspected; video-frames=${result.videoFrames}; audio-tracks=${result.audioTracks}; capture-time=${result.captureOrigin.status}`,
    );
    return 0;
  } catch (error) {
    print(`recorded-media: ${error instanceof RecordedMediaError ? error.code : 'inspect_failed'}`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runReplayCli(process.argv.slice(2));
}
