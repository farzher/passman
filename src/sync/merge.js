import { uuid } from "../shared/util";
function fingerprint(item) {
  return JSON.stringify([item.name, item.urls, item.username, item.password, item.updatedAt]);
}
function snapshot(payload) {
  const result = {};
  for (const item of payload.items) result[item.id] = fingerprint(item);
  for (const [id, time] of Object.entries(payload.deleted)) result[id] = `deleted:${time}`;
  return result;
}
function mergeVaults(local, remote) {
  const base = local.syncBase || remote.syncBase || {};
  const l = new Map(local.items.map((i) => [i.id, i]));
  const r = new Map(remote.items.map((i) => [i.id, i]));
  const deleted = { ...remote.deleted, ...local.deleted };
  const items = [];
  const ids = /* @__PURE__ */ new Set([...l.keys(), ...r.keys(), ...Object.keys(local.deleted), ...Object.keys(remote.deleted)]);
  for (const id of ids) {
    const li = l.get(id), ri = r.get(id);
    const lf = li ? fingerprint(li) : local.deleted[id] ? `deleted:${local.deleted[id]}` : "missing";
    const rf = ri ? fingerprint(ri) : remote.deleted[id] ? `deleted:${remote.deleted[id]}` : "missing";
    if (lf === rf) {
      if (li) { items.push(li); delete deleted[id]; }
      continue;
    }
    const lc = lf !== (base[id] || "missing"), rc = rf !== (base[id] || "missing");
    if (lc && rc && li && ri) {
      items.push(li, { ...ri, id: uuid(), name: `${ri.name} (sync conflict)` });
    } else {
      const chosen = lc ? li : ri;
      if (chosen) { items.push(chosen); delete deleted[id]; }
    }
  }
  const merged = { revision: Math.max(local.revision, remote.revision) + 1, items, deleted };
  merged.syncBase = snapshot(merged);
  return merged;
}
export {
  mergeVaults,
  snapshot
};
