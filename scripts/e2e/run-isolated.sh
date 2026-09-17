#!/usr/bin/env bash
# Dedicated disposable Linux runner only: maps app hosts to localhost, never prod.
set -euo pipefail
if [[ "${CI:-}" != "true" || -z "${RUNNER_TEMP:-}" ]]; then
  echo 'Use the isolated GitHub Actions job on a disposable runner.' >&2; exit 1
fi
export E2E_TOOLS="$RUNNER_TEMP/garma-browser-tools"
export CONVEX_SELF_HOSTED_URL='http://127.0.0.1:3210'
unset CONVEX_DEPLOY_KEY CONVEX_DEPLOYMENT CONVEX_SELF_HOSTED_ADMIN_KEY
CLOUD_HOST='precise-ptarmigan-412.eu-west-1.convex.cloud'
SITE_HOST='precise-ptarmigan-412.eu-west-1.convex.site'
TLS="$RUNNER_TEMP/garma-test-tls"
mkdir -p "$TLS" e2e-results
cp /etc/hosts "$RUNNER_TEMP/garma-hosts-before"
cleanup() {
  [[ -n "${PROXY_PID:-}" ]] && sudo kill "$PROXY_PID" 2>/dev/null || true
  [[ -n "${MEDIA_PID:-}" ]] && kill "$MEDIA_PID" 2>/dev/null || true
  docker rm -f garma-ci-convex >/dev/null 2>&1 || true
  [[ -f "$TLS/proxy-counts.json" ]] && cp "$TLS/proxy-counts.json" e2e-results/ || true
  sudo cp "$RUNNER_TEMP/garma-hosts-before" /etc/hosts
}
trap cleanup EXIT
printf '\n127.0.0.1 %s %s garma-ci.test garma-ci-media.test\n' "$CLOUD_HOST" "$SITE_HOST" | sudo tee -a /etc/hosts >/dev/null
# Resolve the official published image once; run and record its immutable digest.
IMAGE='ghcr.io/get-convex/convex-backend:latest'
docker pull "$IMAGE"
IMAGE="$(docker image inspect "$IMAGE" --format '{{index .RepoDigests 0}}')"
printf '%s\n' "$IMAGE" | tee e2e-results/backend-image.txt
docker run -d --name garma-ci-convex -p 127.0.0.1:3210:3210 -p 127.0.0.1:3211:3211 \
  -e CONVEX_CLOUD_ORIGIN="https://$CLOUD_HOST" -e CONVEX_SITE_ORIGIN="https://$SITE_HOST" \
  -e DISABLE_BEACON=true -e DISABLE_METRICS_ENDPOINT=true "$IMAGE"
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3210/version > e2e-results/backend-version.txt; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:3210/version >/dev/null
CONVEX_SELF_HOSTED_ADMIN_KEY="$(docker exec garma-ci-convex ./generate_admin_key.sh)"
export CONVEX_SELF_HOSTED_ADMIN_KEY
echo "::add-mask::$CONVEX_SELF_HOSTED_ADMIN_KEY"
cat > "$RUNNER_TEMP/garma-test-env" <<'ENV'
GARMA_FAMILY_INVITE_CODE=garma-isolated-browser-test-invitation-2026
GARMA_ALLOWED_ORIGINS=https://garma-ci.test
LIVEKIT_URL=wss://garma-ci-media.test
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
ENV
chmod 600 "$RUNNER_TEMP/garma-test-env"
bunx convex env set --from-file "$RUNNER_TEMP/garma-test-env"
bunx convex deploy --yes --typecheck enable --codegen enable
node scripts/e2e/check-runtime.mjs
bun run build
npm install --prefix "$E2E_TOOLS" --ignore-scripts --no-audit --no-fund playwright@1.63.0
node "$E2E_TOOLS/node_modules/playwright/cli.js" install --with-deps chromium
curl --fail --location --retry 2 'https://github.com/livekit/livekit/releases/download/v1.13.7/livekit_1.13.7_linux_amd64.tar.gz' -o "$RUNNER_TEMP/livekit.tar.gz"
echo "6634aeeb2fb1366b6723708ae4320b9d5408106a4c63457c5e845ae3979c90e2  $RUNNER_TEMP/livekit.tar.gz" | sha256sum --check
mkdir -p "$RUNNER_TEMP/garma-livekit"
tar -xzf "$RUNNER_TEMP/livekit.tar.gz" -C "$RUNNER_TEMP/garma-livekit"
"$RUNNER_TEMP/garma-livekit/livekit-server" --dev --bind 127.0.0.1 > "$RUNNER_TEMP/garma-livekit.log" 2>&1 &
MEDIA_PID=$!
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TLS/key.pem" -out "$TLS/cert.pem" -days 1 \
  -subj '/CN=garma-ci.test' -addext "subjectAltName=DNS:garma-ci.test,DNS:garma-ci-media.test,DNS:$CLOUD_HOST,DNS:$SITE_HOST" 2>/dev/null
sudo "$(command -v node)" scripts/e2e/proxy.mjs "$TLS" > "$RUNNER_TEMP/garma-proxy.log" 2>&1 &
PROXY_PID=$!
for i in $(seq 1 30); do
  if curl -kfsS https://garma-ci.test/ >/dev/null; then break; fi
  sleep 1
done
curl -kfsS https://garma-ci.test/ >/dev/null
node scripts/e2e/smoke.mjs
