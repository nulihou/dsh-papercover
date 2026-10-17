/**
 * Move a scholar paper library from one directory to another.
 *
 * Strategies (in order):
 * 1. Same path after resolve → noop
 * 2. Dest missing → rename whole tree (falls back to copy+remove on EXDEV)
 * 3. Dest exists → merge-move children; skip name collisions; remove old if emptied
 *
 * Rejects nested old/new paths to avoid deleting the library mid-move.
 */
import { access, copyFile, cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

export interface PaperDirMigrateResult {
  migrated: boolean;
  from: string;
  to: string;
  mode: 'noop' | 'rename' | 'merge';
  moved: number;
  skipped: number;
  removedOld: boolean;
  message: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isEmptyDir(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length === 0;
  } catch {
    return true;
  }
}

function assertNotNested(from: string, to: string): void {
  const relToFrom = relative(from, to);
  const relFromTo = relative(to, from);
  const inside = (rel: string) => rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('..'));
  // relative('', '') is ''; treat identical as already handled by caller
  if (relToFrom !== '' && inside(relToFrom)) {
    throw new Error(`新目录不能位于原论文目录内部：${to}`);
  }
  if (relFromTo !== '' && inside(relFromTo)) {
    throw new Error(`原论文目录不能位于新目录内部：${from}`);
  }
}

async function moveEntry(from: string, to: string): Promise<{ moved: number; skipped: number }> {
  if (!(await exists(to))) {
    await mkdir(dirname(to), { recursive: true });
    try {
      await rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EXDEV' && code !== 'EPERM') throw err;
      const info = await stat(from);
      if (info.isDirectory()) {
        await cp(from, to, { recursive: true, errorOnExist: true, force: false });
        await rm(from, { recursive: true, force: true });
      } else {
        await copyFile(from, to);
        await rm(from, { force: true });
      }
    }
    const info = await stat(to);
    const moved = info.isDirectory() ? await countFiles(to) : 1;
    return { moved, skipped: 0 };
  }

  const fromInfo = await stat(from);
  const toInfo = await stat(to);
  // Dest already has a file/dir with this name.
  if (!fromInfo.isDirectory() || !toInfo.isDirectory()) {
    return { moved: 0, skipped: 1 };
  }

  // Both directories: recurse so nested files (e.g. papers/c.json) still move.
  let moved = 0;
  let skipped = 0;
  for (const name of await readdir(from)) {
    const result = await moveEntry(join(from, name), join(to, name));
    moved += result.moved;
    skipped += result.skipped;
  }
  if (await isEmptyDir(from)) {
    await rm(from, { recursive: true, force: true }).catch(() => {});
  }
  return { moved, skipped };
}

async function countFiles(root: string): Promise<number> {
  let n = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else n += 1;
    }
  };
  await walk(root);
  return n;
}

/**
 * @param fromDir - previous paperDir (absolute or relative)
 * @param toDir - next paperDir
 */
export async function migratePaperDir(fromDir: string, toDir: string): Promise<PaperDirMigrateResult> {
  const from = resolve(fromDir.trim());
  const to = resolve(toDir.trim());

  if (from.toLowerCase() === to.toLowerCase()) {
    return {
      migrated: false,
      from,
      to,
      mode: 'noop',
      moved: 0,
      skipped: 0,
      removedOld: false,
      message: '论文目录未变化',
    };
  }

  assertNotNested(from, to);

  if (!(await exists(from))) {
    await mkdir(to, { recursive: true });
    return {
      migrated: false,
      from,
      to,
      mode: 'noop',
      moved: 0,
      skipped: 0,
      removedOld: false,
      message: '原目录不存在，已切换到新路径（将自动创建）',
    };
  }

  const fromStat = await stat(from);
  if (!fromStat.isDirectory()) {
    throw new Error(`原论文目录不是文件夹：${from}`);
  }

  // Dest missing or empty → prefer whole-tree rename.
  if (!(await exists(to)) || (await isEmptyDir(to))) {
    if (await exists(to)) {
      // empty dest: remove so rename can take its place
      await rm(to, { recursive: true, force: true });
    }
    await mkdir(dirname(to), { recursive: true });
    const fileCount = await countFiles(from);
    try {
      await rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EXDEV' && code !== 'EPERM') throw err;
      await cp(from, to, { recursive: true, errorOnExist: true, force: false });
      await rm(from, { recursive: true, force: true });
    }
    return {
      migrated: true,
      from,
      to,
      mode: 'rename',
      moved: fileCount,
      skipped: 0,
      removedOld: true,
      message: `已将论文库从「${from}」整体搬到「${to}」（${fileCount} 个文件）`,
    };
  }

  // Dest has content → merge-move children.
  let moved = 0;
  let skipped = 0;
  const children = await readdir(from);
  for (const name of children) {
    const result = await moveEntry(join(from, name), join(to, name));
    moved += result.moved;
    skipped += result.skipped;
  }

  const removedOld = await isEmptyDir(from);
  if (removedOld) {
    await rm(from, { recursive: true, force: true }).catch(() => {});
  }

  return {
    migrated: moved > 0,
    from,
    to,
    mode: 'merge',
    moved,
    skipped,
    removedOld,
    message: skipped > 0
      ? `已迁移 ${moved} 个文件到「${to}」；${skipped} 项因目标已存在而跳过${removedOld ? '' : `（原目录仍保留：${from}）`}`
      : `已将论文库内容合并搬到「${to}」（${moved} 个文件）`,
  };
}
