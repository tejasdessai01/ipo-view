// api/ipo/[slug].js
// SSR detail page for individual IPOs — returns full HTML with SEO meta tags
// URL: /ipo/company-slug

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

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g, '&#39;');
}

function buildStarsHtml(score) {
  if (score == null) return '<span style="color:var(--text-muted)">Not rated</span>';
  const s = Math.max(0, Math.min(5, Number(score)));
  const full = Math.floor(s);
  const half = s - full >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '<span class="stars">'
    + '<span class="star-full">\u2605</span>'.repeat(full)
    + (half ? '<span class="star-half">\u2605</span>' : '')
    + '<span class="star-empty">\u2605</span>'.repeat(empty)
    + '</span> <span style="font-family:var(--mono);font-size:12px;color:var(--text-mid);">' + s.toFixed(1) + '/5</span>';
}

function getBadgeHtml(status) {
  const map = { open:['badge-open','OPEN'], upcoming:['badge-upcoming','UPCOMING'], allotment:['badge-allot','ALLOTMENT'], listed:['badge-listed','LISTED'] };
  const [cls, label] = map[status] || ['badge-listed', (status||'UNKNOWN').toUpperCase()];
  return `<span class="badge ${cls}">${label}</span>`;
}

function toSlug(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function fmtNum(n) {
  if (n == null) return '\u2014';
  return Number(n).toLocaleString('en-IN');
}

module.exports = async function handler(req, res) {
  const { slug } = req.query;
  if (!slug) return res.status(400).send('Missing slug');

  const missing = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) return res.status(500).send('Server configuration error');

  let ipo;
  try {
    const db = getDb();
    // Slug is now the document ID
    const doc = await db.collection('ipos').doc(slug).get();
    if (doc.exists) {
      ipo = doc.data();
    } else {
      // Fallback: query by slug field or name match
      const snap = await db.collection('ipos').where('slug', '==', slug).limit(1).get();
      if (!snap.empty) {
        ipo = snap.docs[0].data();
      } else {
        const allSnap = await db.collection('ipos').get();
        ipo = allSnap.docs.map(d => d.data()).find(d => toSlug(d.name) === slug);
      }
    }
  } catch (err) {
    console.error('Firestore read failed:', err);
    return res.status(500).send('Failed to load data');
  }

  if (!ipo) {
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.status(404).send(buildPage({
      title: 'IPO Not Found | IPO Watch India',
      body: '<div class="detail-card" style="text-align:center;padding:60px 20px;"><h2 style="margin-bottom:12px;">IPO Not Found</h2><p style="color:var(--text-muted);">This IPO may have been removed or the URL is incorrect.</p><a href="/" class="back-link">\u2190 Back to all IPOs</a></div>',
    }));
  }

  const name = esc(ipo.name || 'Unknown');
  const title = `${name} IPO \u2013 Price, GMP, Review, Dates | IPO Watch India`;
  const description = ipo.about
    ? esc(ipo.about).slice(0, 160)
    : ipo.description
      ? esc(ipo.description).slice(0, 160)
      : `${name} IPO details: price band ${esc(ipo.price_band || '')}, GMP ${esc(ipo.gmp || 'N/A')}, status ${esc(ipo.status || '')}. Complete analysis on IPO Watch India.`;

  const gmpClass = ipo.gmp && ipo.gmp !== 'N/A' ? (ipo.gmp.startsWith('+') ? 'gmp-pos' : 'gmp-neg') : 'gmp-na';
  const issueSize = ipo.issue_size_cr != null ? `\u20B9${fmtNum(ipo.issue_size_cr)} Cr` : '\u2014';

  let gainHtml = '\u2014';
  if (ipo.status === 'listed' && ipo.listing_gain_pct != null) {
    const g = Number(ipo.listing_gain_pct);
    gainHtml = `<span class="${g >= 0 ? 'gain-pos' : 'gain-neg'}">${g >= 0 ? '+' : ''}${g.toFixed(1)}%</span>`;
  }

  const subText = ipo.subscription_times
    ? (Number(ipo.subscription_times) >= 1000
        ? (Number(ipo.subscription_times)/1000).toFixed(1)+'Kx'
        : Number(ipo.subscription_times).toFixed(1)+'x')
    : '\u2014';

  const links = [];
  if (ipo.company_url) links.push(`<a href="${esc(ipo.company_url)}" target="_blank" rel="noopener">Website \u2197</a>`);
  if (ipo.linkedin_url) links.push(`<a href="${esc(ipo.linkedin_url)}" target="_blank" rel="noopener">LinkedIn \u2197</a>`);
  if (ipo.drhp_url) links.push(`<a href="${esc(ipo.drhp_url)}" target="_blank" rel="noopener">DRHP/RHP \u2197</a>`);

  const leadManagers = Array.isArray(ipo.lead_managers) && ipo.lead_managers.length
    ? ipo.lead_managers.map(esc).join(', ') : '\u2014';

  const canonicalUrl = `https://${req.headers.host || 'ipo-view.vercel.app'}/ipo/${slug}`;

  // Financials section
  const fin = ipo.financials || {};
  const hasFinancials = fin.revenue_cr || fin.profit_cr || fin.roe_pct || fin.pe_ratio;

  // Strengths & Risks
  const strengths = Array.isArray(ipo.strengths) && ipo.strengths.length ? ipo.strengths : null;
  const risks = Array.isArray(ipo.risks) && ipo.risks.length ? ipo.risks : null;

  // FAQs
  const faqs = Array.isArray(ipo.faqs) && ipo.faqs.length ? ipo.faqs : null;

  // JSON-LD: main entity
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FinancialProduct',
    name: `${ipo.name} IPO`,
    description: ipo.about || ipo.description || '',
    provider: { '@type': 'Organization', name: ipo.name || '' },
    url: canonicalUrl,
  };

  // JSON-LD: FAQ schema for SEO
  const faqLd = faqs ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(f => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  } : null;

  const body = `
    <a href="/" class="back-link">\u2190 Back to all IPOs</a>

    <div class="detail-card">
      <div class="detail-header">
        <div>
          <h1 class="detail-title">${name}</h1>
          <div class="detail-subtitle">${esc(ipo.sector || '')} \u00b7 ${esc(ipo.exchange || 'NSE/BSE')} \u00b7 ${esc(ipo.issue_type || '')}</div>
        </div>
        <div style="text-align:right;">
          ${getBadgeHtml(ipo.status)}
          <div style="margin-top:8px;">${buildStarsHtml(ipo.ipo_score)}</div>
        </div>
      </div>

      ${ipo.about ? `<div class="detail-desc">${esc(ipo.about)}</div>` : ipo.description ? `<div class="detail-desc">${esc(ipo.description)}</div>` : ''}
      ${ipo.score_reasoning ? `<div class="detail-reasoning">IPO Score: ${esc(ipo.score_reasoning)}</div>` : ''}

      <div class="detail-section-title">IPO Details</div>
      <div class="detail-grid">
        <div class="detail-field">
          <span class="detail-label">Price Band</span>
          <span class="detail-value">${esc(ipo.price_band || '\u2014')}</span>
        </div>
        <div class="detail-field">
          <span class="detail-label">Issue Size</span>
          <span class="detail-value">${issueSize}</span>
        </div>
        <div class="detail-field">
          <span class="detail-label">Lot Size</span>
          <span class="detail-value">${ipo.lot_size ? ipo.lot_size + ' shares' : '\u2014'}</span>
        </div>
        <div class="detail-field">
          <span class="detail-label">Min Investment</span>
          <span class="detail-value">${ipo.min_investment ? '\u20B9' + fmtNum(ipo.min_investment) : '\u2014'}</span>
        </div>
        <div class="detail-field">
          <span class="detail-label">GMP</span>
          <span class="detail-value gmp-val ${gmpClass}">${esc(ipo.gmp || '\u2014')}</span>
        </div>
        <div class="detail-field">
          <span class="detail-label">Subscription</span>
          <span class="detail-value">${subText}</span>
        </div>
        <div class="detail-field">
          <span class="detail-label">Listing Gain</span>
          <span class="detail-value">${gainHtml}</span>
        </div>
        <div class="detail-field">
          <span class="detail-label">Listing Price</span>
          <span class="detail-value">${esc(ipo.listing_price || '\u2014')}</span>
        </div>
      </div>

      <div class="detail-section-title">Key Dates</div>
      <div class="timeline">
        ${buildTimelineItem('Open Date', ipo.open_date)}
        ${buildTimelineItem('Close Date', ipo.close_date)}
        ${buildTimelineItem('Allotment', ipo.allotment_date)}
        ${buildTimelineItem('Listing', ipo.listing_date)}
      </div>

      ${ipo.promoters ? `
      <div class="detail-section-title">Promoters</div>
      <div class="detail-text">${esc(ipo.promoters)}</div>
      ` : ''}

      ${hasFinancials ? `
      <div class="detail-section-title">Key Financials${fin.period ? ` <span class="fin-period">(${esc(fin.period)})</span>` : ''}</div>
      <div class="detail-grid">
        ${fin.revenue_cr != null ? `<div class="detail-field"><span class="detail-label">Revenue</span><span class="detail-value">\u20B9${fmtNum(fin.revenue_cr)} Cr</span></div>` : ''}
        ${fin.profit_cr != null ? `<div class="detail-field"><span class="detail-label">Net Profit</span><span class="detail-value ${Number(fin.profit_cr) >= 0 ? 'fin-pos' : 'fin-neg'}">\u20B9${fmtNum(fin.profit_cr)} Cr</span></div>` : ''}
        ${fin.revenue_growth_pct != null ? `<div class="detail-field"><span class="detail-label">Revenue Growth</span><span class="detail-value">${Number(fin.revenue_growth_pct).toFixed(1)}%</span></div>` : ''}
        ${fin.roe_pct != null ? `<div class="detail-field"><span class="detail-label">ROE</span><span class="detail-value">${Number(fin.roe_pct).toFixed(1)}%</span></div>` : ''}
        ${fin.debt_to_equity != null ? `<div class="detail-field"><span class="detail-label">Debt/Equity</span><span class="detail-value">${Number(fin.debt_to_equity).toFixed(2)}</span></div>` : ''}
        ${fin.eps != null ? `<div class="detail-field"><span class="detail-label">EPS</span><span class="detail-value">\u20B9${Number(fin.eps).toFixed(2)}</span></div>` : ''}
        ${fin.pe_ratio != null ? `<div class="detail-field"><span class="detail-label">P/E Ratio</span><span class="detail-value">${Number(fin.pe_ratio).toFixed(1)}x</span></div>` : ''}
      </div>
      ` : ''}

      ${strengths || risks ? `
      <div class="sr-columns">
        ${strengths ? `
        <div class="sr-col">
          <div class="detail-section-title">Strengths</div>
          <ul class="sr-list sr-strengths">
            ${strengths.map(s => `<li>${esc(s)}</li>`).join('')}
          </ul>
        </div>` : ''}
        ${risks ? `
        <div class="sr-col">
          <div class="detail-section-title">Risks</div>
          <ul class="sr-list sr-risks">
            ${risks.map(r => `<li>${esc(r)}</li>`).join('')}
          </ul>
        </div>` : ''}
      </div>
      ` : ''}

      ${ipo.industry_overview ? `
      <div class="detail-section-title">Industry Overview</div>
      <div class="detail-text">${esc(ipo.industry_overview)}</div>
      ` : ''}

      <div class="detail-section-title">Other Details</div>
      <div class="detail-grid">
        <div class="detail-field">
          <span class="detail-label">Registrar</span>
          <span class="detail-value">${esc(ipo.registrar || '\u2014')}</span>
        </div>
        <div class="detail-field">
          <span class="detail-label">Lead Managers</span>
          <span class="detail-value">${leadManagers}</span>
        </div>
      </div>

      ${links.length ? `<div class="detail-links">${links.join('')}</div>` : ''}
    </div>

    ${faqs ? `
    <div class="faq-section">
      <h2 class="faq-heading">Frequently Asked Questions</h2>
      ${faqs.map(f => `
      <details class="faq-item">
        <summary class="faq-q">${esc(f.q)}</summary>
        <div class="faq-a">${esc(f.a)}</div>
      </details>`).join('')}
    </div>
    ` : ''}

    <div class="detail-disclaimer">
      Data sourced from public filings and market sources. This is not investment advice. Verify independently before making investment decisions.
    </div>`;

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(buildPage({ title, description, canonicalUrl, jsonLd, faqLd, body }));
};

