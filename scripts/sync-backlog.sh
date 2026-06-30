#!/usr/bin/env bash
# ── sync-backlog.sh ───────────────────────────────────────────────────────────
# Extracts the current state of the backlog/ directory and commits it to the
# orphan 'backlog' branch. The orphan branch has its own root commit and
# contains *only* the contents of backlog/ (flattened — no 'backlog/' prefix).
#
# This keeps backlog history separate from the main codebase history, making it
# easy to surface tasks, milestones, and decisions without polluting the
# project's git log. Think of it like a self-contained gh-pages branch for your
# engineering notebook.
#
# Usage:
#   ./scripts/sync-backlog.sh          # sync now
#   ./scripts/sync-backlog.sh --dry-run # show what would be committed
#
# To auto-sync on every commit, add this as a post-commit hook:
#   ln -sf ../../scripts/sync-backlog.sh .git/hooks/post-commit
#
# Ref: https://git-scm.com/docs/git-commit-tree
# Ref: https://git-scm.com/docs/git-read-tree
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BACKLOG_DIR="backlog"
BRANCH="backlog"
DRY_RUN=false

# ── Argument parsing ─────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) echo "Unknown option: $arg"; exit 2 ;;
  esac
done

# ── Pre-flight checks ────────────────────────────────────────────────────────
# Ensure we're inside a git repo
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "❌ Not inside a git repository." >&2
  exit 1
fi

# Ensure the backlog directory exists
if [ ! -d "$BACKLOG_DIR" ]; then
  echo "❌ Directory '$BACKLOG_DIR/' not found." >&2
  exit 1
fi

# Remember which branch we started on so we can return to it
CURRENT_BRANCH=$(git branch --show-current)

# ── Create orphan branch on first run ─────────────────────────────────────────
if ! git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  echo "🔧 Creating orphan branch '$BRANCH'..."
  if [ "$DRY_RUN" = true ]; then
    echo "   (dry-run: would create orphan branch '$BRANCH')"
  else
    # --orphan creates a branch with no parents; we make an empty root commit
    # so the branch ref actually exists and can be used as a parent later.
    # After rm --cached, the working tree still has all files; -f forces
    # the checkout back to main so those files are re-tracked there.
    git checkout --orphan "$BRANCH"
    git rm -rf --cached . 2>/dev/null || true
    git commit --allow-empty -m "backlog: initial empty root commit"
    git checkout -f "$CURRENT_BRANCH"
    echo "   ✅ Created."
  fi
fi

# ── Repo root (used throughout) ──────────────────────────────────────────────
GIT_ROOT=$(git rev-parse --show-toplevel)

# ── If branch still doesn't exist (dry-run skipped creation) ──────────────────
if ! git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  echo "📋 Files that would be synced to new orphan branch '$BRANCH':"
  (cd "$GIT_ROOT" && find "$BACKLOG_DIR" -type f | sort | sed 's/^/   + /')
  echo "🏃 (dry-run: would create orphan branch & commit these files)"
  exit 0
fi

# ── Build the backlog commit using a temporary index ──────────────────────────
# We use GIT_INDEX_FILE to create a separate staging area that represents
# exactly what the orphan branch should look like. This avoids polluting the
# user's real index and keeps the operation self-contained.
# Use mktemp -u to get a unique path without creating the file.
# When GIT_INDEX_FILE points to a non-existent path, git creates a fresh
# in-memory index on first use (git add). If the file already exists but
# isn't a valid index, git errors out with "index file smaller than expected".
TEMP_INDEX=$(mktemp -u)
trap "rm -f $TEMP_INDEX" EXIT

export GIT_INDEX_FILE="$TEMP_INDEX"

# Step 1: Load the orphan branch's current tree into the temp index.
# read-tree populates the index from an existing tree object (the branch tip).
# If the branch doesn't exist yet or has an empty tree, we start with a fresh
# index — the temp file won't exist and git will create one on add.
if ! git read-tree "$BRANCH" 2>/dev/null; then
  rm -f "$TEMP_INDEX"  # ensure no stale/broken index file remains
fi

# Step 2: Stage the current backlog/ files into the temp index.
# --all picks up additions, modifications, and deletions relative to the index.
# We cd to the repo root so paths are relative, then add just the backlog dir.
# -f is required because backlog/ is in .gitignore on main (to prevent
# accidental commits there) — but we explicitly want it in the orphan branch.
(cd "$GIT_ROOT" && git add -f --all "$BACKLOG_DIR/")

# Step 3: Check if there are any changes to commit.
# diff-index compares the working tree (via the index) to the given tree.
if git diff-index --quiet --cached "$BRANCH" -- 2>/dev/null; then
  echo "📋 No changes to sync in '$BACKLOG_DIR/'."
  rm -f "$TEMP_INDEX"
  exit 0
fi

# Step 4: Write the index as a tree object (a snapshot of the directory).
TREE=$(git write-tree)

# Step 5: Get the orphan branch's current tip as parent for this commit.
# This preserves history on the orphan branch — each sync is a new commit
# on top of the previous one.
PARENT=$(git rev-parse "$BRANCH")

# Step 6: Build the commit message with a UTC timestamp for traceability.
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
MSG="backlog: sync from $CURRENT_BRANCH ($TIMESTAMP)"

# Step 7: Show what files changed (staged in the temp index vs. the orphan tip).
echo "📋 Changes to sync:"
git diff-index --cached --name-status "$BRANCH" -- | sed 's/^/   /'

if [ "$DRY_RUN" = true ]; then
  echo "🏃 (dry-run: would commit & update refs/heads/$BRANCH)"
  rm -f "$TEMP_INDEX"
  exit 0
fi

# Step 8: Create the commit object and update the branch ref.
# commit-tree is the low-level plumbing that creates a commit from a tree.
# update-ref atomically points the branch ref at the new commit.
COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "$MSG")
git update-ref "refs/heads/$BRANCH" "$COMMIT"

echo "✅ Synced '$BACKLOG_DIR/' to orphan branch '$BRANCH'"
echo "   commit: $(git rev-parse --short "$COMMIT")"

# Always return to the original branch, even if something above left us
# on a different one (e.g. during first-run orphan branch creation).
if [ "$(git branch --show-current)" != "$CURRENT_BRANCH" ]; then
  git checkout -f "$CURRENT_BRANCH" 2>/dev/null || true
fi
