// Browser-side stand-in for @supabase/supabase-js so tests never touch the real backend.
// Seed rows via window.__seedTasks before load. Inspect window.__db, set window.__fail to force
// errors, and set window.__assistantReply to control what the assistant function returns.
(() => {
  const user = { id: 'user-1', email: 'tester@example.com' };
  const defaults = {
    description: '',
    status: 'todo',
    priority: 'normal',
    is_subtask: false,
    source_task_title: null,
    subtask_ref: null,
    user_id: user.id,
  };
  let counter = 0;
  const stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, counter++)).toISOString();

  const db = {
    rows: (window.__seedTasks || []).map((row) => ({
      ...defaults,
      id: `seed-${counter}`,
      created_at: stamp(),
      ...row,
    })),
  };
  window.__db = db;
  window.__fail = false;
  window.__assistantReply = null;
  window.__invokeCalls = [];

  const copy = (value) => JSON.parse(JSON.stringify(value));

  function from(table) {
    const query = { op: 'select', payload: null, filters: [], single: false };
    const builder = {
      select() { return builder; },
      order() { return builder; },
      single() { query.single = true; return builder; },
      insert(payload) { query.op = 'insert'; query.payload = payload; return builder; },
      update(payload) { query.op = 'update'; query.payload = payload; return builder; },
      delete() { query.op = 'delete'; return builder; },
      eq(column, value) { query.filters.push((row) => row[column] === value); return builder; },
      in(column, values) { query.filters.push((row) => values.includes(row[column])); return builder; },
      then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
    };

    function execute() {
      if (window.__fail) return { data: null, error: { message: 'Simulated failure' } };
      if (table !== 'tasks') return { data: null, error: { message: `Unknown table ${table}` } };
      const matches = (row) => query.filters.every((filter) => filter(row));
      let result;
      if (query.op === 'select') {
        result = db.rows.filter(matches).sort((a, b) => a.created_at.localeCompare(b.created_at));
      } else if (query.op === 'insert') {
        const payloads = Array.isArray(query.payload) ? query.payload : [query.payload];
        result = payloads.map((payload) => {
          const row = { ...defaults, id: `new-${counter}`, created_at: stamp(), ...payload };
          db.rows.push(row);
          return row;
        });
      } else if (query.op === 'update') {
        result = db.rows.filter(matches);
        result.forEach((row) => Object.assign(row, query.payload));
      } else {
        result = db.rows.filter(matches);
        db.rows = db.rows.filter((row) => !result.includes(row));
      }
      const data = copy(result);
      return { data: query.single ? data[0] ?? null : data, error: null };
    }
    return builder;
  }

  window.supabase = {
    createClient() {
      return {
        auth: {
          onAuthStateChange(callback) {
            setTimeout(() => callback('SIGNED_IN', { user }), 0);
            return { data: { subscription: { unsubscribe() {} } } };
          },
          async signInWithPassword() { return { data: { session: { user } }, error: null }; },
          async signUp() { return { data: { session: { user } }, error: null }; },
          async signOut() { return { error: null }; },
        },
        from,
        functions: {
          async invoke(name, options) {
            window.__invokeCalls.push({ name, body: options?.body });
            return window.__assistantReply || { data: { reply: 'Hello from the fake assistant.' }, error: null };
          },
        },
      };
    },
  };
})();
