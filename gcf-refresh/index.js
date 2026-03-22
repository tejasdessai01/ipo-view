// gcf-refresh/index.js
// Google Cloud Function — replaces Vercel's /api/refresh
// Deployed separately with a 300s timeout (vs Vercel's 60s hobby limit)

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore }                  = require('firebase-admin/firestore');
const functions                         = require('@google-cloud/functions-framework');

function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  const dbId = process.env.FIRESTORE_DATABASE_ID || '(default)';
  return getFirestore(dbId);
}

functions.http('refresh', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).send('');
  }

  // Simple auth check — reject requests without the shared secret
  const authToken = process.env.REFRESH_SECRET;
  if (authToken) {
    const provided = req.query.key || req.headers['x-refresh-key'];
    if (provided !== authToken) {
      return res.status(403).json({ error: 'Forbidden — invalid or missing key' });
    }
  }

  // Validate env vars early
  const missing = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'ANTHROPIC_API_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.error('Missing env vars:', missing);
    return res.status(500).json({ error: 'Missing environment variables', missing });
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase init failed:', err);
    return res.status(500).json({ error: 'Firebase init failed', detail: err.message });
  }

  const force = req.query.force === 'true';

  // Skip if already fetched within 23h (prevents double-runs)
  if (!force) {
    try {
      const meta = await db.collection('meta').doc('last_fetch').get();
      if (meta.exists) {
        const hoursSince = (Date.now() - meta.data().fetched_at.toDate().getTime()) / 3600000;
        if (hoursSince < 23) {
          return res.json({ skipped: true, message: `Fetched ${hoursSince.toFixed(1)}h ago. Add ?force=true to override.` });
        }
      }
    } catch (_) {}
  }

  // Build prompt
  const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  const prompt = `You are a financial data assistant. Today is ${today}.

Search for the latest India IPO data and return a JSON array.
Return ONLY a valid JSON array — no markdown, no backticks, no explanation.

[
  {
    "name": "Company Name",
    "sector": "Sector",
    "exchange": "NSE/BSE",
    "status": "open" | "upcoming" | "allotment" | "listed",
    "issue_size_cr": 1234,
    "price_band": "₹100-105",
    "lot_size": 140,
    "open_date": "DD Mon YYYY",
    "close_date": "DD Mon YYYY",
    "allotment_date": "DD Mon YYYY or null",
    "listing_date": "DD Mon YYYY or null",
    "subscription_times": 45.2,
    "gmp": "+₹45" or "N/A",
    "listing_gain_pct": 23.5 or null,
    "listing_price": "₹520" or null,
    "issue_type": "Book Built" or "Fixed Price" or "SME",
    "registrar": "KFin Technologies",
    "lead_managers": ["Axis Capital"],
    "min_investment": 14000,
    "description": "2-3 sentence real factual description of what the company does, its business, and key highlights",
    "ipo_score": 3.5,
    "score_reasoning": "Brief 1-line reason for the score",
    "company_url": "https://company-website.com or null",
    "linkedin_url": "https://linkedin.com/company/... or null",
    "drhp_url": "https://link-to-DRHP-or-RHP-filing or null"
  }
]

Field guidelines:
- description: Real factual info about the company — what it does, revenue, market position. No speculation.
- ipo_score: Rate 1.0–5.0 based on: company fundamentals, sector outlook, valuation vs peers, subscription demand, GMP sentiment, promoter track record. For listed IPOs, factor in actual listing performance.
- company_url: Official company website. null if unknown.
- linkedin_url: Company LinkedIn page. null if unknown.
- drhp_url: Link to DRHP/RHP on SEBI or BSE/NSE. null if unknown.

Include: all currently open IPOs, IPOs opening in the next 30 days, IPOs listed in the last 30 days. Aim for 15-25 entries. Real data only.`;

  // Call Anthropic
  let ipos;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 16000,
        system:     'You are a structured data API. You MUST respond with ONLY a raw JSON array — no prose, no markdown, no explanation, no text before or after the JSON. Your entire response must be parseable by JSON.parse().',
        tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (!r.ok) {
      const body = await r.text();
      console.error('Anthropic error:', r.status, body);
      throw new Error(`Anthropic HTTP ${r.status}: ${body}`);
    }

    const data = await r.json();
    let raw = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    // Strip markdown fences
    raw = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    // If model wrapped JSON in prose, extract the array
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    if (arrayMatch) raw = arrayMatch[0];
    ipos = JSON.parse(raw);
    if (!Array.isArray(ipos)) throw new Error('Not an array');
  } catch (err) {
    console.error('Anthropic fetch/parse failed:', err);
    return res.status(500).json({ error: 'Anthropic fetch/parse failed', detail: err.message });
  }

  // Write to Firestore
  try {
    const existing = await db.collection('ipos').get();
    const delBatch = db.batch();
    existing.docs.forEach(d => delBatch.delete(d.ref));
    await delBatch.commit();

    for (let i = 0; i < ipos.length; i += 400) {
      const batch = db.batch();
      ipos.slice(i, i + 400).forEach((ipo, j) => {
        batch.set(db.collection('ipos').doc(`ipo_${i + j}`), {
          ...ipo,
          lead_managers: Array.isArray(ipo.lead_managers) ? ipo.lead_managers : [],
          updated_at:    new Date(),
        });
      });
      await batch.commit();
    }

    await db.collection('meta').doc('last_fetch').set({
      fetched_at: new Date(),
      ipo_count:  ipos.length,
    });

    return res.json({ success: true, count: ipos.length, fetched_at: new Date().toISOString() });
  } catch (err) {
    console.error('Firestore write failed:', err);
    const isNotFound = err.code === 5 || /NOT_FOUND/.test(err.message);
    const hint = isNotFound
      ? `Firestore database not found. Ensure a Firestore database exists in project "${process.env.FIREBASE_PROJECT_ID}". ` +
        'Create one at https://console.firebase.google.com → Firestore Database → Create database.'
      : null;
    return res.status(500).json({ error: 'Firestore write failed', detail: err.message, hint });
  }
});
