/**
 * OpenRouter runtime sandbox — KERNEL enforcement, not string checks (design §16).
 *
 * macOS: a seatbelt profile (deny default; allow exec/fork; read everywhere; write ONLY under WORKDIR;
 * unix sockets for DNS; remote IP denied unless full-access; parameters passed as `-D`, NEVER
 * interpolated; cwd realpath'd because the kernel matches resolved paths).
 * Linux: bubblewrap (root read-only bind, cwd writable, minimal /dev + /proc, --unshare-pid,
 * --die-with-parent, --unshare-net when network is denied).
 *
 * Policy: ask = confine + no network + approvals; auto-edits = confine + no network + no approvals;
 * full-access = unconfined. Missing sandbox -> loud banner; missing approver -> DENY (callers enforce).
 *
 * The argv builders are pure + tested; running them needs the real kernel tools.
 */

import { realpathSync } from "node:fs";
import type { Permissions } from "../../shared/types.ts";

export interface SandboxSpec {
  argv: string[];
  confined: boolean;
  network: boolean;
}

export const SEATBELT_PROFILE = [
  "(version 1)",
  "(deny default)",
  "(allow process-exec)",
  "(allow process-fork)",
  "(allow sysctl-read)",
  "(allow file-read*)",
  '(allow file-write* (subpath (param "WORKDIR")))',
  "(allow network-outbound (remote unix))", // unix sockets for DNS; remote IP stays denied
].join("\n");

function realCwd(cwd: string): string {
  try { return realpathSync(cwd); } catch { return cwd; }
}

/** Build the sandbox-wrapped argv for a command under a permission policy (design §16). */
export function wrapSandbox(cmd: string[], cwd: string, perms: Permissions, platform: NodeJS.Platform = process.platform): SandboxSpec {
  if (perms === "full-access") return { argv: cmd, confined: false, network: true };

  const workdir = realCwd(cwd);
  if (platform === "darwin") {
    // Parameters passed as -D, never interpolated into the profile.
    return {
      argv: ["sandbox-exec", "-D", `WORKDIR=${workdir}`, "-p", SEATBELT_PROFILE, "--", ...cmd],
      confined: true, network: false,
    };
  }
  // Linux: bubblewrap.
  return {
    argv: [
      "bwrap", "--ro-bind", "/", "/", "--bind", workdir, workdir,
      "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "--die-with-parent", "--unshare-net",
      "--", ...cmd,
    ],
    confined: true, network: false,
  };
}
