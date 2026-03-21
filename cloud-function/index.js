const { Firestore } = require('@google-cloud/firestore');
const fetch = require('node-fetch');

const db = new Firestore();

exports.refreshIpos = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).send('');
  }

  // Guard: skip if fetched < 23h ago (unless ?force=true)
  const force = req.query.force === 'true';
  if (!force) {
    const metaSnap = await db.collection('meta').doc('last_fetch').get();
    if (metaSnap.exists) {
      const lastFetch = metaSnap.data().fetched_at.toDate();
      const hoursSince = (Date.now() - lastFetch.getTime()) / 3600000;
      if (hoursSince < 23) {
        return res.json({
          skipped: true,
          message: `Already fetched ${hoursSince.toFixed(1)}h ago. Use ?force=true to override.`,
        });
      }
    }
  }

  const today = new Date().toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  const prompt = `You are a financial data assistant. Today is ${today}.

Search for the latest India IPO data and return a JSON array.

Return ONLY a valid JSON array (no markdown, no explanation, no backticks):

[
  {
    "name": "Company Name",
    "sector": "Sector",
    "exchange": "NSE" or "BSE" or "NSE/BSE",
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

Include: all currently open IPOs, IPOs opening in the next 30 days, and IPOs listed in the last 30 days. Aim for 15-25 entries. Real data only.`;

  let ipos;
  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      throw new Error(`Anthropic error: ${err}`);
    }

    const data = await anthropicRes.json();
    let raw = '';
    for (const block of data.content || []) {
      if (block.type === 'text') raw += block.text;
    }
    raw = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    ipos = JSON.parse(raw);
    if (!Array.isArray(ipos)) throw new Error('Response was not an array');
  } catch (err) {
    console.error('Fetch/parse error:', err);
    return res.status(500).json({ error: 'Failed to fetch or parse IPO data', detail: err.message });
  }

  // Write to Firestore — batch delete old docs, then insert fresh
  try {
    // Delete all existing IPO docs
    const existing = await db.collection('ipos').get();
    const deleteBatch = db.batch();
    existing.forEach(doc => deleteBatch.delete(doc.ref));
    await deleteBatch.commit();

    // Insert new docs in batches of 500 (Firestore limit)
    const BATCH_SIZE = 400;
    for (let i = 0; i < ipos.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = ipos.slice(i, i + BATCH_SIZE);
      chunk.forEach((ipo, idx) => {
        const ref = db.collection('ipos').doc(`ipo_${i + idx}`);
        batch.set(ref, {
          ...ipo,
          lead_managers: Array.isArray(ipo.lead_managers) ? ipo.lead_managers : [],
          updated_at: Firestore.Timestamp.now(),
        });
      });
      await batch.commit();
    }

    // Update meta
    await db.collection('meta').doc('last_fetch').set({
      fetched_at: Firestore.Timestamp.now(),
      ipo_count: ipos.length,
    });

    return res.json({ success: true, count: ipos.length, fetched_at: new Date().toISOString() });
  } catch (err) {
    console.error('Firestore write error:', err);
    return res.status(500).json({ error: 'Firestore write failed', detail: err.message });
  }
};
