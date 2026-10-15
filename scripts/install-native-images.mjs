// Explicit companion patch installation; never runs during plugin startup.
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = process.argv[2] && resolve(process.argv[2]);
const reverse = process.argv.includes('--reverse');
if (!root || !existsSync(resolve(root, 'server.js'))) {
    console.error('Usage: node scripts/install-native-images.mjs <SillyTavern-folder> [--reverse]');
    process.exit(1);
}
const patch = resolve(dirname(fileURLToPath(import.meta.url)), '../compat/sillytavern-native-images.patch');
const git = args => spawnSync('git', ['-C', root, 'apply', '--whitespace=nowarn', ...args, patch], { encoding: 'utf8', windowsHide: true });
const direction = reverse ? ['--reverse'] : [];
const check = git([...direction, '--check']);
if (check.error) throw check.error;
if (check.status !== 0) {
    const opposite = git([...(reverse ? [] : ['--reverse']), '--check']);
    if (opposite.status === 0) {
        console.log(reverse ? 'Native image patch is already absent.' : 'Native image patch is already installed. Restart and hard-refresh SillyTavern.');
        process.exit(0);
    }
    console.error('Patch does not match this checkout; no files were changed. Review compatibility and local changes before retrying.');
    console.error(check.stderr.trim());
    process.exit(1);
}
const applied = git(direction);
if (applied.status !== 0) {
    console.error(applied.stderr || 'git apply failed');
    process.exit(1);
}
console.log(reverse ? 'Native image patch removed. Restart and hard-refresh SillyTavern.' : 'Native image patch installed. Restart and hard-refresh, then select Codex (ChatGPT subscription) in Image Generation.');
