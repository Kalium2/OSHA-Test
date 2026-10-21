/**
 * Violations Desk — OSHA proxy (Cloudflare Worker)
 *
 * Keeps the DOL API key server-side and returns records already shaped for the
 * Violations Desk UI.
 *
 *   GET /search?name=ACME&state=CA&since=2021-01-01   -> [{ activityNr, openDate, state, establishment }]
 *   GET /inspection?activity=1844208015               -> one mapped record
 *   GET /inspection?name=ACME&state=CA&since=...      -> mapped records for every match (max `limit`, default 10)
 *   GET /standard?code=3314(C)(1)&state=CA            -> the regulation's own text, with its working
 *   GET /health                                       -> { ok: true }
 *
 * Add `&raw=1` to any inspection call to get the unmapped DOL rows instead.
 *
 * Setup:
 *   npx wrangler secret put DOL_API_KEY
 *   npx wrangler deploy
 */

const BASE = 'https://apiprod.dol.gov/v4/get/OSHA';

/**
 * OSHA code dictionary, generated from the DOL data dictionary (OSHA_Meta_Data).
 * Every entry is a published value list. Codes not listed here come from DOL's
 * own lookup datasets at runtime; see loadLookups().
 */

const INSP_TYPE = {
  A: "Accident",
  B: "Complaint",
  C: "Referral",
  D: "Monitoring",
  E: "Variance",
  F: "FollowUp",
  G: "Unprog Rel",
  H: "Planned",
  I: "Prog Related",
  J: "Unprog Other",
  K: "Prog Other",
  L: "Other-L",
  M: "Fat/Cat",
};

const INSP_SCOPE = {
  A: "Complete",
  B: "Partial",
  C: "Records",
  D: "NoInspection",
};

const SAFETY_HLTH = {
  H: "health",
  S: "safety",
};

const OWNER_TYPE = {
  A: "Private",
  B: "LocalGovt",
  C: "StateGovt",
  D: "Federal",
};

const WHY_NO_INSP = {
  A: "No Insp/Not Found",
  B: "No Insp/Out of Business",
  C: "No Insp/Process Inactive",
  D: "No Insp/10 or Fewer Empe",
  E: "No Insp/Denied Entry",
  F: "No Insp/SIC not on PG",
  G: "No Insp/Exempt Voluntary",
  H: "No Insp/NonExempt Consult",
  I: "No Insp/Other",
  J: "No Insp/Employer Exempted By Appropriation Act",
};

const UNION_STATUS = {
  Y: "Yes",
  U: "Yes",
  A: "Yes",
  N: "No",
  B: "No",
};

const ADV_NOTICE = {
  Y: "Yes",
  N: "No",
};

const VIOL_TYPE = {
  S: "Serious",
  W: "Willful",
  R: "Repeat",
  O: "Other",
  U: "Unclassified",
};

const ABATE_COMPLETE = {
  Q: "Quick Fix",
  '1': "Quick Fix",
  X: "Abatement Completed",
  '2': "Abatement Completed",
  I: "Corrected During Inspection",
  '3': "Corrected During Inspection",
  E: "Not Completed - Employer out of business",
  '4': "Not Completed - Employer out of business",
  W: "Not Completed - Worksite changed",
  '5': "Not Completed - Worksite changed",
  S: "Not Completed - Solicitor advised",
  '6': "Not Completed - Solicitor advised",
  A: "Not completed - AD discretion",
  '7': "Not completed - AD discretion",
};

const REC = {
  A: "Accident",
  C: "Complaint",
  I: "Imminent Danger",
  R: "Referral",
  V: "Variance",
};

const HIST_EVENT = {
  Z: "Issued",
  P: "Petition to Mod Abatement",
  I: "Informal Settlement",
  A: "Amendment",
  W: "Empr Withdrew",
  D: "Govt Dismissed",
  L: "State Settlement",
  Y: "State Decision",
  F: "Formal Settlement",
  J: "ALJ Decision",
  R: "Review Commission",
  '1': "State Lower Court",
  '2': "Appeals Court",
  '3': "Supreme Court",
  C: "Contested",
  B: "Modified - Abatement Credit",
  O: "Administrative Law Judge Order",
  Q: "National Office Adjustment",
};

const PEN_FTA = {
  P: "Penalty",
  F: "FTA",
};

const SEX = {
  M: "Male",
  F: "Female",
};

const DEGREE_OF_INJ = {
  '1': "Fatality",
  '2': "Hospitalized injuries",
  '3': "No Hospitalized injuries",
};

const TASK_ASSIGNED = {
  '1': "Task regularly assigned",
  '2': "Task not regularly assigned",
};

const HUM_FACTOR = {
  '1': "Misjudgment, haz. situation",
  '2': "No personal protective eq used",
  '3': "No appropr protective clothing",
  '4': "Malfunc in securing/warning op",
  '5': "Distracting actions by others",
  '6': "Equip. inappropr for operation",
  '7': "Malfunc, neuromuscular system",
  '8': "Perception malfunc,task-envir.",
  '9': "Safety devices removed/inoper.",
  '10': "Position inapropriate for task",
  '11': "Mater-handlg proced. inappropr",
  '12': "Defective equipment in use",
  '13': "Lockout/tagout proced malfunc",
  '14': "Other",
  '15': "Insuff/lack/housekeeping program",
  '16': "Insuff/lack/expos/biologcl mntrg.",
  '17': "Insuff/lack/engineerng controls",
  '18': "Insuff/lack/writn wrk prac prog.",
  '19': "Insuff/lack/respiratory proctect",
  '20': "Insuf/lack/protcv wrk clthg/equip",
};

const EVN_FACTOR = {
  '1': "Pinch point action",
  '2': "Catch point/puncture action",
  '3': "Shear point action",
  '4': "Squeeze point action",
  '5': "Flying object action",
  '6': "Overhead moving/falling obj ac",
  '7': "Gas/vapor/mist/fume/smoke/dust",
  '8': "Materials handlg equip./method",
  '9': "Chemical action/reaction expos",
  '10': "Flammable liq/solid exposure",
  '11': "Temperature +/- tolerance lev.",
  '12': "Radiation condition",
  '13': "Work-surface/facil-layout cond",
  '14': "Illumination",
  '15': "Overpressure/underpressure",
  '16': "Sound level",
  '17': "Weather, earthquake, etc.",
  '18': "Other",
};

// ---------- DOL API ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * NAICS industry titles. OSHA publishes the code only, so "238320" arrives with
 * nothing to say it means Painting and Wall Covering Contractors.
 *
 * The 2022 Census NAICS structure is fetched once and cached for a week. Set
 * NAICS_URL to serve the file from somewhere you control; it needs to be a CSV
 * whose rows contain a code and a title, in that order.
 */
const NAICS_DEFAULT_URL = 'https://raw.githubusercontent.com/TAS-Technologies-Group/NAICS/main/naics_2022_code_file.csv';
let naicsTitles = null;   // code -> title, for every level from 2 to 6 digits

