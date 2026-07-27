const { closeSync, openSync } = require("node:fs");
const { tryLock, unlock } = require("fs-native-extensions");

const [anchorPath] = process.argv.slice(2);
const fd = openSync(anchorPath, "a+");
const locked = tryLock(fd);
process.stdout.write(`${locked ? "acquired" : "contended"}\n`);

if (!locked) {
  closeSync(fd);
  process.exit(0);
}

function releaseAndExit() {
  unlock(fd);
  closeSync(fd);
  process.exit(0);
}

process.on("SIGTERM", releaseAndExit);
process.on("SIGINT", releaseAndExit);
setInterval(() => {}, 1_000);
