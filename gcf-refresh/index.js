// gcf-refresh/index.js
// Google Cloud Function — refreshes IPO data via Claude + web search
// Uses merge/upsert logic: never deletes old data, only adds or updates.

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

function toSlug(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Merge new AI data on top of existing doc. Never overwrite good data with null.
function mergeIpo(existing, incoming) {
  const merged = { ...existing };
  for (const [key, val] of Object.entries(incoming)) {
    // Skip null/undefined incoming values if we already have data
    if ((val === null || val === undefined) && merged[key] != null) continue;
    // Skip empty strings if we already have a value
    if (val === '' && merged[key]) continue;
    merged[key] = val;
  }
  return merged;
}

functions.http('refresh', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).send('');
  }

  const authToken = process.env.REFRESH_SECRET;
  if (authToken) {
    const provided = req.query.key || req.headers['x-refresh-key'];
    if (provided !== authToken) {
      return res.status(403).json({ error: 'Forbidden — invalid or missing key' });
    }
  }

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

  // ── Load existing IPOs from Firestore to inform the AI ──
  let existingDocs = {};
  try {
    const snap = await db.collection('ipos').get();
    snap.docs.forEach(d => {
      existingDocs[d.id] = d.data();
    });
  } catch (_) {}

  const existingNames = Object.values(existingDocs)
    .filter(d => d.status !== 'archived')
    .map(d => d.name)
    .filter(Boolean);

  const existingList = existingNames.length
    ? `\n\nIMPORTANT — We already track these IPOs. Include ALL of them in your response with updated data (do NOT drop any):\n${existingNames.map(n => `- ${n}`).join('\n')}\n\nIf an IPO from this list has been listed for more than 60 days, you may omit it. Otherwise you MUST include it.`
    : '';

  // Build prompt
  const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  const prompt = `You are a financial data assistant. Today is ${today}.

Search for the latest India IPO data and return a JSON array.
Return ONLY a valid JSON array — no markdown, no backticks, no explanation.

Search these sources for comprehensive data:
- investorgain.com/ipo
- chittorgarh.com/ipo
- ipowatch.in
- moneycontrol.com IPO section

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
- status: "open" = currently accepting applications. "upcoming" = dates announced but not yet open. "allotment" = closed, allotment pending or just done, not yet listed. "listed" = trading on exchange.
- description: Real factual info about the company — what it does, revenue, market position. No speculation.
- ipo_score: Rate 1.0–5.0 based on: company fundamentals, sector outlook, valuation vs peers, subscription demand, GMP sentiment, promoter track record. For listed IPOs, factor in actual listing performance.
- company_url: Official company website. null if unknown.
- linkedin_url: Company LinkedIn page. null if unknown.
- drhp_url: Link to DRHP/RHP on SEBI or BSE/NSE. null if unknown.

Include: ALL currently open IPOs, ALL IPOs in allotment phase, ALL IPOs opening in the next 30 days, ALL IPOs listed in the last 60 days. Be thorough — do not skip any. Include both mainboard and SME IPOs. Aim for 15-30 entries.${existingList}`;

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
    raw = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    if (arrayMatch) raw = arrayMatch[0];
    ipos = JSON.parse(raw);
    if (!Array.isArray(ipos)) throw new Error('Not an array');
  } catch (err) {
    console.error('Anthropic fetch/parse failed:', err);
    return res.status(500).json({ error: 'Anthropic fetch/parse failed', detail: err.message });
  }

  // ── Merge/upsert into Firestore (never delete) ──
  try {
    const now = new Date();
    const seenSlugs = new Set();
    let created = 0, updated = 0;

    for (let i = 0; i < ipos.length; i += 400) {
      const batch = db.batch();
      for (const ipo of ipos.slice(i, i + 400)) {
        const slug = toSlug(ipo.name);
        if (!slug || seenSlugs.has(slug)) continue;
        seenSlugs.add(slug);

        const docRef = db.collection('ipos').doc(slug);
        const existing = existingDocs[slug];

        if (existing) {
          // Merge: update fields but don't overwrite good data with null
          const merged = mergeIpo(existing, {
            ...ipo,
            slug,
            lead_managers: Array.isArray(ipo.lead_managers) ? ipo.lead_managers : (existing.lead_managers || []),
          });
          merged.updated_at = now;
          merged.last_seen  = now;
          batch.set(docRef, merged);
          updated++;
        } else {
          // New IPO
          batch.set(docRef, {
            ...ipo,
            slug,
            lead_managers: Array.isArray(ipo.lead_managers) ? ipo.lead_managers : [],
            created_at: now,
            updated_at: now,
            last_seen:  now,
          });
          created++;
        }
      }
      await batch.commit();
    }

    // ── Archive stale IPOs ──
    // IPOs not seen in 7+ days AND listed 90+ days ago → archived
    const STALE_DAYS = 7;
    const ARCHIVE_LISTED_DAYS = 90;
    let archived = 0;

    const archiveBatch = db.batch();
    for (const [docId, doc] of Object.entries(existingDocs)) {
      if (doc.status === 'archived') continue;
      if (seenSlugs.has(docId)) continue; // AI still sees it

      const lastSeen = doc.last_seen?.toDate?.() || doc.updated_at?.toDate?.() || new Date(0);
      const daysSinceLastSeen = (now - lastSeen) / 86400000;

      if (daysSinceLastSeen >= STALE_DAYS) {
        archiveBatch.update(db.collection('ipos').doc(docId), {
          status: 'archived',
          archived_at: now,
          updated_at: now,
        });
        archived++;
      }
    }
    if (archived > 0) await archiveBatch.commit();

    // ── Migrate old docs keyed as ipo_0, ipo_1, etc. to slug-based IDs ──
    const migrateBatch = db.batch();
    let migrated = 0;
    for (const [docId, doc] of Object.entries(existingDocs)) {
      if (/^ipo_\d+$/.test(docId) && doc.name) {
        const slug = toSlug(doc.name);
        if (!seenSlugs.has(slug)) {
          // Move to slug-based doc
          migrateBatch.set(db.collection('ipos').doc(slug), {
            ...doc,
            slug,
            last_seen: doc.last_seen || doc.updated_at || now,
            created_at: doc.created_at || doc.updated_at || now,
            updated_at: now,
          });
          seenSlugs.add(slug);
          migrated++;
        }
        // Delete old ipo_N doc
        migrateBatch.delete(db.collection('ipos').doc(docId));
      }
    }
    if (migrated > 0) await migrateBatch.commit();

    await db.collection('meta').doc('last_fetch').set({
      fetched_at: now,
      ipo_count:  seenSlugs.size,
    });

    return res.json({
      success: true,
      fetched_at: now.toISOString(),
      created,
      updated,
      archived,
      migrated,
      total: seenSlugs.size,
    });
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
