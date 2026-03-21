// api/refresh.js
// Called by Vercel Cron daily at 6:30 AM IST (1:00 AM UTC)
// Also callable manually: GET /api/refresh?force=true

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore }                  = require('firebase-admin/firestore');

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
  return getFirestore();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const db    = getDb();
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
    "min_investment": 14000
  }
]

Include: all currently open IPOs, IPOs opening in the next 30 days, IPOs listed in the last 30 days. Aim for 15-25 entries. Real data only.`;

  // Call Anthropic
  let ipos;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 4000,
        tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`);

    const data = await r.json();
    let raw = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    raw = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    ipos = JSON.parse(raw);
    if (!Array.isArray(ipos)) throw new Error('Not an array');
  } catch (err) {
    return res.status(500).json({ error: 'Anthropic fetch/parse failed', detail: err.message });
  }

  // Write to Firestore
  try {
    // Delete old docs
    const existing = await db.collection('ipos').get();
    const delBatch = db.batch();
    existing.docs.forEach(d => delBatch.delete(d.ref));
    await delBatch.commit();

    // Insert fresh docs in batches of 400
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

    // Update meta
    await db.collection('meta').doc('last_fetch').set({
      fetched_at: new Date(),
      ipo_count:  ipos.length,
    });

    return res.json({ success: true, count: ipos.length, fetched_at: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: 'Firestore write failed', detail: err.message });
  }
};
