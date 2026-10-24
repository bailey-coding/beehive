# Candidate build image (docs/SANDBOX-BUILD-PLAN.md). Commands run through the Durable Object container API, so no
# sandbox-shim is needed (that is only for the SDK's Files/backups). Git clones the candidate repo through the
# Artifacts intercept; esbuild is preinstalled so a build never fetches packages (there is no Internet access anyway).
FROM node:24-trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g esbuild@0.25.0

RUN mkdir -p /workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]
