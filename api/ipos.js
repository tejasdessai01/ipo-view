// api/ipos.js
// Frontend calls GET /api/ipos — returns IPO data + meta
// Firebase credentials stay server-side, nothing exposed to browser

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
  const dbId = process.env.FIRESTORE_DATABASE_ID || '(default)';
  return getFirestore(dbId);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate'); // CDN-cache for 1h

  // Validate env vars early
  const missing = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.error('Missing env vars:', missing);
    return res.status(500).json({ error: 'Missing environment variables', missing });
  }

  try {
    const db = getDb();

    const [ipoSnap, metaSnap] = await Promise.all([
      db.collection('ipos').get(),
      db.collection('meta').doc('last_fetch').get(),
    ]);

    const ipos = ipoSnap.docs.map(d => d.data()).filter(d => d.status !== 'archived');
    const meta = metaSnap.exists ? metaSnap.data() : null;

    return res.json({
      ipos,
      fetched_at: meta?.fetched_at?.toDate?.()?.toISOString() ?? null,
      ipo_count:  meta?.ipo_count ?? ipos.length,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load from Firestore', detail: err.message });
  }
};
