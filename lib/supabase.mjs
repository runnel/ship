// A client for the Supabase Management API's SQL endpoint, the only way to run SQL against a
// hosted project from a machine without a direct database connection. The token never leaves this
// module: it is sent as a bearer header and removed from every message built here.

const API = 'https://api.supabase.com/v1/projects';

// Printable ASCII without spaces: the only characters that can go into a bearer header.
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;
// Supabase project references are 20 lower-case letters today; the shape is kept loose enough for
// other lengths and strict enough that the value is safe in a URL path.
export const PROJECT_REF = /^[a-z0-9]{8,40}$/;

// The request may or may not have reached the database: no answer, a timeout, or a gateway error.
// The caller must find out from the database before it acts again.
export class OutcomeUnknown extends Error {}

export function supabase({ project, token, fetchImpl = globalThis.fetch, timeoutMs = 180_000 }) {
  if (!PROJECT_REF.test(project ?? '')) throw new Error('Supabase project reference is empty or malformed');
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) {
    throw new Error('Supabase access token is empty or has characters that cannot be sent in a header');
  }
  const redact = (text) => String(text).replaceAll(token, '<token>');

  // { status, body } for every answer from the API, whatever the status (4xx is the database or the
  // API refusing the SQL as a whole: nothing was committed). An OutcomeUnknown for a request without
  // an answer and for a 5xx, which a gateway sends while the query may still be running.
  const query = async (sql) => {
    let res;
    try {
      res = await fetchImpl(`${API}/${project}/database/query`, {
        method: 'POST',
        // The API's front door refuses requests without a User-Agent of its own.
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'ship-local-ci/0.1' },
        body: JSON.stringify({ query: sql }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new OutcomeUnknown(redact(`no answer from the Supabase API (${e?.cause?.code ?? e?.name ?? e?.message ?? 'failed'})`));
    }
    // Redacted before it is parsed or cut, so a token cannot survive in a body shape we did not expect.
    const raw = redact(await res.text().catch(() => ''));
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { message: raw.slice(0, 500) };
    }
    // A 5xx that carries Postgres's own error text ("Failed to run sql query: ERROR:  42P01: …") is
    // the database refusing the SQL; any other 5xx is a gateway, which says nothing about whether
    // the query ran.
    const refused = typeof body?.message === 'string' && /(^|: )ERROR:\s/.test(body.message);
    if (res.status >= 500 && !refused) throw new OutcomeUnknown(redact(`the Supabase API answered HTTP ${res.status}`));
    return { status: res.status, body };
  };

  return { query, redact };
}

export const failureText = ({ status, body }) => `HTTP ${status}: ${typeof body?.message === 'string' ? body.message : JSON.stringify(body)}`.slice(0, 600);