async function loadNaics(env) {
  if (naicsTitles) return naicsTitles;
  const map = new Map();
  try {
    const res = await fetch(env.NAICS_URL || NAICS_DEFAULT_URL, {
      cf: { cacheTtl: 604800, cacheEverything: true }
    });
    if (res.ok) {
      const text = await res.text();
      const lines = text.split(/\r?\n/).filter(l => l.trim());

      // The file may lead with a sequence column, so find the code and title by
      // name where there is a header, and by shape where there is not.
      const header = splitCsv(lines[0]).map(h => h.trim().toLowerCase());
      let codeAt = header.indexOf('code');
      let titleAt = header.findIndex(h => h === 'title' || h === 'name' || h === 'description');
      const hasHeader = codeAt !== -1 && titleAt !== -1;

      lines.slice(hasHeader ? 1 : 0).forEach(line => {
        const fields = splitCsv(line);
        let code, title;
        if (hasHeader) {
          code = (fields[codeAt] || '').trim();
          title = (fields[titleAt] || '').trim();
        } else {
          // the code is a run of 2 to 6 digits whose next field is not numeric
          const at = fields.findIndex((f, i) =>
            /^\d{2,6}$/.test(f.trim()) && fields[i + 1] && !/^\d+$/.test(fields[i + 1].trim()));
          if (at === -1) return;
          code = fields[at].trim();
          title = (fields[at + 1] || '').trim();
        }
        if (/^\d{2,6}$/.test(code) && title && !/^\d+$/.test(title)) map.set(code, title);
      });
    }
  } catch (err) {
    /* the code still displays on its own */
  }
  naicsTitles = map;
  return naicsTitles;
}

// Minimal CSV field splitter: handles quoted fields containing commas.
function splitCsv(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

// Exact match where the Census lists it, otherwise the nearest parent level,
// so a code that has been retired still reads as something.
function naicsLabel(code, titles) {
  const digits = String(code ?? '').trim();
  if (!digits || !titles || !titles.size) return digits;
  if (/^0+$/.test(digits)) return digits;   // OSHA uses 000000 for "not recorded"
  for (let len = digits.length; len >= 2; len -= 1) {
    const title = titles.get(digits.slice(0, len));
    if (title) return len === digits.length ? `${digits} — ${title}` : `${digits} — ${title} (group)`;
  }
  return digits;
}

/**
 * DOL returns an intermittent 502 under load: the same query can fail and then
 * succeed seconds later. Retry a few times before giving up, so a transient
 * fault at their end does not surface as a failed search.
 */
async function dol(env, table, filterObject, { limit = 200, offset = 0, cacheTtl = 900 } = {}) {
  const url = new URL(`${BASE}/${table}/json`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  if (filterObject) url.searchParams.set('filter_object', JSON.stringify(filterObject));
  // DOL's /v4/get endpoints take the key as a query parameter, not a header.
  url.searchParams.set('X-API-KEY', env.DOL_API_KEY);

  const RETRY_STATUS = [429, 500, 502, 503, 504];
  const DELAYS = [250, 750, 1500];
  let last = null;

  for (let attempt = 0; attempt <= DELAYS.length; attempt += 1) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': 'violations-desk/1.0' },
        cf: { cacheTtl, cacheEverything: true }   // DOL data changes daily at most
      });
    } catch (err) {
      last = { status: 0, body: String(err).slice(0, 200) };
      if (attempt < DELAYS.length) { await sleep(DELAYS[attempt]); continue; }
      break;
    }

    if (res.ok) {
      const body = await res.json();
      return body.data ?? body;
    }

    last = { status: res.status, body: (await res.text()).slice(0, 300) };
    if (RETRY_STATUS.includes(res.status) && attempt < DELAYS.length) {
      await sleep(DELAYS[attempt]);
      continue;
    }
    break;
  }

  throw Object.assign(new Error(`DOL ${table} returned ${last.status}`), {
    status: last.status === 401 ? 500 : 502,   // a bad key is our problem, not the caller's
    detail: last.body,
    retried: true
  });
}

const eq = (field, value) => ({ and: [{ field, operator: 'eq', value }] });

// "1984-08-09T00:00:00" -> "08/09/1984"; anything unparseable passes through.
function usDate(v) {
  if (!v) return '';
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(v);
}

// Jan 1 of (this year - 4): the current calendar year and the four before it.
function defaultSince() {
  return `${new Date().getFullYear() - 4}-01-01`;
}

async function searchInspections(env, { name, state, since, limit = 25 }) {
  const conds = [];
  if (name) {
    // DOL's `like` needs explicit wildcards; add them when the caller hasn't.
    const n = name.trim().toUpperCase();
    conds.push({ field: 'estab_name', operator: 'like', value: n.includes('%') ? n : `%${n}%` });
  }
  if (state) conds.push({ field: 'site_state', operator: 'eq', value: state.toUpperCase() });
  conds.push({ field: 'open_date', operator: 'gt', value: since || defaultSince() });
  if (conds.length < 2) throw Object.assign(new Error('name or state is required'), { status: 400 });
  return dol(env, 'inspection', { and: conds }, { limit: Math.min(limit, 200) });
}

/**
 * DOL serves every IMIS accident code list through one table,
 * `accident_lookup2`: each row carries `accident_code` (which list it belongs
 * to), `accident_number` (the code) and `accident_value` (its text).
 *
 * `OCC` is confirmed as Occupation. The remaining group names come from the
 * live data: open /lookups on this Worker to list them, then set them here.
 */
const LOOKUP_TABLE = 'accident_lookup2';

const CODE_GROUP = {
  occupation: 'OCC',    // occ_code          573 codes
  nature: 'IN',         // nature_of_inj      22
  bodyPart: 'BD',       // part_of_body       31
  source: 'SO',         // src_of_injury      48
  eventType: 'FT',      // event_type         14
  // also published, and used as a live fallback to the embedded dictionary
  human: 'HU',          // hum_factor         20
  environmental: 'EN',  // evn_factor         18
  task: 'TASK',         // task_assigned       2
  degree: 'DEGR',       // degree_of_inj       3
  operation: 'OPER',    // const_op           71
  fatalCause: 'CAUS',   // fat_cause          30
  // project context on a construction incident
  endUse: 'ENDU',       // const_end_use      17
  projectType: 'PTYP',  // proj_type           5
  projectCost: 'COST'   // proj_cost           7
};

const PROG_TYPE = {
  N: 'National Emphasis Program',
  L: 'Local Emphasis Program',
  S: 'Strategic Plan Code',
  P: 'Primary Emphasis Program',
};

/**
 * Emphasis program codes. DOL publishes no lookup table for prog_value: the
 * codes are set by each OSHA directive, so national ones repeat nationwide
 * while local ones are regional. Add entries here as you meet them; anything
 * unmapped still shows its raw code.
 */
const EMPHASIS_PROGRAM = {
  'RCS-NEP': 'Respirable Crystalline Silica',
  'WAREHOUSE23': 'Warehousing and Distribution Center Operations',
  'T50WHH': 'Top 50 Workplace Health Hazards',
  'CONSTR6': 'Construction (Region VI)'
};

const emphasisLabel = code => {
  const key = String(code || '').trim();
  if (!key) return '';
  const name = EMPHASIS_PROGRAM[key.toUpperCase()];
  if (name) return `${name} (${key})`;
  // DOL stores these upper case; a single plain word reads better in title case
  return /^[A-Z][A-Z\s]*$/.test(key)
    ? key.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase())
    : key;
};

