/**
 * Violations Desk — OSHA proxy (Cloudflare Worker)
 *
 * Keeps the DOL API key server-side and returns records already shaped for the
 * Violations Desk UI.
 *
 *   GET /search?name=ACME&state=CA&since=2021-01-01   -> [{ activityNr, openDate, state, establishment }]
 *   GET /inspection?activity=1844208015               -> one mapped record
 *   GET /inspection?name=ACME&state=CA&since=...      -> mapped records for every match (max `limit`, default 10)
 *   GET /health                                       -> { ok: true }
 *
 * Add `&raw=1` to any inspection call to get the unmapped DOL rows instead.
 *
 * Setup:
 *   npx wrangler secret put DOL_API_KEY
 *   npx wrangler deploy
 */

const BASE = 'https://apiprod.dol.gov/v4/get/OSHA';

// ---------- code tables (DOL publishes codes, not labels) ----------
const INSP_TYPE = {
  A: 'Accident', B: 'Complaint', C: 'Referral', D: 'Monitoring', E: 'Variance',
  F: 'Follow-up', G: 'Unprogrammed related', H: 'Planned', I: 'Programmed related',
  J: 'Unprogrammed other', K: 'Programmed other', L: 'Other'
};
const INSP_SCOPE = { A: 'Complete', B: 'Partial', C: 'Records only', D: 'No inspection' };
const SAFETY_HLTH = { S: 'Safety', H: 'Health' };
const VIOL_TYPE = { S: 'Serious', W: 'Willful', R: 'Repeat', O: 'Other', U: 'Unclassified' };
const DEGREE_OF_INJ = { 1: 'Fatality', 2: 'Hospitalized injury', 3: 'Non-hospitalized injury' };
const HIST_EVENT = {
  Z: 'Issued', P: 'Petition to modify abatement', I: 'Informal settlement', A: 'Amendment',
  W: 'Employer withdrew', D: 'Government dismissed', L: 'State settlement', Y: 'State decision',
  F: 'Formal settlement', J: 'ALJ decision', R: 'Review Commission',
  1: 'State lower court', 2: 'Appeals court', 3: 'Supreme Court'
};

// ---------- DOL API ----------
async function dol(env, table, filterObject, { limit = 200, offset = 0 } = {}) {
  const url = new URL(`${BASE}/${table}/json`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  if (filterObject) url.searchParams.set('filter_object', JSON.stringify(filterObject));

  const res = await fetch(url, {
    headers: { 'X-API-KEY': env.DOL_API_KEY, 'User-Agent': 'violations-desk/1.0' },
    cf: { cacheTtl: 900, cacheEverything: true }   // DOL data changes daily at most
  });
  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(new Error(`DOL ${table} returned ${res.status}`), {
      status: res.status === 401 ? 500 : 502,   // a bad key is our problem, not the caller's
      detail: body.slice(0, 300)
    });
  }
  const body = await res.json();
  return body.data ?? body;
}

const eq = (field, value) => ({ and: [{ field, operator: 'eq', value }] });

async function searchInspections(env, { name, state, since, limit = 25 }) {
  const conds = [];
  if (name) {
    // DOL's `like` needs explicit wildcards; add them when the caller hasn't.
    const n = name.trim().toUpperCase();
    conds.push({ field: 'estab_name', operator: 'like', value: n.includes('%') ? n : `%${n}%` });
  }
  if (state) conds.push({ field: 'site_state', operator: 'eq', value: state.toUpperCase() });
  if (since) conds.push({ field: 'open_date', operator: 'gt', value: since });
  if (!conds.length) throw Object.assign(new Error('name, state or since is required'), { status: 400 });
  return dol(env, 'inspection', { and: conds }, { limit: Math.min(limit, 200) });
}

async function loadInspection(env, activityNr) {
  const [insp] = await dol(env, 'inspection', eq('activity_nr', activityNr), { limit: 1 });
  if (!insp) return null;

  const [violations, events, injuries] = await Promise.all([
    dol(env, 'violation', eq('activity_nr', activityNr)),
    dol(env, 'violation_event', eq('activity_nr', activityNr)).catch(() => []),
    dol(env, 'accident_injury', eq('rel_insp_nr', activityNr)).catch(() => [])
  ]);

  let accident = null;
  const summaryNr = injuries[0]?.summary_nr;
  if (summaryNr) {
    [accident] = await dol(env, 'accident', eq('summary_nr', summaryNr), { limit: 1 }).catch(() => []);
  }
  return { insp, violations, events, injuries, accident };
}

// ---------- mapping to the UI's shape ----------
function latestEventFor(citationId, events) {
  const mine = events
    .filter(e => e.citation_id === citationId && e.pen_fta === 'P')
    .sort((a, b) => String(a.hist_date).localeCompare(String(b.hist_date)));
  const last = mine[mine.length - 1];
  return last ? (HIST_EVENT[last.hist_event] || last.hist_event) : '';
}

