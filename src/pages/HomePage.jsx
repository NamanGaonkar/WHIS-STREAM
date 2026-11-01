import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import MediaCard from "../components/MediaCard";
import { PlayIcon, StarIcon, ChevronLeftIcon, ChevronRightIcon } from "../components/Icons";
import { imgUrl, tmdbFetch } from "../utils/api";
import { useRatings, getRatingForItem } from "../utils/useRatings";
import { isRestricted } from "../utils/ageRating";
import { loadHomeLayout } from "../utils/homeLayout";

function getRecentHistoryItems(history, count = 5) {
  if (!history || history.length === 0) return [];
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = history
    .filter((h) => h.watchedAt && h.watchedAt > thirtyDaysAgo)
    .sort((a, b) => b.watchedAt - a.watchedAt);

  const seen = new Set();
  const unique = [];
  for (const item of recent) {
    const key = `${item.media_type || "movie"}_${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
    if (unique.length >= count) break;
  }
  return unique;
}

// ── Netflix-style Horizontal Row with Slide Controls ─────────────────────────
function NetflixRow({ title, items, onSelect, ratingsMap, watched, onMarkWatched, onMarkUnwatched, progress = {} }) {
  const rowRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  const updateScrollState = useCallback(() => {
    if (!rowRef.current) return;
    const { scrollLeft, scrollWidth, clientWidth } = rowRef.current;
    setCanScrollLeft(scrollLeft > 10);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 10);
  }, []);

  useEffect(() => {
    updateScrollState();
    const el = rowRef.current;
    if (el) {
      el.addEventListener("scroll", updateScrollState, { passive: true });
      window.addEventListener("resize", updateScrollState);
    }
    return () => {
      if (el) el.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
    };
  }, [updateScrollState, items]);

  const scroll = (direction) => {
    if (!rowRef.current) return;
    const width = rowRef.current.clientWidth * 0.75;
    rowRef.current.scrollBy({
      left: direction === "left" ? -width : width,
      behavior: "smooth",
    });
  };

  if (!items || items.length === 0) return null;

  return (
    <div className="netflix-row-container">
      <div className="netflix-row-header">
        <h2 className="netflix-row-title">{title}</h2>
      </div>

      <div className="netflix-row-wrapper">
        {canScrollLeft && (
          <button
            className="netflix-slider-btn netflix-slider-left"
            onClick={() => scroll("left")}
            aria-label="Scroll left"
          >
            <ChevronLeftIcon />
          </button>
        )}

        <div className="netflix-row-track" ref={rowRef}>
          {items.map((item, idx) => {
            const type = item.media_type === "tv" ? "tv" : "movie";
            const pk =
              item.media_type === "movie"
                ? `movie_${item.id}`
                : `tv_${item.id}_s${item.season || 1}e${item.episode || 1}`;
            const rk = `${type}_${item.id}`;
            const rd = ratingsMap[rk] || {};

            return (
              <div key={`${type}_${item.id}_${idx}`} className="netflix-card-slot">
                <MediaCard
                  item={item}
                  onClick={() => onSelect(item)}
                  progress={progress[pk] || 0}
                  watched={watched}
                  onMarkWatched={onMarkWatched}
                  onMarkUnwatched={onMarkUnwatched}
                  ageRating={rd.cert}
                  restricted={rd.restricted}
                />
              </div>
            );
          })}
        </div>

        {canScrollRight && (
          <button
            className="netflix-slider-btn netflix-slider-right"
            onClick={() => scroll("right")}
            aria-label="Scroll right"
          >
            <ChevronRightIcon />
          </button>
        )}
      </div>
    </div>
  );
}

export default function HomePage({
  trending,
  trendingTV,
  loading,
  onSelect,
  progress,
  inProgress,
  offline,
  onRetry,
  watched,
  onMarkWatched,
  onMarkUnwatched,
  history,
  apiKey,
}) {
  const [heroIndex, setHeroIndex] = useState(0);
  const heroCandidates = useMemo(() => trending.slice(0, 5), [trending]);
  const hero = heroCandidates[heroIndex] || trending[0];

  const [recommendedItems, setRecommendedItems] = useState([]);
  const [topRatedItems, setTopRatedItems] = useState([]);

  // Auto-rotate hero every 10 seconds if candidate list has multiple
  useEffect(() => {
    if (heroCandidates.length <= 1) return;
    const interval = setInterval(() => {
      setHeroIndex((prev) => (prev + 1) % heroCandidates.length);
    }, 10000);
    return () => clearInterval(interval);
  }, [heroCandidates.length]);

  const [layout] = useState(() => loadHomeLayout());
  const { order: rowOrder, visible: rowVisible } = layout;

  const allItems = useMemo(
    () => [
      ...inProgress,
      ...trending.map((i) => ({ ...i, media_type: "movie" })),
      ...trendingTV.map((i) => ({ ...i, media_type: "tv" })),
      ...recommendedItems,
      ...topRatedItems,
    ],
    [inProgress, trending, trendingTV, recommendedItems, topRatedItems],
  );

  const { ratingsMap, ageLimitSetting } = useRatings(allItems);

  const enrichedRatingsMap = useMemo(() => {
    const out = {};
    for (const [k, v] of Object.entries(ratingsMap)) {
      out[k] = { ...v, restricted: isRestricted(v.minAge, ageLimitSetting) };
    }
    return out;
  }, [ratingsMap, ageLimitSetting]);

  const filteredRecommendedItems = useMemo(() => {
    return recommendedItems.filter((item) => {
      const rd = getRatingForItem(item, ratingsMap);
      return !isRestricted(rd.minAge, ageLimitSetting);
    });
  }, [recommendedItems, ratingsMap, ageLimitSetting]);

  // Fetch recommendations
  useEffect(() => {
    if (!apiKey || offline) return;
    const recent = getRecentHistoryItems(history, 5);
    if (recent.length === 0) {
      setRecommendedItems([]);
      return;
    }
    const controller = new AbortController();
    Promise.allSettled(
      recent.map((item) =>
        tmdbFetch(`/${item.media_type || "movie"}/${item.id}/recommendations`, apiKey),
      ),
    )
      .then((results) => {
        const pool = [];
        const seen = new Set();
        for (const item of recent) {
          seen.add(`${item.media_type || "movie"}_${item.id}`);
        }
        for (let i = 0; i < results.length; i++) {
          const res = results[i];
          if (res.status !== "fulfilled" || !res.value?.results) continue;
          const srcMediaType = recent[i].media_type || "movie";
          for (const rec of res.value.results) {
            const itemType = rec.media_type || srcMediaType;
            const key = `${itemType}_${rec.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            pool.push({ ...rec, media_type: itemType });
          }
        }
        setRecommendedItems(pool.slice(0, 24));
      })
      .catch((e) => {
        if (e.name !== "AbortError") console.warn("Recommendations fetch failed", e);
      });
    return () => controller.abort();
  }, [apiKey, history, offline]);

  // Fetch top rated
  useEffect(() => {
    if (!apiKey || offline) return;
    const controller = new AbortController();
    Promise.all([
      tmdbFetch("/movie/top_rated", apiKey),
      tmdbFetch("/tv/top_rated", apiKey),
    ])
      .then(([movieData, tvData]) => {
        const movies = (movieData.results || []).slice(0, 15).map((i) => ({ ...i, media_type: "movie" }));
        const tv = (tvData.results || []).slice(0, 15).map((i) => ({ ...i, media_type: "tv" }));
        const merged = [];
        const max = Math.max(movies.length, tv.length);
        for (let i = 0; i < max; i++) {
          if (movies[i]) merged.push(movies[i]);
          if (tv[i]) merged.push(tv[i]);
        }
        setTopRatedItems(merged);
      })
      .catch((e) => {
        if (e.name !== "AbortError") console.warn("Top rated fetch failed", e);
      });
    return () => controller.abort();
  }, [apiKey, offline]);

  const trendingMovieItems = useMemo(
    () => trending.map((i) => ({ ...i, media_type: "movie" })),
    [trending],
  );
  const trendingTVItems = useMemo(
    () => trendingTV.map((i) => ({ ...i, media_type: "tv" })),
    [trendingTV],
  );

  return (
    <div className="fade-in netflix-home">
      {offline && (
        <div className="netflix-offline">
          <div style={{ fontSize: 48 }}>📡</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text)" }}>
            No Internet Connection
          </div>
          <div style={{ fontSize: 14, color: "var(--text2)", maxWidth: 400, textAlign: "center" }}>
            Trending and discovery require an active internet connection. Your downloads and library remain ready offline.
          </div>
          <button className="btn btn-primary" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}

      {!offline && loading && (
        <div className="loader">
          <div className="spinner" />
        </div>
      )}

      {/* ── Netflix Cinematic Billboard Hero ── */}
      {!loading && hero && (
        <div className="netflix-hero">
          <div
            className="netflix-hero-bg"
            style={{
              backgroundImage: `url(${imgUrl(hero.backdrop_path, "original")})`,
            }}
          />
          <div className="netflix-hero-vignette" />
          <div className="netflix-hero-content">
            <div className="netflix-hero-badge">
              <span>WHIS EXCLUSIVE</span>
            </div>
            <h1 className="netflix-hero-title">{hero.title || hero.name}</h1>
            
            <div className="netflix-hero-meta">
              <span className="netflix-match-score">
                ★ {hero.vote_average ? (hero.vote_average * 10).toFixed(0) : "95"}% Match
              </span>
              <span className="netflix-year">
                {(hero.release_date || hero.first_air_date || "").slice(0, 4)}
              </span>
              <span className="netflix-badge-hd">Ultra 4K HD</span>
              <span className="netflix-badge-rating">
                {enrichedRatingsMap[`${hero.media_type || "movie"}_${hero.id}`]?.cert || "PG-13"}
              </span>
            </div>

            <p className="netflix-hero-overview">{hero.overview}</p>

            <div className="netflix-hero-actions">
              <button
                className="netflix-btn-play"
                onClick={() => onSelect(hero)}
              >
                <PlayIcon /> Play
              </button>
              <button
                className="netflix-btn-info"
                onClick={() => onSelect(hero)}
              >
                <span>ℹ</span> More Info
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Netflix Rows ── */}
      <div className="netflix-rows-section">
        {rowOrder.map((id) => {
          if (!rowVisible[id]) return null;

          if (id === "continue") {
            if (inProgress.length === 0) return null;
            return (
              <NetflixRow
                key="continue"
                title="Continue Watching for You"
                items={inProgress}
                onSelect={onSelect}
                ratingsMap={enrichedRatingsMap}
                watched={watched}
                onMarkWatched={onMarkWatched}
                onMarkUnwatched={onMarkUnwatched}
                progress={progress}
              />
            );
          }

          if (id === "trendingMovies") {
            return (
              <NetflixRow
                key="trendingMovies"
                title="Top Trending Movies"
                items={trendingMovieItems}
                onSelect={onSelect}
                ratingsMap={enrichedRatingsMap}
                watched={watched}
                onMarkWatched={onMarkWatched}
                onMarkUnwatched={onMarkUnwatched}
              />
            );
          }

          if (id === "trendingTV") {
            return (
              <NetflixRow
                key="trendingTV"
                title="Binge-Worthy TV Series"
                items={trendingTVItems}
                onSelect={onSelect}
                ratingsMap={enrichedRatingsMap}
                watched={watched}
                onMarkWatched={onMarkWatched}
                onMarkUnwatched={onMarkUnwatched}
              />
            );
          }

          if (id === "recommended") {
            if (filteredRecommendedItems.length === 0) return null;
            return (
              <NetflixRow
                key="recommended"
                title="Because You Watched"
                items={filteredRecommendedItems}
                onSelect={onSelect}
                ratingsMap={enrichedRatingsMap}
                watched={watched}
                onMarkWatched={onMarkWatched}
                onMarkUnwatched={onMarkUnwatched}
              />
            );
          }

          if (id === "topRated") {
            return (
              <NetflixRow
                key="topRated"
                title="Critically Acclaimed & Blockbusters"
                items={topRatedItems}
                onSelect={onSelect}
                ratingsMap={enrichedRatingsMap}
                watched={watched}
                onMarkWatched={onMarkWatched}
                onMarkUnwatched={onMarkUnwatched}
              />
            );
          }

          return null;
        })}
      </div>
    </div>
  );
}
