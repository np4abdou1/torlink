import http from "node:http";
import { pipeline } from "node:stream";
import type { Torrent, TorrentFile } from "webtorrent";
import { contentType, parseRange } from "../daemon/files";
import { matchSubtitles, type MatchedSubtitle } from "./subtitles";

export interface StreamServerOptions {
  port?: number;
  host?: string;
}

export interface StreamSubtitle {
  index: number;
  name: string;
  path: string;
  url: string;
  language?: string;
  isForced: boolean;
}

export interface StreamServerInstance {
  url: string;
  port: number;
  file: TorrentFile;
  fileIndex: number;
  subtitles: StreamSubtitle[];
  close: () => Promise<void>;
}

/**
 * Starts a lightweight, range-aware HTTP streaming server for a specific torrent file.
 * Automatically prioritizes sequential piece downloading and serves companion subtitles.
 */
export async function startStreamServer(
  torrent: Torrent,
  targetFileIndex: number,
  options: StreamServerOptions = {},
): Promise<StreamServerInstance> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;

  const targetFile = torrent.files[targetFileIndex];
  if (!targetFile) {
    throw new Error(`Torrent file index ${targetFileIndex} out of bounds (total files: ${torrent.files.length})`);
  }

  // 1. Select the target file for streaming
  targetFile.select();

  // 2. Discover companion subtitles in the torrent and select them for fast download
  const allPaths = torrent.files.map((f) => f.path);
  const matchedSubs: MatchedSubtitle[] = matchSubtitles(targetFile.path, allPaths);

  const pathToIndex = new Map<string, number>();
  torrent.files.forEach((f, idx) => pathToIndex.set(f.path, idx));

  const streamSubs: StreamSubtitle[] = [];
  for (const sub of matchedSubs) {
    const idx = pathToIndex.get(sub.path);
    if (idx !== undefined && torrent.files[idx]) {
      // Prioritize subtitle download
      torrent.files[idx]!.select();
      streamSubs.push({
        index: idx,
        name: sub.name,
        path: sub.path,
        url: "", // will be populated once port is bound
        language: sub.language,
        isForced: sub.isForced,
      });
    }
  }

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url ?? "/", `http://${host}`);
    const pathname = parsedUrl.pathname;

    // CORS headers for web/player integration
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    // Health / Status endpoint
    if (pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          name: targetFile.name,
          length: targetFile.length,
          downloaded: targetFile.downloaded ?? 0,
          progress: targetFile.progress ?? 0,
          torrentProgress: torrent.progress,
          downloadSpeed: torrent.downloadSpeed,
          peers: torrent.numPeers,
        }),
      );
      return;
    }

    // Subtitle endpoint: /subtitles/:index
    if (pathname.startsWith("/subtitles/")) {
      const subIdxStr = pathname.slice("/subtitles/".length);
      const subIdx = Number.parseInt(subIdxStr, 10);
      const subFile = Number.isFinite(subIdx) ? torrent.files[subIdx] : undefined;

      if (!subFile) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Subtitle not found" }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": contentType(subFile.name),
        "Content-Length": String(subFile.length),
        "Content-Disposition": `inline; filename="${encodeURIComponent(subFile.name)}"`,
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      pipeline(subFile.createReadStream(), res, () => {});
      return;
    }

    // Video stream endpoint: / or /video or /stream
    const range = parseRange(req.headers.range, targetFile.length);
    if (range === "unsatisfiable") {
      res.writeHead(416, { "Content-Range": `bytes */${targetFile.length}` });
      res.end();
      return;
    }

    const type = contentType(targetFile.name);
    const headers: Record<string, string> = {
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      "Content-Disposition": `inline; filename="${encodeURIComponent(targetFile.name)}"`,
    };

    if (range) {
      const length = range.end - range.start + 1;
      res.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${targetFile.length}`,
        "Content-Length": String(length),
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      pipeline(
        targetFile.createReadStream({ start: range.start, end: range.end }),
        res,
        () => {},
      );
      return;
    }

    res.writeHead(200, {
      ...headers,
      "Content-Length": String(targetFile.length),
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    pipeline(targetFile.createReadStream(), res, () => {});
  });

  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("Unable to obtain stream server port"));
      }
    });
  });

  const baseUrl = `http://${host}:${boundPort}`;
  for (const s of streamSubs) {
    s.url = `${baseUrl}/subtitles/${s.index}`;
  }

  return {
    url: `${baseUrl}/`,
    port: boundPort,
    file: targetFile,
    fileIndex: targetFileIndex,
    subtitles: streamSubs,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
