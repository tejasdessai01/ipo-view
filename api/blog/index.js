// api/blog/index.js
// SSR blog listing page — lists all blog posts with SEO

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

module.exports = async function handler(req, res) {
  const blogDir = path.join(process.cwd(), 'content', 'blog');

  let posts = [];
  try {
    const files = fs.readdirSync(blogDir).filter(f => f.endsWith('.md'));
    posts = files.map(file => {
      const raw = fs.readFileSync(path.join(blogDir, file), 'utf8');
      const { data } = matter(raw);
      return {
        slug: file.replace(/\.md$/, ''),
        title: data.title || file.replace(/\.md$/, '').replace(/-/g, ' '),
        date: data.date ? new Date(data.date) : new Date(0),
        description: data.description || '',
        tags: data.tags || [],
        cover: data.cover || null,
      };
    }).sort((a, b) => b.date - a.date);
  } catch (err) {
    console.error('Failed to read blog dir:', err);
  }

  const postCards = posts.map(p => {
    const dateStr = p.date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const tags = p.tags.map(t => `<span class="blog-tag">${esc(t)}</span>`).join('');
    return `
    <a href="/blog/${esc(p.slug)}" class="blog-card">
      <div class="blog-card-date">${esc(dateStr)}</div>
      <h2 class="blog-card-title">${esc(p.title)}</h2>
      <p class="blog-card-desc">${esc(p.description)}</p>
      ${tags ? `<div class="blog-card-tags">${tags}</div>` : ''}
    </a>`;
  }).join('');

  const body = posts.length
    ? `<div class="blog-list">${postCards}</div>`
    : `<div class="empty-state">No blog posts yet. Check back soon!</div>`;

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(buildPage(body));
};

function buildPage(body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Blog | IPO Watch India</title>
<meta name="description" content="IPO insights, guides, and market analysis from IPO Watch India.">
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Sora:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #f6f5f2; --surface: #ffffff; --border: #e4e2dc; --border-light: #f0ede8;
    --text: #1a1814; --text-muted: #8a8680; --text-mid: #4a4744;
    --accent: #e85d1a; --accent-light: #fff4ee; --accent-border: #fbd0b8;
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
  .page-title { font-size: 22px; font-weight: 700; letter-spacing: -0.03em; margin-bottom: 6px; }
  .page-subtitle { font-size: 12px; font-family: var(--mono); color: var(--text-muted); margin-bottom: 24px; }

  .blog-list { display: flex; flex-direction: column; gap: 12px; }
  .blog-card { display: block; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 20px; text-decoration: none; color: inherit; transition: border-color 0.15s, box-shadow 0.15s; }
  .blog-card:hover { border-color: var(--accent-border); box-shadow: 0 2px 8px rgba(232,93,26,0.08); }
  .blog-card-date { font-size: 11px; font-family: var(--mono); color: var(--text-muted); margin-bottom: 6px; }
  .blog-card-title { font-size: 16px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 6px; color: var(--text); }
  .blog-card-desc { font-size: 13px; line-height: 1.6; color: var(--text-mid); margin-bottom: 8px; }
  .blog-card-tags { display: flex; gap: 6px; flex-wrap: wrap; }
  .blog-tag { font-size: 10px; font-family: var(--mono); padding: 2px 8px; background: var(--accent-light); color: var(--accent); border-radius: 3px; border: 1px solid var(--accent-border); }

  .empty-state { text-align: center; padding: 60px 20px; color: var(--text-muted); font-family: var(--mono); font-size: 13px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }

  .footer { padding: 16px 24px; border-top: 1px solid var(--border); background: var(--surface); margin-top: 24px; text-align: center; font-size: 10px; font-family: var(--mono); color: var(--text-muted); }

  @media (max-width: 768px) {
    .topbar { padding: 0 12px; height: 48px; gap: 12px; }
    .page-wrap { padding: 16px 12px; }
    .blog-card { padding: 14px; }
    .blog-card-title { font-size: 15px; }
    .page-title { font-size: 18px; }
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
  <h1 class="page-title">Blog</h1>
  <p class="page-subtitle">IPO insights, guides, and market analysis</p>
  ${body}
</div>

<div class="footer">IPO Watch India</div>

<script defer src="/_vercel/insights/script.js"></script>
<script defer src="/_vercel/speed-insights/script.js"></script>
</body>
</html>`;
}