// Construction operation / cause of injury (code table OPER), from the OSHA data dictionary.
const CONST_OPER = {
  1: "Backfilling and compacting",
  2: "Bituminous concrete placement",
  3: "Construction of playing fields, tennis courts",
  4: "Cutting concrete pavement",
  5: "Demolition",
  6: "Dredging",
  7: "Elevator, escalator installation",
  8: "Emplacing reinforcing steel",
  9: "Erecting structural steel",
  10: "Erection of coffer dams, caissons",
  11: "Excavation",
  12: "Exterior masonry",
  13: "Exterior cladding",
  14: "Exterior carpentry",
  15: "Exterior painting",
  16: "Fencing, installing lights, signs, etc.",
  17: "Fireproofing",
  18: "Forming",
  19: "Forming for piers or pylons",
  20: "Installing interior walls, ceilings, doors",
  21: "Installing metal siding",
  22: "Installing windows and doors, glazing",
  23: "Installing culverts and incidental drainage",
  24: "Installing equipment (HVAC and other)",
  25: "Installing plumbing, lighting fixtures",
  26: "Installing underground plumbing conduit",
  27: "Interior tile work (ceramic, vinyl, acoustic)",
  28: "Interior masonry",
  29: "Interior plumbing, ducting, electrical work",
  30: "Interior carpentry",
  31: "Interior painting and decorating",
  32: "Landscaping",
  33: "Loading dock forming and pouring",
  34: "Paving",
  35: "Pile driving",
  36: "Placing bridge deck",
  37: "Placing bridge girders and beams",
  38: "Plastering",
  39: "Pouring or installing floor decks",
  40: "Pouring concrete floor at grade",
  41: "Pouring concrete for piers, and pylons",
  42: "Pouring concrete foundations and walls",
  43: "Roofing",
  44: "Seawall construction, riprap placement",
  45: "Site clearing and grubbing",
  46: "Site grading and rock removal",
  47: "Stripping and curing concrete",
  48: "Surveying",
  49: "Swimming pool construction",
  50: "Temporary work (buildings, facilities)",
  51: "Traffic protection",
  52: "Trenching, installing pipe",
  53: "Waterproofing",
  54: "Steel Erection Of Solid Web-Connecting",
  55: "Steel Erection Of Solid Web-Bolting-Up/Detail Work",
  56: "Steel Erection Of Solid Web-Welding/Burning/Grindi",
  57: "Steel Erection Of Solid Web-Plumbing-Up",
  58: "Steel Erection Of Solid Web-Moving Point To Point",
  59: "Steel Erection Of Solid Web-Landing Materials (Hoi",
  60: "Steel Erection Of Open Web Steel Joists-Connecting",
  61: "Steel Erection Of Open Web Steel Joists-Bolting-Up",
  62: "Steel Erection Of Open Web Steel Joists-Welding/Bu",
  63: "Steel Erection Of Open Web Steel Joists-Plumbing-U",
  64: "Steel Erection Of Open Web Steel Joists-Moving Poi",
  65: "Steel Erection Of Open Web Steel Joists-Landing Ma",
  66: "Installation Of Decking-Initial Laying Deck (Incl",
  67: "Installation Of Decking-Final Attachment Deck (Wel",
  68: "Installation Of Decking-Flashing Of Decking",
  69: "Installation Of Decking-Hoisting Bundles",
  70: "Other Activities-Installing Ornamental And Archite",
  71: "Other Activities-Post Decking Detail Work",
};

// Construction cause of fatality (code table CAUS), from the OSHA data dictionary.
const FAT_CAUSE = {
  1: "Asphyxiation/inhalation of toxic vapor",
  2: "Caught in stationary equipment",
  3: "Collapse of structure",
  4: "Crushed/run-over of non-operator by operating cons",
  5: "Crushed/run-over/trapped of operator by operating",
  6: "Crushed/run-over by construction equipment during",
  7: "Crushed/run-over by highway vehicle",
  8: "Electrocution by touching exposed wire/source",
  9: "Electrocution by equipment contacting wire",
  10: "Electrocution from equipment installation/tool use",
  11: "Electric shock, other and unknown cause",
  12: "Drown, non-lethal fall",
  13: "Elevator (struck by elevator or counter-weights)",
  14: "Fall from/with ladder",
  15: "Fall from roof",
  16: "Fall from/with scaffold",
  17: "Fall from/with bucket (aerial lift/basket)",
  18: "Fall from/with structure (other than roof)",
  19: "Fall from/with platform catwalk (attached to struc",
  20: "Fall through opening (other than roof)",
  21: "Fall, other",
  22: "Fall from vehicle (vehicle/construction equipment)",
  23: "Fire/explosion",
  24: "Heat/hypothermia",
  25: "Lifting operations",
  26: "Struck by falling object/projectile",
  27: "Trench collapse",
  28: "Unloading-loading equipment/material (except by cr",
  29: "Wall (earthen) collapse",
  30: "Other",
};

async function loadLookups(env) {
  const rows = await loadLookupRows(env);
  const byGroup = new Map();
  rows.forEach(r => {
    const group = String(r.accident_code || '').trim().toUpperCase();
    if (!group) return;
    if (!byGroup.has(group)) byGroup.set(group, new Map());
    const code = r.accident_number ?? r.accident_letter;
    if (code === null || code === undefined) return;
    byGroup.get(group).set(String(code).trim(), String(r.accident_value || '').trim());
  });

  const out = {};
  Object.keys(CODE_GROUP).forEach(name => {
    out[name] = byGroup.get(CODE_GROUP[name]) || new Map();
  });
  out._groups = byGroup;   // kept for the /lookups diagnostic
  return out;
}

// The table is larger than one page, so walk it until a short page comes back.
async function loadLookupRows(env) {
  const all = [];
  for (let page = 0; page < 40; page += 1) {
    const batch = await dol(env, LOOKUP_TABLE, null, {
      limit: 200, offset: page * 200, cacheTtl: 604800
    }).catch(() => []);
    all.push(...batch);
    if (batch.length < 200) break;
  }
  return all;
}

// Plain text when we have it; otherwise the raw code, never a blank.
// Dictionary first (DOL's published value lists), then its lookup datasets.
// A few dictionary values are abbreviated for storage. These read better on screen.
const READABLE = {
  'LocalGovt': 'Local government',
  'StateGovt': 'State government',
  'FollowUp': 'Follow-up',
  'Unprog Rel': 'Unprogrammed related',
  'Prog Related': 'Programmed related',
  'Unprog Other': 'Unprogrammed other',
  'Prog Other': 'Programmed other',
  'Other-L': 'Other',
  'NoInspection': 'No inspection',
  'Records': 'Records only',
  'Fat/Cat': 'Fatality / catastrophe'
};

const fromDict = (table, code) => {
  const key = String(code ?? '').trim();
  if (!key) return '';
  const value = table[key] || table[key.toUpperCase()] || '';
  if (!value) return '';
  const readable = READABLE[value] || value;
  // DOL stores some values lower case ("health", "safety")
  return readable.charAt(0).toUpperCase() + readable.slice(1);
};

const decode = (lookups, name, code) => {
  if (code === null || code === undefined || String(code).trim() === '') return '';
  const key = String(code).trim();
  return (lookups && lookups[name] && lookups[name].get(key)) || key;
};

const inList = (field, values) => ({ and: [{ field, operator: 'in', value: values }] });

/**
 * Load full detail for a set of inspections in a handful of calls rather than
 * five calls per inspection. Cloudflare caps the outbound requests one Worker
 * invocation may make, and a per-inspection loop blows through that cap.
 */
