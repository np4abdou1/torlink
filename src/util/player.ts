import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PlayerLaunchOptions {
  url: string;
  title?: string;
  subtitles?: string[];
  bin?: string;
  detached?: boolean;
}

export interface PlayerSession {
  proc: ChildProcess;
  exited: Promise<number | null>;
}

export function buildMpvArgs(options: {
  url: string;
  title?: string;
  subtitles?: string[];
}): string[] {
  const args: string[] = [
    options.url,
    `--title=${options.title ? `torlink: ${options.title}` : "torlink"}`,
    "--force-window=immediate",
    "--keep-open=no",
  ];

  if (options.subtitles && options.subtitles.length > 0) {
    for (const sub of options.subtitles) {
      args.push(`--sub-file=${sub}`);
    }
  }

  return args;
}

export async function isMpvAvailable(bin = "mpv"): Promise<boolean> {
  try {
    await execFileAsync(bin, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export function launchMpv(options: PlayerLaunchOptions): PlayerSession {
  const bin = options.bin || process.env.TORLINK_PLAYER || "mpv";
  const args = buildMpvArgs({
    url: options.url,
    title: options.title,
    subtitles: options.subtitles,
  });

  const proc = spawn(bin, args, {
    stdio: "ignore",
    detached: options.detached ?? false,
  });

  const exited = new Promise<number | null>((resolve) => {
    proc.once("error", () => resolve(-1));
    proc.once("exit", (code) => resolve(code));
  });

  return { proc, exited };
}
