import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { TorrentEngine } from "../download/engine";
import { startStreamServer } from "../download/stream";
import { isVideo, parseEpisode } from "../download/subtitles";
import { launchMpv, isMpvAvailable } from "../util/player";
import { formatBytes } from "../util/format";
import { resolveTorrentPath } from "../sources/torrentPath";
import { magnetFromTorrentFile } from "../sources/torrentFile";

export interface StreamCliOptions {
  target: string;
  fileIndex?: number;
  episode?: number;
  port?: number;
  player?: string;
  noPlayer?: boolean;
}

export async function runStream(options: StreamCliOptions): Promise<void> {
  let source = options.target.trim();

  // Handle local .torrent file
  const torrentPath = resolveTorrentPath(source);
  if (torrentPath) {
    const parsed = await magnetFromTorrentFile(torrentPath);
    if (!parsed) {
      console.error(`error: failed to read .torrent file '${torrentPath}'`);
      process.exit(1);
      return;
    }
    source = parsed.magnet;
  }

  const engine = new TorrentEngine();
  const tmpDir = path.join(os.tmpdir(), "torlink-stream-" + Date.now());
  await fs.mkdir(tmpDir, { recursive: true }).catch(() => {});

  console.log(`Connecting to swarm and fetching metadata for streaming…`);

  // We add the torrent to engine with deselect: true so pieces only download on stream demand
  const torrent = await new Promise<import("webtorrent").Torrent>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Connecting to peers and fetching torrent metadata timed out"));
    }, 30000);

    engine.add(
      "stream-torrent",
      source,
      tmpDir,
      {
        onMetadata: () => {
          clearTimeout(timer);
          const t = engine.getTorrent("stream-torrent");
          if (t) resolve(t);
          else reject(new Error("Torrent not found after metadata"));
        },
        onError: (err) => {
          clearTimeout(timer);
          reject(new Error(err));
        },
      },
      undefined,
      true, // deselect all pieces initially
    );
  });

  const files = torrent.files;
  if (!files || files.length === 0) {
    console.error("error: no files found in torrent");
    engine.destroy();
    process.exit(1);
    return;
  }

  // Determine target file index
  let targetIndex = options.fileIndex;
  if (targetIndex === undefined && options.episode !== undefined) {
    const epTarget = options.episode;
    const match = files.findIndex((f) => {
      if (!isVideo(f.path)) return false;
      const parsedEp = parseEpisode(f.path);
      return parsedEp?.episode === epTarget;
    });
    if (match >= 0) {
      targetIndex = match;
    } else {
      console.error(`error: no video file found matching episode ${epTarget}`);
      engine.destroy();
      process.exit(1);
      return;
    }
  }

  // Default: find largest video file (for movies) or first video file
  if (targetIndex === undefined) {
    const videoFiles = files
      .map((f, i) => ({ index: i, length: f.length, path: f.path }))
      .filter((f) => isVideo(f.path))
      .sort((a, b) => b.length - a.length);

    if (videoFiles.length > 0) {
      targetIndex = videoFiles[0]!.index;
    } else {
      // Fallback to largest file overall
      const sorted = files
        .map((f, i) => ({ index: i, length: f.length }))
        .sort((a, b) => b.length - a.length);
      targetIndex = sorted[0]!.index;
    }
  }

  const selectedFile = files[targetIndex];
  if (!selectedFile) {
    console.error(`error: file index ${targetIndex} out of bounds`);
    engine.destroy();
    process.exit(1);
    return;
  }

  console.log(`Selected: ${selectedFile.name} (${formatBytes(selectedFile.length)})`);

  // Start HTTP stream server
  const server = await startStreamServer(torrent, targetIndex, {
    port: options.port,
    host: "127.0.0.1",
  });

  console.log(`\nStream server live at: ${server.url}`);
  if (server.subtitles.length > 0) {
    console.log(`Detected ${server.subtitles.length} companion subtitle(s):`);
    for (const sub of server.subtitles) {
      console.log(`  - [${sub.language ?? "Default"}] ${sub.name}`);
    }
  }

  if (options.noPlayer) {
    console.log("\nPress Ctrl+C to stop streaming.\n");
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => resolve());
      process.on("SIGTERM", () => resolve());
    });
    await server.close();
    engine.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return;
  }

  const playerBin = options.player ?? process.env.TORLINK_PLAYER ?? "mpv";
  const playerInstalled = await isMpvAvailable(playerBin);

  if (!playerInstalled) {
    console.log(`\nNote: Media player '${playerBin}' not found in PATH.`);
    console.log(`You can play the live stream directly with any player by opening:`);
    console.log(`  ${server.url}\n`);
    console.log("Press Ctrl+C to stop the stream server.");
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => resolve());
      process.on("SIGTERM", () => resolve());
    });
    await server.close();
    engine.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return;
  }

  console.log(`\nLaunching ${playerBin}…`);
  const subtitleUrls = server.subtitles.map((s) => s.url);
  const session = launchMpv({
    bin: playerBin,
    url: server.url,
    title: selectedFile.name,
    subtitles: subtitleUrls,
  });

  // Keep server alive until player exits or user cancels
  await Promise.race([
    session.exited,
    new Promise<void>((resolve) => {
      process.on("SIGINT", () => resolve());
      process.on("SIGTERM", () => resolve());
    }),
  ]);

  console.log("\nPlayback ended, tearing down stream server…");
  try {
    session.proc.kill();
  } catch {}
  await server.close();
  engine.destroy();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}
