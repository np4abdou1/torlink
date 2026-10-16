import path from "node:path";

export const SUBTITLE_EXTENSIONS = new Set([
  ".srt",
  ".vtt",
  ".ass",
  ".ssa",
  ".sub",
]);

export const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".avi",
  ".webm",
  ".mov",
  ".m4v",
  ".flv",
  ".wmv",
  ".ts",
]);

const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export interface MatchedSubtitle {
  path: string;
  name: string;
  language?: string;
  isForced: boolean;
}

export function isSubtitle(filePath: string): boolean {
  return SUBTITLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function isVideo(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Extracts season and episode numbers from a file path or title.
 * Handles patterns like:
 * - S01E02 / s1e2
 * - 1x02
 * - EP02 / ep.02
 * - [02] or - 02
 */
export function parseEpisode(
  filePath: string,
): { season?: number; episode: number } | null {
  const base = path.basename(filePath);

  // S01E02 or S1E2
  const seMatch = /\b[sS](\d{1,2})[eE](\d{1,3})\b/.exec(base);
  if (seMatch) {
    return {
      season: Number.parseInt(seMatch[1]!, 10),
      episode: Number.parseInt(seMatch[2]!, 10),
    };
  }

  // 1x02
  const xMatch = /\b(\d{1,2})x(\d{1,3})\b/.exec(base);
  if (xMatch) {
    return {
      season: Number.parseInt(xMatch[1]!, 10),
      episode: Number.parseInt(xMatch[2]!, 10),
    };
  }

  // E02 or EP02
  const epMatch = /\b(?:ep|e)[_.\s-]?(\d{1,3})\b/i.exec(base);
  if (epMatch) {
    return {
      episode: Number.parseInt(epMatch[1]!, 10),
    };
  }

  // Anime style: " - 02 " or " [02] "
  const animeMatch = /(?:[\s_-]|\[)(\d{2,3})(?:[\s_.\]-]|\.[a-zA-Z0-9]+$)/.exec(
    base,
  );
  if (animeMatch) {
    return {
      episode: Number.parseInt(animeMatch[1]!, 10),
    };
  }

  return null;
}

const COMMON_LANGUAGES: Record<string, string> = {
  en: "English",
  eng: "English",
  english: "English",
  es: "Spanish",
  spa: "Spanish",
  spanish: "Spanish",
  fr: "French",
  fre: "French",
  fra: "French",
  french: "French",
  de: "German",
  ger: "German",
  deu: "German",
  german: "German",
  it: "Italian",
  ita: "Italian",
  italian: "Italian",
  pt: "Portuguese",
  por: "Portuguese",
  portuguese: "Portuguese",
  ar: "Arabic",
  ara: "Arabic",
  arabic: "Arabic",
  ru: "Russian",
  rus: "Russian",
  russian: "Russian",
  ja: "Japanese",
  jpn: "Japanese",
  japanese: "Japanese",
  ko: "Korean",
  kor: "Korean",
  korean: "Korean",
  zh: "Chinese",
  chi: "Chinese",
  zho: "Chinese",
  chinese: "Chinese",
};

export function detectLanguage(filePath: string): string | undefined {
  const clean = path.basename(filePath, path.extname(filePath)).toLowerCase();
  const tokens = clean.split(/[._\s\-[\],()]+/);
  for (const token of tokens) {
    if (COMMON_LANGUAGES[token]) {
      return COMMON_LANGUAGES[token];
    }
  }
  return undefined;
}

/**
 * Matches companion subtitle files for a given video file within a list of torrent file paths.
 */
export function matchSubtitles(
  videoPath: string,
  allFilePaths: string[],
): MatchedSubtitle[] {
  const subs = allFilePaths.filter(isSubtitle);
  if (subs.length === 0) return [];

  const allVideos = allFilePaths.filter(isVideo);
  const isSingleVideoTorrent = allVideos.length === 1;

  const videoBase = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  const videoEp = parseEpisode(videoPath);

  const matched: MatchedSubtitle[] = [];

  for (const sub of subs) {
    const subName = path.basename(sub);
    const subBase = path.basename(sub, path.extname(sub)).toLowerCase();
    const isForced = /forced/i.test(subBase);
    const language = detectLanguage(sub);

    // 1. Direct name match (e.g. video "Movie.mkv", sub "Movie.en.srt")
    if (subBase.startsWith(videoBase) || subBase.includes(videoBase)) {
      matched.push({ path: sub, name: subName, language, isForced });
      continue;
    }

    // 2. Episode match for series
    if (videoEp) {
      const subEp = parseEpisode(sub);
      if (
        subEp &&
        subEp.episode === videoEp.episode &&
        (videoEp.season === undefined || subEp.season === undefined || subEp.season === videoEp.season)
      ) {
        matched.push({ path: sub, name: subName, language, isForced });
        continue;
      }
    }

    // 3. Subtitle in a folder matching the video name or directory
    const videoDir = path.dirname(videoPath).toLowerCase();
    const subDir = path.dirname(sub).toLowerCase();
    const subEp = parseEpisode(sub);
    if (videoEp && subEp && subEp.episode !== videoEp.episode) {
      continue;
    }
    if (subDir.includes(videoBase) || (videoDir !== "." && subDir.startsWith(videoDir))) {
      matched.push({ path: sub, name: subName, language, isForced });
      continue;
    }

    // 4. Single-video torrent: any subtitle file in the torrent is companion
    if (isSingleVideoTorrent) {
      matched.push({ path: sub, name: subName, language, isForced });
    }
  }

  // Deduplicate by path
  const seen = new Set<string>();
  const unique = matched.filter((m) => {
    if (seen.has(m.path)) return false;
    seen.add(m.path);
    return true;
  });

  // Sort: English first, then non-forced, then natural name sort
  return unique.sort((a, b) => {
    const aEng = a.language === "English" ? 0 : 1;
    const bEng = b.language === "English" ? 0 : 1;
    if (aEng !== bEng) return aEng - bEng;

    const aForced = a.isForced ? 1 : 0;
    const bForced = b.isForced ? 1 : 0;
    if (aForced !== bForced) return aForced - bForced;

    return natural.compare(a.name, b.name);
  });
}
