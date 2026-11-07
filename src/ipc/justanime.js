// ── IPC: JustAnime (justanime.to) episode resolver ───────────────────────────
const https = require("https");
const { ipcMain } = require("electron");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BASE_WEB = "https://justanime.to";
const API_BASE = "https://core.justanime.to/api";

// In-memory cache for AniList IDs and server streams
const _idCache = new Map(); // key `${title}|${season}|${isMovie}` -> anilistId
const _streamCache = new Map(); // key `${anilistId}|${ep}|${mode}` -> stream object

function fetchJson(urlStr, { timeout = 6000, referer = BASE_WEB + "/" } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Referer: referer,
          Origin: BASE_WEB,
          Accept: "application/json, text/plain, */*",
        },
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const nextUrl = new URL(res.headers.location, urlStr).href;
          return fetchJson(nextUrl, { timeout, referer }).then(
            resolve,
            reject,
          );
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(
              new Error(`HTTP ${res.statusCode}: ${data.slice(0, 100)}`),
            );
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("Failed to parse JSON response"));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.end();
  });
}

function fetchAniList(search, isMovie = false) {
  return new Promise((resolve) => {
    const query = `query($search:String,$format:MediaFormat){Media(search:$search,type:ANIME,format:$format,sort:SEARCH_MATCH){id title{english romaji}episodes format relations{edges{relationType node{id type format title{english romaji}episodes startDate{year}seasonYear}}}}}`;
    const body = JSON.stringify({
      query,
      variables: {
        search,
        format: isMovie ? "MOVIE" : undefined,
      },
    });
    const req = https.request(
      "https://graphql.anilist.co",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json?.data?.Media || null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.setTimeout(6000, () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

async function resolveAnilistId(title, season = 1, isMovie = false) {
  const cacheKey = `${title.toLowerCase()}|${season}|${isMovie}`;
  if (_idCache.has(cacheKey)) return _idCache.get(cacheKey);

  const media = await fetchAniList(title, isMovie);
  if (!media) return null;
  if (isMovie || season <= 1) {
    _idCache.set(cacheKey, media.id);
    return media.id;
  }

  // For multi-season anime: traverse relations to find sequel of target season
  let current = media;
  for (let s = 2; s <= season; s++) {
    const edges = current.relations?.edges || [];
    const sequelEdge = edges.find(
      (e) =>
        e.relationType === "SEQUEL" &&
        e.node?.type === "ANIME" &&
        e.node?.format !== "SPECIAL",
    );
    if (!sequelEdge?.node?.id) break;
    current = sequelEdge.node;
    if (s === season) {
      _idCache.set(cacheKey, current.id);
      return current.id;
    }
  }
  _idCache.set(cacheKey, media.id);
  return media.id;
}

async function fetchServerStream(targetId, episodeNumber, server, mode) {
  const streamRes = await fetchJson(
    `${API_BASE}/watch/${targetId}/episode/${episodeNumber}/${server}`,
    { timeout: 4500 }
  );
  const streamObj =
    streamRes[mode] ||
    (mode === "dub" ? streamRes.sub : streamRes.dub);

  if (streamObj?.sources?.length > 0) {
    const primarySource = streamObj.sources[0];
    const subtitles = Array.isArray(streamObj.subtitles)
      ? streamObj.subtitles
      : [];
    const referer =
      streamObj.headers?.Referer || "https://justanime.to/";

    return {
      ok: true,
      url: primarySource.url,
      quality: primarySource.quality || "auto",
      isM3U8: primarySource.isM3U8 !== false,
      referer,
      subtitle: subtitles[0]?.file || null,
      subtitles,
      intro: streamObj.intro || null,
      outro: streamObj.outro || null,
      server,
      isDirectMp4: false,
    };
  }
  throw new Error(`No sources on server ${server}`);
}

const SERVER_PRIORITY = [
  "revo",
  "gigi",
  "momo",
  "nami",
  "calm",
  "onyx",
  "susi",
  "zone",
];

async function resolveJustAnime(event, args = {}) {
  const report = (stage) => {
    try {
      if (event?.sender && !event.sender.isDestroyed()) {
        event.sender.send("justanime-progress", { stage });
      }
    } catch {}
  };

  report("search");
  const title = typeof args.title === "string" ? args.title.trim() : "";
  const isMovie = args.isMovie === true;
  const season = Number(args.seasonNumber) || 1;
  const episodeNumber = isMovie ? 1 : Number(args.episodeNumber) || 1;
  const mode = args.translationType === "dub" ? "dub" : "sub";

  let targetId = Number(args.anilistId) || null;

  if (!targetId && title) {
    targetId = await resolveAnilistId(title, season, isMovie);
  }

  if (!targetId && title) {
    try {
      const searchRes = await fetchJson(
        `${API_BASE}/search/suggestions?query=${encodeURIComponent(title)}`,
        { timeout: 3500 }
      );
      const results = searchRes?.data || [];
      if (results.length > 0) {
        targetId = results[0].id;
      }
    } catch {}
  }

  if (!targetId) {
    return { ok: false, error: "Anime not found on JustAnime" };
  }

  report("stream");

  // Fast path: Race primary servers (revo and gigi) in parallel for near-instant resolution (~300ms)
  try {
    const fastResult = await Promise.any([
      fetchServerStream(targetId, episodeNumber, "revo", mode),
      fetchServerStream(targetId, episodeNumber, "gigi", mode),
    ]);
    if (fastResult?.ok) {
      report("player");
      return fastResult;
    }
  } catch {
    // Both fast candidates failed, proceed to fallback discovery
  }

  report("servers");
  let serversData = null;
  try {
    serversData = await fetchJson(
      `${API_BASE}/watch/${targetId}/episode/${episodeNumber}/servers`,
      { timeout: 5000 }
    );
  } catch (err) {
    return {
      ok: false,
      error: `Episode ${episodeNumber} servers unavailable on JustAnime`,
    };
  }

  const servers = serversData?.servers || {};
  const serverKeys = Object.keys(servers);
  if (!serverKeys.length) {
    return {
      ok: false,
      error: `No servers found for episode ${episodeNumber}`,
    };
  }

  const otherServers = SERVER_PRIORITY.filter(
    (s) => s !== "revo" && s !== "gigi" && servers[s] && servers[s][mode]
  ).concat(
    serverKeys.filter(
      (s) => s !== "revo" && s !== "gigi" && servers[s] && servers[s][mode]
    )
  );

  for (const s of otherServers) {
    try {
      const res = await fetchServerStream(targetId, episodeNumber, s, mode);
      if (res?.ok) {
        report("player");
        return res;
      }
    } catch {
      // try next server
    }
  }

  return {
    ok: false,
    error: `No playable stream found for episode ${episodeNumber} on JustAnime`,
  };
}

function register() {
  ipcMain.handle("resolve-justanime", async (event, args = {}) => {
    try {
      return await resolveJustAnime(event, args);
    } catch (e) {
      return {
        ok: false,
        error: e.message || "Failed to resolve stream on JustAnime",
      };
    }
  });
}

module.exports = {
  register,
  resolveJustAnime,
};
