'use strict';
const fs         = require('fs');
const path       = require('path');
const graphStore = require('../lib/graph-store');

const repoPath = path.resolve(process.argv[2] || process.cwd());

graphStore.open(path.join(repoPath, '.graph'));
console.log('✓ .graph/nodes/ created');

graphStore.initGitAttributes(repoPath);
console.log('✓ .gitattributes updated (merge=union)');

fs.writeFileSync(path.join(repoPath, '.graph', '.gitkeep'), '');
console.log('✓ .graph/.gitkeep created');

console.log(`
Next steps:
  git add .graph/ .gitattributes
  git commit -m "chore: init graph-store tracking"
  git push

Teammates: pull and the orchestrator will start writing task history here.`);
