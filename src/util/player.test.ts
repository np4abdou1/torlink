import { describe, expect, it } from "vitest";
import { buildMpvArgs, isMpvAvailable } from "./player";

describe("player utility", () => {
  it("builds correct mpv arguments with title and subtitles", () => {
    const args = buildMpvArgs({
      url: "http://127.0.0.1:9160/",
      title: "Sample Movie (2024)",
      subtitles: ["http://127.0.0.1:9160/subtitles/1", "/tmp/subs/arabic.srt"],
    });

    expect(args[0]).toBe("http://127.0.0.1:9160/");
    expect(args).toContain("--title=torlink: Sample Movie (2024)");
    expect(args).toContain("--force-window=immediate");
    expect(args).toContain("--keep-open=no");
    expect(args).toContain("--sub-file=http://127.0.0.1:9160/subtitles/1");
    expect(args).toContain("--sub-file=/tmp/subs/arabic.srt");
  });

  it("builds minimal mpv arguments when title and subtitles are omitted", () => {
    const args = buildMpvArgs({
      url: "http://127.0.0.1:9160/",
    });

    expect(args[0]).toBe("http://127.0.0.1:9160/");
    expect(args).toContain("--title=torlink");
    expect(args.some((a) => a.startsWith("--sub-file="))).toBe(false);
  });

  it("detects player binary availability correctly", async () => {
    // 'node' is guaranteed to exist on CI and developer machines
    const nodeAvailable = await isMpvAvailable("node");
    expect(nodeAvailable).toBe(true);

    const mpvAvailable = await isMpvAvailable("mpv");
    expect(typeof mpvAvailable).toBe("boolean");

    const nonExistent = await isMpvAvailable("non_existent_player_binary_12345");
    expect(nonExistent).toBe(false);
  });
});
