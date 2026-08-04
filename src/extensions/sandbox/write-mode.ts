export type SandboxWriteMode = "workspace-write" | "repository-read-only";

export type SandboxChildSnapshot = Readonly<{
  enabled: boolean;
  writeMode: SandboxWriteMode;
}>;
