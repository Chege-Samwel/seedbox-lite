/**
 * Per-user data stores — every session ticket gets an isolated workspace:
 *   library  — the magnet pipeline (user-added magnets with tags/artwork)
 *   history  — watch history with resume positions
 *   shows    — TV tracking: which episodes are watched per show
 */
const db = require('./jsondb');

function keyFor(ticketId) {
  return `user_${ticketId}`;
}

function blank() {
  return { library: [], history: [], shows: {}, favorites: [] };
}

function getUser(ticketId) {
  const data = db.read(keyFor(ticketId), blank());
  if (!data.library) data.library = [];
  if (!data.history) data.history = [];
  if (!data.shows) data.shows = {};
  if (!data.favorites) data.favorites = [];
  return data;
}

function saveUser(ticketId, data) {
  db.write(keyFor(ticketId), data);
}

// ---------- Library (magnet pipeline) ----------

function addLibraryItem(ticketId, item) {
  const data = getUser(ticketId);
  data.library.unshift(item);
  saveUser(ticketId, data);
  return item;
}

function updateLibraryItem(ticketId, itemId, patch) {
  const data = getUser(ticketId);
  const item = data.library.find((i) => i.id === itemId);
  if (!item) return null;
  Object.assign(item, {
    title: patch.title !== undefined ? String(patch.title).slice(0, 200) : item.title,
    kind: ['movie', 'episode', 'other'].includes(patch.kind) ? patch.kind : item.kind,
    showName: patch.showName !== undefined ? String(patch.showName).slice(0, 200) : item.showName,
    season: patch.season !== undefined ? patch.season : item.season,
    episode: patch.episode !== undefined ? patch.episode : item.episode,
    poster: patch.poster !== undefined ? patch.poster : item.poster,
    backdrop: patch.backdrop !== undefined ? patch.backdrop : item.backdrop,
    overview: patch.overview !== undefined ? String(patch.overview).slice(0, 2000) : item.overview,
    metaId: patch.metaId !== undefined ? patch.metaId : item.metaId,
    fileName: patch.fileName !== undefined ? patch.fileName : item.fileName,
    fileIndex: patch.fileIndex !== undefined ? patch.fileIndex : item.fileIndex,
    updatedAt: Date.now(),
  });
  saveUser(ticketId, data);
  return item;
}

function removeLibraryItem(ticketId, itemId) {
  const data = getUser(ticketId);
  const item = data.library.find((i) => i.id === itemId);
  data.library = data.library.filter((i) => i.id !== itemId);
  saveUser(ticketId, data);
  return item || null; // caller destroys the torrent if needed
}

// ---------- History ----------

function upsertHistory(ticketId, entry) {
  const data = getUser(ticketId);
  const existing = data.history.find((h) => h.key === entry.key);
  if (existing) {
    Object.assign(existing, entry, { updatedAt: Date.now() });
  } else {
    data.history.unshift({ ...entry, createdAt: Date.now(), updatedAt: Date.now() });
  }
  // Newest first, cap at 500 entries
  data.history.sort((a, b) => b.updatedAt - a.updatedAt);
  if (data.history.length > 500) data.history = data.history.slice(0, 500);
  saveUser(ticketId, data);
  return data.history.find((h) => h.key === entry.key);
}

function removeHistory(ticketId, key) {
  const data = getUser(ticketId);
  data.history = data.history.filter((h) => h.key !== key);
  saveUser(ticketId, data);
  return true;
}

function clearHistory(ticketId, keepInProgress = false) {
  const data = getUser(ticketId);
  data.history = keepInProgress
    ? data.history.filter((h) => h.duration && h.position / h.duration > 0 && h.position / h.duration < 0.9)
    : [];
  saveUser(ticketId, data);
  return true;
}

// ---------- Favorites ----------

function addFavorite(ticketId, entry) {
  const data = getUser(ticketId);
  if (!data.favorites.find((f) => f.key === entry.key)) {
    data.favorites.unshift({
      key: String(entry.key).slice(0, 200),
      title: String(entry.title || 'Untitled').slice(0, 200),
      poster: entry.poster || null,
      backdrop: entry.backdrop || null,
      kind: entry.kind || 'other',
      ref: entry.ref || null, // { type:'archive'|'show'|'library', id }
      addedAt: Date.now(),
    });
    if (data.favorites.length > 300) data.favorites = data.favorites.slice(0, 300);
    saveUser(ticketId, data);
  }
  return data.favorites;
}

function removeFavorite(ticketId, key) {
  const data = getUser(ticketId);
  data.favorites = data.favorites.filter((f) => f.key !== key);
  saveUser(ticketId, data);
  return data.favorites;
}

function getFavorites(ticketId) {
  return getUser(ticketId).favorites;
}

// ---------- Show tracking ----------

function setEpisodeWatched(ticketId, { showKey, showTitle, poster, season, episode, watched }) {
  const data = getUser(ticketId);
  if (!data.shows[showKey]) {
    data.shows[showKey] = { showKey, title: showTitle || showKey, poster: poster || null, episodes: {}, updatedAt: Date.now() };
  }
  const show = data.shows[showKey];
  if (showTitle) show.title = showTitle;
  if (poster) show.poster = poster;
  const epKey = `s${season}e${episode}`;
  if (watched) show.episodes[epKey] = { season, episode, watchedAt: Date.now() };
  else delete show.episodes[epKey];
  show.updatedAt = Date.now();
  // Drop show entirely if nothing left watched and user un-ticked everything
  saveUser(ticketId, data);
  return show;
}

module.exports = {
  getUser,
  addLibraryItem,
  updateLibraryItem,
  removeLibraryItem,
  upsertHistory,
  removeHistory,
  clearHistory,
  setEpisodeWatched,
  addFavorite,
  removeFavorite,
  getFavorites,
};