function buildTimelineItem(label, value) {
  return `<div class="timeline-item">
    <div class="timeline-dot"></div>
    <div class="timeline-content">
      <span class="timeline-label">${esc(label)}</span>
      <span class="timeline-value">${esc(value || '\u2014')}</span>
    </div>
  </div>`;
}

function buildPage({ title, description, canonicalUrl, jsonLd, faqLd, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${title || 'IPO Watch India'}</title>
${description ? `<meta name="description" content="${description}">` : ''}
${canonicalUrl ? `<link rel="canonical" href="${canonicalUrl}">` : ''}
${canonicalUrl ? `<meta property="og:url" content="${canonicalUrl}">` : ''}
${title ? `<meta property="og:title" content="${title}">` : ''}
${description ? `<meta property="og:description" content="${description}">` : ''}
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
${faqLd ? `<script type="application/ld+json">${JSON.stringify(faqLd)}</script>` : ''}
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Sora:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #f6f5f2; --surface: #ffffff; --border: #e4e2dc; --border-light: #f0ede8;
    --text: #1a1814; --text-muted: #8a8680; --text-mid: #4a4744;
    --accent: #e85d1a; --accent-light: #fff4ee; --accent-border: #fbd0b8;
    --green: #16a34a; --green-bg: #f0fdf4; --green-border: #bbf7d0;
    --red: #dc2626; --red-bg: #fef2f2; --red-border: #fecaca;
    --amber: #d97706; --amber-bg: #fffbeb; --amber-border: #fde68a;
    --blue: #2563eb; --blue-bg: #eff6ff; --blue-border: #bfdbfe;
    --mono: 'DM Mono', monospace; --sans: 'Sora', sans-serif;
  }
  body { background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 13px; min-height: 100vh; -webkit-text-size-adjust: 100%; }
  a, button, summary { -webkit-tap-highlight-color: transparent; }

  .topbar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 0 24px; display: flex; align-items: center; height: 52px; gap: 20px; position: sticky; top: 0; z-index: 100; }
  .logo { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; letter-spacing: -0.02em; white-space: nowrap; text-decoration: none; color: var(--text); }
  .logo-flag { display: flex; flex-direction: column; width: 18px; height: 13px; border-radius: 2px; overflow: hidden; border: 1px solid var(--border); }
  .flag-stripe { flex: 1; }
  .flag-top { background: #FF9933; } .flag-mid { background: #fff; } .flag-bot { background: #138808; }

  .page-wrap { max-width: 800px; margin: 0 auto; padding: 20px 24px; }

  .back-link { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-family: var(--mono); color: var(--accent); text-decoration: none; margin-bottom: 16px; }
  .back-link:hover { text-decoration: underline; }

  .detail-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 24px; }
  .detail-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 16px; }
  .detail-title { font-size: 22px; font-weight: 700; letter-spacing: -0.03em; color: var(--text); }
  .detail-subtitle { font-size: 12px; font-family: var(--mono); color: var(--text-muted); margin-top: 4px; }
  .detail-desc { font-size: 13px; line-height: 1.7; color: var(--text-mid); margin-bottom: 12px; padding: 12px; background: var(--bg); border-radius: 6px; border: 1px solid var(--border-light); }
  .detail-reasoning { font-size: 11px; font-family: var(--mono); color: var(--text-muted); margin-bottom: 16px; padding: 8px 12px; background: var(--amber-bg); border: 1px solid var(--amber-border); border-radius: 5px; }
  .detail-text { font-size: 13px; line-height: 1.7; color: var(--text-mid); margin-bottom: 16px; }

  .detail-grid { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .detail-field { display: flex; flex-direction: column; gap: 3px; }
  .detail-label { font-size: 9px; font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); }
  .detail-value { font-size: 14px; font-weight: 500; color: var(--text); font-family: var(--mono); }
  .fin-pos { color: var(--green); } .fin-neg { color: var(--red); }
  .fin-period { font-weight: 400; font-size: 10px; color: var(--text-mid); text-transform: none; letter-spacing: 0; }

  .detail-section-title { font-size: 10px; font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-muted); margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
  .detail-section-title::after { content: ''; flex: 1; height: 1px; background: var(--border); }

  .sr-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
  .sr-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
  .sr-list li { font-size: 12px; line-height: 1.5; color: var(--text-mid); padding: 6px 10px; border-radius: 5px; }
  .sr-strengths li { background: var(--green-bg); border: 1px solid var(--green-border); }
  .sr-strengths li::before { content: '\\2713 '; color: var(--green); font-weight: 600; margin-right: 4px; }
  .sr-risks li { background: var(--red-bg); border: 1px solid var(--red-border); }
  .sr-risks li::before { content: '\\26A0 '; color: var(--red); margin-right: 4px; }

  .timeline { display: flex; gap: 0; margin-bottom: 20px; position: relative; }
  .timeline::before { content: ''; position: absolute; top: 8px; left: 8px; right: 8px; height: 2px; background: var(--border); z-index: 0; }
  .timeline-item { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; position: relative; z-index: 1; }
  .timeline-dot { width: 16px; height: 16px; border-radius: 50%; background: var(--surface); border: 2px solid var(--accent); }
  .timeline-content { text-align: center; }
  .timeline-label { display: block; font-size: 9px; font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); }
  .timeline-value { display: block; font-size: 12px; font-family: var(--mono); color: var(--text); font-weight: 500; margin-top: 2px; }

  .detail-links { display: flex; gap: 16px; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border-light); }
  .detail-links a { font-size: 12px; font-family: var(--mono); color: var(--accent); text-decoration: none; display: inline-flex; align-items: center; gap: 3px; }
  .detail-links a:hover { text-decoration: underline; }

  .faq-section { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 24px; margin-top: 16px; }
  .faq-heading { font-size: 16px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 16px; }
  .faq-item { border-bottom: 1px solid var(--border-light); }
  .faq-item:last-child { border-bottom: none; }
  .faq-q { font-size: 13px; font-weight: 600; padding: 14px 0; cursor: pointer; list-style: none; display: flex; justify-content: space-between; align-items: center; }
  .faq-q::-webkit-details-marker { display: none; }
  .faq-q::after { content: '+'; font-size: 18px; color: var(--text-muted); font-weight: 300; flex-shrink: 0; margin-left: 12px; }
  details[open] .faq-q::after { content: '\u2212'; }
  .faq-a { font-size: 13px; line-height: 1.7; color: var(--text-mid); padding: 0 0 14px 0; }

  .detail-disclaimer { text-align: center; font-size: 10px; font-family: var(--mono); color: var(--text-muted); margin-top: 16px; padding: 12px; }

  .badge { display: inline-block; font-size: 10px; font-family: var(--mono); padding: 3px 8px; border-radius: 3px; }
  .badge-open     { background: var(--green-bg); color: var(--green); border: 1px solid var(--green-border); }
  .badge-upcoming { background: var(--blue-bg); color: var(--blue); border: 1px solid var(--blue-border); }
  .badge-listed   { background: var(--border-light); color: var(--text-muted); border: 1px solid var(--border); }
  .badge-allot    { background: var(--amber-bg); color: var(--amber); border: 1px solid var(--amber-border); }

  .stars { display: inline-flex; gap: 1px; font-size: 14px; letter-spacing: -1px; }
  .star-full { color: var(--amber); } .star-half { color: var(--amber); } .star-empty { color: var(--border); }
  .gmp-val { font-family: var(--mono); font-weight: 500; }
  .gmp-pos { color: var(--green); } .gmp-neg { color: var(--red); } .gmp-na { color: var(--text-muted); }
  .gain-pos { color: var(--green); font-family: var(--mono); font-weight: 500; }
  .gain-neg { color: var(--red); font-family: var(--mono); font-weight: 500; }

  .footer { padding: 16px 24px; border-top: 1px solid var(--border); background: var(--surface); display: flex; justify-content: space-between; align-items: center; font-size: 10px; font-family: var(--mono); color: var(--text-muted); }

  @media (max-width: 768px) {
    .topbar { padding: 0 12px; height: 48px; }
    .page-wrap { padding: 16px 12px; }
    .detail-card, .faq-section { padding: 14px; }
    .detail-header { flex-direction: column; gap: 10px; }
    .detail-title { font-size: 18px; }
    .detail-subtitle { font-size: 11px; }
    .detail-desc { font-size: 13px; padding: 10px; }
    .detail-grid { grid-template-columns: 1fr 1fr; gap: 10px; }
    .detail-value { font-size: 13px; word-break: break-word; }
    .sr-columns { grid-template-columns: 1fr; gap: 12px; }
    .sr-list li { font-size: 12px; }
    .timeline { flex-direction: column; gap: 12px; }
    .timeline::before { top: 8px; bottom: 8px; left: 7px; width: 2px; height: auto; right: auto; }
    .timeline-item { flex-direction: row; align-items: center; gap: 10px; }
    .timeline-content { text-align: left; }
    .detail-links { flex-wrap: wrap; gap: 10px; }
    .detail-links a { padding: 8px 0; min-height: 44px; display: inline-flex; align-items: center; }
    .faq-q { padding: 16px 0; min-height: 44px; font-size: 13px; }
    .faq-a { font-size: 13px; }
    .faq-heading { font-size: 15px; }
    .back-link { padding: 8px 0; min-height: 44px; display: inline-flex; align-items: center; }
    .footer { flex-direction: column; gap: 6px; text-align: center; padding: 12px; }
  }

  /* iPhone SE / small phones */
  @media (max-width: 375px) {
    .detail-title { font-size: 16px; }
    .detail-grid { gap: 8px; }
    .detail-value { font-size: 12px; }
    .detail-label { font-size: 8px; }
    .sr-list li { font-size: 11px; padding: 5px 8px; }
  }

  /* Safe area for iPhone notch/home indicator */
  @supports (padding-bottom: env(safe-area-inset-bottom)) {
    .footer { padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
    .topbar { padding-top: env(safe-area-inset-top); }
  }
</style>
</head>
<body>

<div class="topbar">
  <a href="/" class="logo">
    <div class="logo-flag">
      <div class="flag-stripe flag-top"></div>
      <div class="flag-stripe flag-mid"></div>
      <div class="flag-stripe flag-bot"></div>
    </div>
    IPO Watch
  </a>
</div>

<div class="page-wrap">
  ${body}
</div>

<div class="footer">
  <span>IPO Watch India \u00b7 For informational purposes only</span>
</div>

<script defer src="/_vercel/insights/script.js"></script>
<script defer src="/_vercel/speed-insights/script.js"></script>
</body>
</html>`;
}
