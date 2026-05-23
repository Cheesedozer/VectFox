import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = resolve(__dirname, '..');
const logPath   = resolve(repoRoot, 'Doc', 'log.txt');

mkdirSync(dirname(logPath), { recursive: true });
const logStream = createWriteStream(logPath, { flags: 'w' });

// Lines matching any of these patterns are kept on the terminal (so live debugging
// still sees everything) but stripped from Doc/log.txt to keep it readable.
// Add more patterns here as new noise sources show up.
const LOG_NOISE_PATTERNS = [
    /getRegexedString: Skipping script /,
    /^Debounced metadata save cancelled$/,
    /^\[WI\] Entry \d+ /,           // [WI] Entry 147 activation successful... / processing / activated by...
    /^WI entry \d+ does not use probability$/,
];

const isNoise = line => LOG_NOISE_PATTERNS.some(re => re.test(line));

const filterChunk = (chunk) => {
    const text = chunk.toString();
    // Split on newline but preserve the trailing newline for each kept line so
    // the log file looks identical to the terminal output (minus noise).
    const lines = text.split('\n');
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isLast = i === lines.length - 1;
        if (isNoise(line)) continue;
        kept.push(isLast ? line : line + '\n');
    }
    return kept.join('');
};

const tee = (chunk, target) => {
    target.write(chunk);
    const filtered = filterChunk(chunk);
    if (filtered) logStream.write(filtered);
};

const args = ['playwright', 'test', ...process.argv.slice(2)];
const child = spawn('npx', args, {
    cwd: repoRoot,
    env: { ...process.env, FORCE_COLOR: '0' },
    shell: true,
});

child.stdout.on('data', c => tee(c, process.stdout));
child.stderr.on('data', c => tee(c, process.stderr));

child.on('close', code => {
    logStream.end(() => process.exit(code ?? 0));
});
