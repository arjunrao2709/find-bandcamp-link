const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Extract YouTube video ID from various URL formats
function extractYouTubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function isYouTubeUrl(input) {
  return /youtube\.com|youtu\.be/.test(input);
}

// Get video title and artist from YouTube oEmbed API
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

// Clean up a YouTube title to make a better Bandcamp search query
function cleanYouTubeTitle(title) {
  return title
    .replace(/\(Official\s*(Music\s*)?Video\)/gi, '')
    .replace(/\[Official\s*(Music\s*)?Video\]/gi, '')
    .replace(/\(Official\s*Audio\)/gi, '')
    .replace(/\[Official\s*Audio\]/gi, '')
    .replace(/\(Lyric\s*Video\)/gi, '')
    .replace(/\[Lyric\s*Video\]/gi, '')
    .replace(/\(Lyrics\)/gi, '')
    .replace(/\[Lyrics\]/gi, '')
    .replace(/\(HD\)/gi, '')
    .replace(/\[HD\]/gi, '')
    .replace(/\(HQ\)/gi, '')
    .replace(/\[HQ\]/gi, '')
    .replace(/\bfeat\..*$/i, '')
    .replace(/\bft\..*$/i, '')
    .trim();
}

// Search Bandcamp and return top results
async function searchBandcamp(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://bandcamp.com/search?q=${encoded}&item_type=t`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    timeout: 10000,
  });

  if (!res.ok) throw new Error(`Bandcamp search failed: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const results = [];

  $('.searchresult').each((i, el) => {
    const $el = $(el);
    const type = $el.find('.result-info .itemtype').text().trim().toUpperCase();
    const heading = $el.find('.result-info .heading a');
    const title = heading.text().trim();
    const link = heading.attr('href');
    const subhead = $el.find('.result-info .subhead').text().trim();
    const imageUrl = $el.find('.art img').attr('src') || $el.find('.art img').attr('data-src');

    if (title && link) {
      results.push({ type, title, link, subhead, imageUrl });
    }
  });

  return results;
}

// Also search Bandcamp for artists/albums if track search yields nothing
async function searchBandcampAll(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://bandcamp.com/search?q=${encoded}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    timeout: 10000,
  });

  if (!res.ok) throw new Error(`Bandcamp search failed: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const results = [];

  $('.searchresult').each((i, el) => {
    const $el = $(el);
    const type = $el.find('.result-info .itemtype').text().trim().toUpperCase();
    const heading = $el.find('.result-info .heading a');
    const title = heading.text().trim();
    const link = heading.attr('href');
    const subhead = $el.find('.result-info .subhead').text().trim();
    const imageUrl = $el.find('.art img').attr('src') || $el.find('.art img').attr('data-src');

    if (title && link) {
      results.push({ type, title, link, subhead, imageUrl });
    }
  });

  return results;
}

app.post('/api/find', async (req, res) => {
  const { input } = req.body;
  if (!input || !input.trim()) {
    return res.status(400).json({ error: 'Input is required' });
  }

  try {
    let searchQuery = input.trim();
    let youtubeInfo = null;

    if (isYouTubeUrl(input)) {
      const videoId = extractYouTubeId(input);
      if (!videoId) {
        return res.status(400).json({ error: 'Could not extract YouTube video ID from URL' });
      }
      youtubeInfo = await getYouTubeInfo(videoId);
      searchQuery = cleanYouTubeTitle(youtubeInfo.title);

      // If the title doesn't include the channel name, prepend it for better search
      const channelClean = youtubeInfo.channel.replace(/\s*-\s*Topic$/i, '').trim();
      if (!searchQuery.toLowerCase().includes(channelClean.toLowerCase())) {
        searchQuery = `${channelClean} ${searchQuery}`;
      }
    }

    // Try track-specific search first
    let results = await searchBandcamp(searchQuery);

    // If no track results, fall back to general search
    if (results.length === 0) {
      results = await searchBandcampAll(searchQuery);
    }

    res.json({
      query: searchQuery,
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
