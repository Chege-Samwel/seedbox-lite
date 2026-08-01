# Legal Notice & Content Responsibility

**SeedBox Lite is a neutral media tool.** It ships with no media content and no links to
copyrighted catalogs. The built-in browse experience sources the Internet Archive's
public-domain and openly licensed collections only.

## User responsibility

Any magnet link or torrent file added to a pipeline is fetched and played back **solely at
that user's initiative**. Users must only add content they own, hold a license for, or are
otherwise legally entitled to access under the laws of their jurisdiction.

The operators and authors of this software act purely as a storage and transmission tool
and **accept no liability** for content users choose to retrieve, store, or view through it.
Misuse of third-party copyrighted material may expose the **user** — not the operator — to
civil or criminal liability under applicable copyright law (for example, Kenya's Copyright
Act 2001, the US DMCA, or EU CDSM Directive 2019/790).

## Data handling

- Watch history, resume points, pipeline configuration, favorites, and login tickets are
  stored on the operator's server disk and tied to the user's login ticket.
- Streamed file chunks are buffered **temporarily** on server disk in a capped rolling
  window and are **automatically deleted** as playback advances and when streams end.
- No analytics, telemetry, advertising, or third-party tracking is present anywhere in the
  software. The only outbound traffic is functional: the metadata/artwork APIs configured
  by the operator and the BitTorrent protocol traffic for user-added torrents.

## Consent & storage in the browser

The app offers a storage-consent banner. Accepting stores the login session and UI
preferences in the browser (auto-login). Choosing "Essential only" keeps everything
tab-scoped; nothing persists after the tab closes.
