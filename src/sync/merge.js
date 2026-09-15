import { uuid } from '../shared/util.js';

function fingerprint(item) {
  return JSON.stringify([item.name, item.urls, item.username, item.password, item.updatedAt]);
}

function withLatestUse(item, other) {
  if (!item) return item;
  const a = Number.isFinite(item.lastUsedAt) ? item.lastUsedAt : null;
  const b = Number.isFinite(other?.lastUsedAt) ? other.lastUsedAt : null;
  return { ...item, lastUsedAt: a === null ? b : b === null ? a : Math.max(a, b) };
}

function snapshot(payload) {
  const result = {};
  for (const item of payload.items) result[item.id] = fingerprint(item);
  for (const [id, time] of Object.entries(payload.deleted)) result[id] = `deleted:${time}`;
  return result;
}

function mergeVaults(local, remote) {
  const base = local.syncBase || remote.syncBase || {};
  const l = new Map(local.items.map(item => [item.id, item]));
  const r = new Map(remote.items.map(item => [item.id, item]));
  const deleted = { ...remote.deleted, ...local.deleted };
  const items = [];
  const ids = new Set([...l.keys(), ...r.keys(), ...Object.keys(local.deleted), ...Object.keys(remote.deleted)]);

  for (const id of ids) {
    const li = l.get(id), ri = r.get(id);
    const lf = li ? fingerprint(li) : local.deleted[id] ? `deleted:${local.deleted[id]}` : 'missing';
    const rf = ri ? fingerprint(ri) : remote.deleted[id] ? `deleted:${remote.deleted[id]}` : 'missing';

    if (lf === rf) {
      if (li) {
        items.push(withLatestUse(li, ri));
        delete deleted[id];
      }
      continue;
    }

    const lc = lf !== (base[id] || 'missing');
    const rc = rf !== (base[id] || 'missing');
    if (lc && rc && li && ri) {
      items.push(
        withLatestUse(li, ri),
        { ...withLatestUse(ri, li), id: uuid(), name: `${ri.name} (sync conflict)` }
      );
    } else {
      const chosen = lc ? li : ri;
      const other = lc ? ri : li;
      if (chosen) {
        items.push(withLatestUse(chosen, other));
        delete deleted[id];
      }
    }
  }

  const merged = { revision: Math.max(local.revision, remote.revision) + 1, items, deleted };
  merged.syncBase = snapshot(merged);
  return merged;
}

export { mergeVaults, snapshot };
