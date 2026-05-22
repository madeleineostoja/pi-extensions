export interface FsPolicy {
  allowRead: string[];
  allowWrite: string[];
  denyPatterns: string[];
}

export interface NetworkPolicy {
  mode: "non-interactive-only" | "always" | "off";
  allow: string[];
}

export interface AuditPolicy {
  log: boolean;
  logFile: string;
}

export interface EnforcementPolicy {
  requireKernelSandbox: boolean;
}

export interface Policy {
  enabled: boolean;
  fs: FsPolicy;
  network: NetworkPolicy;
  audit: AuditPolicy;
  enforcement: EnforcementPolicy;
}

export const DEFAULT_POLICY: Policy = {
  enabled: true,
  fs: {
    allowRead: [
      "<cwd>",
      "~/.cache",
      "~/.config",
      "~/.pi",
      "/usr",
      "/etc",
      "/opt",
      "/Library/Developer",
      "/private/etc",
    ],
    allowWrite: ["<cwd>", "~/.cache/pi", "~/.pi/agent/logs"],
    denyPatterns: [
      "<cwd>/**/.env",
      "<cwd>/**/.env.*",
      "~/.ssh/**",
      "~/.aws/credentials",
      "~/.aws/config",
      "~/.gnupg/**",
      "<cwd>/**/id_rsa",
      "<cwd>/**/id_ed25519",
      "<cwd>/**/*.pem",
      "<cwd>/**/*.key",
      "<cwd>/**/*.p12",
      "~/.netrc",
    ],
  },
  network: {
    mode: "non-interactive-only",
    allow: [
      "github.com",
      "*.github.com",
      "*.githubusercontent.com",
      "api.github.com",
      "registry.npmjs.org",
      "*.npmjs.org",
      "pypi.org",
      "*.pypi.org",
      "files.pythonhosted.org",
      "crates.io",
      "*.crates.io",
      "static.crates.io",
      "proxy.golang.org",
      "sum.golang.org",
    ],
  },
  audit: {
    log: true,
    logFile: "~/.pi/agent/logs/sandbox-audit.jsonl",
  },
  enforcement: {
    requireKernelSandbox: false,
  },
};
