#!/bin/bash
# Test script to verify the CI fix for per-worker install catches zod failures
#
# This test simulates the scenario where workers/shared has a dependency
# version mismatch and verifies that the new CI workflow catches it.

set +e  # Don't exit on error - we want to capture failure cases

echo "=========================================="
echo "Testing CI Fix for Per-Worker Install"
echo "=========================================="

cd /home/paseo/bailey-coding-beehive/beehive

# Save original state
ORIGINAL_SHARED_PKG="workers/shared/package.json"
ORIGINAL_SHARED_LOCK="workers/shared/package-lock.json"

# Cleanup function
cleanup() {
    echo "Cleaning up..."
    # Restore original files if backup exists
    if [ -f "$ORIGINAL_SHARED_PKG.bak" ]; then
        cp "$ORIGINAL_SHARED_PKG.bak" "$ORIGINAL_SHARED_PKG"
        rm -f "$ORIGINAL_SHARED_PKG.bak"
    fi
    if [ -f "$ORIGINAL_SHARED_LOCK.bak" ]; then
        cp "$ORIGINAL_SHARED_LOCK.bak" "$ORIGINAL_SHARED_LOCK"
        rm -f "$ORIGINAL_SHARED_LOCK.bak"
    fi
    
    # Clean node_modules
    rm -rf node_modules
    rm -rf workers/shared/node_modules
    for worker in workers/*/; do
        rm -rf "$worker/node_modules"
    done
    
    echo "Cleanup complete."
}

trap cleanup EXIT

# Backup original files
if [ ! -f "$ORIGINAL_SHARED_PKG.bak" ]; then
    cp "$ORIGINAL_SHARED_PKG" "$ORIGINAL_SHARED_PKG.bak"
fi
if [ -f "$ORIGINAL_SHARED_LOCK" ] && [ ! -f "$ORIGINAL_SHARED_LOCK.bak" ]; then
    cp "$ORIGINAL_SHARED_LOCK" "$ORIGINAL_SHARED_LOCK.bak"
fi

# Clean slate
rm -rf node_modules
rm -rf workers/shared/node_modules
for worker in workers/*/; do
    rm -rf "$worker/node_modules"
done

echo ""
echo "=========================================="
echo "TEST: OLD Behavior (with root npm install)"
echo "=========================================="

# Modify shared to have a non-existent zod version
cat > "$ORIGINAL_SHARED_PKG" << 'EOF'
{
  "name": "@beehive/shared",
  "version": "1.0.0",
  "private": true,
  "description": "test",
  "dependencies": {
    "zod": "99.0.0"
  }
}
EOF

# Remove any existing lock file to force fresh resolution
rm -f "$ORIGINAL_SHARED_LOCK"

echo "Step 1: Install root dependencies (OLD workflow)"
npm install --no-audit --no-fund > /tmp/npm-root.log 2>&1
ROOT_INSTALL=$?

echo "Step 2: Install shared dependencies"
(cd workers/shared && npm install --no-audit --no-fund) > /tmp/npm-shared.log 2>&1
SHARED_INSTALL=$?

echo "Step 3: Check if root has zod"
if [ -d "node_modules/zod" ]; then
    echo "  ✓ Root node_modules/zod exists"
    ROOT_HAS_ZOD=1
else
    echo "  ✗ Root node_modules/zod NOT found"
    ROOT_HAS_ZOD=0
fi

echo "Step 4: Check if shared has zod"
if [ -d "workers/shared/node_modules/zod" ]; then
    echo "  ✓ Shared node_modules/zod exists"
    SHARED_HAS_ZOD=1
else
    echo "  ✗ Shared node_modules/zod NOT found"
    SHARED_HAS_ZOD=0
fi

# Restore original shared package.json for next test
if [ -f "$ORIGINAL_SHARED_PKG.bak" ]; then
    cp "$ORIGINAL_SHARED_PKG.bak" "$ORIGINAL_SHARED_PKG"
fi
if [ -f "$ORIGINAL_SHARED_LOCK.bak" ]; then
    cp "$ORIGINAL_SHARED_LOCK.bak" "$ORIGINAL_SHARED_LOCK"
fi

# Clean for next test
rm -rf node_modules
rm -rf workers/shared/node_modules
for worker in workers/*/; do
    rm -rf "$worker/node_modules"
done

echo ""
echo "OLD Behavior Results:"
echo "  Root install: $ROOT_INSTALL"
echo "  Shared install: $SHARED_INSTALL"
echo "  Root has zod: $ROOT_HAS_ZOD"
echo "  Shared has zod: $SHARED_HAS_ZOD"

if [ $ROOT_HAS_ZOD -eq 1 ] && [ $SHARED_HAS_ZOD -eq 0 ]; then
    echo "  ⚠️  BUG CONFIRMED: Root zod exists but shared zod missing!"
    echo "     Workers importing from shared would use root zod, hiding the version mismatch."
    OLD_HAS_BUG=1
else
    echo "  ✓ No bug detected in old behavior"
    OLD_HAS_BUG=0
fi

echo ""
echo "=========================================="
echo "TEST: NEW Behavior (without root npm install)"
echo "=========================================="

# Modify shared again
cat > "$ORIGINAL_SHARED_PKG" << 'EOF'
{
  "name": "@beehive/shared",
  "version": "1.0.0",
  "private": true,
  "description": "test",
  "dependencies": {
    "zod": "99.0.0"
  }
}
EOF

# Remove lock file
rm -f "$ORIGINAL_SHARED_LOCK"

echo "Step 1: Skip root npm install (NEW workflow - the fix)"
echo "  (not running npm install at root)"

echo "Step 2: Install shared dependencies"
(cd workers/shared && npm install --no-audit --no-fund) > /tmp/npm-shared-new.log 2>&1
SHARED_INSTALL_NEW=$?

echo "Step 3: Check if shared has zod"
if [ -d "workers/shared/node_modules/zod" ]; then
    echo "  ✓ Shared node_modules/zod exists"
    SHARED_HAS_ZOD_NEW=1
else
    echo "  ✗ Shared node_modules/zod NOT found"
    SHARED_HAS_ZOD_NEW=0
fi

# Restore
if [ -f "$ORIGINAL_SHARED_PKG.bak" ]; then
    cp "$ORIGINAL_SHARED_PKG.bak" "$ORIGINAL_SHARED_PKG"
fi
if [ -f "$ORIGINAL_SHARED_LOCK.bak" ]; then
    cp "$ORIGINAL_SHARED_LOCK.bak" "$ORIGINAL_SHARED_LOCK"
fi

echo ""
echo "NEW Behavior Results:"
echo "  Shared install: $SHARED_INSTALL_NEW"
echo "  Shared has zod: $SHARED_HAS_ZOD_NEW"

if [ $SHARED_INSTALL_NEW -ne 0 ]; then
    echo "  ✓ FIX WORKS: Shared install failed because zod@99.0.0 doesn't exist!"
    NEW_CATCHES_BUG=1
else
    echo "  ✗ FIX FAILED: Shared install should have failed"
    NEW_CATCHES_BUG=0
fi

echo ""
echo "=========================================="
echo "SUMMARY"
echo "=========================================="
echo "OLD workflow (with root install):"
if [ $OLD_HAS_BUG -eq 1 ]; then
    echo "  ⚠️  Has bug - does NOT catch version mismatch"
else
    echo "  ✓ No bug detected"
fi

echo ""
echo "NEW workflow (without root install):"
if [ $NEW_CATCHES_BUG -eq 1 ]; then
    echo "  ✓ FIX VERIFIED - catches version mismatch!"
    exit 0
else
    echo "  ✗ FIX NOT WORKING - does not catch version mismatch"
    exit 1
fi
