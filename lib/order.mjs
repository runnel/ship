// Deploy order from `after`: a deployable comes after everything it names; otherwise config order
// is kept, so the output is stable.
export function deployOrder(deployables) {
  const byName = new Map(deployables.map((d) => [d.name, d]));
  for (const d of deployables) {
    for (const a of d.after ?? []) if (!byName.has(a)) throw new Error(`after: unknown deployable ${a}`);
  }
  const done = new Set();
  const out = [];
  const visit = (d, path) => {
    if (done.has(d.name)) return;
    if (path.includes(d.name)) throw new Error(`after cycle: ${[...path.slice(path.indexOf(d.name)), d.name].join(' → ')}`);
    for (const a of d.after ?? []) visit(byName.get(a), [...path, d.name]);
    done.add(d.name);
    out.push(d);
  };
  for (const d of deployables) visit(d, []);
  return out;
}

export function dependentsOf(deployables, name) {
  const out = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of deployables) {
      if (out.has(d.name)) continue;
      if ((d.after ?? []).some((a) => a === name || out.has(a))) {
        out.add(d.name);
        grew = true;
      }
    }
  }
  return out;
}
