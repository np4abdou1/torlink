import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Torrent, TorrentFile } from "webtorrent";
import { startStreamServer } from "./stream";

function createMockTorrentFile(name: string, path: string, length: number): TorrentFile {
  let selected = false;
  return {
    name,
    path,
    length,
    downloaded: 0,
    progress: 0,
    select: () => {
      selected = true;
    },
    deselect: () => {
      selected = false;
    },
    createReadStream: (opts?: { start?: number; end?: number }) => {
      const start = opts?.start ?? 0;
      const end = opts?.end ?? length - 1;
      const chunk = Buffer.alloc(end - start + 1, "A");
      return Readable.from([chunk]);
    },
  };
}

describe("startStreamServer", () => {
  it("streams video with HTTP 200 and HTTP 206 Range headers", async () => {
    const videoFile = createMockTorrentFile("Episode 1.mp4", "Show/Episode 1.mp4", 1000);
    const subFile = createMockTorrentFile("Episode 1.en.srt", "Show/Episode 1.en.srt", 200);

    const mockTorrent = {
      name: "Mock Torrent",
      files: [videoFile, subFile],
      progress: 0.5,
      downloadSpeed: 1024,
      numPeers: 10,
    } as unknown as Torrent;

    const stream = await startStreamServer(mockTorrent, 0, { host: "127.0.0.1" });
    try {
      expect(stream.url).toContain("http://127.0.0.1:");
      expect(stream.port).toBeGreaterThan(0);
      expect(stream.subtitles).toHaveLength(1);
      expect(stream.subtitles[0]!.name).toBe("Episode 1.en.srt");
      expect(stream.subtitles[0]!.url).toBe(`${stream.url}subtitles/1`);

      // Test 1: Full file request
      const fullRes = await fetch(stream.url);
      expect(fullRes.status).toBe(200);
      expect(fullRes.headers.get("content-type")).toBe("video/mp4");
      expect(fullRes.headers.get("content-length")).toBe("1000");
      const fullBuf = await fullRes.arrayBuffer();
      expect(fullBuf.byteLength).toBe(1000);

      // Test 2: HTTP Range request (e.g. seeking or buffering)
      const rangeRes = await fetch(stream.url, {
        headers: { Range: "bytes=100-199" },
      });
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get("content-range")).toBe("bytes 100-199/1000");
      expect(rangeRes.headers.get("content-length")).toBe("100");
      const rangeBuf = await rangeRes.arrayBuffer();
      expect(rangeBuf.byteLength).toBe(100);

      // Test 3: Subtitle endpoint
      const subRes = await fetch(stream.subtitles[0]!.url);
      expect(subRes.status).toBe(200);
      expect(subRes.headers.get("content-length")).toBe("200");
      const subBuf = await subRes.arrayBuffer();
      expect(subBuf.byteLength).toBe(200);

      // Test 4: Status endpoint
      const statusRes = await fetch(`${stream.url}status`);
      expect(statusRes.status).toBe(200);
      const statusJson = (await statusRes.json()) as { name: string; peers: number };
      expect(statusJson.name).toBe("Episode 1.mp4");
      expect(statusJson.peers).toBe(10);
    } finally {
      await stream.close();
    }
  });
});
