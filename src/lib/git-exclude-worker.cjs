const { existsSync, readFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const Module = require("node:module");
const typescript = require("typescript");

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
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
  if (filename.endsWith("file-lease.ts")) {
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

const [cwd, pattern, releasePath] = process.argv.slice(2);
const {
  ensureGitInfoExclude,
  setGitInfoExcludeTestHooks,
} = require("./git.ts");

setGitInfoExcludeTestHooks({
  beforeRename: async () => {
    process.stdout.write("ready\n");
    while (!existsSync(releasePath)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  },
});

ensureGitInfoExclude(cwd, pattern)
  .then(() => {
    process.stdout.write("done\n");
  })
  .catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
