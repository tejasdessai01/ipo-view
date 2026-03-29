// api/blog/[slug].js
// SSR blog post page — renders Markdown with SEO meta tags

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { marked } = require('marked');

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

module.exports = async function handler(req, res) {
  const { slug } = req.query;
  if (!slug) return res.status(400).send('Missing slug');

  const filePath = path.join(process.cwd(), 'content', 'blog', `${slug}.md`);

  let frontmatter, htmlContent;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const { data, content } = matter(raw);
    frontmatter = data;
    htmlContent = marked(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.setHeader('Cache-Control', 's-maxage=60');
      return res.status(404).send(buildPage({
        title: 'Post Not Found | IPO Watch India',
        body: '<div style="text-align:center;padding:60px 20px;"><h2 style="margin-bottom:12px;">Post Not Found</h2><p style="color:var(--text-muted);">This blog post doesn\'t exist or has been removed.</p><a href="/blog" style="color:var(--accent);font-family:var(--mono);font-size:12px;text-decoration:none;">\u2190 Back to blog</a></div>',
      }));
    }
    console.error('Failed to read blog post:', err);
    return res.status(500).send('Failed to load post');
  }

  const title = `${esc(frontmatter.title || slug)} | IPO Watch India`;
  const description = esc(frontmatter.description || '').slice(0, 160);
  const canonicalUrl = `https://${req.headers.host || 'ipo-view.vercel.app'}/blog/${slug}`;
  const dateStr = frontmatter.date
    ? new Date(frontmatter.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';
  const tags = frontmatter.tags || [];

  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: frontmatter.title || slug,
    description: frontmatter.description || '',
    url: canonicalUrl,
    datePublished: frontmatter.date ? new Date(frontmatter.date).toISOString() : undefined,
    publisher: {
      '@type': 'Organization',
      name: 'IPO Watch India',
    },
  };

  const body = `
    <a href="/blog" class="back-link">\u2190 Back to blog</a>
    <article class="blog-post">
      <header class="post-header">
        ${dateStr ? `<div class="post-date">${esc(dateStr)}</div>` : ''}
        <h1 class="post-title">${esc(frontmatter.title || slug)}</h1>
        ${frontmatter.description ? `<p class="post-excerpt">${esc(frontmatter.description)}</p>` : ''}
        ${tags.length ? `<div class="post-tags">${tags.map(t => `<span class="blog-tag">${esc(t)}</span>`).join('')}</div>` : ''}
      </header>
      <div class="post-body">
        ${htmlContent}
      </div>
    </article>`;

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(buildPage({ title, description, canonicalUrl, articleLd, body }));
};

