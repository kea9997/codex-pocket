import * as fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

// Only this user's installed Desktop cache. Never PATH, environment overrides, npm or another CLI.
export const CODEX_BIN_ROOT = path.join(homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
const failure = code => Object.assign(new Error(code), { code });
const same = (a, b, paths) => paths.sep === '\\' ? a.toLowerCase() === b.toLowerCase() : a === b;
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join('/');

// Root/io injection is internal to tests, not HTTP, configuration or environment input.
export function resolveCodexExecutable({ root = CODEX_BIN_ROOT, io = fs, paths = path } = {}) {
  const invalid = () => { throw failure('CODEX_INSTALL_UNAVAILABLE'); };
  try {
    if (typeof root !== 'string' || !paths.isAbsolute(root) || /[\x00-\x1f%]|(?:^|[\\/])\.\.(?:[\\/]|$)|^(?:\\\\|\/\/)/.test(root) || !same(paths.normalize(root), root, paths)) invalid();
    const inspect = (target, file = false) => {
      let current = paths.parse(target).root;
      for (const part of paths.relative(current, target).split(paths.sep)) {
        if (!part || /[<>:"|?*]/.test(part) || /[. ]$/.test(part)) invalid();
        current = paths.join(current, part);
        const stat = io.lstatSync(current), leaf = same(current, target, paths);
        if (stat.isSymbolicLink() || !same(io.realpathSync(current), current, paths) ||
            (leaf && file ? !stat.isFile() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size) || stat.size <= 0 : !stat.isDirectory())) invalid();
        if (leaf) return stat;
      }
      invalid();
    };
    inspect(root);
    const entries = io.readdirSync(root, { withFileTypes: true });
    if (entries.length > 64) invalid();
    const candidates = [];
    for (const entry of entries) {
      if (!/^[a-f0-9]{16}$/.test(entry.name)) continue;
      const directory = paths.join(root, entry.name); inspect(directory);
      const executable = paths.join(directory, 'codex.exe');
      let before;
      try { before = inspect(executable, true); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      let fd;
      try {
        fd = io.openSync(executable, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        if (identity(io.fstatSync(fd)) !== identity(before) || identity(inspect(executable, true)) !== identity(before)) invalid();
      } finally { if (fd !== undefined) io.closeSync(fd); }
      candidates.push({ executable, stat: before });
    }
    if (candidates.length > 1) throw failure('CODEX_INSTALL_AMBIGUOUS');
    if (candidates.length !== 1) invalid();
    const candidate = candidates[0];
    if (identity(inspect(candidate.executable, true)) !== identity(candidate.stat)) invalid();
    return candidate.executable;
  } catch (error) {
    throw failure(error.code === 'CODEX_INSTALL_AMBIGUOUS' ? error.code : 'CODEX_INSTALL_UNAVAILABLE');
  }
}
