import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { TorrentEngine, type TorrentFileInfo } from "../../download/engine";
import { isVideo, isSubtitle, detectLanguage, parseEpisode, matchSubtitles } from "../../download/subtitles";
import { startStreamServer, type StreamServerInstance } from "../../download/stream";
import { launchMpv, isMpvAvailable, type PlayerSession } from "../../util/player";
import { formatBytes, cleanText } from "../../util/format";
import { Panel } from "./Panel";
import { Spinner } from "./Spinner";
import { COLOR, ICON } from "../theme";
import type { DownloadInput } from "../store";

export interface FileItem extends TorrentFileInfo {
  isVideo: boolean;
  isSubtitle: boolean;
  language?: string;
  season?: number;
  episode?: number;
}

interface FileModalProps {
  torrent: DownloadInput;
  width: number;
  height: number;
  onClose: () => void;
  onDownloadSelected: (selectedIndices: number[]) => void;
}

export function FileModal({
  torrent,
  width,
  height,
  onClose,
  onDownloadSelected,
}: FileModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState(0);

  // Streaming state
  const [streaming, setStreaming] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [activeStream, setActiveStream] = useState<StreamServerInstance | null>(null);
  const [activePlayer, setActivePlayer] = useState<PlayerSession | null>(null);

  // Fetch metadata on mount
  useEffect(() => {
    let alive = true;
    const engine = new TorrentEngine();

    engine
      .fetchMetadata(torrent.magnet, undefined, 30000)
      .then((meta) => {
        if (!alive) return;
        const allPaths = meta.files.map((f) => f.path);
        const mapped: FileItem[] = meta.files.map((f) => {
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

        setFiles(mapped);

        // Default selection: select all video files and their companion subtitles
        const defaultSelected = new Set<number>();
        const hasVideos = mapped.some((f) => f.isVideo);
        if (hasVideos) {
          mapped.forEach((f, idx) => {
            if (f.isVideo) defaultSelected.add(idx);
          });
          // Also select any companion subtitles
          mapped.forEach((f, idx) => {
            if (f.isSubtitle) defaultSelected.add(idx);
          });
        } else {
          mapped.forEach((_, idx) => defaultSelected.add(idx));
        }

        setSelected(defaultSelected);
        setLoading(false);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      })
      .finally(() => {
        engine.destroy();
      });

    return () => {
      alive = false;
      engine.destroy();
    };
  }, [torrent.magnet]);

  // Teardown streaming on unmount
  useEffect(() => {
    return () => {
      if (activePlayer) {
        try {
          activePlayer.proc.kill();
        } catch {}
      }
      if (activeStream) {
        void activeStream.close();
      }
    };
  }, [activeStream, activePlayer]);

  const startStreaming = async (fileIndex: number) => {
    const targetFile = files[fileIndex];
    if (!targetFile) return;

    setStreaming(true);
    setStreamStatus(`Connecting to swarm for ${cleanText(targetFile.name)}…`);

    const engine = new TorrentEngine();
    try {
      const torrentInst = await new Promise<import("webtorrent").Torrent>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("Timeout waiting for torrent engine")), 20000);
        engine.add(
          "modal-stream",
          torrent.magnet,
          "/tmp",
          {
            onMetadata: () => {
              clearTimeout(t);
              const inst = engine.getTorrent("modal-stream");
              if (inst) resolve(inst);
              else reject(new Error("Torrent not found"));
            },
            onError: (e) => {
              clearTimeout(t);
              reject(new Error(e));
            },
          },
          undefined,
          true,
        );
      });

      const server = await startStreamServer(torrentInst, fileIndex, { host: "127.0.0.1" });
      setActiveStream(server);

      const hasMpv = await isMpvAvailable("mpv");
      if (!hasMpv) {
        setStreamStatus(`Stream running on ${server.url} (mpv not found in PATH).`);
        return;
      }

      setStreamStatus(`Playing in mpv: ${server.url}`);
      const subUrls = server.subtitles.map((s) => s.url);
      const player = launchMpv({
        bin: "mpv",
        url: server.url,
        title: targetFile.name,
        subtitles: subUrls,
      });
      setActivePlayer(player);

      void player.exited.then(async () => {
        await server.close();
        engine.destroy();
        setActiveStream(null);
        setActivePlayer(null);
        setStreaming(false);
        setStreamStatus(null);
      });
    } catch (err) {
      setStreamStatus(`Stream error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      if (streaming) {
        if (activePlayer) {
          try {
            activePlayer.proc.kill();
          } catch {}
        }
        if (activeStream) {
          void activeStream.close();
        }
        setActiveStream(null);
        setActivePlayer(null);
        setStreaming(false);
        setStreamStatus(null);
        return;
      }
      onClose();
      return;
    }

    if (loading || error) return;

    if (key.upArrow || input === "k") {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor((c) => Math.min(files.length - 1, c + 1));
      return;
    }
    if (key.pageUp) {
      setCursor((c) => Math.max(0, c - 8));
      return;
    }
    if (key.pageDown) {
      setCursor((c) => Math.min(files.length - 1, c + 8));
      return;
    }

    // Toggle single selection
    if (input === " ") {
      setSelected((cur) => {
        const next = new Set(cur);
        if (next.has(cursor)) next.delete(cursor);
        else next.add(cursor);
        return next;
      });
      return;
    }

    // Toggle select all
    if (input === "a") {
      setSelected((cur) => {
        if (cur.size === files.length) return new Set();
        return new Set(files.map((_, i) => i));
      });
      return;
    }

    // Start streaming highlighted file
    if (input === "s" || input === "p") {
      if (!streaming) {
        void startStreaming(cursor);
      }
      return;
    }

    // Confirm download of selected
    if (key.return || input === "d") {
      const chosen = Array.from(selected);
      onDownloadSelected(chosen.length > 0 ? chosen : [cursor]);
      onClose();
    }
  });

  const currentFile = files[cursor];
  const companionSubs = useMemo(() => {
    if (!currentFile || !currentFile.isVideo) return [];
    return matchSubtitles(
      currentFile.path,
      files.map((f) => f.path),
    );
  }, [currentFile, files]);

  // Windowed file list calculation
  const visibleRows = Math.max(4, height - 7);
  const start = Math.max(0, Math.min(cursor - Math.floor(visibleRows / 2), files.length - visibleRows));
  const visibleFiles = files.slice(start, start + visibleRows);

  const totalSize = files.reduce((acc, f) => acc + f.length, 0);

  return (
    <Box flexDirection="column" width={width}>
      <Panel
        title={`files: ${cleanText(torrent.name)}`}
        width={width}
        focused
        height={height - 2}
      >
        {loading ? (
          <Box flexDirection="column" padding={1}>
            <Box>
              <Spinner />
              <Text> Connecting to swarm and fetching file tree…</Text>
            </Box>
            <Box marginTop={1}>
              <Text dimColor>Querying peers for torrent metadata. Press esc to cancel.</Text>
            </Box>
          </Box>
        ) : error ? (
          <Box flexDirection="column" padding={1}>
            <Text color={COLOR.bad}>Failed to fetch files: {error}</Text>
            <Box marginTop={1}>
              <Text dimColor>Press esc to return to results.</Text>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            {/* Header info */}
            <Box justifyContent="space-between" marginBottom={1}>
              <Text dimColor>
                {files.length} file{files.length === 1 ? "" : "s"} &bull; Total: {formatBytes(totalSize)}
              </Text>
              <Text color={selected.size > 0 ? COLOR.good : COLOR.alt}>
                {selected.size} of {files.length} selected for download
              </Text>
            </Box>

            {/* File List */}
            {visibleFiles.map((f, i) => {
              const actualIdx = start + i;
              const isHere = actualIdx === cursor;
              const isChecked = selected.has(actualIdx);

              let badge = "";
              let badgeColor = undefined;
              if (f.isVideo) {
                if (f.episode !== undefined) {
                  badge = f.season !== undefined ? `S${String(f.season).padStart(2, "0")}E${String(f.episode).padStart(2, "0")}` : `EP${f.episode}`;
                  badgeColor = COLOR.accent;
                } else {
                  badge = "Movie";
                  badgeColor = COLOR.accent;
                }
              } else if (f.isSubtitle) {
                badge = f.language ? `Sub: ${f.language}` : "Sub";
                badgeColor = COLOR.good;
              }

              return (
                <Box key={f.index} justifyContent="space-between">
                  <Box flexGrow={1} minWidth={0}>
                    <Text color={COLOR.accent}>{isHere ? `${ICON.pointer} ` : "  "}</Text>
                    <Text color={isChecked ? COLOR.good : undefined}>
                      {isChecked ? `[${ICON.done}] ` : "[ ] "}
                    </Text>
                    <Text
                      wrap="truncate-end"
                      color={isHere ? COLOR.accent : undefined}
                      bold={isHere}
                      dimColor={!isHere && !isChecked}
                    >
                      {f.name}
                    </Text>
                  </Box>

                  <Box flexShrink={0} marginLeft={1}>
                    {badge ? (
                      <Box marginRight={1}>
                        <Text color={badgeColor} bold={isHere}>
                          [{badge}]
                        </Text>
                      </Box>
                    ) : null}
                    <Text dimColor={!isHere} bold={isHere}>
                      {formatBytes(f.length)}
                    </Text>
                  </Box>
                </Box>
              );
            })}

            {/* Companion subtitles bar for highlighted video */}
            {companionSubs.length > 0 ? (
              <Box marginTop={1} paddingLeft={2}>
                <Text dimColor>
                  Subtitles:{" "}
                  {companionSubs.map((s, idx) => (
                    <Text key={idx} color={COLOR.good}>
                      {s.language ?? "Default"}
                      {idx < companionSubs.length - 1 ? ", " : ""}
                    </Text>
                  ))}
                </Text>
              </Box>
            ) : null}

            {/* Streaming status alert */}
            {streamStatus ? (
              <Box marginTop={1} padding={1} borderStyle="round" borderColor={COLOR.accent}>
                <Spinner />
                <Text bold color={COLOR.accent}> {streamStatus}</Text>
              </Box>
            ) : null}
          </Box>
        )}
      </Panel>

      {/* Hints */}
      <Box marginTop={1} justifyContent="space-between">
        <Box>
          <Text color={COLOR.accent} bold>␣</Text>
          <Text dimColor> toggle </Text>
          <Text color={COLOR.accent} bold>a</Text>
          <Text dimColor> all </Text>
          <Text color={COLOR.accent} bold>s / p</Text>
          <Text color={COLOR.good}> stream (mpv) </Text>
          <Text color={COLOR.accent} bold>↵</Text>
          <Text dimColor> download </Text>
        </Box>
        <Box>
          <Text color={COLOR.alt}>esc</Text>
          <Text dimColor> back</Text>
        </Box>
      </Box>
    </Box>
  );
}
