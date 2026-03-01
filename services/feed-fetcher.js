'use strict';

const https  = require('https');
const http   = require('http');
let RssParser;
try { RssParser = require('rss-parser'); } catch {}

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// Interest keyword → subreddits
const SUBREDDIT_MAP = {
  javascript:      ['javascript', 'webdev'],
  typescript:      ['typescript'],
  python:          ['Python'],
  rust:            ['rust'],
  go:              ['golang'],
  react:           ['reactjs'],
  vue:             ['vuejs'],
  svelte:          ['sveltejs'],
  electron:        ['electronjs'],
  ai:              ['MachineLearning', 'LocalLLaMA'],
  'machine learning': ['MachineLearning'],
  'indie hacking': ['indiehackers', 'SideProject'],
  devops:          ['devops', 'sysadmin'],
  swift:           ['swift', 'iOSProgramming'],
  kotlin:          ['Kotlin', 'androiddev'],
  java:            ['java'],
  'c#':            ['csharp'],
  ruby:            ['ruby'],
  elixir:          ['elixir'],
  haskell:         ['haskell'],
};

// HN story — keywords to score against
function _scoreItem(title, description, interests) {
  const haystack = `${title} ${description || ''}`.toLowerCase();
  let score = 0;
  for (const interest of interests) {
    const keyword = interest.toLowerCase();
    if (haystack.includes(keyword)) score += 3;
    // Partial matches for compound words
    const words = keyword.split(/\s+/);
    for (const word of words) {
      if (word.length >= 4 && haystack.includes(word)) score += 1;
    }
  }
  return Math.min(10, score);
}

function _fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { ...options, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data); // return raw string for non-JSON
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

class FeedFetcher {
  constructor() {
    this.db = null;
    this.interestManager = null;
    this.activeProjectIdFn = null;
    this._timer = null;
    this._rss = RssParser ? new RssParser({ timeout: 10000 }) : null;
  }

  start(db, interestManager, activeProjectIdFn) {
    this.db = db;
    this.interestManager = interestManager;
    this.activeProjectIdFn = activeProjectIdFn;

    // Initial fetch after 2 minutes (let app settle), then every 30 min
    setTimeout(() => {
      this.fetchAll().catch(err => console.error('[FeedFetcher] Initial fetch error:', err.message));
    }, 2 * 60 * 1000);

    this._timer = setInterval(() => {
      this.fetchAll().catch(err => console.error('[FeedFetcher] Fetch error:', err.message));
    }, POLL_INTERVAL_MS);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async fetchAll() {
    const projectId = this.activeProjectIdFn?.();
    const interests = this.interestManager?.getEffective(projectId) || [];

    console.log(`[FeedFetcher] Fetching with interests: ${interests.join(', ') || 'none'}`);

    const results = await Promise.allSettled([
      this.fetchHackerNews(interests),
      this.fetchReddit(interests),
      this.fetchRSSFeeds(interests),
    ]);

    let saved = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') saved += r.value || 0;
      else console.error('[FeedFetcher] Source error:', r.reason?.message);
    }

    this.db.pruneOldFeedItems();
    console.log(`[FeedFetcher] Saved ${saved} new items`);
  }

  async fetchHackerNews(interests) {
    const topIds = await _fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
    if (!Array.isArray(topIds)) return 0;

    // Fetch top 30 stories in parallel (limit concurrency)
    const ids = topIds.slice(0, 30);
    const stories = await Promise.allSettled(
      ids.map(id => _fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`))
    );

    let saved = 0;
    for (const r of stories) {
      if (r.status !== 'fulfilled') continue;
      const s = r.value;
      if (!s || s.type !== 'story' || !s.title) continue;
      if ((s.score || 0) < 10) continue; // skip low-signal items

      const score = _scoreItem(s.title, s.text, interests);
      const url = s.url || `https://news.ycombinator.com/item?id=${s.id}`;

      const added = this.db.saveFeedItem({
        source: 'HN',
        title: s.title,
        url,
        description: s.text ? s.text.replace(/<[^>]+>/g, '').slice(0, 200) : null,
        score,
      });
      if (added) saved++;
    }
    return saved;
  }

  async fetchReddit(interests) {
    if (!interests.length) return 0;

    // Collect unique subreddits based on interests
    const subs = new Set();
    for (const interest of interests) {
      const mapped = SUBREDDIT_MAP[interest.toLowerCase()];
      if (mapped) mapped.forEach(s => subs.add(s));
    }
    if (!subs.size) return 0;

    const headers = { headers: { 'User-Agent': 'outpost-companion/1.0' } };
    let saved = 0;

    const fetches = [...subs].slice(0, 6).map(sub =>
      _fetch(`https://www.reddit.com/r/${sub}/hot.json?limit=10`, headers)
        .catch(err => { console.error(`[FeedFetcher] Reddit r/${sub} error:`, err.message); return null; })
    );

    const responses = await Promise.all(fetches);
    const subArr = [...subs].slice(0, 6);

    for (let i = 0; i < responses.length; i++) {
      const data = responses[i];
      if (!data?.data?.children) continue;
      const sub = subArr[i];

      for (const child of data.data.children) {
        const p = child.data;
        if (!p || p.stickied || !p.title) continue;

        const score = _scoreItem(p.title, p.selftext, interests);
        const added = this.db.saveFeedItem({
          source: `r/${sub}`,
          title: p.title,
          url: `https://www.reddit.com${p.permalink}`,
          description: p.selftext ? p.selftext.slice(0, 200) : null,
          score,
        });
        if (added) saved++;
      }
    }
    return saved;
  }

  async fetchRSSFeeds(interests) {
    if (!this._rss) return 0;
    const raw = this.db.getState('rss_feeds');
    if (!raw) return 0;

    let urls;
    try { urls = JSON.parse(raw); } catch { return 0; }
    if (!Array.isArray(urls) || !urls.length) return 0;

    let saved = 0;
    const fetches = urls.map(url =>
      this._rss.parseURL(url)
        .catch(err => { console.error(`[FeedFetcher] RSS ${url} error:`, err.message); return null; })
    );
    const feeds = await Promise.all(fetches);

    for (const feed of feeds) {
      if (!feed?.items) continue;
      for (const item of feed.items.slice(0, 10)) {
        if (!item.title) continue;
        const score = _scoreItem(item.title, item.contentSnippet || item.summary, interests);
        const added = this.db.saveFeedItem({
          source: feed.title || 'RSS',
          title: item.title,
          url: item.link || null,
          description: item.contentSnippet ? item.contentSnippet.slice(0, 200) : null,
          score,
        });
        if (added) saved++;
      }
    }
    return saved;
  }
}

module.exports = FeedFetcher;
