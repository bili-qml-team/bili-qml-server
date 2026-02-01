// scripts/copy-server.js
const fs = require("fs");
const path = require("path");

const cwd = process.cwd();
// Allow passing source filename as the first CLI argument (defaults to server.js)
const targetFiles = ["altcha.mjs", "bili.mjs", "leaderboard.mjs", "server.mjs", "status.mjs", "token.mjs", "vote.mjs"];
const outputPathArg = process.argv[2];
const destDir = path.join(cwd, "node-functions");

try {
  if (!fs.existsSync(outputPathArg)) {
    console.error(`Cannot find output directory: ${outputPathArg}`);
    console.error("Usage: node eo-deploy.js [output-dir]");
    process.exit(1);
  }
  for (const file of targetFiles) {
    const src = path.join(cwd, outputPathArg, file);
    const fileName = path.basename(src);
    // server.mjs -> [[server]].js; others keep the original filename
    const destFileName = fileName === "server.mjs" ? "[[server]].js" : fileName;
    const dest = path.join(destDir, destFileName);

    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest);

    console.log(`Copied: ${src} -> node-functions/${destFileName}`);
  }
} catch (err) {
  console.error("Run failed: ", err);
  process.exit(1);
}
