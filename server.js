const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── YouTube helpers ────────────────────────────────────────────────────────────

function extractYouTubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function isYouTubeUrl(input) {
  return /youtube\.com|youtu\.be/.test(input);
}

async function getYouTubeInfo(videoId) {
  const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BandcampFinder/1.0)' },
    timeout: 8000,
  });
  if (!res.ok) throw new Error(`YouTube oEmbed failed: ${res.status}`);
  const data = await res.json();
  return { title: data.title, channel: data.author_name };
}

// Strip noise from a YouTube video title and extract artist + track components
function parseYouTubeTitle(title, channel) {
  // Remove common suffixes like (Official Video), [Lyrics], etc.
  const noise = [
    /\(?\[?official\s*(music\s*)?video\]?\)?/gi,
    /\(?\[?official\s*audio\]?\)?/gi,
    /\(?\[?lyric\s*video\]?\)?/gi,
    /\(?\[?lyrics\]?\)?/gi,
    /\(?\[?visuali[sz]er\]?\)?/gi,
    /\(?\[?hd\]?\)?/gi,
    /\(?\[?hq\]?\)?/gi,
    /\(?\[?4k\]?\)?/gi,
    /\(?\[?audio\]?\)?/gi,
    /\(?\[?remastered.*?\]?\)?/gi,
    /\(?\[?live.*?\]?\)?/gi,
    /\(?\[?full\s*album\]?\)?/gi,
    /feat\.\s*[^([\-]+/gi,
    /ft\.\s*[^([\-]+/gi,
  ];
  let clean = title;
  for (const re of noise) clean = clean.replace(re, '');
  clean = clean.replace(/\s{2,}/g, ' ').trim().replace(/[-–|]+$/, '').trim();

  // Try to split "Artist - Track" or "Artist: Track"
  const dashMatch = clean.match(/^(.+?)\s*[-–]\s*(.+)$/);
  if (dashMatch) {
    return { artist: dashMatch[1].trim(), track: dashMatch[2].trim() };
  }

  // Fall back: use channel name as artist (strip " - Topic" suffix from auto-generated channels)
  const artist = channel.replace(/\s*-\s*Topic\s*$/i, '').trim();
  return { artist, track: clean };
}

// ── DuckDuckGo search ──────────────────────────────────────────────────────────

const DDG_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://duckduckgo.com/',
};

async function ddgSearch(query) {
  const q = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${q}`;
  const res = await fetch(url, { headers: DDG_HEADERS, timeout: 12000 });
  if (!res.ok) throw new Error(`DDG search failed: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const results = [];
  $('.result').each((_, el) => {
    const $el = $(el);
    const titleEl = $el.find('.result__a').first();
    const title = titleEl.text().trim();
    const href = titleEl.attr('href');
    const snippet = $el.find('.result__snippet').text().trim();

    // DDG wraps URLs — extract the actual URL from the uddg param or direct href
    let link = href || '';
    if (link.includes('uddg=')) {
      try { link = decodeURIComponent(link.match(/uddg=([^&]+)/)[1]); } catch {}
    }

    if (title && link && link.includes('bandcamp.com')) {
      results.push({ title, link, snippet });
    }
  });

  return results;
}

// ── Classify and enrich results ────────────────────────────────────────────────

function classifyBandcampUrl(url) {
  if (/\/track\//.test(url)) return 'TRACK';
  if (/\/album\//.test(url)) return 'ALBUM';
  if (/bandcamp\.com\/?$/.test(url) || /bandcamp\.com\/music/.test(url)) return 'ARTIST';
  // subdomain-only URLs like https://artist.bandcamp.com
  if (/^https?:\/\/[^.]+\.bandcamp\.com\/?$/.test(url)) return 'ARTIST';
  return 'PAGE';
}

// ── Main search strategy ───────────────────────────────────────────────────────

// searchType: 'auto' | 'track' | 'artist' | 'label'
async function findOnBandcamp(artist, track, searchType = 'auto') {
  const queries = [];

  if (searchType === 'label') {
    const name = artist || track;
    if (name) {
      queries.push(`site:bandcamp.com "${name}" label`);
      queries.push(`site:bandcamp.com "${name}" records`);
      queries.push(`site:bandcamp.com "${name}"`);
    }
  } else if (searchType === 'artist') {
    const name = artist || track;
    if (name) {
      queries.push(`site:bandcamp.com "${name}" music`);
      queries.push(`site:bandcamp.com "${name}"`);
    }
  } else if (searchType === 'track') {
    if (artist && track) {
      queries.push(`site:bandcamp.com/track "${artist}" "${track}"`);
      queries.push(`site:bandcamp.com "${artist}" "${track}"`);
      queries.push(`site:bandcamp.com ${artist} ${track}`);
    } else {
      const name = artist || track;
      queries.push(`site:bandcamp.com/track "${name}"`);
      queries.push(`site:bandcamp.com ${name}`);
    }
  } else {
    // auto: use whatever context we have
    if (artist && track) {
      queries.push(`site:bandcamp.com/track "${artist}" "${track}"`);
      queries.push(`site:bandcamp.com "${artist}" "${track}"`);
      queries.push(`site:bandcamp.com ${artist} ${track}`);
    } else if (artist) {
      queries.push(`site:bandcamp.com "${artist}"`);
      queries.push(`site:bandcamp.com ${artist}`);
    } else if (track) {
      queries.push(`site:bandcamp.com "${track}"`);
      queries.push(`site:bandcamp.com ${track}`);
    }
  }

  for (const q of queries) {
    let results;
    try {
      results = await ddgSearch(q);
    } catch (err) {
      console.warn(`DDG query failed (${q}):`, err.message);
      continue;
    }

    if (results.length > 0) {
      return results.map(r => ({
        ...r,
        type: classifyBandcampUrl(r.link),
        subhead: r.snippet,
      }));
    }
  }

  return [];
}

// ── API endpoint ───────────────────────────────────────────────────────────────

app.post('/api/find', async (req, res) => {
  const { input, searchType = 'auto' } = req.body;
  if (!input || !input.trim()) {
    return res.status(400).json({ error: 'Input is required' });
  }

  try {
    let artist = null;
    let track = null;
    let label = null;
    let youtubeInfo = null;
    const raw = input.trim();

    if (searchType === 'label') {
      label = raw;
    } else if (searchType === 'artist') {
      artist = raw;
    } else if (searchType === 'track') {
      const dashMatch = raw.match(/^(.+?)\s*[-–]\s*(.+)$/);
      if (dashMatch) {
        artist = dashMatch[1].trim();
        track = dashMatch[2].trim();
      } else {
        track = raw;
      }
    } else {
      // auto
      if (isYouTubeUrl(raw)) {
        const videoId = extractYouTubeId(raw);
        if (!videoId) return res.status(400).json({ error: 'Could not extract YouTube video ID' });
        youtubeInfo = await getYouTubeInfo(videoId);
        const parsed = parseYouTubeTitle(youtubeInfo.title, youtubeInfo.channel);
        artist = parsed.artist;
        track = parsed.track;
      } else {
        const dashMatch = raw.match(/^(.+?)\s*[-–]\s*(.+)$/);
        if (dashMatch) {
          artist = dashMatch[1].trim();
          track = dashMatch[2].trim();
        } else {
          track = raw;
        }
      }
    }

    const results = await findOnBandcamp(
      searchType === 'label' ? label : artist,
      searchType === 'label' ? null : track,
      searchType
    );

    const queryParts = searchType === 'label'
      ? [label]
      : [artist, track];
    const searchQuery = queryParts.filter(Boolean).join(' – ');

    res.json({
      query: searchQuery,
      searchType,
      artist,
      track,
      label,
      youtubeInfo,
      results: results.slice(0, 8),
    });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message || 'Something went wrong' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
