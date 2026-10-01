import { exportTranscript, replayTranscript, statsTranscript, traceTranscript, usageCsv, validateTranscript } from '../src/runtime/transcript-offline';

const [command, directory, extra, mode] = process.argv.slice(2);
try {
    if (!directory) throw new Error('Usage: transcript.ts validate|stats|trace|replay|export <sessionDirectory> [requestId|destination|csv] [full|share]');
    let result: unknown;
    switch (command) {
        case 'validate': result = validateTranscript(directory); break;
        case 'stats': {
            const stats = statsTranscript(directory);
            if (extra === 'csv') { process.stdout.write(usageCsv(stats)); process.exit(0); }
            result = stats; break;
        }
        case 'trace': if (!extra) throw new Error('trace requires requestId'); result = traceTranscript(directory, extra); break;
        case 'replay': result = replayTranscript(directory); break;
        case 'export': if (!extra || (mode && mode !== 'full' && mode !== 'share')) throw new Error('export requires destination and optional full|share'); result = exportTranscript(directory, extra, mode as 'full' | 'share' | undefined); break;
        default: throw new Error('Unknown offline transcript command');
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
}