function buildPage({ title, description, canonicalUrl, articleLd, body }) {
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
<meta property="og:type" content="article">
<meta name="twitter:card" content="summary">
${articleLd ? `<script type="application/ld+json">${JSON.stringify(articleLd)}</script>` : ''}
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Sora:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #f6f5f2; --surface: #ffffff; --border: #e4e2dc; --border-light: #f0ede8;
    --text: #1a1814; --text-muted: #8a8680; --text-mid: #4a4744;
    --accent: #e85d1a; --accent-light: #fff4ee; --accent-border: #fbd0b8;
    --green: #16a34a; --red: #dc2626; --amber: #d97706; --blue: #2563eb;
    --mono: 'DM Mono', monospace; --sans: 'Sora', sans-serif;
  }
  body { background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 13px; min-height: 100vh; -webkit-text-size-adjust: 100%; }
  a { -webkit-tap-highlight-color: transparent; }

  .topbar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 0 24px; display: flex; align-items: center; height: 52px; gap: 20px; position: sticky; top: 0; z-index: 100; }
  .logo { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; letter-spacing: -0.02em; white-space: nowrap; text-decoration: none; color: var(--text); }
  .logo-flag { display: flex; flex-direction: column; width: 18px; height: 13px; border-radius: 2px; overflow: hidden; border: 1px solid var(--border); }
  .flag-stripe { flex: 1; }
  .flag-top { background: #FF9933; } .flag-mid { background: #fff; } .flag-bot { background: #138808; }
  .nav-link { font-size: 12px; font-family: var(--mono); color: var(--text-muted); text-decoration: none; }
  .nav-link:hover { color: var(--accent); }
  .nav-link.active { color: var(--accent); font-weight: 500; }

  .page-wrap { max-width: 700px; margin: 0 auto; padding: 24px; }

  .back-link { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-family: var(--mono); color: var(--accent); text-decoration: none; margin-bottom: 16px; }
  .back-link:hover { text-decoration: underline; }

  .blog-post { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .post-header { padding: 24px 24px 0; margin-bottom: 20px; }
  .post-date { font-size: 11px; font-family: var(--mono); color: var(--text-muted); margin-bottom: 8px; }
  .post-title { font-size: 24px; font-weight: 700; letter-spacing: -0.03em; line-height: 1.3; margin-bottom: 8px; }
  .post-excerpt { font-size: 14px; line-height: 1.6; color: var(--text-mid); margin-bottom: 12px; }
  .post-tags { display: flex; gap: 6px; flex-wrap: wrap; }
  .blog-tag { font-size: 10px; font-family: var(--mono); padding: 2px 8px; background: var(--accent-light); color: var(--accent); border-radius: 3px; border: 1px solid var(--accent-border); }

  .post-body { padding: 0 24px 24px; font-size: 15px; line-height: 1.8; color: var(--text-mid); }
  .post-body h2 { font-size: 18px; font-weight: 700; color: var(--text); margin: 28px 0 12px; letter-spacing: -0.02em; }
  .post-body h3 { font-size: 15px; font-weight: 600; color: var(--text); margin: 24px 0 8px; }
  .post-body p { margin-bottom: 14px; }
  .post-body ul, .post-body ol { margin: 0 0 14px 20px; }
  .post-body li { margin-bottom: 6px; }
  .post-body strong { color: var(--text); font-weight: 600; }
  .post-body a { color: var(--accent); text-decoration: none; }
  .post-body a:hover { text-decoration: underline; }
  .post-body code { font-family: var(--mono); font-size: 12px; background: var(--bg); padding: 2px 5px; border-radius: 3px; border: 1px solid var(--border); }
  .post-body pre { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 14px; margin-bottom: 14px; overflow-x: auto; }
  .post-body pre code { background: none; border: none; padding: 0; }
  .post-body blockquote { border-left: 3px solid var(--accent); padding: 8px 16px; margin: 0 0 14px; background: var(--accent-light); border-radius: 0 6px 6px 0; }
  .post-body img { max-width: 100%; height: auto; border-radius: 6px; margin: 12px 0; }
  .post-body hr { border: none; border-top: 1px solid var(--border); margin: 24px 0; }

  .footer { padding: 16px 24px; border-top: 1px solid var(--border); background: var(--surface); margin-top: 24px; text-align: center; font-size: 10px; font-family: var(--mono); color: var(--text-muted); }

  @media (max-width: 768px) {
    .topbar { padding: 0 12px; height: 48px; gap: 12px; }
    .page-wrap { padding: 16px 12px; }
    .post-header { padding: 16px 16px 0; }
    .post-title { font-size: 20px; }
    .post-body { padding: 0 16px 16px; font-size: 14px; }
    .post-body h2 { font-size: 16px; }
    .back-link { padding: 8px 0; min-height: 44px; display: inline-flex; align-items: center; }
  }
  @media (max-width: 375px) {
    .post-title { font-size: 18px; }
    .post-body { font-size: 13px; }
  }
  @supports (padding-bottom: env(safe-area-inset-bottom)) {
    .footer { padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
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
  <a href="/" class="nav-link">Dashboard</a>
  <a href="/blog" class="nav-link active">Blog</a>
</div>

<div class="page-wrap">
  ${body}
</div>

<div class="footer">IPO Watch India</div>

<script defer src="/_vercel/insights/script.js"></script>
<script defer src="/_vercel/speed-insights/script.js"></script>
</body>
</html>`;
}
