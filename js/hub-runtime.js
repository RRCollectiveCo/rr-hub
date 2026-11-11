// R&R Hub runtime: gives the Inventory Station, Pack Station and Hub pages the
// same `window.claude.use('db' | 'user' | 'downloads' | 'mcp')` they had on
// claude.ai, backed by Supabase (table public.hub_docs, one row per document).
//
// The pages only use a small slice of that API:
//   createRuntime(supabase, staff, { namespace: 'inventory' | 'pack' | 'hub' })
//   db.doc('col/id')            .get() .set(d) .update(patch) .delete() .onSnapshot(cb, err)
//   db.collection('col')        .add(d) .doc(id) .orderBy(f, dir) .limit(n) .get() .onSnapshot(cb, err)
//   user.canEdit() .isOwner() .id() .me()
//   downloads.save({ filename, data })
//   mcp.listTools(server) .callTool(server, tool, args)   (Shopify, via an edge function)
//
// Collections are small (largest is ~900 packed orders), so each watched
// collection is loaded whole, kept in memory, and sorted/limited here.
// Realtime changes patch that memory copy and re-run every listener.
(function (root) {
  'use strict';

  const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  function newId() {
    let s = '';
    const a = new Uint8Array(20);
    (root.crypto || globalThis.crypto).getRandomValues(a);
    for (const b of a) s += ID_CHARS[b % ID_CHARS.length];
    return s;
  }

  // 'col/id' or a nested one like 'data/users/<email>/<id>': the last part is
  // the record id, everything before it is the collection.
  function splitPath(path) {
    const p = String(path).split('/').filter(Boolean);
    if (p.length < 2 || p.length % 2) throw new Error('Hub record paths look like "collection/id", got: ' + path);
    return [p.slice(0, -1).join('/'), p[p.length - 1]];
  }

  function cmp(a, b) {
    if (a === b) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a) < String(b) ? -1 : 1;
  }

  function docSnap(id, data) {
    const copy = data ? structuredClone(data) : undefined;
    return { id, exists: !!data, data: () => (copy ? structuredClone(copy) : undefined) };
  }

  // ---------------------------------------------------------------- db
  // Each station keeps its own collections, as on claude.ai, where each page had
  // its own database: 'inventory:materials', 'pack:packs', 'hub:today'.
  function createDb(sb, { onError, namespace } = {}) {
    if (!namespace) throw new Error('Hub db needs a namespace (inventory, pack or hub)');
    const ns = c => namespace + ':' + c;
    // cache[col] = { rows: Map(id -> data), ready: Promise, listeners: Set, channel }
    const cache = new Map();

    function report(e) { if (onError) try { onError(e); } catch (_) {} }

    async function fetchAll(col) {
      const rows = new Map();
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await sb.from('hub_docs').select('id,data')
          .eq('collection', ns(col)).range(from, from + PAGE - 1);
        if (error) throw error;
        for (const r of data) rows.set(r.id, r.data);
        if (data.length < PAGE) break;
      }
      return rows;
    }

    function entry(col) {
      let e = cache.get(col);
      if (e) return e;
      e = { rows: new Map(), listeners: new Set(), channel: null, ready: null, loaded: false };
      cache.set(col, e);
      e.ready = fetchAll(col).then(rows => { e.rows = rows; e.loaded = true; emit(col); });
      e.ready.catch(err => { cache.delete(col); report(err); for (const l of e.listeners) l.err && l.err(err); });
      if (sb.channel) {
        e.channel = sb.channel('hub:' + ns(col))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'hub_docs', filter: 'collection=eq.' + ns(col) },
            payload => {
              if (payload.eventType === 'DELETE') e.rows.delete(payload.old && payload.old.id);
              else if (payload.new) e.rows.set(payload.new.id, payload.new.data);
              emit(col);
            })
          .subscribe();
      }
      return e;
    }

    function emit(col) {
      const e = cache.get(col);
      if (!e) return;
      for (const l of e.listeners) {
        try { l.run(); } catch (err) { report(err); }
      }
    }

    // Writes update the local copy right away (pages re-render instantly),
    // then the realtime echo confirms it.
    function localSet(col, id, data) {
      const e = cache.get(col);
      if (!e) return;
      if (data === null) e.rows.delete(id); else e.rows.set(id, data);
      emit(col);
    }

    // Same rules as public.hub_deep_merge: objects merge key by key, anything
    // else is replaced, {__delete__: true} removes the key.
    function applyPatch(base, patch) {
      const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          if (v.__delete__ === true && Object.keys(v).length === 1) delete out[k];
          else out[k] = applyPatch(out[k], v);
        } else out[k] = v;
      }
      return out;
    }

    function docRef(col, id) {
      return {
        id,
        path: col + '/' + id,
        async get() {
          const { data, error } = await sb.from('hub_docs').select('data')
            .eq('collection', ns(col)).eq('id', id).maybeSingle();
          if (error) throw error;
          return docSnap(id, data ? data.data : null);
        },
        async set(data, opts) {
          if (opts && opts.merge) return this.update(data);
          const clean = JSON.parse(JSON.stringify(data));
          const { error } = await sb.from('hub_docs').upsert({ collection: ns(col), id, data: clean });
          if (error) throw error;
          localSet(col, id, clean);
        },
        async update(patch) {
          const clean = JSON.parse(JSON.stringify(patch));
          const e = cache.get(col);
          const { error } = await sb.rpc('hub_patch', { c: ns(col), i: id, patch: clean });
          if (error) throw error;
          if (e) localSet(col, id, applyPatch(e.rows.get(id), clean));
        },
        async delete() {
          const { error } = await sb.from('hub_docs').delete().eq('collection', ns(col)).eq('id', id);
          if (error) throw error;
          localSet(col, id, null);
        },
        onSnapshot(cb, err) {
          const e = entry(col);
          const l = { run: () => cb(docSnap(id, e.rows.get(id))), err };
          e.listeners.add(l);
          // Not loaded yet: the first load runs every listener. Loaded: run once now.
          if (e.loaded) Promise.resolve().then(() => { if (e.listeners.has(l)) l.run(); });
          return () => e.listeners.delete(l);
        },
      };
    }

    function query(col, order, max) {
      function snapshot(rows) {
        let list = [...rows.entries()];
        if (order) {
          const [f, dir] = order;
          list.sort((a, b) => cmp(a[1][f], b[1][f]) * (dir === 'desc' ? -1 : 1));
        }
        if (max != null) list = list.slice(0, max);
        const docs = list.map(([id, d]) => docSnap(id, d));
        return { docs, size: docs.length, empty: !docs.length, forEach: fn => docs.forEach(fn) };
      }
      return {
        orderBy(field, dir = 'asc') { return query(col, [field, dir], max); },
        limit(n) { return query(col, order, n); },
        async get() {
          const e = cache.get(col);
          if (e) { await e.ready; return snapshot(e.rows); }
          return snapshot(await fetchAll(col));
        },
        onSnapshot(cb, err) {
          const e = entry(col);
          const l = { run: () => cb(snapshot(e.rows)), err };
          e.listeners.add(l);
          // Not loaded yet: the first load runs every listener. Loaded: run once now.
          if (e.loaded) Promise.resolve().then(() => { if (e.listeners.has(l)) l.run(); });
          return () => e.listeners.delete(l);
        },
      };
    }

    return {
      doc(path) { const [c, i] = splitPath(path); return docRef(c, i); },
      collection(path) {
        const col = String(path).split('/').filter(Boolean).join('/');
        if (!col || col.split('/').length % 2 === 0) throw new Error('Not a collection path: ' + path);
        const q = query(col, null, null);
        return {
          ...q,
          doc(id) { return docRef(col, id || newId()); },
          async add(data) { const ref = docRef(col, newId()); await ref.set(data); return ref; },
        };
      },
    };
  }

  // ---------------------------------------------------------------- user
  // Roles come from public.hub_staff: owner (Hollie, Nate), manager
  // (Stephanie), staff. canEdit() matches claude.ai's "editor": owners and
  // managers. id() is the person's email.
  // isOwner() is Hollie only, like claude.ai where she owned the pages; Nate
  // was an editor there, so for him (and Stephanie) it's canEdit() only.
  function createUser(staff, ownerName) {
    return {
      async canEdit() { return staff.role === 'owner' || staff.role === 'manager'; },
      async isOwner() { return staff.role === 'owner' && staff.name === ownerName; },
      async role() { return staff.role; },
      async id() { return staff.email; },
      async me() { return { name: staff.name, email: staff.email }; },
    };
  }

  // ---------------------------------------------------------------- downloads
  function createDownloads(doc) {
    return {
      async save({ filename, data }) {
        const blob = data instanceof Blob ? data : new Blob([data]);
        const url = URL.createObjectURL(blob);
        const a = doc.createElement('a');
        a.href = url; a.download = filename || 'download';
        doc.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return { status: 'saved' };
      },
    };
  }

  // ---------------------------------------------------------------- mcp
  // The pages asked claude.ai's Shopify connector for orders/analytics. In the
  // Hub that goes through the `hub-shopify` edge function, which holds the
  // Shopify token as a Supabase secret. Same call shape for the pages.
  function createMcp(sb) {
    const api = {
      async listTools(server) {
        return { servers: server === 'Shopify' ? [{ name: 'Shopify' }] : [] };
      },
      // claude.ai re-ran a watched tool on a schedule ({ refetchInterval: ms });
      // same here, default hourly, never more than once a minute.
      watchTool(server, tool, args, onEvent, opts = {}) {
        let stopped = false;
        const every = Math.max(60000, +(opts.refetchInterval || 0) || 3600000); // ms, like claude.ai
        const run = async () => {
          try {
            const result = await api.callTool(server, tool, args);
            if (!stopped) onEvent({ type: 'data', result: { ...result, cache: { storedAt: Date.now() } } });
          } catch (error) { if (!stopped) onEvent({ type: 'error', error }); }
        };
        run();
        const t = setInterval(run, every);
        return () => { stopped = true; clearInterval(t); };
      },
      async callTool(server, tool, args) {
        if (server !== 'Shopify') throw new Error('Unknown server ' + server);
        const { data, error } = await sb.functions.invoke('hub-shopify', { body: { tool, args } });
        if (error) throw error;
        return data;
      },
    };
    return api;
  }

  function createRuntime(sb, staff, opts = {}) {
    const doc = opts.document || root.document;
    const services = {
      db: createDb(sb, opts),
      user: createUser(staff, opts.ownerName || 'Hollie'),
      downloads: doc ? createDownloads(doc) : null,
      mcp: createMcp(sb),
    };
    return {
      async use(name) {
        if (!(name in services) || !services[name]) throw new Error('Not available in the Hub: ' + name);
        return services[name];
      },
    };
  }

  const api = { createRuntime, createDb, newId };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RRHubRuntime = api;
})(typeof window !== 'undefined' ? window : globalThis);
