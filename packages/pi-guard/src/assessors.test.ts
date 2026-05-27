import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { assessBashCommand } from "./assessors";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-guard-"));
  execSync("git init", { cwd: dir });
  execSync("git config user.email test@test.com", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
  return dir;
}

describe("assessBashCommand — harmless commands", () => {
  it("passes pnpm test", () => {
    expect(assessBashCommand("pnpm test", "/", new Set())).toBeUndefined();
  });

  it("passes rg TODO src", () => {
    expect(assessBashCommand("rg TODO src", "/", new Set())).toBeUndefined();
  });

  it("passes git status", () => {
    expect(assessBashCommand("git status", "/", new Set())).toBeUndefined();
  });

  it("passes git diff", () => {
    expect(assessBashCommand("git diff", "/", new Set())).toBeUndefined();
  });

  it("passes normal git push", () => {
    expect(
      assessBashCommand("git push origin main", "/", new Set()),
    ).toBeUndefined();
  });

  it("passes python scripts/foo.py", () => {
    expect(
      assessBashCommand("python scripts/foo.py", "/", new Set()),
    ).toBeUndefined();
  });
});

describe("assessBashCommand — file removal", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    try {
      rmSync(repo, { recursive: true });
    } catch {}
  });

  it("allows deleting clean tracked file", () => {
    const f = join(repo, "clean.md");
    writeFileSync(f, "hello");
    execSync("git add clean.md", { cwd: repo });
    execSync('git commit -m "init"', { cwd: repo });
    expect(assessBashCommand("rm clean.md", repo, new Set())).toBeUndefined();
  });

  it("prompts for untracked file deletion", () => {
    writeFileSync(join(repo, "untracked.md"), "hello");
    const action = assessBashCommand("rm untracked.md", repo, new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:rm-risky");
  });

  it("prompts for dirty tracked file deletion", () => {
    const f = join(repo, "dirty.md");
    writeFileSync(f, "hello");
    execSync("git add dirty.md", { cwd: repo });
    execSync('git commit -m "init"', { cwd: repo });
    writeFileSync(f, "changed");
    const action = assessBashCommand("rm dirty.md", repo, new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:rm-risky");
  });

  it("allows deleting session-created file", () => {
    const f = join(repo, "session.md");
    writeFileSync(f, "hello");
    const sessionPaths = new Set([f]);
    expect(
      assessBashCommand("rm session.md", repo, sessionPaths),
    ).toBeUndefined();
  });

  it("prompts for broad target .", () => {
    const action = assessBashCommand("rm -rf .", repo, new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:rm-risky");
  });

  it("prompts for variable target", () => {
    const action = assessBashCommand('rm "$TARGET"', repo, new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:rm-risky");
  });

  it("prompts for unparseable chained rm", () => {
    const action = assessBashCommand("rm a.txt && rm b.txt", repo, new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:rm-risky");
  });

  it("prompts for find -delete", () => {
    const action = assessBashCommand(
      "find . -name '*.tmp' -delete",
      repo,
      new Set(),
    );
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:find-delete");
  });

  it("prompts for find -exec rm", () => {
    const action = assessBashCommand(
      "find src -name '*.test.ts' -exec rm {} \\;",
      repo,
      new Set(),
    );
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:find-delete");
  });

  it("allows rmdir on session-created directory", () => {
    const d = join(repo, "newdir");
    mkdirSync(d);
    expect(
      assessBashCommand("rmdir newdir", repo, new Set([d])),
    ).toBeUndefined();
  });
});

describe("assessBashCommand — git local-loss", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    try {
      rmSync(repo, { recursive: true });
    } catch {}
  });

  it("prompts for git clean -fd", () => {
    const action = assessBashCommand("git clean -fd", repo, new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:git-clean");
  });

  it("prompts for git clean -fdx", () => {
    const action = assessBashCommand("git clean -fdx", repo, new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:git-clean");
  });

  it("prompts for git reset --hard when dirty", () => {
    writeFileSync(join(repo, "dirty.md"), "x");
    execSync("git add dirty.md", { cwd: repo });
    execSync('git commit -m "init"', { cwd: repo });
    writeFileSync(join(repo, "dirty.md"), "y");
    const action = assessBashCommand("git reset --hard", repo, new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:git-reset-hard");
  });

  it("passes git reset --hard when clean", () => {
    writeFileSync(join(repo, "clean.md"), "x");
    execSync("git add clean.md", { cwd: repo });
    execSync('git commit -m "init"', { cwd: repo });
    expect(
      assessBashCommand("git reset --hard", repo, new Set()),
    ).toBeUndefined();
  });

  it("prompts for git checkout -- . when dirty", () => {
    writeFileSync(join(repo, "dirty.md"), "x");
    execSync("git add dirty.md", { cwd: repo });
    execSync('git commit -m "init"', { cwd: repo });
    writeFileSync(join(repo, "dirty.md"), "y");
    const action = assessBashCommand("git checkout -- .", repo, new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:git-discard");
  });

  it("passes git checkout -- . when clean", () => {
    writeFileSync(join(repo, "clean.md"), "x");
    execSync("git add clean.md", { cwd: repo });
    execSync('git commit -m "init"', { cwd: repo });
    expect(
      assessBashCommand("git checkout -- .", repo, new Set()),
    ).toBeUndefined();
  });

  it("prompts for git restore . when dirty", () => {
    writeFileSync(join(repo, "dirty.md"), "x");
    execSync("git add dirty.md", { cwd: repo });
    execSync('git commit -m "init"', { cwd: repo });
    writeFileSync(join(repo, "dirty.md"), "y");
    const action = assessBashCommand("git restore .", repo, new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:git-discard");
  });

  it("passes git restore . when clean", () => {
    writeFileSync(join(repo, "clean.md"), "x");
    execSync("git add clean.md", { cwd: repo });
    execSync('git commit -m "init"', { cwd: repo });
    expect(assessBashCommand("git restore .", repo, new Set())).toBeUndefined();
  });

  it("prompts for git stash drop", () => {
    const action = assessBashCommand("git stash drop", repo, new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:git-stash-delete");
  });

  it("prompts for git stash clear", () => {
    const action = assessBashCommand("git stash clear", repo, new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:git-stash-delete");
  });

  it("prompts for git branch -D", () => {
    const action = assessBashCommand("git branch -D feature", repo, new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:git-ref-delete");
  });

  it("prompts for git tag -d", () => {
    const action = assessBashCommand("git tag -d v1.0", repo, new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:git-ref-delete");
  });

  it("prompts for git push --force", () => {
    const action = assessBashCommand(
      "git push --force origin main",
      repo,
      new Set(),
    );
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:git-force-push");
  });

  it("prompts for git push --force-with-lease", () => {
    const action = assessBashCommand(
      "git push --force-with-lease origin main",
      repo,
      new Set(),
    );
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:git-force-push");
  });

  it("passes normal git push", () => {
    expect(
      assessBashCommand("git push origin main", repo, new Set()),
    ).toBeUndefined();
  });

  it("passes git reset --soft", () => {
    expect(
      assessBashCommand("git reset --soft HEAD~1", repo, new Set()),
    ).toBeUndefined();
  });

  it("passes git reset --mixed", () => {
    expect(
      assessBashCommand("git reset --mixed HEAD~1", repo, new Set()),
    ).toBeUndefined();
  });
});

describe("assessBashCommand — shell overwrite / truncate", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    try {
      rmSync(repo, { recursive: true });
    } catch {}
  });

  it("prompts for truncating redirect to existing untracked file", () => {
    writeFileSync(join(repo, "existing.txt"), "hello");
    const action = assessBashCommand("echo x > existing.txt", repo, new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:redirect-overwrite");
  });

  it("passes redirect to new file", () => {
    expect(
      assessBashCommand("echo x > newfile.txt", repo, new Set()),
    ).toBeUndefined();
  });

  it("passes redirect to /dev/null", () => {
    expect(
      assessBashCommand("some-cmd > /dev/null", repo, new Set()),
    ).toBeUndefined();
  });

  it("passes redirect to /dev/stderr", () => {
    expect(
      assessBashCommand("some-cmd > /dev/stderr", repo, new Set()),
    ).toBeUndefined();
  });

  it("prompts for truncate -s 0 on existing untracked file", () => {
    writeFileSync(join(repo, "existing.txt"), "hello");
    const action = assessBashCommand(
      "truncate -s 0 existing.txt",
      repo,
      new Set(),
    );
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:truncate-zero");
  });

  it("prompts for dd of= on existing untracked file", () => {
    writeFileSync(join(repo, "existing.txt"), "hello");
    const action = assessBashCommand(
      "dd if=/dev/zero of=existing.txt bs=1 count=1",
      repo,
      new Set(),
    );
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:dd-output");
  });

  it("prompts for sed -i on existing untracked file", () => {
    writeFileSync(join(repo, "existing.txt"), "hello");
    const action = assessBashCommand(
      "sed -i 's/hello/world/' existing.txt",
      repo,
      new Set(),
    );
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:sed-in-place");
  });

  it("prompts for perl -pi on existing untracked file", () => {
    writeFileSync(join(repo, "existing.txt"), "hello");
    const action = assessBashCommand(
      "perl -pi -e 's/hello/world/' existing.txt",
      repo,
      new Set(),
    );
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:perl-in-place");
  });

  it("prompts for mv overwrite of existing untracked file", () => {
    writeFileSync(join(repo, "src.txt"), "a");
    writeFileSync(join(repo, "dest.txt"), "b");
    const action = assessBashCommand("mv src.txt dest.txt", repo, new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:mv-overwrite");
  });

  it("passes mv to new destination", () => {
    writeFileSync(join(repo, "src.txt"), "a");
    execSync("git add src.txt", { cwd: repo });
    execSync('git commit -m "init"', { cwd: repo });
    expect(
      assessBashCommand("mv src.txt dest.txt", repo, new Set()),
    ).toBeUndefined();
  });

  it("prompts for cp overwrite of existing untracked file", () => {
    writeFileSync(join(repo, "src.txt"), "a");
    writeFileSync(join(repo, "dest.txt"), "b");
    const action = assessBashCommand("cp src.txt dest.txt", repo, new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:cp-overwrite");
  });

  it("passes cp to new destination", () => {
    writeFileSync(join(repo, "src.txt"), "a");
    execSync("git add src.txt", { cwd: repo });
    execSync('git commit -m "init"', { cwd: repo });
    expect(
      assessBashCommand("cp src.txt dest.txt", repo, new Set()),
    ).toBeUndefined();
  });
});

describe("assessBashCommand — permissions", () => {
  it("prompts for chmod -R", () => {
    const action = assessBashCommand("chmod -R 755 dir", "/", new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:permissions-risky");
  });

  it("prompts for chmod 777", () => {
    const action = assessBashCommand("chmod 777 file", "/", new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:permissions-risky");
  });

  it("prompts for chown -R", () => {
    const action = assessBashCommand("chown -R user:group dir", "/", new Set());
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:permissions-risky");
  });

  it("passes safe chmod", () => {
    expect(assessBashCommand("chmod 644 file", "/", new Set())).toBeUndefined();
  });
});

describe("assessBashCommand — rsync", () => {
  it("prompts for rsync --delete", () => {
    const action = assessBashCommand(
      "rsync --delete -av src/ dest/",
      "/",
      new Set(),
    );
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:rsync-delete");
  });

  it("passes rsync without --delete", () => {
    expect(
      assessBashCommand("rsync -av src/ dest/", "/", new Set()),
    ).toBeUndefined();
  });
});

describe("assessBashCommand — inline interpreter", () => {
  it("prompts for python -c with os.remove", () => {
    const action = assessBashCommand(
      "python -c 'import os; os.remove(\"file.txt\")'",
      "/",
      new Set(),
    );
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:inline-interpreter-delete");
  });

  it("prompts for python3 -c with shutil.rmtree", () => {
    const action = assessBashCommand(
      "python3 -c 'import shutil; shutil.rmtree(\"dir\")'",
      "/",
      new Set(),
    );
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:inline-interpreter-delete");
  });

  it("passes python scripts/foo.py", () => {
    expect(
      assessBashCommand("python scripts/foo.py", "/", new Set()),
    ).toBeUndefined();
  });

  it("prompts for node -e with fs.unlinkSync", () => {
    const action = assessBashCommand(
      'node -e \'require("fs").unlinkSync("file.txt")\'',
      "/",
      new Set(),
    );
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:inline-interpreter-delete");
  });

  it("prompts for node -e with fs.rmSync", () => {
    const action = assessBashCommand(
      'node -e \'require("fs").rmSync("dir", {recursive:true})\'',
      "/",
      new Set(),
    );
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:inline-interpreter-delete");
  });

  it("prompts for ruby -e with File.delete", () => {
    const action = assessBashCommand(
      "ruby -e 'File.delete(\"file.txt\")'",
      "/",
      new Set(),
    );
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:inline-interpreter-delete");
  });

  it("prompts for perl -e with unlink", () => {
    const action = assessBashCommand(
      'perl -e "unlink \\\"file.txt\\\""',
      "/",
      new Set(),
    );
    expect(action).toBeDefined();
    expect(action?.allowKey).toBe("bash:inline-interpreter-delete");
  });
});

describe("assessBashCommand — edit/write pass-through", () => {
  it("does not assess edit tool calls (handled by pi-readonly)", () => {
    // assessBashCommand is only called for bash, but verify it doesn't block edit-like bash strings
    expect(assessBashCommand("edit file.ts", "/", new Set())).toBeUndefined();
  });
});
