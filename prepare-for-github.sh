#!/bin/bash
# Run this script once from the repo root to clean up git tracking
# before making the repository public on GitHub.
#
# On Windows, run in Git Bash:
#   cd "C:\Users\martin.riha\Martin Repos\Custom-LLM-provider"
#   bash prepare-for-github.sh

set -e

echo "==> Removing node_modules, out/, .vs/, *.vsix from git tracking (files stay on disk)..."
git rm -r --cached node_modules/ --ignore-unmatch
git rm -r --cached out/ --ignore-unmatch
git rm -r --cached .vs/ --ignore-unmatch
git rm --cached *.vsix --ignore-unmatch

echo "==> Staging new/updated files..."
git add .gitignore
git add README.md
git add images/
git add LICENSE

echo "==> Creating cleanup commit..."
git commit -m "chore: prepare for public release

- Add .gitignore (exclude node_modules, out, .vs, *.vsix)
- Remove tracked build artifacts and IDE metadata
- Add screenshot images
- Update README with screenshots, Alibaba Coding Plan link, donate section"

echo ""
echo "==> Done! Repository is ready for GitHub public release."
echo "    Push with: git push origin main"
