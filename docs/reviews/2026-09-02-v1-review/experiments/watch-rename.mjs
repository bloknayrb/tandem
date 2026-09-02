import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-review-watch-"));
const file = path.join(dir, "doc.md");
fs.writeFileSync(file, "v1\n");
const events = [];
const w = fs.watch(file, (ev, name) => events.push(`${ev}:${name}`));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await sleep(100);
// 1. in-place write (what Vim/VS Code-in-place do)
fs.writeFileSync(file, "v2\n");
await sleep(200);
console.log("after in-place write:", events.splice(0));
// 2. atomic rename-replace (what Tandem's own atomicWrite does, and git/sed -i/JetBrains/Zed/Emacs)
const tmp = path.join(dir, ".tandem-tmp-x");
fs.writeFileSync(tmp, "v3\n");
fs.renameSync(tmp, file);
await sleep(200);
console.log("after rename-replace:", events.splice(0));
// 3. a subsequent in-place external edit on the NEW inode
fs.writeFileSync(file, "v4 external edit\n");
await sleep(300);
console.log("after later in-place external edit (should be 'change' if watcher alive):", events.splice(0));
// 4. another rename replace
fs.writeFileSync(tmp, "v5\n");
fs.renameSync(tmp, file);
await sleep(300);
console.log("after 2nd rename-replace:", events.splice(0));
w.close();
console.log("platform", process.platform, process.version);
