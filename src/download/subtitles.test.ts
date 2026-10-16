import { describe, expect, it } from "vitest";
import {
  isSubtitle,
  isVideo,
  parseEpisode,
  detectLanguage,
  matchSubtitles,
} from "./subtitles";

describe("subtitles utility", () => {
  it("identifies subtitle extensions correctly", () => {
    expect(isSubtitle("movie.srt")).toBe(true);
    expect(isSubtitle("movie.vtt")).toBe(true);
    expect(isSubtitle("movie.ass")).toBe(true);
    expect(isSubtitle("movie.mp4")).toBe(false);
    expect(isSubtitle("movie.nfo")).toBe(false);
  });

  it("identifies video extensions correctly", () => {
    expect(isVideo("movie.mp4")).toBe(true);
    expect(isVideo("movie.mkv")).toBe(true);
    expect(isVideo("movie.avi")).toBe(true);
    expect(isVideo("movie.srt")).toBe(false);
  });

  it("parses episode numbers from standard naming conventions", () => {
    expect(parseEpisode("Breaking.Bad.S01E03.1080p.mkv")).toEqual({
      season: 1,
      episode: 3,
    });
    expect(parseEpisode("Show.1x05.HDTV.mp4")).toEqual({
      season: 1,
      episode: 5,
    });
    expect(parseEpisode("[Group] Anime Title - 12 [1080p].mkv")).toEqual({
      episode: 12,
    });
    expect(parseEpisode("Series.EP08.720p.mkv")).toEqual({
      episode: 8,
    });
    expect(parseEpisode("Just A Movie (2024).mkv")).toBeNull();
  });

  it("detects language from filename tokens", () => {
    expect(detectLanguage("movie.en.srt")).toBe("English");
    expect(detectLanguage("movie.eng.srt")).toBe("English");
    expect(detectLanguage("movie.ar.srt")).toBe("Arabic");
    expect(detectLanguage("movie.Spanish.srt")).toBe("Spanish");
    expect(detectLanguage("movie.french.forced.srt")).toBe("French");
    expect(detectLanguage("movie.unknown.srt")).toBeUndefined();
  });

  it("matches subtitles for a movie with direct naming", () => {
    const allFiles = [
      "Inception (2010)/Inception.2010.1080p.mkv",
      "Inception (2010)/Inception.2010.1080p.en.srt",
      "Inception (2010)/Inception.2010.1080p.es.srt",
      "Inception (2010)/sample.mp4",
    ];

    const matched = matchSubtitles(
      "Inception (2010)/Inception.2010.1080p.mkv",
      allFiles,
    );

    expect(matched.length).toBe(2);
    expect(matched[0]!.name).toBe("Inception.2010.1080p.en.srt");
    expect(matched[0]!.language).toBe("English");
    expect(matched[1]!.name).toBe("Inception.2010.1080p.es.srt");
    expect(matched[1]!.language).toBe("Spanish");
  });

  it("matches subtitles across subdirectories for TV episodes", () => {
    const allFiles = [
      "Show.S02/Show.S02E01.mkv",
      "Show.S02/Show.S02E02.mkv",
      "Show.S02/Subs/Show.S02E01.en.srt",
      "Show.S02/Subs/Show.S02E01.fr.srt",
      "Show.S02/Subs/Show.S02E02.en.srt",
    ];

    const matchedE01 = matchSubtitles("Show.S02/Show.S02E01.mkv", allFiles);
    expect(matchedE01.length).toBe(2);
    expect(matchedE01.map((m) => m.name)).toEqual([
      "Show.S02E01.en.srt",
      "Show.S02E01.fr.srt",
    ]);

    const matchedE02 = matchSubtitles("Show.S02/Show.S02E02.mkv", allFiles);
    expect(matchedE02.length).toBe(1);
    expect(matchedE02[0]!.name).toBe("Show.S02E02.en.srt");
  });

  it("associates all subtitles in a single-video torrent", () => {
    const allFiles = [
      "Release/video.mkv",
      "Release/Subs/2_Eng.srt",
      "Release/Subs/3_Arabic.srt",
    ];

    const matched = matchSubtitles("Release/video.mkv", allFiles);
    expect(matched.length).toBe(2);
    expect(matched[0]!.name).toBe("2_Eng.srt");
    expect(matched[0]!.language).toBe("English");
    expect(matched[1]!.name).toBe("3_Arabic.srt");
    expect(matched[1]!.language).toBe("Arabic");
  });
});
