import WebTorrent, { type Torrent } from "webtorrent";

export interface TorrentProgress {
  progress: number;
  downloaded: number;
  total: number;
  speed: number;
  uploadSpeed: number;
  uploaded: number;
  peers: number;
  timeRemaining: number;
  name: string;
}

export interface TorrentMeta {
  name: string;
  total: number;
  files: number;
  // The .torrent metadata (piece hashes), available once metadata arrives. We
  // persist it so a later re-seed can verify the on-disk file without having to
  // re-fetch metadata from the swarm (which a bare magnet would require).
  torrentFile?: Uint8Array;
}

export interface TorrentFileInfo {
  index: number;
  name: string;
  path: string;
  length: number;
}

export interface AddHandlers {
  onMetadata?: (meta: TorrentMeta, files?: TorrentFileInfo[]) => void;
  // webtorrent has checked any pieces already on disk against their hashes and
  // the torrent is ready to trade. On a large seed that check runs for minutes.
  onReady?: () => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class TorrentEngine {
  private client: WebTorrent | null = null;
  private torrents = new Map<string, Torrent>();

  private ensureClient(): WebTorrent {
    if (!this.client) {
      // On macOS, mDNSResponder occupies UDP port 5350 — the NAT-PMP
      // client port. Binding it fails asynchronously with EADDRINUSE,
      // and since the PMP client is a raw EventEmitter with no error
      // listener, the error surfaces as an uncaughtException that kills
      // the app the moment a download starts. NAT-PMP can never succeed
      // on macOS because the port is permanently taken, so disable it
      // and let UPnP handle NAT traversal instead.
      //
      // TORLINK_NO_UTP turns uTP off. It stays on by default, the way every
      // major client ships it, but webtorrent can exhaust the socket pool with
      // it: `utp-native` multiplexes perfectly well (UTP.prototype.connect
      // reuses an existing binding) and webtorrent already holds a bound uTP
      // socket on the TCP port, yet lib/torrent.js dials through the
      // module-level `UTP.connect`, which allocates a fresh UDP socket per
      // outgoing peer. Sockets then scale with peer count until the ephemeral
      // port pool or buffer space runs out (WSAENOBUFS on Windows, EMFILE
      // against the fd limit elsewhere), and a failed bind is re-emitted on an
      // emitter nothing listens to, so it arrives as an uncaughtException and
      // kills the process. The opt-out is a workaround until that dial path is
      // fixed upstream.
      const opts = {
        ...(process.env.TORLINK_NO_UTP ? { utp: false } : {}),
        ...(process.platform === "darwin" ? { natPmp: false } : {}),
      };
      this.client = new WebTorrent(opts);
      this.client.on("error", () => {});
    }
    return this.client;
  }

  // `source` is a magnet URI, an infoHash, or a path to a .torrent file. Seeding
  // an existing file passes the stored .torrent path so webtorrent can verify it
  // locally instead of re-fetching metadata from the swarm.
  // `announce` supplements whatever trackers are already in the source URI;
  // webtorrent dedupes internally.
  add(
    id: string,
    source: string,
    dir: string,
    handlers: AddHandlers,
    announce?: string[],
    deselect?: boolean,
  ): void {
    const client = this.ensureClient();
    const existing = this.torrents.get(id);
    if (existing) {
      this.torrents.delete(id);
      try {
        existing.destroy();
      } catch {}
    }

    const opts: { path: string; announce?: string[]; deselect?: boolean } = {
      path: dir,
      ...(announce && announce.length > 0 ? { announce } : {}),
      ...(deselect ? { deselect: true } : {}),
    };
    let torrent: Torrent;
    try {
      torrent = client.add(source, opts);
    } catch (e) {
      handlers.onError?.(message(e));
      return;
    }
    this.torrents.set(id, torrent);

    torrent.on("metadata", () => {
      handlers.onMetadata?.({
        name: torrent.name,
        total: torrent.length,
        files: torrent.files?.length ?? 0,
        torrentFile: torrent.torrentFile,
      });
    });
    torrent.on("ready", () => {
      handlers.onReady?.();
    });
    torrent.on("done", () => {
      // A finished torrent is a complete, verified torrent: keep it alive so it
      // can seed. The queue owns its lifetime from here (remove/destroy).
      handlers.onDone?.();
    });
    torrent.on("error", (err: unknown) => {
      handlers.onError?.(message(err));
      this.torrents.delete(id);
      try {
        torrent.destroy();
      } catch {}
    });
  }

  // The TCP port the client accepts incoming peers on (diagnostics / tests).
  listenPort(): number | null {
    return this.client?.torrentPort ?? null;
  }

  getTorrent(id: string): Torrent | undefined {
    return this.torrents.get(id);
  }

  // A torrent's file paths relative to its download dir, top-level folder
  // included; empty before metadata arrives or once the torrent is gone.
  filePaths(id: string): string[] {
    return (this.torrents.get(id)?.files ?? []).map((file) => file.path);
  }

  files(id: string): TorrentFileInfo[] {
    return (this.torrents.get(id)?.files ?? []).map((file, index) => ({
      index,
      name: file.name,
      path: file.path,
      length: file.length,
    }));
  }

  selectFiles(id: string, fileIndices: number[]): void {
    const t = this.torrents.get(id);
    if (!t?.files) return;
    const targets = new Set(fileIndices);
    t.files.forEach((file, index) => {
      if (targets.has(index)) {
        file.select();
      } else {
        file.deselect();
      }
    });
  }

  fetchMetadata(
    source: string,
    announce?: string[],
    timeoutMs = 25000,
  ): Promise<{ name: string; infoHash: string; files: TorrentFileInfo[] }> {
    return new Promise((resolve, reject) => {
      const client = this.ensureClient();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const done = (err?: Error, result?: { name: string; infoHash: string; files: TorrentFileInfo[] }) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try {
          torrent?.destroy();
        } catch {}
        if (err) reject(err);
        else if (result) resolve(result);
      };

      timer = setTimeout(() => {
        done(new Error("Fetching torrent metadata timed out"));
      }, timeoutMs);

      let torrent: Torrent;
      try {
        torrent = client.add(source, {
          path: "/tmp",
          ...(announce && announce.length > 0 ? { announce } : {}),
          deselect: true,
        });
      } catch (e) {
        done(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      torrent.on("metadata", () => {
        const files: TorrentFileInfo[] = (torrent.files || []).map((f, i) => ({
          index: i,
          name: f.name,
          path: f.path,
          length: f.length,
        }));
        done(undefined, {
          name: torrent.name,
          infoHash: torrent.infoHash,
          files,
        });
      });

      torrent.on("error", (err: unknown) => {
        done(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  stats(id: string): TorrentProgress | null {
    const t = this.torrents.get(id);
    if (!t) return null;

    let progress = 0;
    let downloaded = 0;
    let total = 0;
    let speed = 0;
    let uploadSpeed = 0;
    let uploaded = 0;
    let peers = 0;
    let timeRemaining = Infinity;
    let name = "";

    try {
      progress = t.progress || 0;
      downloaded = t.downloaded || 0;
      total = t.length || 0;
      speed = t.downloadSpeed || 0;
      uploadSpeed = t.uploadSpeed || 0;
      uploaded = t.uploaded || 0;
      peers = t.numPeers || 0;
      timeRemaining = typeof t.timeRemaining === "number" && !isNaN(t.timeRemaining) ? t.timeRemaining : Infinity;
      name = t.name || "";
    } catch {
      // Every stat is read inside this try on purpose: webtorrent getters can
      // throw before metadata parses and on a torrent in an error state, and
      // stats() runs from the poll interval, where an escaping throw is an
      // uncaught exception. Partial numbers beat a dead poller.
    }

    return {
      progress,
      downloaded,
      total,
      speed,
      uploadSpeed,
      uploaded,
      peers,
      timeRemaining,
      name,
    };
  }

  remove(id: string): void {
    const t = this.torrents.get(id);
    this.torrents.delete(id);
    if (t) {
      try {
        t.destroy();
      } catch {}
    }
  }

  destroy(): void {
    this.torrents.clear();
    // Never block shutdown on webtorrent's async teardown: hand off the client
    // destroy to a later tick and let the OS reclaim sockets if we exit first.
    const client = this.client;
    this.client = null;
    if (client) {
      setImmediate(() => {
        try {
          client.destroy();
        } catch {}
      });
    }
  }
}
