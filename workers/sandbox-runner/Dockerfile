# Build container for candidate bundles (docs/SANDBOX-BUILD-PLAN.md). The base image tag must match the
# @cloudflare/sandbox version in package.json. esbuild is preinstalled so a build does not fetch it per request.
FROM docker.io/cloudflare/sandbox:0.12.14

RUN npm install -g esbuild@0.25.0
