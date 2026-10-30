# Candidate build image (docs/SANDBOX-BUILD-PLAN.md). Commands run through the Durable Object container API, so no
# sandbox-shim is needed (that is only for the SDK's Files/backups). Git clones the candidate repo through the
# Artifacts intercept; esbuild is preinstalled so a build never fetches packages (there is no Internet access anyway).
# Base image pinned by digest (node:24-trixie-slim, read from Docker Hub 2026-10-25); bump it deliberately.
FROM node:24-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g esbuild@0.25.0

# Builds run as the unprivileged `node` user (uid 1000) in /workspace.
RUN mkdir -p /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
