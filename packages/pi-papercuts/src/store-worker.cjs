const { existsSync, readFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const Module = require("node:module");
const typescript = require("typescript");

const [mode, root, key] = process.argv.slice(2);
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "@pi-extensions/lib") {
    return join(__dirname, "store-worker-lib.cjs");
  }
  if (request.startsWith(".") && request.endsWith(".js") && parent?.filename) {
    const sourcePath = resolve(
      dirname(parent.filename),
      `${request.slice(0, -3)}.ts`,
    );
    if (existsSync(sourcePath)) {
      return sourcePath;
    }
  }
  return originalResolveFilename.call(this, request, parent, ...rest);
};

Module._extensions[".ts"] = function (module, filename) {
  let source = readFileSync(filename, "utf-8");
  if (filename.endsWith(join("lib", "src", "file-lease.ts"))) {
    source = source.replace(
      "const require = createRequire(import.meta.url);\n",
      "",
    );
  }
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

if (mode === "hold") {
  const { acquireFileLease } = require("@pi-extensions/lib");
  acquireFileLease(root, { timeoutMs: 2_000 })
    .then((lease) => {
      process.stdout.write("ready\n");
      const release = () => {
        void lease.release().finally(() => process.exit(0));
      };
      process.on("SIGTERM", release);
      process.on("SIGINT", release);
      setInterval(() => {}, 1_000);
    })
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
} else if (mode === "propose" || mode === "stream") {
  const { createPapercutStore } = require("./store.ts");
  const store = createPapercutStore(root);
  const keys =
    mode === "stream"
      ? Array.from({ length: 8 }, (_, index) => `${key}-${index}`)
      : [key];
  const impact =
    mode === "stream"
      ? "Concurrent writers must not lose this record. ".repeat(25_000)
      : "Concurrent writers must not lose this record.";

  if (mode === "stream") {
    process.stdout.write("ready\n");
  }
  Promise.all(
    keys.map((proposalKey) =>
      store.propose(
        {
          key: proposalKey,
          title: `Concurrent ${proposalKey}`,
          trigger: `Trigger ${proposalKey}`,
          impact,
          currentGap: "The registry must serialize cross-process writes.",
          proposedResolution:
            "Use the shared file lease and atomic replacement.",
          suggestedDestination: "tooling",
        },
        { kind: "agent", sessionId: proposalKey },
      ),
    ),
  )
    .then(() => process.stdout.write("done\n"))
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
} else {
  process.stderr.write("Expected hold, propose, or stream mode.\n");
  process.exitCode = 1;
}