async function loadInspections(env, inspections) {
  if (!inspections.length) return [];
  const ids = inspections.map(i => String(i.activity_nr));

  const [violations, events, injuries, genDuty, emphasis] = await Promise.all([
    dol(env, 'violation', inList('activity_nr', ids), { limit: 200 }).catch(() => []),
    dol(env, 'violation_event', inList('activity_nr', ids), { limit: 200 }).catch(() => []),
    dol(env, 'accident_injury', inList('rel_insp_nr', ids), { limit: 200 }).catch(() => []),
    dol(env, 'violation_gen_duty_std', inList('activity_nr', ids), { limit: 200 }).catch(() => []),
    dol(env, 'emphasis_codes', inList('activity_nr', ids), { limit: 200 }).catch(() => [])
  ]);

  // Accident narratives, in one more call, keyed by the injuries' summary numbers.
  const summaryNrs = [...new Set(injuries.map(i => String(i.summary_nr)).filter(Boolean))];
  // The narrative lives in accident_abstract, one row per line of text.
  const [accidents, abstracts] = summaryNrs.length
    ? await Promise.all([
        dol(env, 'accident', inList('summary_nr', summaryNrs), { limit: 200 }).catch(() => []),
        dol(env, 'accident_abstract', inList('summary_nr', summaryNrs), { limit: 200 }).catch(() => [])
      ])
    : [[], []];

  const by = (rows, field) => {
    const m = new Map();
    (rows || []).forEach(r => {
      const k = String(r[field]);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    });
    return m;
  };
  const vByInsp = by(violations, 'activity_nr');
  const eByInsp = by(events, 'activity_nr');
  const iByInsp = by(injuries, 'rel_insp_nr');
  const aBySummary = by(accidents, 'summary_nr');
  const gdByInsp = by(genDuty, 'activity_nr');
  const empByInsp = by(emphasis, 'activity_nr');
  const absBySummary = by(abstracts, 'summary_nr');

  // Code tables, fetched once per request and only when there is an injury to decode.
  const [lookups, naics] = await Promise.all([
    injuries.length ? loadLookups(env) : null,
    loadNaics(env)
  ]);

  return inspections.map(insp => {
    const id = String(insp.activity_nr);
    const myInjuries = iByInsp.get(id) || [];
    const summaryNr = myInjuries[0]?.summary_nr;
    return {
      insp,
      violations: vByInsp.get(id) || [],
      events: eByInsp.get(id) || [],
      injuries: myInjuries,
      accident: summaryNr ? (aBySummary.get(String(summaryNr)) || [])[0] || null : null,
      abstractLines: summaryNr ? (absBySummary.get(String(summaryNr)) || []) : [],
      lookups,
      naics,
      genDuty: gdByInsp.get(id) || [],
      emphasis: empByInsp.get(id) || []
    };
  });
}

async function loadInspection(env, activityNr) {
  const [insp] = await dol(env, 'inspection', eq('activity_nr', activityNr), { limit: 1 });
  if (!insp) return null;
  const [record] = await loadInspections(env, [insp]);
  return record;
}

// ---------- mapping to the UI's shape ----------
function latestEventFor(citationId, events) {
  const mine = events
    .filter(e => e.citation_id === citationId && e.pen_fta === 'P')
    .sort((a, b) => String(a.hist_date).localeCompare(String(b.hist_date)));
  const last = mine[mine.length - 1];
  return last ? (fromDict(HIST_EVENT, last.hist_event) || last.hist_event) : '';
}

// Street on one line, "City, ST ZIP" on the next. A state with no city is not
// an address, so it is left out rather than shown alone.
function addressBlock(street, city, state, zip) {
  const lines = [];
  if (String(street || '').trim()) lines.push(String(street).trim());
  if (String(city || '').trim()) {
    lines.push([String(city).trim(), state].filter(Boolean).join(', ') + (zip ? ' ' + zip : ''));
  }
  return lines.join('\n');
}

const flag = v => (String(v || '').trim().toUpperCase() === 'X' ? 'Yes' : '');

// The six planning-guide flags read better as one line than six empty boxes.
function planningGuides(insp) {
  const safety = [['Manufacturing', insp.safety_manuf], ['Construction', insp.safety_const], ['Maritime', insp.safety_marit]]
    .filter(([, v]) => flag(v)).map(([k]) => k);
  const health = [['Manufacturing', insp.health_manuf], ['Construction', insp.health_const], ['Maritime', insp.health_marit]]
    .filter(([, v]) => flag(v)).map(([k]) => k);
  const parts = [];
  if (safety.length) parts.push(`Safety: ${safety.join(', ')}`);
  if (health.length) parts.push(`Health: ${health.join(', ')}`);
  return parts.join(' · ');
}

// hazsub1..hazsub5 collapse into one field.
const hazSubs = v => [v.hazsub1, v.hazsub2, v.hazsub3, v.hazsub4, v.hazsub5]
  .map(x => String(x || '').trim()).filter(Boolean).join(', ');

// Force ranking, worst first: Willful, FAT/CAT, Repeat, Serious, Other.
// An inspection ranks by the most severe thing in it; citations rank the same
// way within their inspection (FAT/CAT is an inspection-level flag only).
const VIOL_RANK = { W: 1, R: 3, S: 4, O: 5, U: 6 };

// A citation tied to a fatality or catastrophe outranks everything in its
// inspection: rec 'A' is accident-related, 'I' imminent danger.
const isAccidentCitation = v => ['A', 'I'].includes(String(v.rec || '').trim().toUpperCase());

function inspectionRank(rec) {
  const c = rec.counts || {};
  if (c.willful > 0) return 1;
  if (rec.fatCat) return 2;
  if (c.repeat > 0) return 3;
  if (c.serious > 0) return 4;
  if (c.other > 0 || c.unclass > 0) return 5;
  return 6;
}

// Most severe first, then the larger current penalty, then the newer inspection.
function bySeverity(a, b) {
  const r = inspectionRank(a) - inspectionRank(b);
  if (r) return r;
  const pen = (b.penalties?.current || 0) - (a.penalties?.current || 0);
  if (pen) return pen;
  const year = d => String(d || '').slice(-4);
  return year(b.dateOpened).localeCompare(year(a.dateOpened));
}

