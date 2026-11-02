/**
 * `classifyCommand` reads a command step's argv (holes kept as text) before it runs: protected
 * actions wait for Israel's approval gate, and what hides its program is refused when saved. A
 * step with a shell can still do any of this inside a script; the gate is not a barrier.
 */
import type { CommandClass, ProtectedAction } from "./types.ts";

const basename = (value: string) => value.slice(value.lastIndexOf("/") + 1);
const shells = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const managers = new Set(["npm", "pnpm", "yarn", "bun", "vp"]);
const forbidden = new Map([
  ...["sudo", "su", "doas", "pkexec"].map((name) => [name, "changes execution identity"] as const),
  ...["crontab", "at"].map((name) => [name, "schedules host commands"] as const),
  ["xargs", "runs commands it reads"],
]);
const protectedPrograms = {
  restart: [
    "systemctl",
    "service",
    "shutdown",
    "reboot",
    "poweroff",
    "halt",
    "loginctl",
    "launchctl",
    "kill",
    "pkill",
    "killall",
  ],
  deploy: [
    "docker",
    "podman",
    "nerdctl",
    "kubectl",
    "helm",
    "railway",
    "flyctl",
    "fly",
    "vercel",
    "netlify",
    "heroku",
    "terraform",
    "pulumi",
    "ssh",
    "scp",
  ],
} satisfies Partial<Record<ProtectedAction, readonly string[]>>;
const wrappers = new Set(["env", "nice", "nohup", "time", "timeout", "stdbuf"]);
const valueOptions: Readonly<Record<string, readonly string[]>> = {
  env: ["-u"],
  nice: ["-n"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  stdbuf: ["-i", "-o", "-e"],
  git: ["-C", "-c", "--git-dir", "--work-tree"],
};
const ghRead: Readonly<Record<string, readonly string[]>> = {
  pr: ["view", "list", "diff", "checks", "status"],
  issue: ["view", "list"],
  run: ["view", "list", "watch"],
  repo: ["view"],
  release: ["view", "list"],
};
const SETTINGS_FILE = /(^|\/)\.t3\/userdata\/settings\.json$/;
const settingsReaders = new Set([
  "cat",
  "less",
  "head",
  "tail",
  "grep",
  "rg",
  "jq",
  "diff",
  "wc",
  "stat",
  "ls",
  "file",
  "sha256sum",
  "md5sum",
]);
const deploy = /(^|[-_.])(deploy|cutover|release|publish|rollout)([-_.]|$)/i;
const interpreters = new Set([
  "node",
  "bun",
  "deno",
  "tsx",
  "ts-node",
  "python",
  "python3",
  "bash",
  "sh",
  "zsh",
]);
/** Options that run inline code, short flags combined or with the code attached (`-pe`, `-cprint(1)`). */
const inlineOptions: Readonly<Record<string, RegExp>> = {
  node: /^(-[^-]*[ep]|--(eval|print)(=|$))/,
  bun: /^(-[^-]*[ep]|--(eval|print)(=|$))/,
  perl: /^-[^-]*[eE]/,
  ruby: /^-[^-]*[eE]/,
  osascript: /^-[^-]*e/,
  python: /^-[^-]*c/,
  shell: /^(-[^-]*c|--command(=|$))/,
};

/** Classifies literal argv before execution. */
export const classifyCommand = (argv: ReadonlyArray<string>): CommandClass => {
  const program = argv[0] ?? "";
  const deny = (reason: string): CommandClass => ({ kind: "forbidden", reason });
  if (program.includes("{{")) return deny("the program must be a literal");
  const name = basename(program);
  const args = argv.slice(1);
  if (wrappers.has(name)) {
    let index = 0;
    while (index < args.length) {
      const arg = args[index] ?? "";
      if (arg === "--") {
        index++;
        break;
      }
      if (name === "env" && (/^-[^-]*S/.test(arg) || arg.startsWith("--split-string")))
        return deny("env -S hides the command in a string");
      if (arg.startsWith("-")) {
        index += valueOptions[name]?.includes(arg) ? 2 : 1;
        continue;
      }
      if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
        index++;
        continue;
      }
      break;
    }
    if (name === "timeout") index++;
    return classifyCommand(args.slice(index));
  }
  const reason = forbidden.get(name);
  if (reason) return deny(reason);
  const python = /^python3(?:\.\d+)?$/.test(name) || name === "python";
  const scriptIndex = args.findIndex((arg) => !arg.startsWith("-"));
  const script = scriptIndex < 0 ? undefined : args[scriptIndex];
  const options = scriptIndex < 0 ? args : args.slice(0, scriptIndex);
  const inline = inlineOptions[shells.has(name) ? "shell" : python ? "python" : name];
  if (
    (shells.has(name) && !script) ||
    (inline !== undefined && options.some((arg) => inline.test(arg))) ||
    (name === "deno" && args[0] === "eval")
  )
    return { kind: "inline-shell", reason: "executes inline code or reads commands from stdin" };
  const protect = (action: ProtectedAction, reason: string): CommandClass => ({
    kind: "protected",
    action,
    reason,
  });
  for (const [action, programs] of Object.entries(protectedPrograms)) {
    if (programs.includes(name)) {
      return protect(
        action === "restart" ? "restart" : "deploy",
        "controls host processes or infrastructure",
      );
    }
  }
  const settingsAt = (arg: string | undefined) => arg !== undefined && SETTINGS_FILE.test(arg);
  const operands = args.filter((arg) => !arg.startsWith("-"));
  // Readers and a copy out of the file only read it; any other program that names it may write.
  const writesSettings = settingsReaders.has(name)
    ? false
    : name === "cp"
      ? settingsAt(operands.at(-1))
      : args.some(settingsAt);
  if (writesSettings) return protect("settings", "changes T3 settings");
  if (name === "git") {
    let index = 0;
    while (args[index]?.startsWith("-"))
      index += valueOptions.git?.includes(args[index] ?? "") ? 2 : 1;
    if (args[index] === "push") {
      const pushArgs = args.slice(index + 1);
      if (
        pushArgs.some(
          (arg) =>
            arg === "--force" ||
            arg.startsWith("--force-with-lease") ||
            arg === "--force-if-includes" ||
            /^-[^-]*f/.test(arg) ||
            arg.startsWith("+"),
        )
      )
        return protect("force-push", "force pushes git changes");
      const refspecs = pushArgs.filter((arg) => !arg.startsWith("-")).slice(1);
      if (
        pushArgs.some((arg) => ["--all", "--mirror", "--tags"].includes(arg)) ||
        refspecs.length === 0 ||
        refspecs.some(
          (refspec) => !/^(?:refs\/heads\/)?wf\/.+/.test(refspec.split(":").at(-1) ?? ""),
        )
      )
        return protect("merge", "pushes outside an explicit workflow branch");
    }
    if (args[index] === "send-email") return protect("deploy", "publishes git changes");
  }
  if (name === "gh" && args[0] !== "search" && !ghRead[args[0] ?? ""]?.includes(args[1] ?? ""))
    return protect(args[0] === "pr" && args[1] === "merge" ? "merge" : "deploy", "changes GitHub");
  if ((managers.has(name) || name === "cargo") && args[0] === "publish")
    return protect("deploy", "publishes a package");
  // Package managers run scripts as `run <script>` and, except npm, as `<script>` alone.
  const managerScript = managers.has(name)
    ? ((args[0] === "run" || args[0] === "run-script" ? args[1] : args[0]) ?? "")
    : "";
  if (managerScript === "restart" || managerScript === "stop")
    return protect("restart", "runs a package restart or stop script");
  if (
    ["update-mac-app.sh", "publish-mac-app.sh"].includes(name) ||
    deploy.test(name) ||
    ((interpreters.has(name) || python) &&
      script !== undefined &&
      (["update-mac-app.sh", "publish-mac-app.sh"].includes(basename(script)) ||
        deploy.test(basename(script)))) ||
    deploy.test(managerScript)
  )
    return protect("deploy", "runs a deployment or publishing script");
  if (name === "rm") {
    const flags = args.filter((arg) => arg.startsWith("-"));
    const recursive = flags.some(
      (arg) => arg === "--recursive" || /^-[^-]*r/.test(arg) || /^-[^-]*R/.test(arg),
    );
    const force = flags.some((arg) => arg === "--force" || /^-[^-]*f/.test(arg));
    if (recursive && force && args.some((arg) => ["/", "~", "~/", "$HOME", "/*"].includes(arg)))
      return deny("recursively removes a host root or home");
  }
  return { kind: "allowed" };
};

/** Checks whether argv already cites the shared serialization wrapper. */
export const citesHeavyScript = (argv: ReadonlyArray<string>): boolean =>
  argv.some((arg) => basename(arg) === "heavy.sh");
