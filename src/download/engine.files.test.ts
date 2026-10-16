import { EventEmitter } from "node:events";
import { describe, it, expect, vi, afterEach } from "vitest";

class MockFile {
  name: string;
  path: string;
  length: number;
  selected = false;
  constructor(name: string, path: string, length: number) {
    this.name = name;
    this.path = path;
    this.length = length;
  }
  select() {
    this.selected = true;
  }
  deselect() {
    this.selected = false;
  }
}

class MockTorrent extends EventEmitter {
  name = "Mock Torrent";
  infoHash = "0123456789abcdef0123456789abcdef01234567";
  files: MockFile[] = [];
  destroy = vi.fn();
}

let lastMockTorrent: MockTorrent | null = null;
let lastAddOpts: Record<string, unknown> | null = null;

vi.mock("webtorrent", () => {
  return {
    default: class extends EventEmitter {
      torrentPort = 6881;
      add(_source: string, opts?: Record<string, unknown>): MockTorrent {
        lastAddOpts = opts ?? null;
        const t = new MockTorrent();
        lastMockTorrent = t;
        return t;
      }
      destroy(): void {}
    },
  };
});

afterEach(() => {
  lastMockTorrent = null;
  lastAddOpts = null;
  vi.resetModules();
});

describe("TorrentEngine file selection and metadata", () => {
  it("exposes files and allows selecting specific files while deselecting others", async () => {
    const { TorrentEngine } = await import("./engine");
    const engine = new TorrentEngine();

    engine.add(
      "hash1",
      "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
      "/tmp",
      {},
      undefined,
      true,
    );

    expect(lastAddOpts).toMatchObject({ deselect: true });

    const f1 = new MockFile("Episode 1.mkv", "Show/Episode 1.mkv", 1000);
    const f2 = new MockFile("Episode 2.mkv", "Show/Episode 2.mkv", 1200);
    lastMockTorrent!.files = [f1, f2];

    const files = engine.files("hash1");
    expect(files).toHaveLength(2);
    expect(files[0]!.name).toBe("Episode 1.mkv");
    expect(files[1]!.name).toBe("Episode 2.mkv");

    // Select file 0 only
    engine.selectFiles("hash1", [0]);
    expect(f1.selected).toBe(true);
    expect(f2.selected).toBe(false);

    // Select file 1 only
    engine.selectFiles("hash1", [1]);
    expect(f1.selected).toBe(false);
    expect(f2.selected).toBe(true);

    engine.destroy();
  });

  it("fetches metadata without downloading files", async () => {
    const { TorrentEngine } = await import("./engine");
    const engine = new TorrentEngine();

    const metaPromise = engine.fetchMetadata(
      "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
    );

    expect(lastAddOpts).toMatchObject({ deselect: true });

    lastMockTorrent!.name = "Test Movie";
    lastMockTorrent!.files = [
      new MockFile("Movie.mkv", "Movie.mkv", 5000000),
      new MockFile("Movie.en.srt", "Movie.en.srt", 10000),
    ];

    // Emit metadata event
    lastMockTorrent!.emit("metadata");

    const meta = await metaPromise;
    expect(meta.name).toBe("Test Movie");
    expect(meta.files).toHaveLength(2);
    expect(meta.files[0]!.name).toBe("Movie.mkv");
    expect(meta.files[1]!.name).toBe("Movie.en.srt");

    engine.destroy();
  });
});
