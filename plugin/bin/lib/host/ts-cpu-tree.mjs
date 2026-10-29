// Select the whole owned tree, independent of executable name or process group.
export function selectTsCpuTree(rows, pid) {
  const parent = rows.find((row) => row.pid === pid)
  if (!parent) throw new Error('backend not found')
  const owned = new Set([pid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (owned.has(row.pid) || !owned.has(row.ppid) && row.pgid !== pid) continue
      owned.add(row.pid)
      changed = true
    }
  }
  return { status: 'measured', parent, processes: rows.filter((row) => row.pid !== pid && owned.has(row.pid)) }
}

export function linuxTsCpuTree(pid, { read, list, process }) {
  const rows = []
  for (const name of list('/proc')) {
    if (!/^[1-9]\d*$/.test(name)) continue
    try { rows.push(process(Number(name), read, 1)) }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error
    }
  }
  return selectTsCpuTree(rows, pid)
}
