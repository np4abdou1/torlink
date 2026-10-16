import { TorrentEngine, type TorrentFileInfo } from "../download/engine";
import { formatBytes } from "../util/format";
import { isVideo, isSubtitle, detectLanguage, parseEpisode } from "../download/subtitles";
import { resolveTorrentPath } from "../sources/torrentPath";
import { magnetFromTorrentFile } from "../sources/torrentFile";

export interface ExploreOptions {
  target: string;
  json?: boolean;
}

export interface ExploredFile extends TorrentFileInfo {
  isVideo: boolean;
  isSubtitle: boolean;
  language?: string;
  season?: number;
  episode?: number;
}

export interface ExploreResult {
  name: string;
  infoHash: string;
  totalBytes: number;
  files: ExploredFile[];
}

export async function runExplore(options: ExploreOptions): Promise<void> {
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
  try {
    if (!options.json) {
      console.log(`Connecting to swarm and fetching metadata for ${source.slice(0, 40)}…`);
    }

    const meta = await engine.fetchMetadata(source);
    let totalBytes = 0;
    const files: ExploredFile[] = meta.files.map((f) => {
      totalBytes += f.length;
      const vid = isVideo(f.path);
      const sub = isSubtitle(f.path);
      const ep = parseEpisode(f.path);
      const lang = sub ? detectLanguage(f.path) : undefined;
      return {
        ...f,
        isVideo: vid,
        isSubtitle: sub,
        language: lang,
        season: ep?.season,
        episode: ep?.episode,
      };
    });

    const result: ExploreResult = {
      name: meta.name,
      infoHash: meta.infoHash,
      totalBytes,
      files,
    };

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    console.log("\n=======================================================");
    console.log(` Torrent: ${meta.name}`);
    console.log(` Hash:    ${meta.infoHash}`);
    console.log(` Files:   ${files.length}  |  Total Size: ${formatBytes(totalBytes)}`);
    console.log("=======================================================\n");

    const padIdx = String(files.length - 1).length;
    for (const f of files) {
      const idxStr = String(f.index).padStart(padIdx, " ");
      const sizeStr = formatBytes(f.length).padStart(9, " ");

      let tag = "";
      if (f.isVideo) {
        if (f.episode !== undefined) {
          const epStr = f.season !== undefined ? `S${String(f.season).padStart(2, "0")}E${String(f.episode).padStart(2, "0")}` : `EP${f.episode}`;
          tag = ` [Video: ${epStr}]`;
        } else {
          tag = " [Video]";
        }
      } else if (f.isSubtitle) {
        tag = ` [Sub: ${f.language ?? "Unknown"}]`;
      }

      console.log(` ${idxStr}. ${sizeStr}  ${f.path}${tag}`);
    }
    console.log("\nTip: Stream any file using: torlnk stream \"<magnet>\" --file <index>\n");
  } finally {
    engine.destroy();
  }
}
