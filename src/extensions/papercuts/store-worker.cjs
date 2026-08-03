const { existsSync, readFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const Module = require("node:module");
const typescript = require("typescript");

const [mode, root, key] = process.argv.slice(2);
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "#lib/file-lease") {
    return join(__dirname, "..", "..", "lib", "file-lease.ts");
  }
  if (request === "#lib/git") {
    return join(__dirname, "..", "..", "lib", "git.ts");
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
  if (filename.endsWith(join("src", "lib", "file-lease.ts"))) {
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
  require("#lib/file-lease")
    .acquireFileLease(root, { timeoutMs: 2_000 })
    .then((lease) => {
      process.stdout.write("ready\n");
      const release = () => void lease.release().finally(() => process.exit(0));
      process.on("SIGTERM", release);
      process.on("SIGINT", release);
      setInterval(() => {}, 1_000);
    })
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
} else if (mode === "record" || mode === "record-cwd" || mode === "stream") {
  const stores = require("./store.ts");
  const store =
    mode === "record-cwd"
      ? stores.createPapercutStoreForCwd(root)
      : Promise.resolve(stores.createPapercutStore(root));
  const keys =
    mode === "stream"
      ? Array.from({ length: 8 }, (_, index) => `${key}-${index}`)
      : [key];
  if (mode === "stream") {
    process.stdout.write("ready\n");
  }
  store
    .then((value) =>
      Promise.all(
        keys.map((recordKey) =>
          value.record({
            key: recordKey,
            title: `Concurrent ${recordKey}`,
            task: "Concurrent registry validation",
            incident: "Cross-process writes need serialization.",
            evidence: "Several workers wrote at once.",
            workarounds: ["Used the shared lease."],
            taskOutcome: "The task continued safely.",
            suggestedDestination: "tooling",
          }),
        ),
      ),
    )
    .then(() => process.stdout.write("done\n"))
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
} else {
  process.stderr.write("Expected hold, record, record-cwd, or stream mode.\n");
  process.exitCode = 1;
}