export function mapRecord({ insp, violations, events, injuries, accident }) {
  const live = (violations || []).filter(v => v.delete_flag !== 'D');
  const count = t => live.filter(v => v.viol_type === t).length;
  const sum = f => live.reduce((n, v) => n + (parseFloat(v[f]) || 0), 0);

  const fatal = accident?.fatality === 'X' || (injuries || []).some(i => Number(i.degree_of_inj) === 1);
  const fatCat = fatal ? 'FAT' : (insp.insp_type === 'A' ? 'CAT' : null);

  return {
    activityNr: String(insp.activity_nr),
    dateOpened: insp.open_date,
    caseStatus: insp.close_case_date ? 'CLOSED' : 'OPEN',
    state: insp.site_state,
    establishment: insp.estab_name,
    fatCat,

    siteAddress: [insp.site_address, [insp.site_city, insp.site_state].filter(Boolean).join(', ') +
      (insp.site_zip ? ' ' + insp.site_zip : '')].filter(s => s && s.trim()).join('\n'),
    mailingAddress: [insp.mail_street, [insp.mail_city, insp.mail_state].filter(Boolean).join(', ') +
      (insp.mail_zip ? ' ' + insp.mail_zip : '')].filter(s => s && s.trim()).join('\n'),
    naics: insp.naics_code,
    inspectionType: INSP_TYPE[insp.insp_type] || insp.insp_type || '',
    scope: INSP_SCOPE[insp.insp_scope] || insp.insp_scope || '',
    safetyHealth: SAFETY_HLTH[insp.safety_hlth] || insp.safety_hlth || '',
    advancedNotice: insp.adv_notice || '',

    counts: {
      serious: count('S'), willful: count('W'), repeat: count('R'),
      other: count('O'), unclass: count('U')
    },
    penalties: { current: sum('current_penalty'), initial: sum('initial_penalty') },

    violationItems: live.map(v => ({
      citationId: v.citation_id,
      initialCitationType: VIOL_TYPE[v.initial_viol_type] || v.initial_viol_type || '',
      citationType: VIOL_TYPE[v.viol_type] || v.viol_type || '',
      standardCited: v.standard,
      issuanceDate: v.issuance_date,
      abatementDueDate: v.abate_date,
      currentPenalty: v.current_penalty,
      initialPenalty: v.initial_penalty,
      ftaPenalty: v.fta_penalty,
      contest: v.contest_date,
      latestEvent: latestEventFor(v.citation_id, events || []),
      note: '',
      standardDetails: ''   // fill from your standards data source
    })),

    investigation: (accident || (injuries || []).length) ? {
      investigationNr: accident?.summary_nr ?? injuries[0]?.summary_nr ?? '',
      event: accident?.event_date ?? '',
      narrative: accident?.abstract_text ?? '',
      keywords: accident?.event_keyword ?? '',
      injured: (injuries || []).map(i => ({
        inspection: String(i.rel_insp_nr ?? ''),
        age: i.age, sex: i.sex,
        degreeOfInjury: DEGREE_OF_INJ[Number(i.degree_of_inj)] || i.degree_of_inj || '',
        natureOfInjury: i.nature_of_inj,   // numeric code (OSHA table IN)
        occupation: i.occ_code             // numeric code (OSHA table OCC)
      }))
    } : null
  };
}

// ---------- HTTP ----------
function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  const allow = allowed.length === 0 ? '*' : (allowed.includes(origin) ? origin : '');
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' };
  if (allow) {
    h['Access-Control-Allow-Origin'] = allow;
    h['Vary'] = 'Origin';
  }
  return h;
}

const json = (data, request, env, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: corsHeaders(request, env) });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { ...corsHeaders(request, env), 'Access-Control-Allow-Methods': 'GET, OPTIONS' }
      });
    }
    if (request.method !== 'GET') return json({ error: 'GET only' }, request, env, 405);
    if (url.pathname === '/health') return json({ ok: true }, request, env);
    if (!env.DOL_API_KEY) return json({ error: 'DOL_API_KEY is not set on this Worker' }, request, env, 500);

    const q = url.searchParams;
    try {
      if (url.pathname === '/search') {
        const rows = await searchInspections(env, {
          name: q.get('name'), state: q.get('state'), since: q.get('since'),
          limit: Number(q.get('limit')) || 25
        });
        return json(rows.map(r => ({
          activityNr: String(r.activity_nr),
          openDate: r.open_date,
          state: r.site_state,
          establishment: r.estab_name
        })), request, env);
      }

      if (url.pathname === '/inspection') {
        const raw = q.get('raw') === '1';

        if (q.get('activity')) {
          const data = await loadInspection(env, q.get('activity'));
          if (!data) return json({ error: 'No inspection found' }, request, env, 404);
          return json(raw ? data : mapRecord(data), request, env);
        }

        // by name: look up matches, then load each one
        const limit = Math.min(Number(q.get('limit')) || 10, 25);
        const matches = await searchInspections(env, {
          name: q.get('name'), state: q.get('state'), since: q.get('since'), limit
        });
        const loaded = await Promise.all(
          matches.slice(0, limit).map(m => loadInspection(env, String(m.activity_nr)))
        );
        const found = loaded.filter(Boolean);
        return json(raw ? found : found.map(mapRecord), request, env);
      }

      return json({ error: 'Not found. Try /search, /inspection or /health' }, request, env, 404);
    } catch (err) {
      return json(
        { error: err.message, detail: err.detail },
        request, env, err.status || 500
      );
    }
  }
};
