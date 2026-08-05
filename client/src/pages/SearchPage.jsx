import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { searchArchive, searchMetadata, getLibrary } from '../services/api';
import { MediaCard, ReadyBadge, Spinner, EmptyState } from '../components/ui';

export default function SearchPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const [archiveRes, setArchiveRes] = useState(null);
  const [metaRes, setMetaRes] = useState(null);
  const [libRes, setLibRes] = useState([]);
  const [busy, setBusy] = useState(false);

  const doSearch = useCallback(async (term) => {
    if (!term.trim()) { setArchiveRes(null); setMetaRes(null); setLibRes([]); return; }
    setBusy(true);
    // Resolve independently: pipeline + archive results render as soon as
    // they arrive; the external metadata lookup settles on its own and must
    // not block them (a blocked provider used to stall the whole search).
    let coreDone = 0;
    const markCore = () => { if (++coreDone >= 2) setBusy(false); };
    getLibrary()
      .then((lib) => {
        const needle = term.toLowerCase();
        setLibRes((lib?.items || []).filter((i) =>
          (i.title || '').toLowerCase().includes(needle) || (i.showName || '').toLowerCase().includes(needle)
        ));
      })
      .catch(() => setLibRes([]))
      .finally(markCore);
    searchArchive(term)
      .then((v) => setArchiveRes(v))
      .catch(() => setArchiveRes({ results: [], error: 'Archive unreachable' }))
      .finally(markCore);
    searchMetadata(term, 'any')
      .then((v) => setMetaRes(v))
      .catch(() => setMetaRes({ found: false }));
  }, []);

  useEffect(() => {
    const initial = params.get('q');
    if (initial) { setQ(initial); doSearch(initial); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e) => {
    e.preventDefault();
    setParams(q ? { q } : {});
    doSearch(q);
  };

  return (
    <div className="sb-app">
      <div className="page" style={{ paddingTop: 24 }}>
        <h1 className="page-title">Search</h1>
        <p className="page-sub">Legal films from the Internet Archive, your pipeline, and artwork database</p>

        <form className="search-bar" onSubmit={submit}>
          <div className="search-wrap">
            <Search />
            <input
              className="input"
              placeholder="Movies, shows, your magnets…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
            />
          </div>
          <button className="btn btn-primary" disabled={busy}>Go</button>
        </form>

        {busy && <Spinner label="Searching…" />}

        {!busy && archiveRes && (
          <>
            {libRes.length > 0 && (
              <>
                <h2 className="row-title" style={{ marginBottom: 12 }}>In your pipeline</h2>
                <div className="grid" style={{ marginBottom: 26 }}>
                  {libRes.map((item) => (
                    <MediaCard key={item.id} title={item.title} subtitle={item.kind}
                      poster={item.poster} badge={<ReadyBadge state={item.live?.readyState} />}
                      onClick={() => navigate('/library')} />
                  ))}
                </div>
              </>
            )}

            <h2 className="row-title" style={{ marginBottom: 4 }}>Internet Archive</h2>
            <p className="page-sub" style={{ marginBottom: 14 }}>
              {archiveRes.error ? archiveRes.error : `${archiveRes.numFound?.toLocaleString() || 0} public-domain results`}
            </p>
            {archiveRes.results?.length ? (
              <div className="grid">
                {archiveRes.results.map((it) => (
                  <MediaCard key={it.id} title={it.title} subtitle={it.year || ''} poster={it.poster}
                    onClick={() => navigate(`/title/archive/${it.id}`)} />
                ))}
              </div>
            ) : !archiveRes.error && <p className="page-sub">No archive results for “{q}”.</p>}

            {metaRes?.found && (
              <>
                <h2 className="row-title" style={{ margin: '26px 0 12px' }}>Show &amp; movie info</h2>
                <div className="grid">
                  {[metaRes.best, ...(metaRes.results || [])].filter(Boolean)
                    .filter((v, i, arr) => arr.findIndex((x) => x.id === v.id) === i)
                    .slice(0, 8)
                    .map((m) => (
                      <MediaCard key={m.id} title={m.title} subtitle={`${m.kind}${m.year ? ` · ${m.year}` : ''}`}
                        poster={m.poster}
                        onClick={() => {
                          if (m.kind === 'show') navigate(`/title/show/${encodeURIComponent(m.title)}`);
                          else navigate(`/search?q=${encodeURIComponent(m.title)}`);
                        }} />
                    ))}
                </div>
              </>
            )}
          </>
        )}

        {!busy && !archiveRes && <EmptyState emoji="🔎" title="Find something to watch">Search the legal public-domain catalog or your own pipeline.</EmptyState>}
      </div>
    </div>
  );
}
