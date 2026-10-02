import { readFile, stat } from 'node:fs/promises';
import { worktreePlan } from '../paths.js';

export async function linkedWorktree(start) {
  const plan = worktreePlan(start);
  let step = plan.next();
  while (!step.done) {
    const { op, path } = step.value;
    let response;
    try {
      if (op === 'stat') {
        const info = await stat(path);
        response = { value: { kind: info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other' } };
      } else if (op === 'read') response = { value: await readFile(path, 'utf8') };
      else throw new Error(`unknown plan request: ${op}`);
    } catch (error) { response = { error }; }
    step = plan.next(response);
  }
  return step.value ?? {};
}
