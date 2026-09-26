# Production image for Render (Docker runtime): Node + Playwright Chromium
# with all OS dependencies preinstalled. Render's native Node runtime cannot
# apt-get the browser libraries, so Docker is the reliable path for the
# price scraper. Matches playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
# Render injects PORT at runtime; the app reads env.PORT. EXPOSE is documentary.
EXPOSE 10000

CMD ["node", "src/index.js"]