// violation_gen_duty_std holds the cited standard's text, one row per line,
// keyed by citation. Lines join in line_nr order.
function genDutyText(rows, citationId) {
  return (rows || [])
    .filter(r => String(r.citation_id) === String(citationId))
    .slice()
    .sort((a, b) => Number(a.line_nr) - Number(b.line_nr))
    .map(r => String(r.line_text || '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

// The initial citation type comes from the earliest event's hist_vtype.
function initialTypeFrom(events, citationId) {
  const mine = (events || [])
    .filter(e => String(e.citation_id) === String(citationId) && e.hist_vtype)
    .sort((a, b) => String(a.hist_date).localeCompare(String(b.hist_date)));
  const first = mine[0];
  return first ? (fromDict(VIOL_TYPE, first.hist_vtype) || first.hist_vtype) : '';
}

// accident_abstract holds the narrative split across numbered lines.
function abstractText(lines, accident) {
  const text = (lines || [])
    .slice()
    .sort((a, b) => Number(a.line_nr) - Number(b.line_nr))
    .map(l => (l.abstract_text || '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  return text || accident?.abstract_text || '';
}

export function mapRecord({ insp, violations, events, injuries, accident, abstractLines, genDuty, emphasis, lookups, naics }) {
  const live = (violations || []).filter(v => v.delete_flag !== 'D');
  const count = t => live.filter(v => v.viol_type === t).length;
  const sum = f => live.reduce((n, v) => n + (parseFloat(v[f]) || 0), 0);

  // Fatality only. A recorded fatality on the accident, or an injury recorded as
  // a fatality. The inspection type is deliberately NOT used: an accident or
  // Fat/Cat inspection may involve no death, and flagging those drowns out the
  // ones that do.
  const fatal = accident?.fatality === 'X' || (injuries || []).some(i => Number(i.degree_of_inj) === 1);
  const fatCat = fatal ? 'FATALITY' : null;

  return {
    activityNr: String(insp.activity_nr),
    dateOpened: usDate(insp.open_date),
    caseStatus: insp.close_case_date ? 'CLOSED' : 'OPEN',
    dateClosed: usDate(insp.close_case_date),
    state: insp.site_state,
    establishment: insp.estab_name,
    fatCat,

    siteAddress: addressBlock(insp.site_address, insp.site_city, insp.site_state, insp.site_zip),
    mailingAddress: addressBlock(insp.mail_street, insp.mail_city, insp.mail_state, insp.mail_zip),
    naics: naicsLabel(insp.naics_code, naics),
    inspectionType: fromDict(INSP_TYPE, insp.insp_type) || insp.insp_type || '',
    scope: fromDict(INSP_SCOPE, insp.insp_scope) || insp.insp_scope || '',
    safetyHealth: fromDict(SAFETY_HLTH, insp.safety_hlth) || insp.safety_hlth || '',
    advancedNotice: fromDict(ADV_NOTICE, insp.adv_notice) || insp.adv_notice || '',
    employees: insp.nr_in_estab || '',
    unionStatus: fromDict(UNION_STATUS, insp.union_status),
    whyNoInspection: fromDict(WHY_NO_INSP, insp.why_no_insp),
    ownerType: fromDict(OWNER_TYPE, insp.owner_type) || insp.owner_type || '',
    migrant: flag(insp.migrant),
    planningGuides: planningGuides(insp),
    emphasisPrograms: (emphasis || [])
      .map(e => {
        const label = fromDict(PROG_TYPE, e.prog_type) || e.prog_type || '';
        const value = emphasisLabel(e.prog_value);
        return value ? (label ? `${label}: ${value}` : value) : label;
      })
      .filter(Boolean).join(' · '),

    counts: {
      serious: count('S'), willful: count('W'), repeat: count('R'),
      other: count('O'), unclass: count('U')
    },
    penalties: { current: sum('current_penalty'), initial: sum('initial_penalty') },

    violationItems: live.slice().sort((x, y) => {
      const jump = (isAccidentCitation(y) ? 1 : 0) - (isAccidentCitation(x) ? 1 : 0);
      if (jump) return jump;
      const r = (VIOL_RANK[x.viol_type] || 9) - (VIOL_RANK[y.viol_type] || 9);
      return r || (parseFloat(y.current_penalty) || 0) - (parseFloat(x.current_penalty) || 0);
    }).map(v => ({
      citationId: v.citation_id,
      initialCitationType: initialTypeFrom(events, v.citation_id)
        || VIOL_TYPE[v.initial_viol_type] || v.initial_viol_type || '',
      citationType: fromDict(VIOL_TYPE, v.viol_type) || v.viol_type || '',
      standardCited: v.standard,
      issuanceDate: usDate(v.issuance_date),
      abatementDueDate: usDate(v.abate_date),
      currentPenalty: v.current_penalty,
      initialPenalty: v.initial_penalty,
      ftaPenalty: v.fta_penalty,
      contest: usDate(v.contest_date),
      latestEvent: latestEventFor(v.citation_id, events || []),
      standardDetails: genDutyText(genDuty, v.citation_id),
      abateComplete: fromDict(ABATE_COMPLETE, v.abate_complete) || v.abate_complete || '',
      finalOrderDate: usDate(v.final_order_date),
      prompted: fromDict(REC, v.rec) || v.rec || '',
      hazcat: v.hazcat || '',
      gravity: String(v.gravity ?? '').trim() ? String(Number(v.gravity)) : '',
      emphasis: flag(v.emphasis),
      hazSubstances: hazSubs(v),
      accidentRelated: isAccidentCitation(v)
    })),

    investigation: (accident || (injuries || []).length) ? {
      investigationNr: accident?.summary_nr ?? injuries[0]?.summary_nr ?? '',
      event: usDate(accident?.event_date),
      eventTime: accident?.event_time ?? '',
      projectType: decode(lookups, 'projectType', accident?.proj_type),
      projectCost: decode(lookups, 'projectCost', accident?.proj_cost),
      constructionEndUse: decode(lookups, 'endUse', accident?.const_end_use),
      buildingStories: accident?.build_stories ?? '',
      narrative: abstractText(abstractLines, accident),
      keywords: accident?.event_keyword ?? '',
      injured: (injuries || []).map(i => ({
        inspection: String(i.rel_insp_nr ?? ''),
        age: i.age, sex: fromDict(SEX, i.sex) || i.sex || '',
        degreeOfInjury: fromDict(DEGREE_OF_INJ, i.degree_of_inj) || decode(lookups, 'degree', i.degree_of_inj),
        natureOfInjury: decode(lookups, 'nature', i.nature_of_inj),
        occupation: decode(lookups, 'occupation', i.occ_code),
        partOfBody: decode(lookups, 'bodyPart', i.part_of_body),
        sourceOfInjury: decode(lookups, 'source', i.src_of_injury),
        eventType: decode(lookups, 'eventType', i.event_type),
        humanFactor: fromDict(HUM_FACTOR, i.hum_factor) || decode(lookups, 'human', i.hum_factor),
        environmentalFactor: fromDict(EVN_FACTOR, i.evn_factor) || decode(lookups, 'environmental', i.evn_factor),
        taskAssigned: fromDict(TASK_ASSIGNED, i.task_assigned) || decode(lookups, 'task', i.task_assigned),
        hazardousSubstance: i.hazsub ?? '',
        constructionOperation: fromDict(CONST_OPER, i.const_op) || decode(lookups, 'operation', i.const_op),
        constructionCause: fromDict(CONST_OPER, i.const_op_cause) || decode(lookups, 'operation', i.const_op_cause),
        fatalityCause: fromDict(FAT_CAUSE, i.fat_cause) || decode(lookups, 'fatalCause', i.fat_cause),
        injuryLine: i.injury_line_nr ?? '',
        fallDistance: i.fall_distance ?? '',
        fallHeight: i.fall_ht ?? ''
      }))
    } : null
  };
}

// ---------- HTTP ----------
/**
 * Underwriting summary of the records currently on screen. The page posts the
 * records it is showing, so deleting one and running again changes the answer.
 * Needs an ANTHROPIC_API_KEY secret on this Worker; without it the endpoint
 * says so plainly rather than failing quietly.
 */
const SUMMARY_SYSTEM = [
  'You summarise OSHA inspection records for a commercial insurance underwriter.',
  'For each inspection return one summary of UNDER 50 WORDS covering only what bears on risk:',
  'the worst citation types, whether anyone died or was seriously hurt, the hazard involved,',
  'whether penalties were reduced on settlement, and whether the hazard was abated.',
  'Lead with the most serious fact. Do not repeat the establishment name, dates or the activity number.',
  'Do not speculate beyond the record. Where a field is absent, say nothing about it.',
  'Return JSON only: {"summaries":[{"activityNr":"...","summary":"..."}],"overall":"..."}',
  'where "overall" is one sentence of under 40 words on the pattern across all the inspections.'
].join(' ');

// Only the fields that bear on the summary, so the prompt stays small.
function summaryInput(rec) {
  return {
    activityNr: rec.activityNr,
    opened: rec.dateOpened,
    status: rec.caseStatus,
    inspectionType: rec.inspectionType,
    fatality: rec.fatCat ? 'yes' : 'no',
    counts: rec.counts,
    penalties: rec.penalties,
    emphasisPrograms: rec.emphasisPrograms || undefined,
    citations: (rec.violationItems || []).slice(0, 12).map(v => ({
      type: v.citationType,
      initialType: v.initialCitationType,
      standard: v.standardCited,
      currentPenalty: v.currentPenalty,
      initialPenalty: v.initialPenalty,
      abatement: v.abateComplete || undefined,
      promptedBy: v.prompted || undefined,
      accidentRelated: v.accidentRelated || undefined,
      text: (v.standardDetails || '').slice(0, 300) || undefined
    })),
    investigation: rec.investigation ? {
      narrative: (rec.investigation.narrative || '').slice(0, 600),
      injured: (rec.investigation.injured || []).slice(0, 3).map(i => ({
        age: i.age, sex: i.sex, degree: i.degreeOfInjury,
        nature: i.natureOfInjury, occupation: i.occupation
      }))
    } : undefined
  };
}

async function summarise(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'Summaries are not configured on this service (no model credential).' }, request, env, 501);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Expected a JSON body of records' }, request, env, 400);
  }
  const records = Array.isArray(body?.records) ? body.records : [];
  if (!records.length) return json({ error: 'No records to summarise' }, request, env, 400);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: env.SUMMARY_MODEL || 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: SUMMARY_SYSTEM,
      messages: [{
        role: 'user',
        content: 'Summarise these inspections:\n' + JSON.stringify(records.slice(0, 25).map(summaryInput))
      }]
    })
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    return json({ error: `The model service returned ${res.status}`, detail }, request, env, 502);
  }

  const data = await res.json();
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  try {
    const parsed = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
    return json({ ...parsed, generated: new Date().toISOString() }, request, env);
  } catch {
    return json({ summaries: [], overall: text, generated: new Date().toISOString() }, request, env);
  }
}

