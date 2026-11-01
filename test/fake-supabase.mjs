// A stand-in for the Supabase Management API's SQL endpoint, enough to run ship migrations apply
// without a network. It does not parse SQL: a test lists `facts`, each naming a post-condition by its
// label and by a snippet of its generated SQL (`match`), and what the database answers before and
// after the migration was applied. Every request is recorded.
//
//   facts: [{ label, match, before: false, after: true, afterDry: after }]
//   applyStatus: 400 → the apply is refused (nothing changes), with `applyMessage`
//   applyThrows: n → the first n apply requests get no answer; each took effect anyway if `appliedAnyway`
//   applyThrowsCode: the error code of that failure ('ECONNREFUSED' = it never left the machine)
//   refusalCommits: a refused apply has changed the database all the same (a file that commits part of itself)
//   dryMessage: the dry run fails with that Postgres message (default: the marker with the results)
//   echoTokenInErrors: every error message repeats the bearer token, as a careless API might

export function fakeSupabase({ project = 'abcdefghijklmnopqrst', token = 'sbp_test_token_0123456789', facts = [], applyStatus = null, applyMessage = 'ERROR:  42P07: relation "x" already exists', applyThrows = 0, applyThrowsCode = null, appliedAnyway = false, refusalCommits = false, dryMessage = null, echoTokenInErrors = false, denyToken = false, unreachable = false } = {}) {
  const requests = [];
  let throwsLeft = applyThrows === true ? 1 : applyThrows;
  const state = { applied: false };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const error = (status, message) => json(status, { message: echoTokenInErrors ? `${message} (Bearer ${token})` : message });
  // The API wraps what Postgres says: "Failed to run sql query: ERROR:  <sqlstate>: <message>".
  const sqlError = (status, message) => error(status, `Failed to run sql query: ${message}`);

  const fetch = async (url, init = {}) => {
    const sql = JSON.parse(init.body).query;
    const kind = sql.startsWith('begin read only;') ? 'check' : sql.startsWith('begin;') && sql.includes('DRY_RUN_OK') ? 'dry-run' : 'apply';
    requests.push({ url, kind, sql, headers: init.headers });
    if (unreachable) throw new TypeError('fetch failed');
    if (!String(url).endsWith(`/v1/projects/${project}/database/query`)) return error(404, 'Not Found');
    if (denyToken || init.headers.Authorization !== `Bearer ${token}`) return error(401, 'Unauthorized');
    if (!init.headers['User-Agent']) return error(403, 'error code: 1010');

    if (kind === 'dry-run') {
      if (dryMessage) return sqlError(400, dryMessage);
      const results = facts.filter((f) => sql.includes(`'label', '${f.label}'`)).map((f) => ({ label: f.label, ok: f.afterDry ?? f.after }));
      return sqlError(400, `ERROR:  P0001: DRY_RUN_OK ${JSON.stringify(results)}\nCONTEXT:  PL/pgSQL function inline_code_block line 1 at RAISE`);
    }
    if (kind === 'check') {
      const fact = facts.find((f) => sql.includes(f.match));
      if (!fact) return sqlError(400, `ERROR:  42703: no fact for ${sql}`);
      return sqlError(400, `ERROR:  P0001: CHECK_OK ${JSON.stringify([{ label: fact.label, ok: state.applied ? fact.after : fact.before }])}`);
    }
    if (throwsLeft > 0) {
      throwsLeft--;
      if (appliedAnyway) state.applied = true;
      throw Object.assign(new TypeError('fetch failed'), applyThrowsCode ? { cause: { code: applyThrowsCode } } : {});
    }
    if (applyStatus) {
      if (refusalCommits) state.applied = true;
      return sqlError(applyStatus, applyMessage);
    }
    state.applied = true;
    return json(201, []);
  };

  return { fetch, requests, state, token, project, of: (kind) => requests.filter((r) => r.kind === kind) };
}
