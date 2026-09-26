# Production image for Render (Docker runtime): Node + Playwright Chromium
# with all OS dependencies preinstalled. Render's native Node runtime cannot
# apt-get the browser libraries, so Docker is the reliable path for the
# price scraper. Matches playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Belt and braces: the base image ships browsers for its own Playwright
# version, but the npm package MUST find its exact browser build
# (every Playwright minor version needs a different Chromium revision —
# a ^-range drift is enough to break launch with "Executable doesn't exist").
# Installing here guarantees the image always matches package.json.
RUN npx playwright install chromium

COPY src ./src

ENV NODE_ENV=production
# Render injects PORT at runtime; the app reads env.PORT. EXPOSE is documentary.
EXPOSE 10000

CMD ["node", "src/index.js"]
