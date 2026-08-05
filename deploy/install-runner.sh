#!/bin/bash
# ─── One-time: install the GitHub Actions self-hosted runner ─────
#
# Run this ON the VM, once. After it finishes, deploying is `git push`.
#
#   1. https://github.com/Vishal-Merugu/Career-Compass/settings/actions/runners/new
#   2. Copy the token it shows (starts with A..., valid ~1 hour)
#   3. On the VM:  ./deploy/install-runner.sh <TOKEN>
#
# The runner dials OUT to GitHub over HTTPS, so it needs no inbound route and
# works fine on a VPN-gated VM.

set -euo pipefail

REPO_URL="https://github.com/Vishal-Merugu/Career-Compass"
RUNNER_DIR="$HOME/actions-runner"
CONFIG_DIR="$HOME/cc-config"
TOKEN="${1:-}"

if [ -z "$TOKEN" ]; then
  echo "Usage: ./deploy/install-runner.sh <REGISTRATION_TOKEN>"
  echo
  echo "Get a token from:"
  echo "  $REPO_URL/settings/actions/runners/new"
  exit 1
fi

# ─── Preflight ───────────────────────────────────────────────────

if ! docker info >/dev/null 2>&1; then
  echo "❌ Cannot talk to Docker as $(id -un)."
  echo "   Fix: sudo usermod -aG docker $(id -un)   (then log out and back in)"
  exit 1
fi

if ! curl -sSf -o /dev/null --max-time 10 https://api.github.com; then
  echo "❌ The VM cannot reach api.github.com."
  echo "   The runner needs outbound HTTPS to GitHub. Check egress firewall."
  exit 1
fi

# ─── Config that must outlive deploys ────────────────────────────
# The runner checks out into its own workspace, so gitignored files cannot
# live in the repo — they are copied in from here on every deploy.

mkdir -p "$CONFIG_DIR"
echo "📁 Config dir: $CONFIG_DIR"
for f in .env linkedin-cookies.json; do
  if [ -f "$CONFIG_DIR/$f" ]; then
    echo "   ✅ $f"
  else
    echo "   ⚠️  $f MISSING — copy it here before the first deploy:"
    echo "      scp $f <vm>:$CONFIG_DIR/"
  fi
done

# ─── Runner ──────────────────────────────────────────────────────

if [ -d "$RUNNER_DIR" ]; then
  echo "ℹ️  $RUNNER_DIR already exists — reconfiguring."
  ( cd "$RUNNER_DIR" && sudo ./svc.sh uninstall 2>/dev/null || true )
  ( cd "$RUNNER_DIR" && ./config.sh remove --token "$TOKEN" 2>/dev/null || true )
else
  mkdir -p "$RUNNER_DIR"
fi

cd "$RUNNER_DIR"

if [ ! -f ./config.sh ]; then
  echo "⬇️  Fetching latest runner release..."
  # Capture the response before parsing it. Piping curl straight into an
  # early-exiting filter (grep -m1, head) closes the pipe under curl, which
  # returns 23 and — with pipefail + set -e — kills the script.
  API_JSON=$(curl -sSfL https://api.github.com/repos/actions/runner/releases/latest)
  VERSION=$(printf '%s' "$API_JSON" | tr ',' '\n' \
    | awk -F'"' '/tag_name/ {print $4}' | tr -d 'v')

  if [ -z "$VERSION" ]; then
    echo "❌ Could not determine the latest runner version from the GitHub API."
    exit 1
  fi
  case "$(uname -m)" in
    x86_64)  ARCH=x64 ;;
    aarch64) ARCH=arm64 ;;
    *) echo "❌ Unsupported arch: $(uname -m)"; exit 1 ;;
  esac
  echo "   version $VERSION, arch $ARCH"
  curl -sSfL -o runner.tar.gz \
    "https://github.com/actions/runner/releases/download/v${VERSION}/actions-runner-linux-${ARCH}-${VERSION}.tar.gz"
  tar xzf runner.tar.gz && rm runner.tar.gz
fi

echo "🔗 Registering with $REPO_URL..."
./config.sh \
  --unattended \
  --url "$REPO_URL" \
  --token "$TOKEN" \
  --name "$(hostname)" \
  --labels self-hosted,vm \
  --work _work \
  --replace

# Run as a service so it survives reboots and SSH disconnects.
echo "🚀 Installing as a system service..."
sudo ./svc.sh install "$(id -un)"
sudo ./svc.sh start

echo
echo "✅ Runner is live. Deploying is now: git push origin main"
echo
echo "   Status:  cd $RUNNER_DIR && sudo ./svc.sh status"
echo "   Logs:    journalctl -u 'actions.runner.*' -f"
echo "   Runners: $REPO_URL/settings/actions/runners"
echo
echo "   ⚠️  This repo is PUBLIC. Keep the workflow triggered on push/dispatch"
echo "      only — a pull_request trigger would let fork PRs run code here."