/**
 * The published text of a cited standard, taken from the regulator itself.
 *
 * Cal/OSHA publishes every Title 8 section as its own page on dir.ca.gov, and
 * federal standards come from the eCFR versioner API. Both are public, keyless
 * and authoritative. A citation therefore shows the regulation's own wording or
 * it shows nothing: no model is asked to describe a standard. The AI summary of
 * the inspections themselves (POST /summary) is unaffected.
 */

/**
 * OSHA stores a cited standard in its own packed form: "19100037 B06" is
 * 29 CFR 1910.37(b)(6), and "5A0001" is section 5(a)(1) of the Act. State plan
 * codes arrive closer to how they are published: "3314(C)(1)", "1532.1(L)(2)".
 */

// State plans publish their own codes. Only California is fetched today; the
// rest of this list names the regulation for the /standard diagnostic, so an
// unresolved code is at least identifiable.
const STATE_PLAN_TITLES = {
  CA: 'California Code of Regulations, Title 8',
  MI: 'Michigan Occupational Safety and Health Standards',
  OR: 'Oregon Administrative Rules, Chapter 437',
  WA: 'Washington Administrative Code, Chapter 296',
  NC: 'North Carolina Occupational Safety and Health Standards',
  KY: 'Kentucky Occupational Safety and Health Standards',
  MN: 'Minnesota Rules, Chapter 5205',
  NV: 'Nevada Administrative Code, Chapter 618',
  TN: 'Tennessee Occupational Safety and Health Standards',
  UT: 'Utah Administrative Code, R614',
  VA: 'Virginia Occupational Safety and Health Standards',
  SC: 'South Carolina Occupational Safety and Health Standards',
  MD: 'Maryland Occupational Safety and Health Standards',
  AZ: 'Arizona Administrative Code, Title 20 Chapter 5',
  IN: 'Indiana Occupational Safety and Health Standards',
  IA: 'Iowa Administrative Code, Chapter 875',
  HI: 'Hawaii Administrative Rules, Title 12',
  AK: 'Alaska Administrative Code, Title 8',
  NM: 'New Mexico Administrative Code, Title 11',
  VT: 'Vermont Occupational Safety and Health Standards',
  PR: 'Puerto Rico Occupational Safety and Health Standards',
  WY: 'Wyoming Occupational Health and Safety Rules'
};

function normaliseStandard(raw) {
  const value = String(raw || '').trim().toUpperCase();
  if (!value) return '';
  if (/^5A0*1$/.test(value.replace(/\s+/g, ''))) return 'Section 5(a)(1) of the OSH Act (general duty clause)';

  const [numeric, ...rest] = value.split(/\s+/);
  let head = numeric;

  // 19100037 -> 1910.37 ; 19260501 -> 1926.501
  const packed = numeric.match(/^(19\d{2})(\d+)$/);
  if (packed) {
    const section = packed[2].replace(/^0+/, '') || '0';
    head = packed[1] + '.' + section;
  } else if (!/^\d/.test(numeric)) {
    return value;   // not a federal citation; pass it through as given
  }

  // B06 -> (b)(6) ; A01 -> (a)(1) ; IV -> (IV)
  const suffix = rest.map(part => {
    const m = part.match(/^([A-Z])(\d+)$/);
    if (m) return '(' + m[1].toLowerCase() + ')(' + String(Number(m[2])) + ')';
    if (/^[IVX]+$/.test(part)) return '(' + part + ')';
    if (/^[A-Z]$/.test(part)) return '(' + part.toLowerCase() + ')';
    if (/^\d+$/.test(part)) return '(' + String(Number(part)) + ')';
    return '(' + part.toLowerCase() + ')';
  }).join('');

  return packed ? '29 CFR ' + head + suffix : head + suffix;
}

// ---------- reading a regulation page ----------

/**
 * Markup to plain text, one paragraph per line. The line breaks are the point:
 * a subsection is found by the line that opens it, which is far more reliable
 * than hunting for "(c)" inside a wall of text that also says "(c)" in the
 * middle of a cross reference.
 */
function toPlainText(markup) {
  return String(markup || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|head|hed|section|blockquote|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'")
    // &sect; matters: it is how dir.ca.gov writes the section heading, and the
    // heading is what tells the regulation apart from the page around it.
    .replace(/&sect;/gi, '§').replace(/&para;/gi, '¶').replace(/&deg;/gi, '°')
    .replace(/&mdash;/gi, '—').replace(/&ndash;/gi, '–').replace(/&middot;/gi, '·')
    .replace(/&[lr]dquo;/gi, '"').replace(/&[lr]squo;/gi, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n').map(line => line.trim()).filter(Boolean)
    .join('\n');
}

const clamp = (text, max = 900) =>
  text.length > max ? text.slice(0, max).replace(/\s+\S*$/, '') + '…' : text;

/**
 * Both publishers wrap the regulation in material that is not the regulation:
 * dir.ca.gov puts a disclaimer and breadcrumbs above it and the rulemaking
 * history below, the eCFR appends its source note. The section itself runs from
 * its own heading to the first of those endings.
 */
const SECTION_END = /^(HISTORY\b|NOTE\s*\d*:\s*Authority cited|Note\s*\d*:\s*Authority cited|\[\d+ FR \d)/;

// The wrapper dir.ca.gov puts around every section, dropped when no heading is
// found so the disclaimer is never mistaken for the regulation.
const SECTION_CHROME = /(provided free of charge by the Department of Industrial Relations|full disclaimer|Return to index|New query|Go Back|Skip to Main Content)/i;

function sectionBody(page) {
  const lines = page.split('\n');
  const head = lines.findIndex(line => /^§\s*\d/.test(line) || /^\d{2,5}(\.\d+)?\.\s+\S/.test(line));
  const title = head === -1 ? '' : lines[head].replace(/\s+/g, ' ').trim();
  const rest = (head === -1 ? lines.filter(line => !SECTION_CHROME.test(line)) : lines.slice(head + 1));
  const stop = rest.findIndex(line => SECTION_END.test(line));
  return { title, body: (stop === -1 ? rest : rest.slice(0, stop)).join('\n').trim() };
}

// ---------- finding the cited subsection ----------

// The "(a)" / "(1)" / "(A)" a paragraph opens with, if it opens with one.
const leadToken = line => (String(line).match(/^\(([A-Za-z0-9]{1,4})\)/) || [])[1] || null;

const TOKEN_KIND = {
  digit: t => /^\d{1,3}$/.test(t),
  upper: t => /^[A-Z]{1,2}$/.test(t),
  lower: t => /^[a-z]{1,2}$/.test(t),
  // The CFR nests romans under digits, so i, v and x are not read as ordinary
  // top-level letters: (a)(1)(i) must not look like a sibling of (a).
  letter: t => /^[a-hj-uwyz]$/.test(t),
  roman: t => /^[ivxl]{1,4}$/.test(t)
};

// How each publisher nests its subsections, outermost first.
const NESTING = {
  ca: ['lower', 'digit', 'upper'],         // 3314(c)(1)(A)
  cfr: ['letter', 'digit', 'roman', 'upper']  // 1910.37(b)(6)(i)(A)
};

// OSHA stores the path upper case; each level has its own published casing.
const asLevel = (token, kind) =>
  kind === 'upper' ? String(token).toUpperCase() : String(token).toLowerCase();

/**
 * The paragraph a citation points at, e.g. (c)(1) within section 3314.
 *
 * Walks one level at a time: find the line that opens (c), keep it and
 * everything nested under it, then look for (1) inside what is left. A level
 * ends at the next paragraph opening at the same depth or shallower.
 *
 * Where the path cannot be followed — the page numbers its parts differently,
 * or the citation is deeper than the page goes — this returns as much as it did
 * follow, which is more use than returning nothing.
 */
function paragraphFor(text, path, scheme) {
  const levels = NESTING[scheme] || NESTING.ca;
  let lines = text.split('\n');

  for (let depth = 0; depth < path.length; depth += 1) {
    const kind = levels[Math.min(depth, levels.length - 1)];
    const wanted = asLevel(path[depth], kind);
    const start = lines.findIndex(line => leadToken(line) === wanted);
    if (start === -1) break;

    const ancestors = levels.slice(0, depth + 1);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      const token = leadToken(lines[i]);
      if (token && ancestors.some(k => TOKEN_KIND[k](token))) { end = i; break; }
    }
    lines = lines.slice(start, end);
  }
  return lines.join(' ').trim();
}

// "3314(C)(1)" -> ['C','1'] ; "19100037 B06" -> ['B','06'] ; "1532.1(L)(2)" -> ['L','2']
function subPath(code) {
  const tail = String(code || '').trim().replace(/^[^(\s]*/, '');
  const path = [];

  const parens = tail.match(/\(([A-Za-z0-9]{1,4})\)/g);
  if (parens) {
    parens.forEach(part => path.push(part.slice(1, -1)));
  } else {
    tail.trim().split(/\s+/).filter(Boolean).forEach(part => {
      const m = part.match(/^([A-Za-z])(\d+)$/);
      if (m) { path.push(m[1], m[2]); return; }
      if (/^[A-Za-z]{1,4}$/.test(part) || /^\d{1,3}$/.test(part)) path.push(part);
    });
  }
  return path.map(t => (/^\d+$/.test(t) ? String(Number(t)) : t));
}

// ---------- fetching ----------

/**
 * One regulation page is cited by several citations in the same search, and the
 * platform caps how many outbound requests one invocation may make. Pages are
 * held here for the life of the isolate on top of the edge cache, so twelve
 * citations to section 3314 cost one fetch.
 */
const pageCache = new Map();

/**
 * Returns { status, text }. text is null unless the page came back.
 *
 * Only a page that actually arrived is cached. Caching a failure — here or at
 * the edge — turns one refused request into a week of identical blanks, which
 * looks exactly like a bug in the lookup and is impossible to tell apart from
 * one. cacheTtlByStatus keeps the long cache for successes only.
 */
async function fetchText(url) {
  if (pageCache.has(url)) return { status: 200, text: pageCache.get(url) };
  try {
    const res = await fetch(url, {
      headers: {
        // Some government sites refuse an unfamiliar agent outright.
        'User-Agent': 'Mozilla/5.0 (compatible; ViolationsDesk/1.0; +underwriting reference tool)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      redirect: 'follow',
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: { '200-299': 604800, '301-399': 3600, '400-499': 60, '500-599': 0 }
      }
    });
    if (!res.ok) return { status: res.status, text: null };

    const text = await res.text();
    if (pageCache.size > 200) pageCache.clear();
    pageCache.set(url, text);
    return { status: res.status, text };
  } catch (err) {
    return { status: 0, text: null, error: String(err).slice(0, 120) };
  }
}

// ---------- California: Title 8 on dir.ca.gov ----------

/**
 * Cal/OSHA publishes each section as its own page: section 3314 is at
 * /title8/3314.html and section 1532.1 at /title8/1532_1.html. The decimal
 * becomes an underscore — a dotted section fetched with the dot 404s, which is
 * one reason dotted citations used to come back empty.
 */
/**
 * The section number a code refers to, in the form California publishes it.
 *
 * OSHA stores a section in two different ways and both arrive here:
 *   "3314(C)(1)" / "1532.1(L)(2)"   already published form
 *   "23400012 A"                    packed: 4 digits of section group,
 *                                   4 of section number -> 2340.12
 * The packed form is not only federal. Reading "23400012" as "23400" asks for a
 * section that does not exist, which is how 2340.12(a) came back empty.
 */
function californiaSection(code) {
  // Some records carry the regulation's name on the front: T8-3203(A), 8 CCR 3314.
  const cleaned = String(code || '').trim().toUpperCase()
    .replace(/^(T\s*-?\s*8|8\s*CCR|CCR\s*T?\s*-?\s*8?|CAL\s*\/?\s*OSHA)[\s.:-]*/, '');
  const first = cleaned.split(/\s+/)[0].replace(/^[^\d]*/, '');
  if (!first) return null;

  const packed = first.match(/^(\d{4})(\d{4})$/);
  if (packed) {
    const tail = packed[2].replace(/^0+/, '');
    return tail ? `${packed[1]}.${tail}` : packed[1];
  }

  const plain = first.match(/^(\d{2,5}(?:\.\d+)?)/);
  return plain ? plain[1] : null;
}

// 2340.12 -> /title8/2340_12.html. The decimal is an underscore in the filename.
function californiaUrl(code) {
  const section = californiaSection(code);
  return section ? `https://www.dir.ca.gov/title8/${section.replace('.', '_')}.html` : null;
}

async function californiaText(code) {
  const url = californiaUrl(code);
  if (!url) return null;

  const page = await fetchText(url);
  if (!page.text) return null;

  const { title, body } = sectionBody(toPlainText(page.text));
  if (!body || body.length < 40) return null;

  const para = paragraphFor(body, subPath(code), 'ca') || body;
  return clamp([title, para].filter(Boolean).join(' '));
}

// ---------- federal: 29 CFR from the eCFR ----------

// "19100037 B06" -> { part: '1910', section: '1910.37', path: ['b','6'] }
function federalParts(code) {
  const value = String(code || '').trim().toUpperCase();
  const [numeric, ...rest] = value.split(/\s+/);
  const packed = numeric.match(/^(19\d{2})(\d+)$/);
  if (!packed) return null;
  const path = [];
  rest.forEach(part => {
    const m = part.match(/^([A-Z])(\d+)$/);
    if (m) { path.push(m[1].toLowerCase(), String(Number(m[2]))); return; }
    if (/^[IVX]+$/.test(part)) { path.push(part.toLowerCase()); return; }
    if (/^[A-Z]$/.test(part)) { path.push(part.toLowerCase()); return; }
    if (/^\d+$/.test(part)) path.push(String(Number(part)));
  });
  return { part: packed[1], section: `${packed[1]}.${packed[2].replace(/^0+/, '') || '0'}`, path };
}

let ecfrDate = null;
async function latestCfrDate() {
  if (ecfrDate) return ecfrDate;
  try {
    const res = await fetch('https://www.ecfr.gov/api/versioner/v1/titles.json', {
      cf: { cacheTtl: 86400, cacheEverything: true }
    });
    if (res.ok) {
      const body = await res.json();
      const title29 = (body.titles || []).find(t => Number(t.number) === 29);
      ecfrDate = title29?.latest_issue_date || null;
    }
  } catch { /* fall through to the date below */ }
  if (!ecfrDate) ecfrDate = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  return ecfrDate;
}

async function federalText(code) {
  const parts = federalParts(code);
  if (!parts) return null;
  const date = await latestCfrDate();
  const url = `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-29.xml`
    + `?part=${parts.part}&section=${encodeURIComponent(parts.section)}`;

  const page = await fetchText(url);
  if (!page.text) return null;

  const { title, body } = sectionBody(toPlainText(page.text));
  if (!body || body.length < 20) return null;

  const para = paragraphFor(body, parts.path, 'cfr') || body;
  return clamp([title, para].filter(Boolean).join(' '));
}

// Section 5(a)(1) of the OSH Act is statute, not a regulation, so it is not on
// either site. OSHA stores it as 5A0001.
const GENERAL_DUTY = 'Section 5(a)(1) of the Occupational Safety and Health Act (general duty clause): '
  + 'each employer shall furnish to each of his employees employment and a place of employment which are '
  + 'free from recognized hazards that are causing or are likely to cause death or serious physical harm.';

const isGeneralDuty = code => /^5A0*1$/.test(String(code || '').trim().toUpperCase().replace(/\s+/g, ''));

/**
 * One cited standard, from whichever regulator publishes it. The state decides
 * where a non-federal code is looked up: a bare "3314" is a different rule in
 * every state plan, so without a state nothing is fetched.
 */
async function officialText(env, { code, state }) {
  if (!String(code || '').trim()) return null;
  if (isGeneralDuty(code)) return { text: GENERAL_DUTY, source: 'OSH Act' };

  const federal = await federalText(code);
  if (federal) return { text: federal, source: 'eCFR' };

  if (String(state || '').toUpperCase() === 'CA') {
    const ca = await californiaText(code);
    if (ca) return { text: ca, source: 'CA Title 8' };
  }
  return null;
}

/**
 * POST /standards — the regulation's own text for each cited standard.
 *
 * Returns only what a regulator publishes. A standard that cannot be fetched is
 * simply absent from `definitions`; the screen leaves that description blank and
 * still shows the citation and its number.
 */
async function describeStandards(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Expected a JSON body of standards' }, request, env, 400);
  }

  // Accepts plain codes, or { standard, state } where the state matters: a code
  // that is not a federal citation belongs to that state's own plan.
  const seen = new Set();
  const standards = [];
  (body?.standards || []).forEach(entry => {
    const code = String((entry && entry.standard) ?? entry ?? '').trim();
    if (!code || seen.has(code)) return;
    seen.add(code);
    standards.push({ code, state: String(entry?.state || '').trim().toUpperCase() });
  });
  standards.splice(40);
  if (!standards.length) return json({ definitions: {} }, request, env);

  const definitions = {};
  const found = await Promise.all(standards.map(std => officialText(env, std).catch(() => null)));
  standards.forEach((std, i) => {
    if (found[i]) definitions[std.code] = found[i];
  });

  return json({ definitions }, request, env);
}

/**
 * GET /standard?code=3314(C)(1)&state=CA — the same lookup for one standard,
 * showing its working: the page asked for, the subsection path read out of the
 * code, and whether anything came back. For checking a citation that arrives
 * without a description.
 */
async function standardDiagnostic(request, env, q) {
  const code = (q.get('code') || '').trim();
  const state = (q.get('state') || '').trim().toUpperCase();
  const result = code ? await officialText(env, { code, state }).catch(() => null) : null;

  const federal = Boolean(federalParts(code)) || isGeneralDuty(code);
  const page = !federal && state === 'CA' ? californiaUrl(code) : null;

  // Why a blank description is blank: the code could not be read, the page is
  // not there, or the page is there and the subsection could not be found in it.
  let reason;
  let status;
  if (result) reason = undefined;
  else if (!code) reason = 'no standard given';
  else if (federal) reason = 'the eCFR returned nothing for this section';
  else if (!state) reason = 'the inspection carries no state, so a state plan code cannot be looked up';
  else if (state !== 'CA') reason = `${STATE_PLAN_TITLES[state] || state + ' state plan'} is not retrieved; only California is fetched today`;
  else if (!page) reason = 'no section number could be read out of the code';
  else {
    const got = await fetchText(page);
    status = got.status;
    reason = got.text
      ? 'the page was found but held no usable text'
      : got.status === 0
        ? 'the page could not be reached: ' + (got.error || 'network error')
        : `Cal/OSHA returned ${got.status} for that address`;
  }

  return json({
    code,
    state,
    citation: normaliseStandard(code) || code,
    federal,
    section: californiaSection(code),
    page,
    subsection: subPath(code),
    found: Boolean(result),
    status,
    reason,
    text: result?.text,
    textSource: result?.source
  }, request, env);
}

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
        headers: {
          ...corsHeaders(request, env),
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }
    if (request.method === 'POST' && url.pathname === '/summary') {
      return summarise(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/standards') {
      return describeStandards(request, env);
    }
    if (request.method !== 'GET') return json({ error: 'GET only' }, request, env, 405);
    if (url.pathname === '/health') {
      // `bindings` lists the NAMES this Worker can see (never values) so a missing
      // or misspelled secret is easy to spot.
      return json({
        ok: true,
        bindings: Object.keys(env).sort(),
        hasKey: Boolean(env.DOL_API_KEY),
        keyLength: env.DOL_API_KEY ? String(env.DOL_API_KEY).length : 0
      }, request, env);
    }
    // Checking one standard needs no DOL key: it reads the regulator, not DOL.
    if (url.pathname === '/standard') {
      return standardDiagnostic(request, env, url.searchParams);
    }
    if (!env.DOL_API_KEY) return json({ error: 'DOL_API_KEY is not set on this Worker' }, request, env, 500);

    const q = url.searchParams;
    try {
      if (url.pathname === '/lookups') {
        // Lists every code group in accident_lookup2 with its size and a sample,
        // so CODE_GROUP can be set from the live data rather than guessed.
        const lookups = await loadLookups(env);
        const groups = [...lookups._groups.entries()]
          .map(([code, values]) => {
            const sample = [...values.entries()].slice(0, 3)
              .map(([k, v]) => `${k} = ${v}`);
            return { accident_code: code, codes: values.size, sample };
          })
          .sort((a, b) => b.codes - a.codes);
        const mapped = Object.fromEntries(
          Object.entries(CODE_GROUP).map(([field, code]) => [field, {
            accident_code: code,
            resolved: (lookups[field] && lookups[field].size) || 0
          }])
        );
        return json({ groups, currentMapping: mapped }, request, env);
      }

      if (url.pathname === '/search') {
        const rows = await searchInspections(env, {
          name: q.get('name'), state: q.get('state'), since: q.get('since'),
          limit: Number(q.get('limit')) || 25
        });
        return json(rows.map(r => ({
          activityNr: String(r.activity_nr),
          openDate: usDate(r.open_date),
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

        // by name: look up matches, then load them all in one batch
        const limit = Math.min(Number(q.get('limit')) || 10, 25);
        const matches = await searchInspections(env, {
          name: q.get('name'), state: q.get('state'), since: q.get('since'), limit
        });
        const found = await loadInspections(env, matches.slice(0, limit));
        return json(raw ? found : found.map(mapRecord).sort(bySeverity), request, env);
      }

      return json({ error: 'Not found. Try /search, /inspection or /health' }, request, env, 404);
    } catch (err) {
      const message = err.retried && err.status === 502
        ? 'The Department of Labor service is not responding right now. Try again in a moment.'
        : err.message;
      return json({ error: message, detail: err.detail }, request, env, err.status || 500);
    }
  }
};
